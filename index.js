// index.js - MediaFlow Proxy mejorado (Node 18+)
// Recomendación: setear API_PASSWORD en env: API_PASSWORD=superclave123

const express = require("express");
const compression = require("compression");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline, Readable, PassThrough } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 3000;
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// Caché RAM (6 horas)
const memoryCache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 120 });

// Disco
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Límite disco (20GB por defecto)
const DISK_CACHE_LIMIT = parseInt(process.env.DISK_CACHE_LIMIT || String(20 * 1024 * 1024 * 1024), 10);
const MAX_RAM_CACHE_BYTES = parseInt(process.env.MAX_RAM_CACHE_BYTES || String(10 * 1024 * 1024), 10); // 10MB

function defaultBrowserHeaders(referer) {
  return {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    Referer: referer || undefined,
  };
}

function hashName(input) {
  return crypto.createHash("md5").update(input).digest("hex");
}

function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let total = 0;
  const list = files.map((f) => {
    const p = path.join(CACHE_DIR, f);
    const s = fs.statSync(p);
    total += s.size;
    return { file: f, path: p, size: s.size, mtime: s.mtimeMs };
  });
  return { total, list };
}

function enforceDiskLimit() {
  try {
    const { total, list } = getDiskUsage();
    if (total <= DISK_CACHE_LIMIT) return;
    console.log("⚠️ Disk cache excedida. Limpiando...");
    list.sort((a, b) => a.mtime - b.mtime);
    let cur = total;
    for (const item of list) {
      try {
        fs.unlinkSync(item.path);
        cur -= item.size;
        if (cur <= DISK_CACHE_LIMIT) break;
      } catch (e) {
        console.warn("No se pudo borrar:", item.path, e.message);
      }
    }
  } catch (e) {
    console.error("Error enforceDiskLimit:", e.message || e);
  }
}

app.use(compression());

