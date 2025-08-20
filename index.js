// index.js (ESM) - MediaFlow Proxy PRO (cache mixto + streaming robusto)
import express from "express";
import fetch from "node-fetch";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { PassThrough } from "stream";
import { pipeline } from "stream/promises";
import morgan from "morgan";
import helmet from "helmet";
import compression from "compression";

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------- CONFIG -----------------
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = 20 * 1024 * 1024 * 1024; // 20 GB fixed
const MEMORY_TTL_SEC = 21600; // 6 hours

// ----------------- PREP -----------------
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const memoryCache = new NodeCache({ stdTTL: MEMORY_TTL_SEC, checkperiod: 120 });

// Middlewares
app.use(helmet());
app.use(morgan("combined"));

// Use compression for non-proxy routes only
app.use(
  compression({
    level: 6,
    threshold: 1024,
    filter(req, res) {
      // don't compress responses for proxy endpoint(s)
      if (req.path === "/proxy" || req.path.startsWith("/proxy")) return false;
      return compression.filter(req, res);
    }
  })
);

// ---------- Helpers ----------
function makeSafeFileName(url) {
  // base64 url-safe (replace +/ with -_ and remove =)
  const b64 = Buffer.from(url).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "") + ".cache";
}
function metaPathFor(filePath) {
  return `${filePath}.meta.json`;
}

function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  const fileList = [];
  for (const file of files) {
    const filePath = path.join(CACHE_DIR, file);
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) continue;
      totalSize += stats.size;
      fileList.push({ file, filePath, size: stats.size, mtime: stats.mtime });
    } catch (e) {
      // ignore single file errors
    }
  }
  return { totalSize, fileList };
}

function enforceDiskLimit() {
  try {
    let { totalSize, fileList } = getDiskUsage();
    if (totalSize <= DISK_CACHE_LIMIT) return;
    fileList.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const f of fileList) {
      try {
        fs.unlinkSync(f.filePath);
        const meta = metaPathFor(f.filePath);
        if (fs.existsSync(meta)) fs.unlinkSync(meta);
      } catch (e) {
        console.error("Error borrando cache:", e?.message || e);
      }
      totalSize -= f.size;
      if (totalSize <= DISK_CACHE_LIMIT) break;
    }
  } catch (e) {
    console.error("enforceDiskLimit error:", e?.message || e);
  }
}

// ---------- Auth middleware ----------
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MediaFlow"');
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// ---------- /proxy endpoint ----------
// Usage:
//   GET /proxy?url=<ENCODED_URL>&password=...
// Range support: the player can send Range header; if present we proxy directly and do NOT cache partial requests.
app.get("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Falta la URL de destino (?url=...)" });

    // Normalize target URL
    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      return res.status(400).json({ error: "URL inválida" });
    }

    const rangeHeader = req.headers.range;

    // If client requested Range -> do direct streaming (no cache)
    if (rangeHeader) {
      const upstream = await fetch(target.toString(), {
        headers: {
          Range: rangeHeader,
          "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (MediaFlow)",
          Referer: req.headers.referer || target.origin,
          Accept: req.headers.accept || "*/*"
        },
        redirect: "follow"
      });

      // Forward status and headers (except content-encoding)
      res.status(upstream.status);
      upstream.headers.forEach((v, k) => {
        if (k.toLowerCase() === "content-encoding") return;
        res.setHeader(k, v);
      });

      if (!upstream.body) return res.status(502).json({ error: "Upstream no envió body" });
      return pipeline(upstream.body, res).catch((e) => {
        console.error("Range pipeline error:", e?.message || e);
      });
    }

    // No Range -> try disk cache first
    const fileName = makeSafeFileName(target.toString());
    const filePath = path.join(CACHE_DIR, fileName);
    const metaFile = metaPathFor(filePath);

    if (fs.existsSync(filePath) && fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        res.status(200);
        // restore useful headers (skip content-encoding)
        for (const [k, v] of Object.entries(meta.headers || {})) {
          if (k.toLowerCase() === "content-encoding") continue;
          res.setHeader(k, v);
        }
        const readStream = fs.createReadStream(filePath);
        return pipeline(readStream, res).catch((e) => {
          console.error("Cached file pipeline error:", e?.message || e);
        });
      } catch (e) {
        console.error("Error leyendo cache/meta, se eliminará cache corrupta:", e?.message || e);
        try { fs.unlinkSync(filePath); } catch {}
        try { fs.unlinkSync(metaFile); } catch {}
        // continue to download fresh
      }
    }

    // Not cached -> download from upstream and stream to client while writing to disk (.tmp -> rename)
    const upstream = await fetch(target.toString(), {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (MediaFlow)",
        Referer: req.headers.referer || target.origin,
        Accept: req.headers.accept || "*/*"
      },
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 200) {
      const text = await upstream.text().catch(() => "");
      return res.status(upstream.status).send(text || `Upstream error ${upstream.status}`);
    }

    // Prepare response headers (skip content-encoding)
    const headers = {};
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return;
      headers[key] = value;
      res.setHeader(key, value);
    });
    res.status(upstream.status);

    const tmpFilePath = filePath + ".tmp";
    const writeStream = fs.createWriteStream(tmpFilePath, { flags: "w" });
    const pass = new PassThrough();

    let hadError = false;
    function cleanupTmp() {
      try { writeStream.close(); } catch {}
      if (fs.existsSync(tmpFilePath)) {
        try { fs.unlinkSync(tmpFilePath); } catch (e) { /* ignore */ }
      }
    }

    upstream.body.on("error", (err) => {
      hadError = true;
      console.error("Upstream body error:", err?.message || err);
      cleanupTmp();
    });
    writeStream.on("error", (err) => {
      hadError = true;
      console.error("File write error:", err?.message || err);
      cleanupTmp();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        hadError = true;
        cleanupTmp();
      }
    });

    // Pipe: upstream -> pass -> [res, file]
    upstream.body.pipe(pass);
    pass.pipe(res);
    pass.pipe(writeStream);

    // When finished writing file, finalize cache
    writeStream.on("finish", () => {
      if (hadError) {
        cleanupTmp();
        return;
      }
      try {
        fs.renameSync(tmpFilePath, filePath);
        const meta = { headers, createdAt: Date.now() };
        fs.writeFileSync(metaFile, JSON.stringify(meta));
        // enforce disk limit async
        try { enforceDiskLimit(); } catch (e) { console.error("enforceDiskLimit:", e?.message || e); }
      } catch (e) {
        console.error("Error finalizando cache:", e?.message || e);
        cleanupTmp();
      }
    });

    // Do not await; streaming already in progress
    return;
  } catch (err) {
    console.error("Unhandled error in /proxy:", err?.stack || err);
    try { return res.status(500).json({ error: "Error interno en el proxy" }); } catch (e) {}
  }
});

// simple health
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow proxy escuchando en http://localhost:${PORT} (port ${PORT})`);
});
