// index.js (ESM) - proxy robusto, streaming y cache mixto
import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { pipeline } from "stream";
import { promisify } from "util";
import { fileURLToPath } from "url";
import mime from "mime-types";

const pipe = promisify(pipeline);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// contraseña configurable por env (recomendado)
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// cache en RAM (para archivos pequeños)
const memoryCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 });

// carpeta para cache en disco
const CACHE_DIR = path.join(__dirname, "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// límite disco (por defecto 20 GB)
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT) || 20 * 1024 * 1024 * 1024;

// helper para obtener uso de disco
function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  const fileList = files
    .map((file) => {
      const filePath = path.join(CACHE_DIR, file);
      const stats = fs.statSync(filePath);
      totalSize += stats.size;
      return { file, filePath, size: stats.size, mtime: stats.mtimeMs };
    })
    .filter((f) => !f.file.endsWith(".tmp"));
  return { totalSize, fileList };
}

// borra archivos viejos hasta entrar en límite
function enforceDiskLimit() {
  let { totalSize, fileList } = getDiskUsage();
  if (totalSize <= DISK_CACHE_LIMIT) return;
  fileList.sort((a, b) => a.mtime - b.mtime);
  for (const f of fileList) {
    try {
      fs.unlinkSync(f.filePath);
      totalSize -= f.size;
      if (totalSize <= DISK_CACHE_LIMIT) break;
    } catch (e) {
      console.warn("No se pudo borrar caché:", f.filePath, e.message);
    }
  }
}

// compresión para respuestas pequeñas/JSON
app.use(compression({ level: 6 }));

// middleware auth: acepta ?password= o ?api_password= o header x-api-password
app.use("/proxy", (req, res, next) => {
  const pass =
    req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    res.status(401).json({ error: "Contraseña inválida" });
    return;
  }
  next();
});

