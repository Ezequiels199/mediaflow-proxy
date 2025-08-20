// index.js (CommonJS - listo para Node 18+)
// Requisitos: express, compression, node-cache
const express = require("express");
const compression = require("compression");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 Contraseña (puedes setear API_PASSWORD en env vars)
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// 🧠 Caché en RAM (TTL 6h)
const memoryCache = new NodeCache({ stdTTL: 21600, checkperiod: 120 });

// 📁 Caché en disco
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// 📦 Límite disco (configurable) -> 20 GB por defecto
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT) || 20 * 1024 * 1024 * 1024;

// 🧾 Umbral máximo para guardar en RAM (no queremos meter archivos grandes en memoria)
const MEMORY_CACHE_MAX = 10 * 1024 * 1024; // 10 MB

// util: listado y uso disco
function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith(".cache"));
  let totalSize = 0;
  const fileList = files.map((file) => {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    totalSize += stats.size;
    return { file, filePath, size: stats.size, mtime: stats.mtimeMs };
  });
  return { totalSize, fileList };
}

function enforceDiskLimit() {
  let { totalSize, fileList } = getDiskUsage();
  if (totalSize <= DISK_CACHE_LIMIT) return;
  console.log("⚠️ Caché en disco excedida, limpiando...");
  fileList.sort((a, b) => a.mtime - b.mtime);
  for (const file of fileList) {
    try {
      fs.unlinkSync(file.filePath);
      totalSize -= file.size;
      if (totalSize <= DISK_CACHE_LIMIT) break;
    } catch (e) {
      console.warn("No pude borrar", file.filePath, e.message);
    }
  }
}

// compresión (respuesta al cliente)
app.use(compression());

// Middleware auth para /proxy
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Helper: filename seguro para cache
function cacheFileNameFor(url) {
  const safe = Buffer.from(url).toString("base64url"); // node 16+ (base64url)
  return `${safe}.cache`;
}

