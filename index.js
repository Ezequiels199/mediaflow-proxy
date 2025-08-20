// index.js (ESM) - MediaFlow Proxy PRO (usa ?url= como parámetro principal)
// - Streaming eficiente (no buffer en RAM para archivos grandes)
// - Soporta Range (seek), cache en disco (.tmp -> .cache), cache en RAM para archivos pequeños
// - Límite disco 20GB, limpieza FIFO, auth por password/api_password/x-api-password
// - /proxy/ip para validación por MediaFusion, /health y / (mensajito)

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PassThrough } from "stream";
import { pipeline } from "stream/promises";
import morgan from "morgan";
import helmet from "helmet";

let fetchFn = globalThis.fetch;
try {
  // si no hay fetch global (Node <18), usar node-fetch
  if (!fetchFn) {
    // dynamic import para no romper si ya existe fetch
    const mod = await import("node-fetch");
    fetchFn = mod.default;
  }
} catch (e) {
  console.warn("node-fetch no pudo cargarse:", e?.message || e);
  fetchFn = globalThis.fetch;
}

const app = express();
const PORT = process.env.PORT || 3000;

// --------------- CONFIG ----------------
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
const DISK_CACHE_LIMIT = 20 * 1024 * 1024 * 1024; // 20 GB fixed
const RAM_CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const MEMORY_TTL_SEC = 60 * 60 * 6; // 6 hours

// ------------- PREP --------------------
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const memoryCache = new NodeCache({ stdTTL: MEMORY_TTL_SEC, checkperiod: 120 });

// Middlewares
app.use(helmet());
app.use(morgan("tiny"));
// Use compression for everything EXCEPT proxy routes
app.use(
  compression({
    level: 6,
    filter(req, res) {
      if (req.path === "/proxy" || req.path.startsWith("/proxy")) return false;
      return compression.filter(req, res);
    }
  })
);

// Root friendly message (so opening base URL doesn't show "Cannot GET /")
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/plain");
  res.send(
    "🚀 MediaFlow Proxy activo. Usa /proxy?url=<VIDEO_URL>&password=<PASSWORD>  - /health para status"
  );
});

// Health endpoint
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// Auth middleware for /proxy routes (accepts ?password OR ?api_password OR header x-api-password)
function checkAuth(req) {
  return (
    (req.query && (req.query.password || req.query.api_password)) ||
    req.headers["x-api-password"]
  );
}
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    res.setHeader("WWW-Authenticate", 'Basic realm="MediaFlow"');
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// /proxy/ip for MediaFusion validation
app.get("/proxy/ip", (req, res) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) return res.status(401).json({ error: "Contraseña inválida" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || req.ip;
  res.json({ ok: true, ip, service: "MediaFlow Proxy" });
});

// ---------------- Helpers ----------------
function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  const fileList = [];
  for (const file of files) {
    const fp = path.join(CACHE_DIR, file);
    try {
      const st = fs.statSync(fp);
      if (!st.isFile()) continue;
      totalSize += st.size;
      fileList.push({ file, filePath: fp, size: st.size, mtime: st.mtimeMs });
    } catch (e) {
      // ignore individual read errors
    }
  }
  return { totalSize, fileList };
}

