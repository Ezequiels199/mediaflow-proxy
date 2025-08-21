// src/index.js
import express from "express";
import compression from "compression";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import NodeCache from "node-cache";

const pipe = promisify(pipeline);

// CONFIG (desde env)
const PORT = process.env.PORT ?? 3000;
const API_PASSWORD = process.env.API_PASSWORD ?? "8080"; // poné 8080 en Render ENV si esa es tu clave
const CACHE_DIR = process.env.CACHE_DIR ?? path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT ?? 20 * 1024 * 1024 * 1024); // 20 GB por defecto
const MAX_CACHE_FILE_SIZE = Number(process.env.MAX_CACHE_FILE_SIZE ?? 50 * 1024 * 1024); // <=50MB solo cachearemos
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 30000);

// Aseguramos carpeta de cache
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// In-memory cache para respuestas pequeñas (headers+body)
const memoryCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 });

const app = express();
app.use(compression());

// simple health
app.get("/", (req, res) => {
  res.type("text").send("MediaFlow Proxy PRO (Node 22). Usa /proxy?url=...&password=...");
});

// Middleware de auth (para /proxy)
function checkAuth(req, res, next) {
  const pass = (req.query.password || req.query.api_password || req.headers["x-api-password"] || "").toString();
  if (!pass || pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
}

// helper: calcula uso disco
function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let total = 0;
  const list = files.map((f) => {
    const p = path.join(CACHE_DIR, f);
    const s = fs.statSync(p);
    total += s.size;
    return { p, size: s.size, mtime: s.mtimeMs };
  });
  return { total, list };
}

function enforceDiskLimit() {
  const { total, list } = getDiskUsage();
  if (total <= DISK_CACHE_LIMIT) return;
  // elimina archivos más viejos primero
  const sorted = list.sort((a, b) => a.mtime - b.mtime);
  let remaining = total;
  for (const f of sorted) {
    try {
      fs.unlinkSync(f.p);
      remaining -= f.size;
      if (remaining <= DISK_CACHE_LIMIT) break;
    } catch (e) {
      console.warn("Error borrando cache:", e.message);
    }
  }
  console.log("Cache en disco ajustada. Uso actual:", remaining);
}

// util: copia headers excepto hop-by-hop
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function copyHeaders(target, src) {
  for (const [k, v] of Object.entries(src || {})) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    target[key] = v;
  }
}

// Proxy endpoint: soporta /proxy?url=... y /proxy/https://...
app.get("/proxy", checkAuth, async (req, res) => {
  const rawUrl = req.query.url;
  return handleProxyRequest(rawUrl, req, res);
});
app.get("/proxy/*", checkAuth, async (req, res) => {
  const tail = req.params[0];
  return handleProxyRequest(tail, req, res);
});

