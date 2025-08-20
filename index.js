/**
 * mediaflow-proxy - index.js
 * Recomendado para Node >=18 (usa global fetch si existe, sino undici)
 */

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";
import mime from "mime-types";

const PORT = parseInt(process.env.PORT || "3000", 10);
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = parseInt(process.env.DISK_CACHE_LIMIT || String(20 * 1024 * 1024 * 1024), 10); // 20GB por defecto
const MEMORY_CACHE_MAX_BYTES = parseInt(process.env.MEMORY_CACHE_MAX_BYTES || String(1 * 1024 * 1024), 10); // 1MB
const MAX_CONCURRENT_DOWNLOADS = parseInt(process.env.MAX_CONCURRENT_DOWNLOADS || "4", 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.FETCH_TIMEOUT_MS || "120000", 10); // 120s

// fetch polifill si es necesario
const fetchFn = globalThis.fetch ?? (await import("undici")).fetch;

// crear carpeta cache si falta
if (!fs.existsSync(CACHE_DIR)) await fsp.mkdir(CACHE_DIR, { recursive: true });

// memoria (solo para pequeños)
const memoryCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 });

// semáforo simple para limitar concurrencia de descargas
let currentDownloads = 0;
const waitForDownloadSlot = async () => {
  while (currentDownloads >= MAX_CONCURRENT_DOWNLOADS) await new Promise((r) => setTimeout(r, 150));
  currentDownloads++;
};
const releaseDownloadSlot = () => { if (currentDownloads > 0) currentDownloads--; };

// util: safe filename (base64 URL-safe)
function safeFileName(url) {
  const b64 = Buffer.from(url).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".cache";
}

async function getDiskUsage() {
  const entries = await fsp.readdir(CACHE_DIR);
  let total = 0;
  const list = [];
  for (const file of entries) {
    try {
      const fp = path.join(CACHE_DIR, file);
      const st = await fsp.stat(fp);
      list.push({ file, path: fp, size: st.size, mtime: st.mtimeMs });
      total += st.size;
    } catch (e) {
      // skip
    }
  }
  return { total, list };
}

async function enforceDiskLimit() {
  const { total, list } = await getDiskUsage();
  if (total <= DISK_CACHE_LIMIT) return;
  const sorted = list.sort((a, b) => a.mtime - b.mtime);
  let t = total;
  for (const item of sorted) {
    try {
      await fsp.unlink(item.path);
      t -= item.size;
      if (t <= DISK_CACHE_LIMIT) break;
    } catch (e) {
      console.warn("No se pudo borrar cache:", item.path, e?.message || e);
    }
  }
}

// helper para validar URL
function validateTargetUrl(u) {
  try {
    const url = new URL(u);
    if (!["http:", "https:"].includes(url.protocol)) return false;
    return true;
  } catch {
    return false;
  }
}

// headers a forwardear
const FORWARD_HEADERS = ["content-type", "content-length", "accept-ranges", "content-range", "cache-control", "etag", "last-modified"];

// start app
const app = express();
app.use(compression());

// auth middleware para /proxy
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  next();
});

// health
app.get("/", (req, res) => res.send("mediaflow-proxy OK"));