function enforceDiskLimit() {
  try {
    let { totalSize, fileList } = getDiskUsage();
    if (totalSize <= DISK_CACHE_LIMIT) return;
    fileList.sort((a, b) => a.mtime - b.mtime);
    for (const f of fileList) {
      try {
        fs.unlinkSync(f.filePath);
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

// resolve target URL robustly: accepts ?url=, path encoded like /proxy/<encoded-url>, raw
function resolveTargetUrl(req) {
  // priority: query param ?url, then query target/u, then path after /proxy/
  let candidate = null;
  if (req.query && (req.query.url || req.query.target || req.query.u)) {
    candidate = req.query.url || req.query.target || req.query.u;
  } else if (req.path && req.path.startsWith("/proxy/")) {
    // req.path = /proxy/<whatever>
    const trailing = req.path.replace(/^\/proxy\/?/, "");
    if (trailing) candidate = trailing;
  } else if (req.params && req.params[0]) {
    candidate = req.params[0];
  }

  if (!candidate) return null;

  // try several decodings/normalizations until we find something starting with http/https
  const tries = [];
  tries.push(candidate);
  try {
    tries.push(decodeURIComponent(candidate));
  } catch (e) {}
  try {
    const maybeBase64 = Buffer.from(candidate, "base64").toString("utf8");
    if (maybeBase64 && maybeBase64.length < 2000) tries.push(maybeBase64);
  } catch (e) {}
  // strip leading slashes
  if (candidate.startsWith("/")) tries.push(candidate.replace(/^\/+/, ""));
  // some clients send "https:/" (one slash) - correct to https://
  if (/^https?:\/[^/]/i.test(candidate)) {
    tries.push(candidate.replace(/^https?:\/([^/])/, (m, g1) => `${m[0]}${m[1]}//${g1}`));
  }

  for (const t of tries) {
    if (!t || typeof t !== "string") continue;
    const s = t.trim();
    if (/^https?:\/\//i.test(s)) return s;
  }
  return null;
}

// ---------------- /proxy endpoint ----------------
// Usage: GET /proxy?url=<URL>&password=...  (preferred)
// Also accepts /proxy/<encoded-url>?password=...
app.get("/proxy", async (req, res) => {
  try {
    const target = resolveTargetUrl(req);
    if (!target) return res.status(400).json({ error: "Falta la URL de destino (?url=...)" });

    // create stable cache key
    const key = sha1(target);
    const fileName = `${key}.cache`;
    const tmpName = `${key}.tmp`;
    const filePath = path.join(CACHE_DIR, fileName);
    const tmpPath = path.join(CACHE_DIR, tmpName);

    const rangeHeader = req.headers.range;

    // If Range requested -> proxy direct to upstream and do NOT cache partials
    if (rangeHeader) {
      const upstream = await fetchFn(target, {
        headers: {
          Range: rangeHeader,
          "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (MediaFlow)",
          Referer: req.headers.referer || new URL(target).origin,
          Accept: req.headers.accept || "*/*"
        },
        redirect: "follow"
      });

      // forward status and headers (except content-encoding)
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

    // No Range: serve from disk cache if exists
    if (fs.existsSync(filePath)) {
      const st = fs.statSync(filePath);
      res.status(200);
      // best-effort content-type; if you saved meta you could restore headers - assume video/mp4
      const ct = "video/mp4";
      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", String(st.size));
      res.setHeader("Accept-Ranges", "bytes");
      return fs.createReadStream(filePath).pipe(res);
    }

    // Not cached: download from origin, stream to client and write to tmp file
    const upstream = await fetchFn(target, {
      headers: {
        "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (MediaFlow)",
        Referer: req.headers.referer || new URL(target).origin,
        Accept: req.headers.accept || "*/*"
      },
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 200) {
      const txt = await upstream.text().catch(() => "");
      return res.status(upstream.status).send(txt || `Upstream error ${upstream.status}`);
    }

    // Prepare headers to client (except content-encoding)
    upstream.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-encoding") return;
      res.setHeader(k, v);
    });
    res.status(upstream.status);

    const pass = new PassThrough();
    const writeStream = fs.createWriteStream(tmpPath, { flags: "w" });

    let hadError = false;
    const cleanupTmp = () => {
      try { writeStream.close(); } catch {}
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch {}
      }
    };

    upstream.body.on("error", (err) => {
      hadError = true;
      console.error("Upstream error:", err?.message || err);
      cleanupTmp();
    });
    writeStream.on("error", (err) => {
      hadError = true;
      console.error("Write stream error:", err?.message || err);
      cleanupTmp();
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        hadError = true;
        cleanupTmp();
      }
    });

    // Pipe upstream -> pass -> client AND write to tmp
    upstream.body.pipe(pass);
    pass.pipe(res);
    pass.pipe(writeStream);

    // When finished writing file, rename tmp -> final and optionally cache in RAM if small
    writeStream.on("finish", () => {
      if (hadError) {
        cleanupTmp();
        return;
      }
      try {
        fs.renameSync(tmpPath, filePath);
        try {
          const st = fs.statSync(filePath);
          if (st.size <= RAM_CACHE_MAX_BYTES) {
            const buf = fs.readFileSync(filePath);
            memoryCache.set(key, { headers: { "content-type": upstream.headers.get("content-type") || "application/octet-stream" }, body: buf });
            console.log("📦 Guardado en RAM:", target);
          }
        } catch (e) {
          // ignore small cache errors
        }
        // Enforce disk limit async
        setImmediate(() => {
          try { enforceDiskLimit(); } catch (e) { console.error("enforceDiskLimit:", e?.message || e); }
        });
      } catch (e) {
        console.error("Error finalizando cache:", e?.message || e);
        cleanupTmp();
      }
    });

    return; // streaming in progress
  } catch (e) {
    console.error("Unhandled in /proxy:", e?.stack || e);
    try {
      if (!res.headersSent) return res.status(500).json({ error: "Error interno en proxy" });
      else return res.end();
    } catch (ee) {}
  }
});

// optional: allow /proxy/<encoded-or-raw-path> as legacy; redirect to ?url= form for simplicity
app.get("/proxy/*", (req, res) => {
  // If someone used path form, redirect to query form with encoded url
  const trailing = req.path.replace(/^\/proxy\/?/, "");
  if (!trailing) return res.status(400).json({ error: "Falta URL" });
  try {
    // try decodeURIComponent first
    let maybe = trailing;
    try { maybe = decodeURIComponent(trailing); } catch {}
    // If starts with http(s), redirect
    if (/^https?:\/\//i.test(maybe)) {
      const redirectTo = `/proxy?url=${encodeURIComponent(maybe)}&password=${encodeURIComponent(req.query.password || req.query.api_password || "")}`;
      return res.redirect(302, redirectTo);
    }
  } catch (e) {}
  return res.status(400).json({ error: "URL inválida en path. Usá ?url=" });
});

// --------------- start ----------------
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en http://localhost:${PORT} (port ${PORT})`);
});