// Auth middleware para /proxy
app.use("/proxy", (req, res, next) => {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"] ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : undefined);

  if (!API_PASSWORD) {
    console.warn("⚠️ API_PASSWORD no seteada en env. Usando fallback (no seguro).");
  }

  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Ruta proxy
app.get("/proxy/*", async (req, res) => {
  try {
    let target = req.params[0] || req.query.url;
    if (!target) return res.status(400).json({ error: "Falta URL objetivo" });

    try { target = decodeURIComponent(target); } catch (e) {}

    if (!/^https?:\/\//i.test(target)) {
      return res.status(400).json({ error: "La URL objetivo debe empezar por http:// o https://" });
    }

    const name = hashName(target) + ".cache";
    const filePath = path.join(CACHE_DIR, name);

    const rangeHeader = req.headers.range;

    // 1) RAM cache (sin Range)
    const ram = memoryCache.get(target);
    if (ram && !rangeHeader) {
      console.log("Sirviendo RAM:", target);
      for (const [k, v] of Object.entries(ram.headers || {})) {
        if (k.toLowerCase() === "transfer-encoding") continue;
        res.setHeader(k, v);
      }
      return res.status(200).send(ram.body);
    }

    // 2) Disco cache (sin Range)
    if (fs.existsSync(filePath) && !rangeHeader) {
      console.log("Sirviendo DISCO:", target);
      const stat = fs.statSync(filePath);
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      const read = fs.createReadStream(filePath);
      return streamPipeline(read, res).catch((err) => {
        console.error("Error enviando desde disco:", err.message || err);
        if (!res.headersSent) res.status(500).json({ error: "Error leyendo cache disco" });
      });
    }

    // 3) Fetch upstream
    console.log("Fetching:", target, rangeHeader ? "(Range)" : "");
    const upstreamHeaders = {
      ...defaultBrowserHeaders(req.get("referer") || target),
      ...(rangeHeader ? { Range: rangeHeader } : {}),
      Accept: req.headers.accept || "*/*",
    };

    if (typeof fetch !== "function") {
      throw new Error("fetch no disponible. Usar Node 18+");
    }

    const upstreamResp = await fetch(target, {
      method: "GET",
      headers: upstreamHeaders,
    });

    if (!upstreamResp.ok) {
      const text = await upstreamResp.text().catch(() => "");
      console.warn("Upstream status:", upstreamResp.status);
      return res.status(upstreamResp.status).json({ error: "Error al obtener origen", status: upstreamResp.status, body: text });
    }

    // Reenviar headers salvo los peligrosos
    upstreamResp.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "transfer-encoding") return;
      if (k === "content-encoding") return;
      res.setHeader(key, value);
    });
    res.setHeader("Access-Control-Allow-Origin", "*");

    const contentLength = Number(upstreamResp.headers.get("content-length") || 0);
    const shouldCacheInRam = contentLength > 0 && contentLength <= MAX_RAM_CACHE_BYTES && !rangeHeader;

    if (shouldCacheInRam) {
      // pequeño: buffer completo
      const buffer = Buffer.from(await upstreamResp.arrayBuffer());
      memoryCache.set(target, { headers: Object.fromEntries(upstreamResp.headers.entries()), body: buffer });
      try { fs.writeFileSync(filePath, buffer); enforceDiskLimit(); } catch (e) { /* ignore */ }
      return res.status(upstreamResp.status).send(buffer);
    }

    // GRANDE: stream. Convertimos WHATWG ReadableStream a Node Readable (fromWeb)
    const upstreamBody = upstreamResp.body;
    if (!upstreamBody) return res.status(500).json({ error: "Origen no devolvió body" });

    // Node 18+: Readable.fromWeb
    let nodeStream;
    try {
      nodeStream = Readable.fromWeb(upstreamBody);
    } catch (e) {
      // fallback: si por alguna razón no funciona, intentar arrayBuffer streaming (menos ideal)
      console.warn("No se pudo convertir fromWeb:", e.message || e);
      const buf = Buffer.from(await upstreamResp.arrayBuffer());
      // escribir y enviar
      try { fs.writeFileSync(filePath, buf); enforceDiskLimit(); } catch (err) {}
      res.setHeader("Content-Length", buf.length);
      return res.status(upstreamResp.status).send(buf);
    }

    // Duplicar stream: uno a cliente, otro a disco (si lo soportás)
    const writeToDisk = true;
    let fileWrite = null;
    if (writeToDisk) {
      try {
        fileWrite = fs.createWriteStream(filePath);
      } catch (e) {
        fileWrite = null;
        console.warn("No se pudo abrir cache disco:", e.message || e);
      }
    }

    const pass = new PassThrough();
    // pipe upstream -> pass (y opcionalmente a file)
    nodeStream.on("error", (err) => {
      console.warn("Error stream upstream:", err && err.message ? err.message : err);
      try { if (!res.headersSent) res.status(500).json({ error: "Error en upstream stream" }); else res.end(); } catch (e) {}
    });

    nodeStream.pipe(pass);
    if (fileWrite) {
      // hay que recrear otro stream para escritura (pipe a file). Como no podemos "multi-pipe" el mismo nodeStream
      // lo hacemos duplicando mediante PassThrough: upstream -> two PassThroughs.
      // Mejor: crear dos PassThrough y pipe upstream into both using pipeline:
      const passForFile = new PassThrough();
      // Repipe: nodeStream -> both passes by piping nodeStream into passForFile and pass (we already piped into pass),
      // so instead: unpipe y rehacer: (simple approach: pipe nodeStream into both via 'nodeStream.pipe(pass); nodeStream.pipe(passForFile);')
      try {
        // Duplicate by piping upstream to both (most streams allow multiple pipe targets)
        nodeStream.pipe(passForFile);
        passForFile.pipe(fileWrite).on("error", (e) => {
          console.warn("Error escribiendo cache disco (stream):", e.message || e);
        });
      } catch (e) {
        console.warn("No se pudo duplicar stream para disco:", e.message || e);
      }
    }

    // Pipe al cliente
    res.status(upstreamResp.status);
    streamPipeline(pass, res).catch((err) => {
      console.warn("Cliente cortó la conexión o error en pipeline:", err && err.message ? err.message : err);
      try { if (!res.headersSent) res.end(); } catch (e) {}
    });

    // Cuando termine escritura a disco, forzar limpieza
    if (fileWrite) {
      fileWrite.on("finish", () => {
        enforceDiskLimit();
      });
    }
  } catch (err) {
    console.error("Error interno en proxy:", err && err.stack ? err.stack : err);
    try {
      if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy" });
      else res.end();
    } catch (e) {}
  }
});

app.get("/", (req, res) => {
  res.json({ ok: true, note: "MediaFlow Proxy (mejorado). Protegido por contraseña." });
});

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOT SET"})`);
});
