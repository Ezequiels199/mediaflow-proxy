// index.js (ESM) - MediaFlow Proxy + Addon (manifest, catalog, stream, meta)
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
      if (req.path === "/proxy" || req.path.startsWith("/proxy")) return false;
      return compression.filter(req, res);
    }
  })
);

// ---------- Helpers ----------
function makeSafeFileName(url) {
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
    } catch (e) {}
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

// ---------- Auth middleware for /proxy ----------
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MediaFlow"');
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// ---------- PROXY Endpoint (streaming + cache) ----------
// Usage: GET /proxy?url=<ENCODED_URL>&password=...
// - If client sends Range -> direct proxy (no cache).
// - If no Range -> serve from disk cache if present, else stream+save to disk.
app.get("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Falta la URL de destino (?url=...)" });

    let target;
    try {
      target = new URL(targetUrl);
    } catch (e) {
      return res.status(400).json({ error: "URL inválida" });
    }

    const rangeHeader = req.headers.range;

    // If Range requested -> direct proxy without caching
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

    // No Range -> check disk cache
    const fileName = makeSafeFileName(target.toString());
    const filePath = path.join(CACHE_DIR, fileName);
    const metaFile = metaPathFor(filePath);

    if (fs.existsSync(filePath) && fs.existsSync(metaFile)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
        res.status(200);
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
      }
    }

    // Not cached -> download upstream while streaming to client and writing .tmp
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
        try { fs.unlinkSync(tmpFilePath); } catch (e) {}
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

    upstream.body.pipe(pass);
    pass.pipe(res);
    pass.pipe(writeStream);

    writeStream.on("finish", () => {
      if (hadError) {
        cleanupTmp();
        return;
      }
      try {
        fs.renameSync(tmpFilePath, filePath);
        const meta = { headers, createdAt: Date.now() };
        fs.writeFileSync(metaFile, JSON.stringify(meta));
        try { enforceDiskLimit(); } catch (e) { console.error("enforceDiskLimit:", e?.message || e); }
      } catch (e) {
        console.error("Error finalizando cache:", e?.message || e);
        cleanupTmp();
      }
    });

    return;
  } catch (err) {
    console.error("Unhandled error in /proxy:", err?.stack || err);
    try { return res.status(500).json({ error: "Error interno en el proxy" }); } catch (e) {}
  }
});

// ---------- /proxy/ip (validación para MediaFusion) ----------
app.get("/proxy/ip", (req, res) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  res.json({ ok: true, ip, service: "MediaFlow Proxy" });
});

// ---------- Simple health ----------
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ----------------- Addon: manifest, catalog, streams, meta -----------------
// SAMPLE in-memory catalog (edítalos como quieras)
const MOVIES = [
  {
    id: "mf:ff9",
    type: "movie",
    name: "Rápidos y Furiosos 9",
    poster: "https://m.media-amazon.com/images/I/81p+xe8cbnL._AC_SY679_.jpg",
    // sources: original direct links; Stremio will call the stream endpoint to get proxy urls
    sources: [
      "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4"
    ]
  },
  {
    id: "mf:matrix4",
    type: "movie",
    name: "Matrix Resurrections",
    poster: "https://m.media-amazon.com/images/I/71v06ZcP3XL._AC_SY679_.jpg",
    sources: [
      "https://sample-videos.com/video123/mp4/720/big_buck_bunny_720p_1mb.mp4"
    ]
  }
];

// Manifest served to Stremio
const manifest = {
  id: "org.mediaflow.proxy",
  version: "1.0.0",
  name: "MediaFlow Proxy",
  description: "Addon que sirve streams a través de MediaFlow Proxy",
  resources: ["catalog", "stream", "meta"],
  types: ["movie"],
  catalogs: [{ type: "movie", id: "mf_catalog", name: "MediaFlow Catalog" }],
  idPrefixes: ["mf"]
};

app.get("/manifest.json", (_req, res) => res.json(manifest));

// Catalog endpoint
app.get("/catalog/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  if (type === "movie" && id === "mf_catalog") {
    const metas = MOVIES.map((m) => ({
      id: m.id,
      type: m.type,
      name: m.name,
      poster: m.poster,
      description: m.description || ""
    }));
    return res.json({ metas });
  }
  return res.json({ metas: [] });
});

// Stream endpoint: returns streams (proxy-wrapped) for a given meta id
app.get("/stream/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  if (type !== "movie") return res.json({ streams: [] });
  const movie = MOVIES.find((m) => m.id === id);
  if (!movie) return res.json({ streams: [] });

  // Base URL of this server (to build proxy links)
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  const proxyBase = `${protocol}://${host}`;

  const streams = (movie.sources || []).map((src, i) => ({
    title: `Fuente ${i + 1}`,
    url: `${proxyBase}/proxy?url=${encodeURIComponent(src)}&password=${encodeURIComponent(API_PASSWORD)}`
  }));

  return res.json({ streams });
});

// Meta endpoint (optional)
app.get("/meta/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  const movie = MOVIES.find((m) => m.id === id);
  if (!movie) return res.json({ meta: {} });
  return res.json({ meta: movie });
});

// ----------------- Start -----------------
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow proxy + addon escuchando en http://localhost:${PORT} (port ${PORT})`);
});
