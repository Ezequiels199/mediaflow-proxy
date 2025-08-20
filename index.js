// index.js - MediaFlow Proxy (robusto, streaming real, Range, headers tipo navegador)
// Node >=18 recomendado.
// CommonJS para máxima compatibilidad en Render.

const express = require("express");
const compression = require("compression");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const { pipeline, Readable, PassThrough } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
const { URL } = require("url");

const app = express();
const PORT = Number(process.env.PORT || 3000);

// ---------------- CONFIGURACIÓN (ENV friendly) ----------------
const API_PASSWORD = process.env.API_PASSWORD || "superclave123"; // poné esto en ENV en producción
const ENABLE_DISK_CACHE = (process.env.ENABLE_DISK_CACHE || "false").toLowerCase() === "true"; // por defecto false
const DISK_CACHE_DIR = path.join(process.cwd(), process.env.DISK_CACHE_DIR || "disk_cache");
const DISK_CACHE_MAX_FILE = Number(process.env.DISK_CACHE_MAX_FILE || String(200 * 1024 * 1024)); // 200MB por archivo
const DISK_CACHE_TOTAL_LIMIT = Number(process.env.DISK_CACHE_TOTAL_LIMIT || String(5 * 1024 * 1024 * 1024)); // 5GB total
const RAM_CACHE_MAX_BYTES = Number(process.env.RAM_CACHE_MAX_BYTES || String(5 * 1024 * 1024)); // 5MB archivo para caché RAM
const RAM_CACHE_TTL = Number(process.env.RAM_CACHE_TTL || String(60 * 60 * 6)); // 6h
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || String(120000)); // 120s

// crear carpeta cache disco si está habilitada
if (ENABLE_DISK_CACHE && !fs.existsSync(DISK_CACHE_DIR)) {
  fs.mkdirSync(DISK_CACHE_DIR, { recursive: true });
}

// caché en memoria
const memoryCache = new NodeCache({ stdTTL: RAM_CACHE_TTL, checkperiod: 120 });

// ---------------- helpers ----------------
function base64url(s) {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function cacheFilePathFor(url) {
  return path.join(DISK_CACHE_DIR, base64url(url) + ".cache");
}
function tmpFilePathFor(url) {
  return cacheFilePathFor(url) + ".tmp";
}
function diskUsage() {
  try {
    const files = fs.readdirSync(DISK_CACHE_DIR || ".").filter(f => f.endsWith(".cache"));
    let total = 0;
    const list = files.map(f => {
      const p = path.join(DISK_CACHE_DIR, f);
      const st = fs.statSync(p);
      total += st.size;
      return { file: f, path: p, size: st.size, mtime: st.mtimeMs };
    });
    return { total, list };
  } catch (e) {
    return { total: 0, list: [] };
  }
}
function enforceDiskLimit() {
  try {
    if (!ENABLE_DISK_CACHE) return;
    const { total, list } = diskUsage();
    if (total <= DISK_CACHE_TOTAL_LIMIT) return;
    list.sort((a,b) => a.mtime - b.mtime);
    let cur = total;
    for (const item of list) {
      try { fs.unlinkSync(item.path); cur -= item.size; } catch(e){ /* noop */ }
      if (cur <= DISK_CACHE_TOTAL_LIMIT) break;
    }
  } catch (e) {
    console.warn("enforceDiskLimit:", e && e.message ? e.message : e);
  }
}
function isValidHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; } catch { return false; }
}
function isWhatwgReadable(streamLike) {
  return !!(streamLike && typeof streamLike.getReader === "function");
}
function nodeReadableFrom(streamLike) {
  // si es Node stream, devolver tal cual
  if (streamLike && typeof streamLike.pipe === "function") return streamLike;
  // si es WHATWG ReadableStream -> Readable.fromWeb
  try {
    if (Readable && typeof Readable.fromWeb === "function" && isWhatwgReadable(streamLike)) {
      return Readable.fromWeb(streamLike);
    }
  } catch (e) {
    // fallback: try Readable.from on iterable
  }
  // fallback generic
  try { return Readable.from(streamLike); } catch (e) { throw new Error("No se pudo convertir a Node Readable"); }
}

// headers "navegador" por defecto para evitar 403
function defaultBrowserHeaders(targetUrl) {
  const referer = (() => {
    try { return new URL(targetUrl).origin; } catch { return undefined; }
  })();
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    ...(referer ? { "Referer": referer, "Origin": referer } : {})
  };
}

// timeout helper usando AbortController
function fetchWithTimeout(url, opts = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), timeoutMs);
  const signal = ac.signal;
  const merged = Object.assign({}, opts, { signal });
  return (async () => {
    try {
      const r = await fetch(url, merged);
      clearTimeout(id);
      return r;
    } catch (e) {
      clearTimeout(id);
      throw e;
    }
  })();
}