// main proxy route (soporta GET y HEAD para chequear)
app.get("/proxy/*", async (req, res) => {
  let target = req.params[0];
  try {
    if (!target) return res.status(400).json({ error: "Falta la URL de destino" });
    // si vienen encoded slashes, aceptar
    target = decodeURIComponent(target);

    if (!validateTargetUrl(target)) return res.status(400).json({ error: "URL inválida o protocolo no permitido" });

    const cachePath = path.join(CACHE_DIR, safeFileName(target));
    const tmpPath = cachePath + ".tmp";

    const clientRange = req.headers.range;

    // permitir bypass de cache ?cache=0
    const bypassCache = req.query.cache === "0";

    // Opcional: override headers (referer/ua/cookie) desde query
    const extraReferer = req.query.referer;
    const extraUA = req.query.ua;
    const extraCookie = req.query.cookie;

    // 1) Si no hay Range y existe en memoria => servir
    if (!clientRange && !bypassCache && memoryCache.has(target)) {
      const cached = memoryCache.get(target);
      Object.entries(cached.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      return res.status(200).end(cached.body);
    }

    // 2) Si no hay Range y existe en disco => stream directo
    if (!clientRange && !bypassCache && fs.existsSync(cachePath)) {
      const st = await fsp.stat(cachePath);
      const headers = {
        "content-length": st.size,
        "accept-ranges": "bytes",
        "access-control-allow-origin": "*"
      };
      // intentar sacar content-type del nombre o dejar que el cliente infiera
      const ext = path.extname(target).split("?")[0];
      const ct = mime.lookup(ext) || "application/octet-stream";
      headers["content-type"] = ct;
      res.writeHead(200, headers);
      const rs = fs.createReadStream(cachePath);
      try {
        await pipeline(rs, res);
      } catch (e) {
        console.error("Error al servir cache disco:", e?.message || e);
      }
      return;
    }

    // 3) No cache o Range: traer del upstream con streaming
    // controlar concurrencia
    await waitForDownloadSlot();

    const upstreamHeaders = {};
    if (clientRange) upstreamHeaders["range"] = clientRange;
    // forward basic client headers
    ["accept", "accept-language", "user-agent", "referer"].forEach((h) => {
      if (req.headers[h] && !upstreamHeaders[h]) upstreamHeaders[h] = req.headers[h];
    });
    if (extraReferer) upstreamHeaders["referer"] = extraReferer;
    if (extraUA) upstreamHeaders["user-agent"] = extraUA;
    if (extraCookie) upstreamHeaders["cookie"] = extraCookie;

    // timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetchFn(target, { method: "GET", headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
    } catch (e) {
      clearTimeout(timeout);
      releaseDownloadSlot();
      console.error("Fetch fallo:", e?.message || e);
      return res.status(502).json({ error: "Error al conectar con el origen", detail: String(e?.message || e) });
    }
    clearTimeout(timeout);

    // preparar headers de salida
    const out = {};
    FORWARD_HEADERS.forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) out[h] = v;
    });
    out["access-control-allow-origin"] = "*";

    // si upstream responde con 4xx/5xx (excepto 200 y 206)
    if (![200, 206].includes(upstream.status) && upstream.status >= 400) {
      const txt = await upstream.text().catch(() => "");
      releaseDownloadSlot();
      return res.status(upstream.status).send(txt || { error: "Origen devolvió error", status: upstream.status });
    }

    // escribir headers y comenzar streaming
    res.writeHead(upstream.status, out);

    // si podemos cachear en disco: (solo cuando no hay range y status 200 y tamaño razonable)
    const contentLengthHeader = upstream.headers.get("content-length");
    const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : NaN;
    const canCacheToDisk = !clientRange && upstream.status === 200 && !isNaN(contentLength) && contentLength > 0 && contentLength < (DISK_CACHE_LIMIT * 0.9);

    if (canCacheToDisk && !bypassCache) {
      // stream directo al cliente y al archivo tmp
      const ws = fs.createWriteStream(tmpPath, { flags: "wx" }).on("error", (e) => {
        // si existe o hay problema, loguear y continuar sin cache
        if (e.code !== "EEXIST") console.warn("Error creando tmp:", e?.message || e);
      });
      const tee = new PassThrough();
      upstream.body.pipe(tee);
      tee.pipe(res);
      tee.pipe(ws);

      // cuando termine la descarga, renombrar tmp -> cache
      ws.on("finish", async () => {
        try {
          await fsp.rename(tmpPath, cachePath);
          await enforceDiskLimit();
          // si el archivo es pequeño, guardar en memoria
          if (!isNaN(contentLength) && contentLength <= MEMORY_CACHE_MAX_BYTES) {
            try {
              const buf = await fsp.readFile(cachePath);
              const smallHeaders = {};
              FORWARD_HEADERS.forEach((h) => {
                const v = upstream.headers.get(h);
                if (v) smallHeaders[h] = v;
              });
              memoryCache.set(target, { headers: smallHeaders, body: buf });
            } catch (e) { /* no crítico */ }
          }
        } catch (e) {
          console.warn("No se pudo renombrar tmp -> cache:", e?.message || e);
          try { await fsp.unlink(tmpPath); } catch {}
        }
      });

      // errores
      upstream.body.on("error", (e) => {
        console.error("Error en upstream stream:", e?.message || e);
        try { tee.destroy(); } catch {}
      });
      res.on("close", () => {
        try { tee.destroy(); } catch {}
      });

      // liberar slot cuando termine respuesta
      res.on("finish", () => releaseDownloadSlot());
      res.on("error", () => releaseDownloadSlot());
      return;
    } else {
      // no cachear a disco: pipe directo upstream -> cliente
      try {
        await pipeline(upstream.body, res);
      } catch (e) {
        console.error("Error en piping:", e?.message || e);
      } finally {
        releaseDownloadSlot();
      }
      return;
    }
  } catch (err) {
    console.error("Error general /proxy:", err?.message || err);
    if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy" });
  }
});

// start server
app.listen(PORT, () => {
  console.log(`🚀 mediaflow-proxy escuchando en :${PORT}`);
});
