// index.js - MediaFlow Proxy (RE LEGAL)
// Node >=18 (ESM). No scrapers. Integración segura de resolvers opcional.
// Copiar/pegar tal cual.

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import morgan from "morgan";
import mime from "mime-types";

let fetchFn = globalThis.fetch;
if (!fetchFn) {
  // undici fallback si Node no tiene global fetch
  const undici = await import("undici");
  fetchFn = undici.fetch;
}

const app = express();
app.use(morgan("tiny"));
app.use(compression({ level: 6 }));

// ---------------- CONFIG ----------------
const PORT = Number(process.env.PORT || 3000);
const API_PASSWORD = process.env.API_PASSWORD || "superclave123"; // Cambiala en producción
const DISABLE_RESOLVERS = (process.env.DISABLE_RESOLVERS || "false").toLowerCase() === "true";
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT_BYTES = Number(process.env.DISK_CACHE_LIMIT_BYTES || 20 * 1024 * 1024 * 1024); // 20GB
const MEMORY_CACHE_MAX_BYTES = Number(process.env.MEMORY_CACHE_MAX_BYTES || 2 * 1024 * 1024); // 2MB
const MEMORY_TTL_SEC = Number(process.env.MEMORY_TTL_SEC || 6 * 3600);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 120000);
const MAX_CONCURRENT_DOWNLOADS = Number(process.env.MAX_CONCURRENT_DOWNLOADS || 4);

// create cache dir
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// memory cache
const memoryCache = new NodeCache({ stdTTL: MEMORY_TTL_SEC, checkperiod: 120 });

// concurrency control
let activeDownloads = 0;
const waitForSlot = async () => {
  while (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) await new Promise((r) => setTimeout(r, 100));
  activeDownloads++;
};
const releaseSlot = () => { if (activeDownloads > 0) activeDownloads--; };

// ---------------- helpers ----------------
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const cachePath = (url) => path.join(CACHE_DIR, `${sha1(url)}.cache`);
const tmpPath = (url) => path.join(CACHE_DIR, `${sha1(url)}.tmp`);
const metaPath = (url) => path.join(CACHE_DIR, `${sha1(url)}.meta.json`);

async function diskFiles() {
  try {
    const entries = await fsp.readdir(CACHE_DIR);
    let total = 0;
    const list = [];
    for (const e of entries) {
      const p = path.join(CACHE_DIR, e);
      try {
        const st = await fsp.stat(p);
        if (!st.isFile()) continue;
        total += st.size;
        list.push({ file: e, path: p, size: st.size, mtime: st.mtimeMs });
      } catch {}
    }
    return { total, list };
  } catch { return { total: 0, list: [] }; }
}

async function enforceDiskLimit() {
  try {
    const { total, list } = await diskFiles();
    if (total <= DISK_CACHE_LIMIT_BYTES) return;
    list.sort((a, b) => a.mtime - b.mtime);
    let t = total;
    for (const f of list) {
      try { await fsp.unlink(f.path); t -= f.size; if (t <= DISK_CACHE_LIMIT_BYTES) break; } catch {}
    }
  } catch (e) { console.warn("enforceDiskLimit:", e?.message || e); }
}

function isValidHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; } catch { return false; }
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : size - 1;
  if (isNaN(start) || isNaN(end) || start > end) return null;
  if (end >= size) end = size - 1;
  return { start, end };
}

// Convert WHATWG ReadableStream -> Node Readable
function ReadableFromWeb(webStream) {
  // Node 18+: Readable.fromWeb exists
  try {
    // eslint-disable-next-line no-undef
    const { Readable } = await import("stream");
    if (typeof Readable.fromWeb === "function") return Readable.fromWeb(webStream);
  } catch {}
  // fallback: try require
  try {
    // CommonJS fallback (should not be needed on modern Node ESM)
    // eslint-disable-next-line global-require
    const { Readable } = require("stream");
    return Readable.from(webStream);
  } catch (e) {
    throw new Error("No Readable conversion available");
  }
}