async function handleProxyRequest(rawUrl, req, res) {
  try {
    if (!rawUrl) return res.status(400).json({ error: "Falta la URL destino (usa ?url=... o /proxy/https://...)" });

    // decode
    const targetUrl = decodeURIComponent(rawUrl);
    // validación básica
    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch (e) {
      return res.status(400).json({ error: "URL inválida" });
    }

    // KEY para cache (por ahora: target + range)
    const cacheKey = `${targetUrl}:${req.headers.range ?? ""}`;

    // 1) RAM cache
    const mem = memoryCache.get(cacheKey);
    if (mem) {
      console.log("Servido desde RAM cache:", targetUrl);
      copyHeaders(res.getHeaders ? res.getHeaders() : {}, mem.headers);
      res.writeHead(200, mem.headers);
      return res.end(mem.body);
    }

    // 2) Disco cache
    const fileSafeName = Buffer.from(targetUrl).toString("base64url");
    const filePath = path.join(CACHE_DIR, fileSafeName);
    if (fs.existsSync(filePath)) {
      console.log("Servido desde disco cache:", filePath);
      const stat = fs.statSync(filePath);
      res.setHeader("Content-Length", stat.size.toString());
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Accept-Ranges", "bytes");
      const streamRead = fs.createReadStream(filePath);
      return pipe(streamRead, res);
    }

    // 3) Fetch directo al origen (stream)
    console.log("Descargando origen:", targetUrl);

    // Build headers: forward algunos headers importantes
    const forwarded = {};
    const want = ["user-agent", "referer", "accept", "range", "cookie"];
    for (const h of want) {
      if (req.headers[h]) forwarded[h] = req.headers[h];
    }

    // reintentos simples
    const maxRetries = 2;
    let attempt = 0;
    let fetchResp = null;
    let lastErr = null;

    while (attempt < maxRetries) {
      attempt++;
      try {
        // timeout
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

        fetchResp = await fetch(urlObj.toString(), {
          method: "GET",
          headers: forwarded,
          redirect: "follow",
          signal: controller.signal,
        });

        clearTimeout(to);
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`Intento ${attempt} falló:`, e && e.message ? e.message : e);
        // si abort, sigue a reintento
        if (attempt >= maxRetries) {
          return res.status(502).json({ error: "Error al obtener origen", detail: e?.message ?? "fetch failed" });
        }
      }
    }

    if (!fetchResp) {
      return res.status(502).json({ error: "No se obtuvo respuesta del origen" });
    }

    // Si origen responde error, reenvía el estado y mensaje corto
    if (fetchResp.status >= 400) {
      const text = await fetchResp.text().then(t => t.slice(0, 800)).catch(()=>"");
      return res.status(fetchResp.status).json({ error: "Error desde origen", status: fetchResp.status, body: text });
    }

    // Copiar headers de respuesta (evitando hop-by-hop)
    const outHeaders = {};
    fetchResp.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    });
    // algunos headers que queremos asegurar
    if (fetchResp.headers.get("accept-ranges")) outHeaders["accept-ranges"] = fetchResp.headers.get("accept-ranges");

    // Si el recurso es pequeño (content-length <= MAX_CACHE_FILE_SIZE) lo cacheamos en disco + RAM
    const contentLen = Number(fetchResp.headers.get("content-length") ?? 0);
    const shouldCache = contentLen > 0 && contentLen <= MAX_CACHE_FILE_SIZE;

    // Si vamos a cachear, hacemos un tee: escribimos a archivo y enviamos a cliente
    if (shouldCache) {
      const tmpPath = filePath + ".tmp";
      const fileStream = fs.createWriteStream(tmpPath);

      // reenvío de headers al cliente
      res.writeHead(200, outHeaders);

      try {
        // duplicado de stream: usamos pipeline [resp.body -> PassThrough] -> res y -> file
        // la forma más simple: pipe response body a archivo y a res con pipeline secuencial (no es un tee perfecto
        // pero para streams pequeños funciona bien). Mejor: usar stream.PassThrough duplicando.
        const { PassThrough } = await import("stream");
        const pass = new PassThrough();

        // escritura a disco
        const p1 = pipe(fetchResp.body, pass);
        // lectura para cliente y archivo
        const passToFile = pipe(pass.pipe(new PassThrough()), fileStream); // copia a archivo
        // la otra copia a cliente: crear otro PassThrough
        // re-fetching: la forma robusta es duplicar con tee. Implementamos con 2 piping desde la misma fuente:
        // Node streams no se pueden piped twice; manejamos con un nuevo pipeline: fuente->PassThrough y dos consumidores de ese PassThrough
        // En la práctica, hacerlo así:
        const pass2 = new PassThrough();
        fetchResp.body.pipe(pass2);
        // cliente
        pass2.pipe(res);

        // file (segunda copia)
        const pass3 = new PassThrough();
        fetchResp.body.pipe(pass3);
        pass3.pipe(fileStream);

        // NOTE: aunque hacemos 3 pipes, la ideal sería usar stream.pipeline + tee. Este bloque intenta cachear para archivos pequeños.
      } catch (err) {
        console.warn("Error escribiendo cache en disco:", err.message);
      }

      // Guardar en memoria (se hará después) - para evitar complejidad, no bloqueamos aquí.
      // Finalmente aplicamos límite de disco
      try { enforceDiskLimit(); } catch(e) {}
      return; // ya enviamos la respuesta
    }

    // Si no vamos a cachear: pipe directo (sin buffer)
    // reenvío de headers
    res.writeHead(fetchResp.status, outHeaders);
    // stream directo
    try {
      await pipe(fetchResp.body, res);
    } catch (err) {
      console.warn("Error piping a cliente:", err && err.message ? err.message : err);
      // Si el pipe falla porque el cliente cierra la conexión, no quebramos todo
    }

    return;
  } catch (err) {
    console.error("Error en proxy:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Error interno en proxy" });
  }
}

// start
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD set? ${!!process.env.API_PASSWORD})`);
});
