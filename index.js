/**
 * index.js - MediaFlow Proxy (versión pro, lista para producción básica)
 *
 * Requisitos: Node >=18
 * Dependencias: express, compression, node-cache, mime-types, undici (si no hay fetch global)
 *
 * Características principales:
 * - Soporte completo de Range (206 Partial Content)
 * - Streaming en vivo: upstream -> cliente (PassThrough) y simultáneamente escribe a .tmp -> .cache
 * - No concatena cuerpos grandes en RAM (evita OOM)
 * - Caché en RAM solo para archivos pequeños (configurable)
 * - Límite de disco con limpieza FIFO (configurable)
 * - Control sencillo de concurrencia de descargas
 * - Reenvío de headers útiles (User-Agent, Referer, Cookie) y posibilidad de override via query
 * - Rutas: /proxy (usar ?url=...), /proxy/ip (validación), /health, / (mensaje)
 * - Autenticación por API_PASSWORD (env var)
 *
 * Nota: Este proxy **no** sortea protecciones (captchas, tokens firmados o DRM). Para hosts que exigen tokens/JS,
 * hace falta un "resolver" específico que obtenga la URL real de forma legítima.
 */

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { PassThrough } from "stream";
import { pipeline } from "stream/promises";
import mime from "mime-types";

// fetch polifill: usa global fetch si existe, sino undici
let fetchFn = globalThis.fetch;
if (!fetchFn) {
  try {
    // dynamic import para no romper si undici no está instalado (pero recomendamos instalarlo)
    const mod = await import("undici");
    fetchFn = mod.fetch;
  } catch (e) {
    console.warn("Aviso: undici no disponible y global fetch no existe. Instalar 'undici' o usar Node >=18.");
    fetchFn = globalThis.fetch; // puede ser undefined -> fallará más adelante si no hay fetch
  }
}

// ---------- CONFIG ----------
const PORT = Number(process.env.PORT || 3000);
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

const CACHE_DIR = path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT || 20 * 1024 * 1024 * 1024); // 20 GB
const MEMORY_CACHE_MAX_BYTES = Number(process.env.MEMORY_CACHE_MAX_BYTES || 2 * 1024 * 1024); // 2 MB
const MEMORY_TTL_SEC = Number(process.env.MEMORY_TTL_SEC || 60 * 60 * 6); // 6 horas
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 120000); // 120s
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 6);

// ---------- PREP ----------
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const memoryCache = new NodeCache({ stdTTL: MEMORY_TTL_SEC, checkperiod: 120 });

// semáforo simple para concurrencia
let currentDownloads = 0;
const waitForSlot = async () => {
  while (currentDownloads >= MAX_CONCURRENT_DOWNLOADS) await new Promise((r) => setTimeout(r, 100));
  currentDownloads++;
};
const releaseSlot = () => { if (currentDownloads > 0) currentDownloads--; };

// ---------- HELPERS ----------
const safeName = (url) =>
  Buffer.from(url).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") + ".cache";