// Proxy principal
app.get("/proxy/*", async (req, res) => {
  try {
    const encoded = req.params[0]; // en la URL: /proxy/<url encoded>
    if (!encoded) return res.status(400).json({ error: "Falta la URL de destino (usa /proxy/<url completa>)" });

    // permitir tanto /proxy/https://... como /proxy/http://...
    const targetUrl = decodeURIComponent(encoded);
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return res.status(400).json({ error: "URL inválida" });
    }

    // nombre de cache
    const fileName = cacheFileNameFor(targetUrl);
    const filePath = path.join(CACHE_DIR, fileName);

    // Si está en RAM y no hay Range -> servir
    if (!req.headers.range && memoryCache.has(targetUrl)) {
      const cached = memoryCache.get(targetUrl);
      console.log("Sirviendo desde RAM:", targetUrl);
      Object.entries(cached.headers || {}).forEach(([k, v]) => res.setHeader(k, v));
      res.status(200).send(cached.body);
      return;
    }

    // Si existe en disco
    if (!req.headers.range && fs.existsSync(filePath)) {
      console.log("Sirviendo desde DISCO (completo):", targetUrl);
      const stat = fs.statSync(filePath);
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": getContentType(filePath) || "application/octet-stream",
      });
      const rs = fs.createReadStream(filePath);
      return rs.pipe(res);
    }

    // Si piden Range y hay archivo en disco -> responder rango
    if (req.headers.range && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const range = req.headers.range;
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (!m) {
        return res.status(416).end();
      }
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      if (start >= stat.size) {
        return res.status(416).end();
      }
      res.writeHead(206, {
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": getContentType(filePath) || "application/octet-stream",
      });
      const rs = fs.createReadStream(filePath, { start, end });
      return rs.pipe(res);
    }

    // No está cacheado -> fetch upstream y streamear
    console.log("Descargando desde origen:", targetUrl);

    // Construir headers upstream: copiamos headers del cliente pero sobreescribimos lo sensible
    const upstreamHeaders = {};
    // transferimos algunos headers útiles (no el host)
    ["user-agent", "accept-language", "cookie"].forEach(h => {
      if (req.headers[h]) upstreamHeaders[h] = req.headers[h];
    });

    // Forzar User-Agent, Accept, Referer y Origin para evitar 403 en CDNs/HLS
    upstreamHeaders["user-agent"] =
      req.headers["user-agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36";

    // Si es HLS / m3u8, usar Accept específico
    if (targetUrl.includes(".m3u8")) {
      upstreamHeaders["accept"] = "application/vnd.apple.mpegurl, application/x-mpegURL, */*";
    } else {
      upstreamHeaders["accept"] = req.headers["accept"] || "*/*";
    }

    upstreamHeaders["referer"] = req.headers["referer"] || targetUrl;
    upstreamHeaders["origin"] = req.headers["origin"] || parsed.origin;

    // Forward Range if provided
    if (req.headers.range) upstreamHeaders["range"] = req.headers.range;

    // Evitar pasar host y connection
    delete upstreamHeaders["host"];
    delete upstreamHeaders["connection"];

    // Usamos fetch global (Node 18+). Seguimos la redirección automática.
    const upstreamResp = await fetch(targetUrl, {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow",
    });

    // Si upstream devuelve 4xx/5xx, devolver mensaje de error con body (útil para debug)
    if (!upstreamResp.ok && upstreamResp.status !== 206) {
      const text = await upstreamResp.text().catch(() => "");
      return res.status(upstreamResp.status).json({ error: "Error al obtener el origen", status: upstreamResp.status, body: text });
    }

    // Cabeceras para el cliente (pasamos la mayoría)
    const headersOut = {};
    upstreamResp.headers.forEach((v, k) => {
      // No reenviaremos algunos headers que interfieren
      if (["content-encoding"].includes(k)) return;
      headersOut[k] = v;
    });

    // Si upstream devolvió Content-Length y no hay range del cliente -> podemos decidir cachear en disco
    const contentLength = upstreamResp.headers.get("content-length");
    const sizeNum = contentLength ? parseInt(contentLength, 10) : null;

    // Preparamos escritura a archivo temporal en disco
    const tempPath = filePath + ".tmp";
    const writeStream = fs.createWriteStream(tempPath, { flags: "w" });

    // Cabezeras al cliente: preservamos status upstream (200 o 206)
    const upstreamStatus = upstreamResp.status || 200;
    Object.entries(headersOut).forEach(([k, v]) => res.setHeader(k, v));
    // aseguro Accept-Ranges
    res.setHeader("Accept-Ranges", "bytes");

    // Si upstream es 206 (range) devolvemos 206, si 200 devolvemos 200
    res.writeHead(upstreamStatus);

    // Stream: leemos por chunks del cuerpo (async iterator) y escribimos a cliente y a disco
    let savedChunks = [];
    let accumulated = 0;
    try {
      for await (const chunk of upstreamResp.body) {
        // chunk es Uint8Array
        // escribir a cliente
        res.write(Buffer.from(chunk));
        // escribir a disco
        writeStream.write(Buffer.from(chunk));

        // acumular para caché en RAM si pequeño
        if (accumulated + chunk.length <= MEMORY_CACHE_MAX) {
          savedChunks.push(Buffer.from(chunk));
        } else {
          // si ya excede, liberamos savedChunks memory
          savedChunks = [];
        }
        accumulated += chunk.length;
      }
    } catch (e) {
      // error de stream (cliente cortó / upstream cerró)
      console.error("Error en streaming:", e.message);
      try { writeStream.destroy(); } catch (er) {}
      // eliminar tmp
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (er){}
      // si ya escribimos algo al cliente no podemos cambiar status; cerramos la conexión
      return res.end();
    }

    // Terminamos escritura en disco
    writeStream.end();

    // Si el tamaño total es pequeño, guardamos en RAM
    if (accumulated > 0 && accumulated <= MEMORY_CACHE_MAX) {
      memoryCache.set(targetUrl, { headers: headersOut, body: Buffer.concat(savedChunks) });
    }

    // Renombrar tmp -> archivo final (si hubo datos)
    if (fs.existsSync(tempPath)) {
      try {
        fs.renameSync(tempPath, filePath);
      } catch (e) {
        console.warn("No pude renombrar tmp a cache:", e.message);
      }
    }

    // Aplicar limpieza si toca
    enforceDiskLimit();

    // cerrar response
    return res.end();
  } catch (err) {
    console.error("Error en proxy:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Error interno en proxy" });
  }
});

// simple root
app.get("/", (req, res) => {
  res.send("MediaFlow Proxy PRO - funcionando");
});

// helper content-type básico (por extensión)
function getContentType(filename) {
  const ext = String(filename).split(".").pop().toLowerCase();
  if (["mp4", "m4v"].includes(ext)) return "video/mp4";
  if (["mkv"].includes(ext)) return "video/x-matroska";
  if (["webm"].includes(ext)) return "video/webm";
  if (["m3u8"].includes(ext)) return "application/vnd.apple.mpegurl";
  if (["ts"].includes(ext)) return "video/mp2t";
  return null;
}

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOT-SET"})`);
});
