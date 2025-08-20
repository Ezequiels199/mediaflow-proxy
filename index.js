// index.js (ESM)
// Reescrito para aceptar URLs crudas, codificadas y vía query, streaming eficiente,
// cache en RAM y en disco, límites en disco, soporte Range y mejor manejo de errores.

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 Cambiá esto si querés otra contraseña
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// 🗄️ Caché en memoria (solo para respuestas pequeñas)
const memoryCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 }); // 6h

// 📂 Carpeta de cache en disco
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// 📏 Límite total de caché en disco (20 GB por defecto — ajustar si querés)
const DISK_CACHE_LIMIT = Number(process.env.DISK_CACHE_LIMIT) || 20 * 1024 * 1024 * 1024;

// Tamaño máximo para almacenar en RAM (20 MB aquí)
const RAM_CACHE_MAX_BYTES = 20 * 1024 * 1024;

// --- utilidades ---
function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
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
  fileList.sort((a, b) => a.mtime - b.mtime); // borrar los más viejos primero
  for (const f of fileList) {
    try {
      fs.unlinkSync(f.filePath);
      totalSize -= f.size;
    } catch (e) {
      console.warn("Error borrando cache:", f.filePath, e.message);
    }
    if (totalSize <= DISK_CACHE_LIMIT) break;
  }
}

// --- middlewares ---
app.use(compression({ level: 6 }));

