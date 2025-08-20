// index.js
// Proxy de streaming “pro” con caché en disco y soporte de Range.
// Requisitos: Node 18+, ffmpeg NO requerido. Pensado para Render/VPS.

// Módulos
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import got from "got";
import { pipeline } from "stream";
import { promisify } from "util";

const pump = promisify(pipeline);

// ----- Config ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// Tamaños y límites
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, "disk_cache");
const MAX_CACHE_GB = Number(process.env.MAX_CACHE_GB || "10"); // total caché
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || "2048"); // máx. cache por archivo (2 GB por defecto)
const MAX_CACHE_BYTES = MAX_CACHE_GB * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;

// Timeouts/reintentos
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || "25000");
const REQ_RETRIES = Number(process.env.REQ_RETRIES || "2");

// Seguridad / compatibilidad
const ENABLE_CORS = String(process.env.ENABLE_CORS || "true") === "true";
const SPOOF_UA =
  process.env.USER_AGENT ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // e.g. "cdn.example.com,media.domain.tld"
const FORCE_HTTPS_ONLY = String(process.env.FORCE_HTTPS_ONLY || "false") === "true";

// Patrones de tipos “streameables”
const CT_OK = [
  /^video\//i,
  /^audio\//i,
  /application\/octet-stream/i,
  /application\/vnd\.apple\.mpegurl/i, // m3u8
  /application\/x-mpegURL/i,
  /application\/dash\+xml/i, // mpd
];

// Crear carpeta de caché
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Utilidad: hash estable para nombres de archivo
function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Escanea caché y calcula tamaño total + lista de archivos
function getCacheState() {
  const files = fs.readdirSync(CACHE_DIR);
  let total = 0;
  const entries = [];
  for (const f of files) {
    const p = path.join(CACHE_DIR, f);
    try {
      const st = fs.statSync(p);
      if (st.isFile()) {
        total += st.size;
        entries.push({ p, size: st.size, mtime: st.mtimeMs });
      }
    } catch {}
  }
  return { total, entries };
}

// Enforce LRU (borra los más antiguos) si nos pasamos del tope
function enforceCacheBudget() {
  let { total, entries } = getCacheState();
  if (total <= MAX_CACHE_BYTES) return;

  entries.sort((a, b) => a.mtime - b.mtime); // más viejos primero
  for (const e of entries) {
    try {
      fs.unlinkSync(e.p);
      total -= e.size;
      if (total <= MAX_CACHE_BYTES) break;
    } catch {}
  }
}

// Decide si conviene cachear este response
function shouldCache(contentType, contentLength, hasRange) {
  if (hasRange) return false; // no cacheamos respuestas parciales
  if (contentLength && Number(contentLength) > MAX_FILE_BYTES) return false;
  if (!contentType) return false;
  return CT_OK.some((re) => re.test(String(contentType)));
}

// Copia headers “seguros” del origen al cliente
function forwardHeaders(src, res) {
  const passthrough = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "last-modified",
    "etag",
    "cache-control",
  ];
  for (const h of passthrough) {
    const v = src.headers.get(h);
    if (v) res.setHeader(h, v);
  }
}

// Valida y normaliza la URL destino
function parseTargetUrl(req) {
  // Soportamos 2 formas:
  // 1) /proxy/<URL-ENCODED>
  // 2) /proxy?url=<URL>
  let target =
    req.params[0] ||
    req.query.url ||
    (req.path.startsWith("/proxy/") ? decodeURIComponent(req.path.slice(7)) : "");

  if (!target) return { error: "Falta la URL de destino (?url= o /proxy/<url>)" };

  try {
    const u = new URL(target);
    if (FORCE_HTTPS_ONLY && u.protocol !== "https:") {
      return { error: "Solo se permiten URLs https" };
    }
    if (ALLOWED_HOSTS.length) {
      if (!ALLOWED_HOSTS.includes(u.hostname)) {
        return { error: `Host no permitido: ${u.hostname}` };
      }
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return { error: "Protocolo no soportado (solo http/https)" };
    }
    return { url: u.toString() };
  } catch {
    return { error: "URL inválida" };
  }
}

// -------- App -----------
const app = express();
app.set("trust proxy", true);

app.use(
  helmet({
    contentSecurityPolicy: false, // no molestemos a players externos
  })
);
app.use(compression());
if (ENABLE_CORS) app.use(cors());
app.use(morgan("combined"));

// Salud
app.get("/", (req, res) => {
  res.type("text/plain").send(
    [
      "MediaFlow Proxy PRO ✅",
      `Auth: password via ?password=... o header x-api-password`,
      `Cache dir: ${CACHE_DIR} (máx ${MAX_CACHE_GB} GB; archivo ≤ ${MAX_FILE_MB} MB)`,
      `Ejemplo: /proxy?url=https://servidor.com/video.mp4&password=...`,
    ].join("\n")
  );
});

app.get("/healthz", (req, res) => res.json({ ok: true }));

// Auth muy simple
function requireAuth(req, res, next) {
  const pass = req.query.password || req.headers["x-api-password"];
  if (!API_PASSWORD || pass === API_PASSWORD) return next();
  res.status(401).json({ error: "Contraseña inválida" });
}