// Build forward headers (safe whitelist)
function buildForwardHeaders(req) {
  const allowed = new Set(["referer", "cookie", "user-agent", "authorization"]);
  const result = {};
  const forwardParam = (req.query.forward || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  forwardParam.forEach(k => {
    if (!allowed.has(k)) return;
    if (req.query[k]) result[k] = req.query[k];
  });
  try {
    const j = req.headers["x-forward-headers"];
    if (j) {
      const obj = typeof j === "string" ? JSON.parse(j) : j;
      for (const k of Object.keys(obj || {})) {
        const kl = k.toLowerCase();
        if (!allowed.has(kl)) continue;
        result[kl] = obj[k];
      }
    }
  } catch {}
  if (!result["user-agent"]) result["user-agent"] = req.headers["user-agent"] || "MediaFlow-Proxy/1.0";
  return result;
}

// resolve target from request (supports ?url= and path form)
function resolveTargetFromReq(req) {
  const q = req.query.url || req.query.u || req.query.target;
  if (q) return String(q);
  const suffix = (req.path || "").replace(/^\/proxy\/?/, "");
  if (!suffix) return null;
  try {
    const dec = decodeURIComponent(suffix);
    if (isValidHttpUrl(dec)) return dec;
  } catch {}
  if (isValidHttpUrl(suffix)) return suffix;
  return null;
}

// ---------------- auth middleware ----------------
function getPass(req) {
  return req.query.api_password || req.query.password || req.headers["x-api-password"];
}
app.use("/proxy", (req, res, next) => {
  const pass = getPass(req);
  if (!API_PASSWORD) return res.status(500).json({ error: "API_PASSWORD not set" });
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  next();
});

// ---------------- main handler ----------------
app.get(["/proxy", "/proxy/*"], async (req, res) => {
  const rawTarget = resolveTargetFromReq(req);
  if (!rawTarget) return res.status(400).json({ error: "Falta parámetro ?url=" });
  if (!isValidHttpUrl(rawTarget)) return res.status(400).json({ error: "URL inválida" });

  // Optional resolver (safe, no scrapers). If DISABLE_RESOLVERS true -> skip.
  let target = rawTarget;
  if (!DISABLE_RESOLVERS) {
    try {
      // dynamic import; resolvers.js must export `resolveUrl`
      const mod = await import(pathToFileURL(path.join(process.cwd(), "resolvers.js")).href);
      if (mod && typeof mod.resolveUrl === "function") {
        const maybe = await mod.resolveUrl(rawTarget, { ip: req.ip });
        if (typeof maybe === "string" && isValidHttpUrl(maybe)) target = maybe;
      }
    } catch (e) {
      // If resolvers.js missing or throws, fallback to rawTarget
      // Keep silent (but log)
      console.warn("resolver load/exec failed, using raw URL:", e?.message || e);
      target = rawTarget;
    }
  }

  if (!isValidHttpUrl(target)) return res.status(400).json({ error: "URL final inválida" });

  const cPath = cachePath(target);
  const tPath = tmpPath(target);
  const mPath = metaPath(target);
  const rangeHeader = req.headers.range;

  try {
    // 1) Memory cache quick path (no range)
    if (!rangeHeader && memoryCache.has(target)) {
      const cached = memoryCache.get(target);
      res.writeHead(200, cached.headers);
      return res.end(cached.body);
    }

    // 2) Serve from disk cache if present (with Range support)
    if (fs.existsSync(cPath)) {
      const st = await fsp.stat(cPath);
      const size = st.size;
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(mPath, "utf8")); } catch {}
      const contentType = meta["content-type"] || mime.lookup(path.extname(target)) || "application/octet-stream";

      if (rangeHeader) {
        const rng = parseRange(rangeHeader, size);
        if (!rng) {
          res.status(416).set({ "Content-Range": `bytes */${size}` }).end();
          return;
        }
        const { start, end } = rng;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*"
        });
        const rs = fs.createReadStream(cPath, { start, end });
        return rs.pipe(res);
      } else {
        res.writeHead(200, {
          "Content-Length": String(size),
          "Accept-Ranges": "bytes",
          "Content-Type": contentType,
          "Access-Control-Allow-Origin": "*"
        });
        const rs = fs.createReadStream(cPath);
        return rs.pipe(res);
      }
    }

    // 3) Range requested but not cached -> forward Range to upstream (no caching of partials)
    if (rangeHeader) {
      const upstreamHeaders = { range: rangeHeader, "user-agent": req.headers["user-agent"] || "MediaFlow-Proxy/1.0" };
      const forward = buildForwardHeaders(req);
      Object.assign(upstreamHeaders, forward);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let upstream;
      try {
        upstream = await fetchFn(target, { method: "GET", headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
      } catch (err) {
        clearTimeout(timeout);
        console.error("fetch Range error:", err?.message || err);
        return res.status(502).json({ error: "Error conectando al origen (Range)" });
      }
      clearTimeout(timeout);

      res.status(upstream.status);
      upstream.headers.forEach((v, k) => { if (k.toLowerCase() === "content-encoding") return; res.setHeader(k, v); });
      res.setHeader("Access-Control-Allow-Origin", "*");

      if (!upstream.body) return res.status(502).json({ error: "Origen no devolvió body (Range)" });
      const nodeStream = ReadableFromWeb(upstream.body);
      return nodeStream.pipe(res);
    }

    // 4) No Range & not cached => stream upstream -> client and tee to tmp file (cache)
    await waitForSlot();
    const upstreamHeaders = { "user-agent": req.headers["user-agent"] || "MediaFlow-Proxy/1.0" };
    Object.assign(upstreamHeaders, buildForwardHeaders(req));

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let upstreamResp;
    try {
      upstreamResp = await fetchFn(target, { method: "GET", headers: upstreamHeaders, redirect: "follow", signal: controller.signal });
    } catch (err) {
      clearTimeout(timeoutId);
      releaseSlot();
      console.error("fetch upstream error:", err?.message || err);
      return res.status(502).json({ error: "Error conectando al origen" });
    }
    clearTimeout(timeoutId);

    if (!upstreamResp || (upstreamResp.status >= 400 && upstreamResp.status !== 200 && upstreamResp.status !== 206)) {
      releaseSlot();
      const txt = upstreamResp ? await upstreamResp.text().catch(() => "") : "";
      return res.status(upstreamResp ? upstreamResp.status : 502).send(txt || { error: "Upstream returned error" });
    }

    const contentType = upstreamResp.headers.get("content-type") || mime.lookup(path.extname(target)) || "application/octet-stream";
    const contentLength = upstreamResp.headers.get("content-length") || null;

    const headersToClient = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*" };
    if (contentLength) headersToClient["Content-Length"] = contentLength;
    res.writeHead(upstreamResp.status === 206 ? 206 : 200, headersToClient);

    if (!upstreamResp.body) {
      releaseSlot();
      return res.status(502).json({ error: "Origen no devolvió body" });
    }

    const upstreamNode = ReadableFromWeb(upstreamResp.body);

    // tee to client and to tmp file
    const passToClient = upstreamNode.pipe(new (await import("stream")).PassThrough()); // ensures we can also pipe to file
    const passToFile = upstreamNode.pipe(new (await import("stream")).PassThrough());

    // pipe to client
    passToClient.pipe(res);

    // write to tmp
    const ws = fs.createWriteStream(tPath, { flags: "w" });
    passToFile.pipe(ws);

    ws.on("finish", async () => {
      try {
        await fsp.rename(tPath, cPath);
        const meta = { url: target, "content-type": contentType, fetchedAt: Date.now() };
        await fsp.writeFile(mPath, JSON.stringify(meta), "utf8").catch(()=>{});
        try {
          const st = await fsp.stat(cPath);
          if (st.size > 0 && st.size <= MEMORY_CACHE_MAX_BYTES) {
            const buf = await fsp.readFile(cPath);
            memoryCache.set(target, { headers: { "Content-Type": contentType }, body: buf });
          }
        } catch {}
        setImmediate(() => enforceDiskLimit());
      } catch (e) {
        try { if (fs.existsSync(tPath)) await fsp.unlink(tPath); } catch {}
      } finally { releaseSlot(); }
    });

    ws.on("error", (e) => {
      console.warn("write stream error:", e?.message || e);
    });

    upstreamNode.on("error", (e) => {
      console.error("upstreamNode error", e?.message || e);
      try { res.destroy(); } catch {}
    });

    return;
  } catch (err) {
    console.error("proxy handler error:", err?.stack || err);
    try { res.status(500).json({ error: "Error interno en proxy" }); } catch {}
  }
});

// ip helper
app.get("/proxy/ip", (req, res) => {
  const pass = getPass(req);
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  res.json({ ok: true, ip, service: "MediaFlow Proxy (legal)" });
});

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy (legal) escuchando en :${PORT}`);
});

// ----- small util to build file:// URL for dynamic import -----
function pathToFileURL(p) {
  // simple url builder for file path imports (works on Windows/Unix)
  let resolved = path.resolve(p);
  if (process.platform === "win32") {
    resolved = "/" + resolved.replace(/\\/g, "/");
  }
  return new URL(`file://${resolved}`);
}