// Autenticación: acepta ?password= o ?api_password= o cabecera x-api-password
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.query.api_password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Helper para obtener la URL destino en forma robusta:
// - /proxy/https://...  (req.params[0])
// - /proxy/<encoded-url>  (url codificada)
// - /proxy?url=...  (query param)
function resolveTargetUrl(req) {
  let raw = req.params && req.params[0] ? req.params[0] : null;
  if (!raw) raw = req.query.url || req.query.target || req.query.u || null;
  if (!raw) return null;

  // Si viene con prefijo "/proxy/https:..." express a veces quita la segunda barra.
  // Intentamos saneamientos y decodificaciones hasta que tengamos algo con http/https.
  let candidates = [raw];

  // decodeURIComponent si está codificada
  try {
    candidates.push(decodeURIComponent(raw));
  } catch (e) { /* ignore */ }

  // Base64 decode (si acaso)
  try {
    const b = Buffer.from(raw, "base64").toString("utf8");
    if (b && b.length > 0) candidates.push(b);
  } catch (e) { /* ignore */ }

  // If it starts with "/https:/" or "/http:/" strip leading slash
  if (raw.startsWith("/http") || raw.startsWith("http")) {
    candidates.push(raw.replace(/^\/+/, ""));
  }

  // Try all candidates and return the first that seems valid
  for (const c of candidates) {
    if (!c || typeof c !== "string") continue;
    const s = c.trim();
    if (/^https?:\/\//i.test(s)) return s;
  }

  return null;
}

// Proxy con cache mixto y streaming eficiente
app.get("/proxy/*", async (req, res) => {
  try {
    const target = resolveTargetUrl(req);
    if (!target) {
      return res.status(400).json({ error: "Falta la URL de destino (usa /proxy/<url> o /proxy?url=...)" });
    }

    const rangeHeader = req.headers.range;
    const cacheKey = sha1(target);
    const fileName = `${cacheKey}.cache`;
    const tmpName = `${cacheKey}.tmp`;
    const filePath = path.join(CACHE_DIR, fileName);
    const tmpPath = path.join(CACHE_DIR, tmpName);

    // 1) Si caché en RAM existe y no hay Range, servir desde RAM directamente
    if (!rangeHeader && memoryCache.has(cacheKey)) {
      const cached = memoryCache.get(cacheKey);
      console.log("📦 Sirviendo desde RAM:", target);
      res.writeHead(200, cached.headers);
      return res.end(Buffer.from(cached.body));
    }

    // 2) Si archivo existe en disco
    if (fs.existsSync(filePath)) {
      console.log("📁 Sirviendo desde DISCO:", target);
      const stat = fs.statSync(filePath);

      // Si solicitan Range: servir con createReadStream con start/end
      if (rangeHeader) {
        const matches = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        const start = matches && matches[1] ? parseInt(matches[1], 10) : 0;
        const end = matches && matches[2] ? parseInt(matches[2], 10) : stat.size - 1;
        const chunkSize = end - start + 1;
        const headers = {
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunkSize),
          "Content-Type": "video/mp4", // genérico, el navegador/cliente ajustará
        };
        res.writeHead(206, headers);
        const stream = fs.createReadStream(filePath, { start, end });
        return stream.pipe(res);
      } else {
        const headers = {
          "Content-Length": String(stat.size),
          "Content-Type": "video/mp4",
          "Accept-Ranges": "bytes",
        };
        res.writeHead(200, headers);
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    // 3) Descargar desde origen (stream), enviar al cliente y grabar en disco de forma segura
    console.log("⬇️ Descargando desde origen:", target);

    // Usa global fetch cuando esté disponible (Node 18+) o falla con buen mensaje
    const fetchFn = globalThis.fetch;
    if (!fetchFn) {
      return res.status(500).json({ error: "fetch no disponible en este entorno. Instalar node-fetch o actualizar Node." });
    }

    const upstreamHeaders = {};
    if (rangeHeader) upstreamHeaders.Range = rangeHeader;

    const upstreamResponse = await fetchFn(target, { headers: upstreamHeaders });
    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      // pasar el status y texto
      const text = await upstreamResponse.text().catch(() => "");
      return res.status(upstreamResponse.status).send(text || `Error upstream ${upstreamResponse.status}`);
    }

    // Preparar headers para cliente (filtrar headers peligrosos)
    upstreamResponse.headers.forEach((val, key) => {
      upstreamHeaders[key] = val;
    });

    // Si la respuesta es pequeña, acumular en RAM y (opcional) caché en RAM
    const contentLength = upstreamResponse.headers.get("content-length");
    const cl = contentLength ? parseInt(contentLength, 10) : NaN;

    // Si no hay Range: stream al cliente y guardar a tmp -> rename a final
    res.writeHead(upstreamResponse.status, {
      "Content-Type": upstreamResponse.headers.get("content-type") || "application/octet-stream",
      "Content-Length": contentLength || undefined,
      "Accept-Ranges": upstreamResponse.headers.get("accept-ranges") || "bytes",
    });

    // Para no duplicar el body, hacemos un "tee": pasar datos a cliente y a un archivo temporal.
    // Usamos PassThrough para poder leer el body solo una vez.
    const pass = new PassThrough();

    // Stream upstream -> pass
    const body = upstreamResponse.body;
    // Con pipeline, en caso de error se propaga y manejamos catch.
    // Escribimos simultáneamente a la respuesta y a un archivo tmp.
    const writeStream = fs.createWriteStream(tmpPath);
    // pipeline: upstream body -> pass -> [res, writeStream]
    // para enviar a dos destinos clónicos, pipelne pass -> res y pass -> writeStream
    // pero res no es un stream para pipeline promisified, así que pipe manual:
    pass.pipe(res);
    const writePromise = pipeline(body, pass, writeStream).then(() => {
      // Al terminar guardamos en nombre final (rename)
      try {
        fs.renameSync(tmpPath, filePath);
        console.log("✅ Guardado en disco:", filePath);
        // Si el archivo es pequeño lo guardamos también en RAM cache
        try {
          const sizeStat = fs.statSync(filePath);
          if (sizeStat.size <= RAM_CACHE_MAX_BYTES) {
            const buf = fs.readFileSync(filePath);
            memoryCache.set(cacheKey, {
              headers: { "content-type": upstreamResponse.headers.get("content-type") || "application/octet-stream" },
              body: buf,
            });
            console.log("📦 También cacheado en RAM:", target);
          }
        } catch (e) {
          // ignore
        }
        // Aplicar limite de disco (sin esperar)
        enforceDiskLimit();
      } catch (e) {
        console.warn("No se pudo renombrar tmp -> cache:", e.message);
        if (fs.existsSync(tmpPath)) {
          try { fs.unlinkSync(tmpPath); } catch (ee) { /* ignore */ }
        }
      }
    }).catch((err) => {
      console.error("Error descargando y guardando:", err && err.message ? err.message : err);
      // Intenta borrar tmp
      if (fs.existsSync(tmpPath)) {
        try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
      }
    });

    // No await writePromise aquí: dejamos que la descarga continúe y el cliente reciba datos en tiempo real.
    return; // la respuesta ya está siendo enviada por pass.pipe(res)
  } catch (err) {
    console.error("Error en /proxy:", err && err.stack ? err.stack : err);
    // Si la respuesta aún no fue enviada, devolvemos JSON de error
    try {
      if (!res.headersSent) {
        res.status(500).json({ error: "Error interno en proxy", details: String(err.message || err) });
      } else {
        // si ya se estaba transmitiendo, finalizamos
        res.end();
      }
    } catch (e) { /* ignore */ }
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor proxy corriendo en puerto ${PORT}`);
});
