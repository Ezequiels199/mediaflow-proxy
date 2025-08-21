// index.js - Node 22+ (fetch nativo, AbortSignal.timeout, stream/web)
import express from "express";
import compression from "compression";
import morgan from "morgan";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { finished } from "stream/promises";

const app = express();
const PORT = process.env.PORT || 3000;

// Config
const API_PASSWORD = process.env.PROXY_PASSWORD || "8080";
const CACHE_DIR = process.env.CACHE_DIR || path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = parseInt(process.env.DISK_CACHE_LIMIT || String(20 * 1024 * 1024 * 1024), 10);
const RAM_CACHE_MAX_ITEM = parseInt(process.env.RAM_CACHE_MAX_ITEM || String(5 * 1024 * 1024), 10);
const RAM_CACHE_TTL = parseInt(process.env.RAM_CACHE_TTL || String(60 * 60 * 6), 10);

// Crear carpeta cache si no existe
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Cache RAM
const memoryCache = new NodeCache({ stdTTL: RAM_CACHE_TTL, checkperiod: 120 });

// Helpers
const safeFilename = (url) => Buffer.from(url).toString("base64url");
const isHttpUrl = (s) => {
  try {
    const u = new URL(s);
    return ["http:", "https:"].includes(u.protocol);
  } catch {
    return false;
  }
};
const filterHeaders = (headers) => {
  const out = {};
  for (const [k, v] of headers) {
    if (!["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"].includes(k.toLowerCase())) {
      out[k] = v;
    }
  }
  out["Access-Control-Allow-Origin"] = "*";
  out["Access-Control-Expose-Headers"] = "Content-Length, Content-Type, Accept-Ranges";
  return out;
};
const getDiskUsage = () => {
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  const list = [];
  for (const file of files) {
    const fp = path.join(CACHE_DIR, file);
    const st = fs.statSync(fp);
    if (st.isFile()) {
      totalSize += st.size;
      list.push({ file, size: st.size, mtimeMs: st.mtimeMs, path: fp });
    }
  }
  return { totalSize, list };
};
const enforceDiskLimit = () => {
  let { totalSize, list } = getDiskUsage();
  if (totalSize <= DISK_CACHE_LIMIT) return;
  list = list.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const f of list) {
    fs.unlinkSync(f.path);
    totalSize -= f.size;
    if (totalSize <= DISK_CACHE_LIMIT) break;
  }
};

// Middlewares
app.use(compression({ level: 6 }));
app.use(morgan("tiny"));

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), diskUsage: getDiskUsage().totalSize });
});

// Debug auth
app.get("/debug-auth", (req, res) => {
  const pass = req.query.password || req.headers["x-api-password"];
  res.json({ auth: pass === API_PASSWORD });
});

// Auth middleware
const auth = (req, res, next) => {
  const pass = req.query.password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Auth failed" });
  next();
};

// Proxy endpoint
app.get("/proxy", auth, async (req, res) => {
  try {
    const target = req.query.url?.toString();
    if (!target || !isHttpUrl(target)) return res.status(400).json({ error: "Invalid url" });

    const range = req.headers.range;
    const cacheKey = target;
    const filepath = path.join(CACHE_DIR, safeFilename(target));

    // RAM cache
    if (!range && memoryCache.has(cacheKey)) {
      const cached = memoryCache.get(cacheKey);
      res.writeHead(200, cached.headers);
      return res.end(cached.body);
    }

    // Disk cache
    if (!range && fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath);
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": "application/octet-stream",
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*"
      });
      return fs.createReadStream(filepath).pipe(res);
    }

    // Fetch origen
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s
    const origin = await fetch(target, {
      headers: range ? { Range: range } : {},
      signal: controller.signal,
      redirect: "follow"
    }).finally(() => clearTimeout(timeout));

    if (!origin.ok && origin.status !== 206) {
      return res.status(502).json({ error: "Fetch failed", status: origin.status });
    }

    const headers = filterHeaders(origin.headers);
    res.writeHead(origin.status, headers);

    // Stream
    const contentLength = Number(origin.headers.get("content-length") || "0");
    const shouldCacheDisk = !range && contentLength > 0 && contentLength <= DISK_CACHE_LIMIT;
    const shouldCacheRam = !range && contentLength > 0 && contentLength <= RAM_CACHE_MAX_ITEM;

    if (shouldCacheDisk) {
      const tmp = filepath + ".tmp";
      const ws = fs.createWriteStream(tmp);
      origin.body.pipeTo(ws.writable).catch(() => {});
      await origin.body.pipeTo(res.writable);
      await finished(res);
      fs.renameSync(tmp, filepath);
      enforceDiskLimit();
      if (shouldCacheRam) {
        const buf = fs.readFileSync(filepath);
        memoryCache.set(cacheKey, { headers, body: buf });
      }
    } else if (shouldCacheRam) {
      const chunks = [];
      for await (const chunk of origin.body) {
        chunks.push(chunk);
        res.write(chunk);
      }
      res.end();
      memoryCache.set(cacheKey, { headers, body: Buffer.concat(chunks) });
    } else {
      await origin.body.pipeTo(res.writable);
      await finished(res);
    }
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Root
app.get("/", (req, res) => {
  res.type("text/plain").send("MediaFlow Proxy PRO - Node 22+");
});

// Start
app.listen(PORT, () => console.log(`🚀 Proxy corriendo en puerto ${PORT}`));
