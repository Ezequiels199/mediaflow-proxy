// src/index.js
/**
 * MediaFlow Proxy - Advanced (Node >=22, ESM)
 * - Stream eficiente para archivos grandes
 * - Concurrencia: una sola descarga upstream por URL
 * - Range support: forwards ranges or serves from cache if available
 * - Disk cache with LRU cleanup
 *
 * Env:
 *  - API_PASSWORD (default "8080")
 *  - PORT (default 3000)
 *  - CACHE_DIR (default ./disk_cache)
 *  - DISK_CACHE_LIMIT (bytes, default 10GB)
 *  - MAX_CONCURRENT_FETCH (default 6)
 */
import express from "express";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";
import mime from "mime";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const API_PASSWORD = process.env.API_PASSWORD || "8080";
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT || 10 * 1024 * 1024 * 1024); // 10GB
const MAX_CONCURRENT_FETCH = Number(process.env.MAX_CONCURRENT_FETCH || 6);

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ---------- Utilities ---------- */
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex");
const extFromUrl = (u) => {
  try { return path.extname(new URL(u).pathname) || ""; } catch { return ""; }
};

async function listCacheFiles() {
  const names = await fs.promises.readdir(CACHE_DIR);
  const infos = [];
  let total = 0;
  for (const name of names) {
    try {
      const fp = path.join(CACHE_DIR, name);
      const st = await fs.promises.stat(fp);
      if (st.isFile()) {
        infos.push({ name, path: fp, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      }
    } catch (e) { /* ignore */ }
  }
  return { total, infos };
}

let cleaning = false;
async function enforceDiskLimit() {
  if (cleaning) return;
  cleaning = true;
  try {
    const { total, infos } = await listCacheFiles();
    if (total <= DISK_CACHE_LIMIT) return;
    infos.sort((a, b) => a.mtime - b.mtime); // oldest first
    let cur = total;
    for (const f of infos) {
      try {
        await fs.promises.unlink(f.path);
        cur -= f.size;
        console.info("[cache] removed", f.name, f.size);
        if (cur <= DISK_CACHE_LIMIT) break;
      } catch (e) { /* ignore */ }
    }
  } catch (e) {
    console.warn("[cache] cleanup error:", e.message);
  } finally {
    cleaning = false;
  }
}

/* ---------- Simple concurrency limiter for upstream fetches ---------- */
let currentFetches = 0;
const pendingFetchQueue = [];
function fetchSlotAcquire() {
  return new Promise((resolve) => {
    if (currentFetches < MAX_CONCURRENT_FETCH) {
      currentFetches++;
      resolve();
    } else {
      pendingFetchQueue.push(resolve);
    }
  });
}
function fetchSlotRelease() {
  currentFetches = Math.max(0, currentFetches - 1);
  const next = pendingFetchQueue.shift();
  if (next) {
    currentFetches++;
    next();
  }
}

/* ---------- In-progress downloads map ----------
   key => {
     clients: [ PassThrough streams ],
     writeStream: fs.WriteStream,
     contentType?: string,
     contentLength?: number,
     aborted: boolean
   }
*/
const downloads = new Map();

/* ---------- Helpers ---------- */
function checkPassword(req) {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  return pass && String(pass) === String(API_PASSWORD);
}

function parseRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  const start = m[1] ? parseInt(m[1], 10) : 0;
  const end = m[2] ? parseInt(m[2], 10) : (fileSize - 1);
  if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) return null;
  return { start, end };
}

/* safeWriteAll: escribe chunk a múltiples PassThroughs respetando backpressure */
async function safeWriteAll(chunk, dstreams) {
  const drains = [];
  for (const s of dstreams) {
    const ok = s.write(chunk);
    if (!ok) {
      // esperar drain
      drains.push(new Promise((res) => s.once("drain", res)));
    }
  }
  if (drains.length) await Promise.all(drains);
}

/* ---------- Routes ---------- */
app.get("/", (req, res) => {
  res.type("text").send("MediaFlow Proxy - Advanced. Use /proxy?password=...&url=...");
});

app.get("/health", (req, res) => res.json({ ok: true, cacheDir: CACHE_DIR }));

/**
 * Main endpoint:
 * /proxy?password=XXX&url=ENCODED_URL
 */