// HEAD passthrough (útil para players que chequean primero)
app.head("/proxy/*", requireAuth, async (req, res) => {
  const { url, error } = parseTargetUrl(req);
  if (error) return res.status(400).json({ error });

  try {
    const head = await got.head(url, {
      headers: {
        "user-agent": SPOOF_UA,
        range: req.headers.range,
        referer: req.headers.referer,
        origin: req.headers.origin,
        "accept-encoding": req.headers["accept-encoding"],
      },
      timeout: { request: REQ_TIMEOUT_MS },
      retry: { limit: REQ_RETRIES },
      https: { rejectUnauthorized: false },
    });
    forwardHeaders(head, res);
    return res.status(head.statusCode).end();
  } catch (err) {
    return res.status(502).json({ error: "HEAD al origen falló", detail: err.message });
  }
});

// GET principal
app.get(["/proxy/*", "/proxy"], requireAuth, async (req, res) => {
  const { url, error } = parseTargetUrl(req);
  if (error) return res.status(400).json({ error });

  const wantsRange = !!req.headers.range;
  const key = sha256(url);
  const cachePath = path.join(CACHE_DIR, key);

  // Si tenemos el archivo cacheado y NO hay query nocache=1…
  const noCache = req.query.nocache === "1";
  if (!noCache && fs.existsSync(cachePath)) {
    try {
      const st = fs.statSync(cachePath);
      // Soportar Range desde cache
      const total = st.size;
      if (wantsRange) {
        const m = String(req.headers.range).match(/bytes=(\d+)-(\d+)?/);
        if (!m) return res.status(416).end();
        const start = parseInt(m[1], 10);
        const end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (start >= total || end >= total) return res.status(416).end();

        res.status(206);
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", end - start + 1);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        // best-effort para content-type (guardamos un .ct al cachear)
        const ctSidecar = cachePath + ".ct";
        if (fs.existsSync(ctSidecar)) {
          res.setHeader("Content-Type", fs.readFileSync(ctSidecar, "utf8"));
        }

        const rs = fs.createReadStream(cachePath, { start, end });
        return pump(rs, res).catch(() => {});
      } else {
        res.status(200);
        const ctSidecar = cachePath + ".ct";
        if (fs.existsSync(ctSidecar)) {
          res.setHeader("Content-Type", fs.readFileSync(ctSidecar, "utf8"));
        }
        res.setHeader("Content-Length", total);
        const rs = fs.createReadStream(cachePath);
        return pump(rs, res).catch(() => {});
      }
    } catch {
      // si falla, seguimos y reproxeamos
    }
  }

  // No cacheado (o nocache=1) → pedimos al origen
  try {
    const upstream = got.stream(url, {
      headers: {
        "user-agent": SPOOF_UA,
        range: req.headers.range,
        referer: req.headers.referer,
        origin: req.headers.origin,
        "accept-encoding": req.headers["accept-encoding"],
      },
      timeout: { request: REQ_TIMEOUT_MS },
      retry: { limit: REQ_RETRIES },
      https: { rejectUnauthorized: false },
      throwHttpErrors: false, // queremos pasar 4xx/5xx tal cual
    });

    upstream.on("response", async (uRes) => {
      // Encabezados hacia el cliente
      forwardHeaders(uRes, res);
      res.status(uRes.statusCode || 200);

      const ctype = uRes.headers.get
        ? uRes.headers.get("content-type")
        : uRes.headers["content-type"];
      const clen = uRes.headers.get
        ? uRes.headers.get("content-length")
        : uRes.headers["content-length"];

      // ¿Conviene cachear?
      const okToCache = shouldCache(ctype, clen, wantsRange);

      if (okToCache) {
        // Escribimos a .part y renombramos al finalizar (atómico)
        const tmpPath = cachePath + ".part";
        const fileOut = fs.createWriteStream(tmpPath);
        // Guardamos content-type en un sidecar
        if (ctype) {
          try {
            fs.writeFileSync(cachePath + ".ct", String(ctype));
          } catch {}
        }

        // En paralelo, enviamos al cliente y guardamos a disco
        await Promise.all([
          pump(upstream, res).catch(() => {}),
          pump(upstream.clone(), fileOut).catch(() => {}),
        ]).finally(() => {
          // Cerrar y mover a definitivo
          if (fs.existsSync(tmpPath)) {
            try {
              fs.renameSync(tmpPath, cachePath);
              enforceCacheBudget();
            } catch {
              try {
                fs.unlinkSync(tmpPath);
              } catch {}
            }
          }
        });
      } else {
        // Solo proxyeamos al cliente (sin cache)
        await pump(upstream, res).catch(() => {});
      }
    });

    upstream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: "Fallo al obtener el origen", detail: err.message });
      } else {
        res.end();
      }
    });
  } catch (err) {
    return res.status(500).json({ error: "Error en proxy", detail: err.message });
  }
});

// 404 claro
app.use((req, res) => res.status(404).json({ error: "No encontrado" }));

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en http://localhost:${PORT}`);
  console.log(`📦 Cache en: ${CACHE_DIR} (máx ${MAX_CACHE_GB} GB)`);
});