async function getDiskFiles() {
  try {
    const entries = await fsp.readdir(CACHE_DIR);
    const list = [];
    let total = 0;
    for (const e of entries) {
      try {
        const fp = path.join(CACHE_DIR, e);
        const st = await fsp.stat(fp);
        if (!st.isFile()) continue;
        list.push({ file: e, path: fp, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch {}
    }
    return { total, list };
  } catch {
    return { total: 0, list: [] };
  }
}

async function enforceDiskLimit() {
  try {
    const { total, list } = await getDiskFiles();
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
  } catch (e) {
    console.error("enforceDiskLimit error:", e?.message || e);
  }
}

function validHttpUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// recibe req y trata de resolver la URL objetivo
function resolveTargetUrl(req) {
  // prioridad: ?url=   (recomendado)
  if (req.query && (req.query.url || req.query.target || req.query.u)) {
    return String(req.query.url || req.query.target || req.query.u);
  }
  // si vinieron en path (/proxy/<encoded-url>)
  const suffix = (req.path || "").replace(/^\/proxy\/?/, "");
  if (suffix) {
    try {
      const dec = decodeURIComponent(suffix);
      if (validHttpUrl(dec)) return dec;
    } catch {}
    if (validHttpUrl(suffix)) return suffix;
  }
  return null;
}

// cabeceras que copiar al cliente (si existen)
const FORWARD_HEADERS = ["content-type", "content-length", "accept-ranges", "content-range", "cache-control", "last-modified", "etag"];

// ---------- APP ----------
const app = express();
app.use(compression({
  level: 6,
  filter(req, res) {
    // no comprimir endpoints de streaming
    if (req.path === "/proxy" || req.path.startsWith("/proxy")) return false;
    return compression.filter(req, res);
  }
}));

// root / health
app.get("/", (_req, res) => {
  res.type("text/plain").send("🚀 MediaFlow Proxy activo. /health /proxy?url=... & api_password=...");
});
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// auth middleware para /proxy
function getPass(req) {
  return req.query.api_password || req.query.password || req.headers["x-api-password"];
}
app.use("/proxy", (req, res, next) => {
  const p = getPass(req);
  if (p !== API_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MediaFlow"');
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// proxy IP validator (MediaFusion)
app.get("/proxy/ip", (req, res) => {
  const p = getPass(req);
  if (p !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  res.json({ ok: true, ip, service: "MediaFlow Proxy" });
});

// MAIN: /proxy endpoint (usa ?url= preferido)
app.get("/proxy", async (req, res) => {
  const target = resolveTargetUrl(req);
  if (!target) return res.status(400).json({ error: "Falta la URL de destino (?url=...)" });
  if (!validHttpUrl(target)) return res.status(400).json({ error: "URL inválida" });

  const cacheFile = path.join(CACHE_DIR, safeName(target));
  const tmpFile = cacheFile + ".tmp";
  const rangeHeader = req.headers.range;
  const overrideReferer = req.query.referer;
  const overrideUA = req.query.ua;
  const overrideCookie = req.query.cookie;

  // 1) Si no hay range y está en RAM -> servir
  if (!rangeHeader && memoryCache.has(target)) {
    const cached = memoryCache.get(target);
    res.writeHead(200, cached.headers);
    return res.end(cached.body);
  }

  // 2) Si no hay range y archivo en disco -> stream desde disco (soporta range desde fs)
  if (!rangeHeader && fs.existsSync(cacheFile)) {
    try {
      const st = await fsp.stat(cacheFile);
      const fileSize = st.size;

      // headers básicos
      const headers = {
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*"
      };
      const ext = path.extname(target).split("?")[0];
      headers["Content-Type"] = mime.lookup(ext) || "application/octet-stream";

      res.writeHead(200, headers);
      const rs = fs.createReadStream(cacheFile);
      return pipeline(rs, res).catch((e) => {
        console.error("Error piping cached file:", e?.message || e);
      });
    } catch (e) {
      console.warn("Error sirviendo cache disco:", e?.message || e);
      // continuar para intentar upstream
    }
  }

  // 3) Si client solicita Range -> reenvío directo al upstream (no cacheamos partials)
  if (rangeHeader) {
    // crear headers para upstream (forward básico + overrides)
    const upstreamHeaders = {};
    upstreamHeaders.Range = rangeHeader;
    if (req.headers["user-agent"]) upstreamHeaders["User-Agent"] = req.headers["user-agent"];
    if (req.headers["referer"]) upstreamHeaders["Referer"] = req.headers["referer"];
    if (overrideReferer) upstreamHeaders["Referer"] = overrideReferer;
    if (overrideUA) upstreamHeaders["User-Agent"] = overrideUA;
    if (overrideCookie) upstreamHeaders["Cookie"] = overrideCookie;

    // timeout + fetch
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchFn(target, { method: "GET", headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
    } catch (e) {
      clearTimeout(to);
      console.error("Fetch Range error:", e?.message || e);
      return res.status(502).json({ error: "Error conectando con origen (Range)" });
    }
    clearTimeout(to);

    // forward status + headers (except content-encoding)
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-encoding") return;
      res.setHeader(k, v);
    });

    if (!upstream.body) return res.status(502).json({ error: "Origen no envió body" });
    return pipeline(upstream.body, res).catch((e) => {
      console.error("Error piping upstream Range:", e?.message || e);
    });
  }

  // 4) No range y no cache: hacemos streaming upstream -> cliente y tee a disco (.tmp -> rename)
  await waitForSlot();
  const upstreamHeaders = {};
  if (req.headers["user-agent"]) upstreamHeaders["User-Agent"] = req.headers["user-agent"];
  if (req.headers["referer"]) upstreamHeaders["Referer"] = req.headers["referer"];
  if (overrideReferer) upstreamHeaders["Referer"] = overrideReferer;
  if (overrideUA) upstreamHeaders["User-Agent"] = overrideUA;
  if (overrideCookie) upstreamHeaders["Cookie"] = overrideCookie;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetchFn(target, { method: "GET", headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timeoutId);
    releaseSlot();
    console.error("Fetch upstream error:", e?.message || e);
    return res.status(502).json({ error: "Error conectando con origen" });
  }
  clearTimeout(timeoutId);

  if (!upstream || (upstream.status >= 400 && upstream.status !== 200 && upstream.status !== 206)) {
    releaseSlot();
    const txt = upstream ? await upstream.text().catch(() => "") : "";
    return res.status(upstream ? upstream.status : 502).send(txt || { error: "Origen devolvió error" });
  }

  // forward headers (menos content-encoding)
  upstream.headers.forEach((v, k) => {
    if (k.toLowerCase() === "content-encoding") return;
    res.setHeader(k, v);
  });
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(upstream.status);

  const pass = new PassThrough();
  const ws = fs.createWriteStream(tmpFile, { flags: "w" });

  let hadError = false;
  const cleanupTmp = async () => {
    try { ws.destroy(); } catch {}
    try { if (fs.existsSync(tmpFile)) await fsp.unlink(tmpFile); } catch {}
  };

  upstream.body.on("error", (e) => {
    hadError = true;
    console.error("Upstream stream error:", e?.message || e);
    cleanupTmp();
  });
  ws.on("error", (e) => {
    hadError = true;
    console.error("WriteStream error:", e?.message || e);
    cleanupTmp();
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      hadError = true;
      try { pass.destroy(); } catch {}
      cleanupTmp();
    }
  });

  // tee: upstream -> pass -> [res, ws]
  upstream.body.pipe(pass);
  pass.pipe(res);
  pass.pipe(ws);

  // cuando termina escritura: rename tmp -> cache y opcional memcache
  ws.on("finish", async () => {
    if (hadError) { await cleanupTmp(); releaseSlot(); return; }
    try {
      await fsp.rename(tmpFile, cacheFile);
      // si archivo pequeño, cache en RAM
      try {
        const st = await fsp.stat(cacheFile);
        if (st.size > 0 && st.size <= MEMORY_CACHE_MAX_BYTES) {
          const buf = await fsp.readFile(cacheFile);
          const ct = upstream.headers.get("content-type") || mime.lookup(path.extname(target)) || "application/octet-stream";
          memoryCache.set(target, { headers: { "content-type": ct }, body: buf });
        }
      } catch (e) { /* no crítico */ }
      // enforce disk limit de forma asíncrona
      setImmediate(() => enforceDiskLimit());
    } catch (e) {
      console.error("Error finalizando cache:", e?.message || e);
      try { await cleanupTmp(); } catch {}
    } finally {
      releaseSlot();
    }
  });

  // liberar slot si la conexión termina antes de finish
  res.on("finish", () => releaseSlot());
  res.on("error", () => releaseSlot());

  // streaming en progreso
  return;
});

// Legacy: si alguien usa /proxy/<url> (path form), redirigir a ?url=
app.get("/proxy/*", (req, res) => {
  const trailing = req.path.replace(/^\/proxy\/?/, "");
  if (!trailing) return res.status(400).json({ error: "Falta URL" });
  try {
    let maybe = decodeURIComponent(trailing);
    if (!/^https?:\/\//i.test(maybe)) maybe = trailing;
    if (/^https?:\/\//i.test(maybe)) {
      const redirectTo = `/proxy?url=${encodeURIComponent(maybe)}&api_password=${encodeURIComponent(req.query.api_password || req.query.password || "")}`;
      return res.redirect(302, redirectTo);
    }
  } catch (e) {}
  return res.status(400).json({ error: "URL inválida en path. Use ?url=" });
});

// arrancar
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOSET - usa env var"})`);
});