app.get("/proxy", async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(401).json({ error: "Contraseña inválida" });

    const raw = req.query.url;
    if (!raw) return res.status(400).json({ error: "Falta parámetro url" });

    const target = decodeURIComponent(String(raw));
    if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: "URL inválida" });

    // key y paths
    const key = sha1(target) + extFromUrl(target);
    const cachePath = path.join(CACHE_DIR, key);

    const clientRange = req.headers.range;

    // Si está cacheado íntegramente => servir (soporta ranges)
    if (fs.existsSync(cachePath)) {
      const stat = await fs.promises.stat(cachePath);
      const size = stat.size;
      const type = mime.getType(cachePath) || "application/octet-stream";
      if (clientRange) {
        const r = parseRange(clientRange, size);
        if (!r) return res.status(416).send("Requested Range Not Satisfiable");
        res.writeHead(206, {
          "Content-Type": type,
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${r.start}-${r.end}/${size}`,
          "Content-Length": r.end - r.start + 1
        });
        const rs = fs.createReadStream(cachePath, { start: r.start, end: r.end, highWaterMark: 64 * 1024 });
        return rs.pipe(res);
      } else {
        res.writeHead(200, { "Content-Type": type, "Content-Length": size });
        const rs = fs.createReadStream(cachePath, { highWaterMark: 128 * 1024 });
        console.info("[cache] serve full", target);
        return rs.pipe(res);
      }
    }

    // Si hay un download en progreso -> agregamos cliente
    if (downloads.has(key)) {
      const entry = downloads.get(key);
      console.info("[join] client joins existing download:", target);
      // si download already has contentType/length, propagar
      if (entry.contentType) res.setHeader("Content-Type", entry.contentType);
      if (entry.contentLength) res.setHeader("Content-Length", entry.contentLength);
      // crear passthrough y pipe a cliente
      const clientStream = new PassThrough({ highWaterMark: 64 * 1024 });
      entry.clients.push(clientStream);
      clientStream.pipe(res);
      return;
    }

    // Si no está cacheado y no hay descarga -> iniciar fetch (No-cache for Range requests: forward directly)
    if (clientRange) {
      // para ranges: mejor forward directly (sin guardar) para evitar inconsistencias
      console.info("[range-forward] forwarding range to upstream:", target);
      const headers = { "user-agent": req.headers["user-agent"] || "node-fetch" };
      if (clientRange) headers.range = clientRange;
      const upstream = await fetch(target, { method: "GET", headers });
      if (!upstream.ok) {
        const body = await upstream.text().then(t => t.slice(0, 800)).catch(() => "");
        return res.status(502).json({ error: "Error upstream", status: upstream.status, preview: body });
      }
      // forward status and headers
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => {
        // cuidar content-length / content-range
        if (k.toLowerCase() === "transfer-encoding") return;
        res.setHeader(k, v);
      });
      await pipeline(upstream.body, res);
      return;
    }

    // Acquire fetch slot (limita concurrencia global hacia upstream)
    await fetchSlotAcquire();

    // nuevo entry de descarga
    const tmpPath = cachePath + ".part";
    const ws = fs.createWriteStream(tmpPath, { flags: "w", highWaterMark: 256 * 1024 });
    const entry = { clients: [], writeStream: ws, contentType: null, contentLength: null, aborted: false };
    downloads.set(key, entry);

    // set up first client stream (el que hizo la request)
    const clientStream = new PassThrough({ highWaterMark: 64 * 1024 });
    entry.clients.push(clientStream);
    clientStream.pipe(res);

    // iniciar fetch
    try {
      console.info("[fetch] starting upstream fetch:", target);
      const upstream = await fetch(target, { method: "GET", headers: { "user-agent": req.headers["user-agent"] || "node-fetch" } });
      if (!upstream.ok) {
        const body = await upstream.text().then(t => t.slice(0, 800)).catch(() => "");
        throw new Error(`Upstream responded ${upstream.status}: ${body}`);
      }

      const ct = upstream.headers.get("content-type");
      const cl = upstream.headers.get("content-length");
      if (ct) entry.contentType = ct;
      if (cl) entry.contentLength = cl;
      if (entry.contentType) {
        // set header for all current clients (future ones will get if join)
        res.setHeader("Content-Type", entry.contentType);
      }
      if (entry.contentLength) res.setHeader("Content-Length", entry.contentLength);

      // Stream iterate and write to disk + clients respecting backpressure
      let bytes = 0;
      for await (const chunk of upstream.body) {
        // write to disk (respect backpressure)
        if (!ws.write(chunk)) {
          await new Promise((r) => ws.once("drain", r));
        }
        bytes += chunk.length || chunk.byteLength || 0;

        // write to all client passthroughs safely (backpressure-aware)
        try {
          await safeWriteAll(chunk, entry.clients);
        } catch (e) {
          // if a client's stream is closed/destroyed, remove it
          entry.clients = entry.clients.filter((s) => !s.destroyed);
        }
      }

      // finish
      ws.end();
      // close all client streams
      for (const s of entry.clients) s.end();

      // atomic rename tmp -> final
      await fs.promises.rename(tmpPath, cachePath);
      console.info("[fetch] finished", target, "bytes:", bytes);

      // Cleanup if we exceed disk limit (async)
      enforceDiskLimit().catch((e) => console.warn("[cache] cleanup error:", e.message));
    } catch (err) {
      // abort: destroy clients and cleanup tmp
      console.warn("[fetch] error for", target, err.message);
      entry.aborted = true;
      try { ws.destroy(); } catch {}
      try { await fs.promises.unlink(tmpPath); } catch {}
      // notify clients if possible
      for (const s of entry.clients) {
        try {
          if (!s.destroyed) s.destroy(err);
        } catch {}
      }
      // if original response not sent headers, send error
      if (!res.headersSent) {
        res.status(502).json({ error: "Error al obtener origen", detail: err.message });
      }
    } finally {
      downloads.delete(key);
      fetchSlotRelease();
    }

  } catch (err) {
    console.error("[proxy] unexpected:", err);
    if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy" });
  }
});

/* ---------- graceful ---------- */
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

app.listen(PORT, () => {
  console.log(`MediaFlow Proxy PRO (advanced) listening :${PORT}`);
  console.log(`CACHE_DIR=${CACHE_DIR} DISK_CACHE_LIMIT=${DISK_CACHE_LIMIT} MAX_CONCURRENT_FETCH=${MAX_CONCURRENT_FETCH}`);
});