// comprueba si el cliente cerró conexión
function onClientAbort(req, cleanup) {
  const cb = () => {
    try { cleanup(); } catch(e) {}
  };
  req.on("close", cb);
  req.on("aborted", cb);
  // devuelve función para remover listeners
  return () => { try { req.off("close", cb); req.off("aborted", cb); } catch(e){} };
}

// ---------------- middlewares ----------------
app.use(compression());

// auth para /proxy (query=password o api_password, o header x-api-password)
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (!API_PASSWORD) {
    console.warn("⚠️ API_PASSWORD no seteada en env - usando fallback (no recomendado)");
  }
  if (pass !== API_PASSWORD) {
    res.status(401).json({ error: "Contraseña inválida" });
    return;
  }
  next();
});

// ruta principal: soporta /proxy?url=... o /proxy/<url_encoded>
app.get(["/proxy", "/proxy/*"], async (req, res) => {
  try {
    // resolver target
    let target = req.query.url || req.query.u || (req.params && req.params[0]);
    if (!target) return res.status(400).json({ error: "Falta parámetro url. Ej: /proxy?url=https://..." });

    try { target = decodeURIComponent(target); } catch(e) { /* ignore */ }
    if (!isValidHttpUrl(target)) return res.status(400).json({ error: "URL inválida" });

    console.log(`[proxy] peticion: ${target}  range:${!!req.headers.range}`);

    // CACHE RAM quick path (solo sin Range)
    if (!req.headers.range && memoryCache.has(target)) {
      const cached = memoryCache.get(target);
      console.log("[proxy] sirviendo desde RAM cache:", target);
      for (const [k,v] of Object.entries(cached.headers || {})) {
        try { res.setHeader(k, v); } catch(e) {}
      }
      res.status(cached.status || 200).end(cached.body);
      return;
    }

    // DISK cache quick path (solo si habilitado y sin Range)
    const cPath = cacheFilePathFor(target);
    if (ENABLE_DISK_CACHE && !req.headers.range && fs.existsSync(cPath)) {
      console.log("[proxy] sirviendo desde DISCO cache:", target);
      const st = fs.statSync(cPath);
      res.setHeader("Content-Length", String(st.size));
      res.setHeader("Accept-Ranges", "bytes");
      // intentamos adivinar content-type por extensión simple
      const ext = target.split(".").pop().split(/\?|#/)[0].toLowerCase();
      if (ext === "m3u8") res.setHeader("Content-Type","application/vnd.apple.mpegurl");
      else if (ext === "ts") res.setHeader("Content-Type","video/MP2T");
      else if (ext === "mp4") res.setHeader("Content-Type","video/mp4");
      const rs = fs.createReadStream(cPath);
      return streamPipeline(rs, res).catch(e => { console.warn("error disco->cliente:", e && e.message); });
    }

    // Si piden Range y hay cache en disco => serve partial
    if (ENABLE_DISK_CACHE && req.headers.range && fs.existsSync(cPath)) {
      const st = fs.statSync(cPath);
      const total = st.size;
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (!m) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
        return;
      }
      const start = m[1] ? parseInt(m[1],10) : 0;
      const end = m[2] ? parseInt(m[2],10) : total - 1;
      if (start >= total) {
        res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
        return;
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", String(end - start + 1));
      const rs = fs.createReadStream(cPath, { start, end });
      return streamPipeline(rs, res).catch(e=>{ console.warn("error partial disk->client", e && e.message); });
    }

    // ------------------------------------------------------------
    // FETCH al upstream con headers "navegador" por defecto y Range si viene
    // ------------------------------------------------------------
    const upstreamHeaders = Object.assign({}, defaultBrowserHeaders(target));
    // Forward algunos headers basicos del cliente si vienen (no host)
    if (req.headers["user-agent"]) upstreamHeaders["User-Agent"] = req.headers["user-agent"];
    if (req.headers["accept"]) upstreamHeaders["Accept"] = req.headers["accept"];
    if (req.headers["range"]) upstreamHeaders["Range"] = req.headers["range"];
    // Evitar enviar headers problemáticos
    delete upstreamHeaders["host"];
    delete upstreamHeaders["connection"];

    let upstreamResp;
    try {
      upstreamResp = await fetchWithTimeout(target, { method: "GET", headers: upstreamHeaders, redirect: "follow" }, FETCH_TIMEOUT_MS);
    } catch (e) {
      console.warn("[proxy] error fetch upstream:", e && e.name ? e.name : e);
      return res.status(502).json({ error: "No se pudo conectar al origen", detail: String(e && e.message ? e.message : e) });
    }

    // si upstream responde no ok y no es 206 -> devolver body y status para debug
    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      const body = await upstreamResp.text().catch(()=>"");
      console.warn("[proxy] upstream responde error:", upstreamResp.status);
      return res.status(upstreamResp.status).send(body || `Upstream returned ${upstreamResp.status}`);
    }

    // Reenviar headers relevantes al cliente
    upstreamResp.headers.forEach((v,k) => {
      const kl = k.toLowerCase();
      if (kl === "content-encoding" || kl === "transfer-encoding") return; // dejar que compression/pipe maneje
      try { res.setHeader(k, v); } catch(e) {}
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!res.getHeader("Accept-Ranges")) res.setHeader("Accept-Ranges","bytes");

    // Decide cache en disco/ram
    const contentLengthHeader = upstreamResp.headers.get("content-length");
    const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
    const ext = target.split(".").pop().split(/\?|#/)[0].toLowerCase();
    const isM3U8 = ext === "m3u8";

    const canCacheToDisk = ENABLE_DISK_CACHE && contentLength && contentLength > 0 && contentLength <= DISK_CACHE_MAX_FILE && !req.headers.range && !isM3U8;
    const canCacheToRam = contentLength && contentLength > 0 && contentLength <= RAM_CACHE_MAX_BYTES && !req.headers.range;

    // Convertir body a Node stream si es WHATWG
    let upstreamNodeStream;
    if (upstreamResp.body && typeof upstreamResp.body.pipe === "function") {
      upstreamNodeStream = upstreamResp.body;
    } else {
      upstreamNodeStream = nodeReadableFrom(upstreamResp.body);
    }

    // Si cacheamos a disco: tee al cliente y al archivo tmp
    if (canCacheToDisk) {
      const tmpPath = tmpFilePathFor(target);
      const ws = fs.createWriteStream(tmpPath);
      const passForClient = new PassThrough();
      const passForFile = new PassThrough();

      // duplicar: upstream -> passForClient & passForFile
      upstreamNodeStream.pipe(passForClient);
      upstreamNodeStream.pipe(passForFile);

      // pipe hacia cliente y a archivo
      passForClient.pipe(res);
      const filePromise = streamPipeline(passForFile, ws)
        .then(() => {
          try { fs.renameSync(tmpPath, cPath); } catch(e){
            // fallback: move tmp to final path using cacheFilePathFor
            try { fs.renameSync(tmpPath, cacheFilePathFor(target)); } catch(e2){ console.warn("rename tmp:", e2 && e2.message); }
          }
          enforceDiskLimit();
        })
        .catch(e => {
          console.warn("[proxy] error guardando cache disco:", e && e.message);
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e2){/*noop*/ }
        });

      // Si debe guardarse también en RAM (archivo muy pequeño), acumular
      if (canCacheToRam) {
        const chunks = [];
        const r = new PassThrough();
        upstreamNodeStream.pipe(r);
        r.on("data", c => chunks.push(c));
        r.on("end", () => {
          try {
            const full = Buffer.concat(chunks);
            memoryCache.set(target, { headers: Object.fromEntries(upstreamResp.headers.entries()), body: full, status: upstreamResp.status });
          } catch(e){}
        });
      }

      // manejar abort del cliente
      const removeAbort = onClientAbort(req, () => {
        try { passForClient.destroy(); passForFile.destroy(); } catch(e){}
      });

      // no await aquí; la respuesta se envía en streaming
      return;
    }

    // Si no cacheamos a disco: hacemos streaming directo (posiblemente guardando en RAM si muy pequeño)
    if (canCacheToRam) {
      const chunks = [];
      const r = new PassThrough();
      upstreamNodeStream.pipe(r);
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        try {
          const full = Buffer.concat(chunks);
          memoryCache.set(target, { headers: Object.fromEntries(upstreamResp.headers.entries()), body: full, status: upstreamResp.status });
        } catch(e){}
      });
      await streamPipeline(r, res);
      return;
    } else {
      // streaming directo, sin buffers grandes
      const removeAbort = onClientAbort(req, () => {
        try { upstreamNodeStream.destroy && upstreamNodeStream.destroy(); } catch(e) {}
      });
      await streamPipeline(upstreamNodeStream, res);
      return;
    }

  } catch (err) {
    console.error("[proxy] Error interno:", err && err.stack ? err.stack : err);
    try {
      if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy", detail: (err && err.message) ? err.message : String(err) });
      else res.end();
    } catch(e){}
  }
});

// health
app.get("/", (req,res) => res.send("MediaFlow Proxy - OK"));

// start
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOSET"})`);
});