// ruta proxy: /proxy/<ENCODED_URL_OR_RAW_URL>
// ejemplo: /proxy/https://domain/file.mp4?password=superclave123
app.get("/proxy/*", async (req, res) => {
  try {
    const targetUrl = req.params[0];
    if (!targetUrl) return res.status(400).json({ error: "Falta URL de destino" });

    // normalizar (si viene url con http... ya está bien)
    const normalizedUrl = targetUrl.startsWith("http") ? targetUrl : decodeURIComponent(targetUrl);

    // generar nombre de archivo seguro
    const fileName = Buffer.from(normalizedUrl).toString("base64url") + ".cache";
    const tmpName = fileName + ".tmp";
    const filePath = path.join(CACHE_DIR, fileName);
    const tmpPath = path.join(CACHE_DIR, tmpName);

    // si está en RAM (solo para ficheros pequeños)
    const mem = memoryCache.get(normalizedUrl);
    if (mem && mem.body && Buffer.byteLength(mem.body) < 5 * 1024 * 1024) {
      // respuesta en memoria
      res.writeHead(200, mem.headers);
      return res.end(mem.body);
    }

    // si existe en disco: stream directo
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const total = stat.size;
      const range = req.headers.range;
      const contentType = mime.lookup(normalizedUrl) || "application/octet-stream";

      if (range) {
        // manejo parcial
        const matches = /bytes=(\d+)-(\d+)?/.exec(range);
        let start = 0,
          end = total - 1;
        if (matches) {
          start = parseInt(matches[1], 10);
          if (matches[2]) end = parseInt(matches[2], 10);
        }
        if (start >= total) {
          res.status(416).setHeader("Content-Range", `bytes */${total}`).end();
          return;
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Accept-Ranges": "bytes",
          "Content-Length": chunkSize,
          "Content-Type": contentType,
        });
        const readStream = fs.createReadStream(filePath, { start, end });
        return pipe(readStream, res).catch(() => {
          try { readStream.destroy(); } catch {}
        });
      } else {
        res.writeHead(200, {
          "Content-Length": total,
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
        });
        const readStream = fs.createReadStream(filePath);
        return pipe(readStream, res).catch(() => {
          try { readStream.destroy(); } catch {}
        });
      }
    }

    // Si no está cacheado: obtener desde origen y streamear
    const originHeaders = {};
    const forwardHeaders = {};
    // Podés añadir headers adicionales si hace falta (User-Agent etc)
    if (req.headers["user-agent"]) forwardHeaders["user-agent"] = req.headers["user-agent"];
    if (req.headers["range"]) forwardHeaders["range"] = req.headers["range"];

    const originRes = await fetch(normalizedUrl, {
      headers: forwardHeaders,
      redirect: "follow",
    });

    if (!originRes.ok && originRes.status !== 206) {
      // propagar error del origen
      const txt = await originRes.text().catch(() => "");
      res.status(502).json({ error: "Error al obtener origen", status: originRes.status, body: txt });
      return;
    }

    // copiar headers útiles
    originRes.headers.forEach((v, k) => {
      originHeaders[k.toLowerCase()] = v;
    });

    // convertir WHATWG stream a Node Readable si hace falta
    let sourceStream = originRes.body;
    // Node 18+: Readable.fromWeb (si es WebReadable)
    const { Readable } = await import("stream");
    if (typeof Readable.fromWeb === "function" && typeof sourceStream.getReader === "function") {
      sourceStream = Readable.fromWeb(sourceStream);
    } else if (typeof sourceStream.pipe !== "function" && typeof Readable.from === "function") {
      // fallback
      sourceStream = Readable.from(sourceStream);
    }

    // preparar respuesta
    const statusCode = originRes.status === 206 ? 206 : 200;
    const headersToSend = {};
    // enviar Content-Type si lo conocemos
    headersToSend["Content-Type"] =
      originHeaders["content-type"] || mime.lookup(normalizedUrl) || "application/octet-stream";

    // pasar Content-Range / Accept-Ranges / Content-Length si están
    if (originHeaders["content-range"]) headersToSend["Content-Range"] = originHeaders["content-range"];
    if (originHeaders["accept-ranges"]) headersToSend["Accept-Ranges"] = originHeaders["accept-ranges"];
    if (originHeaders["content-length"]) headersToSend["Content-Length"] = originHeaders["content-length"];

    res.writeHead(statusCode, headersToSend);

    // Creamos streams: uno hacia cliente y otro hacia archivo temporal
    const writeStream = fs.createWriteStream(tmpPath, { flags: "w" });

    // pipe source -> cliente y -> archivo (usamos pipe múltiple desde la fuente)
    // Nota: .pipe a múltiples destinatarios está soportado en Node.
    sourceStream.on("error", (e) => {
      console.error("Error en origen stream:", e.message);
      try { writeStream.destroy(); } catch {}
      try { res.destroy(e); } catch {}
    });
    writeStream.on("error", (e) => {
      console.warn("Error escribiendo cache disco:", e.message);
    });

    // Conectar streaming: directamente
    sourceStream.pipe(res, { end: true });
    sourceStream.pipe(writeStream, { end: true });

    // Cuando termine de escribir el archivo, renombrar tmp -> definitivo
    writeStream.on("finish", () => {
      try {
        fs.renameSync(tmpPath, filePath);
        enforceDiskLimit();
        // si el archivo es pequeño, también lo guardamos en RAM para acceso rápido
        try {
          const stats = fs.statSync(filePath);
          if (stats.size < 5 * 1024 * 1024) {
            const data = fs.readFileSync(filePath);
            memoryCache.set(normalizedUrl, { headers: headersToSend, body: data });
          }
        } catch (e) {
          // noop
        }
      } catch (e) {
        console.warn("No se pudo renombrar tmp:", e.message);
      }
    });

    // En caso de que el cliente cancele la conexión -> terminar escrituras
    req.on("close", () => {
      if (!res.writableEnded) {
        try { sourceStream.destroy(); } catch {}
        try { writeStream.destroy(); } catch {}
      }
    });
  } catch (err) {
    console.error("Error interno en proxy:", err);
    res.status(500).json({ error: "Error interno en proxy" });
  }
});

app.get("/", (req, res) => {
  res.send(
    `<h3>MediaFlow Proxy</h3><p>Protegido por contraseña. Usá /proxy/<URL>?password=... para probar.</p>`
  );
});

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOSET"})`);
});
