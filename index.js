// index.js (CommonJS, compatible con Node 18+)
const express = require("express");
const compression = require("compression");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const stream = require("stream");
const { pipeline } = require("stream");
const { promisify } = require("util");
const pipelineAsync = promisify(pipeline);

const app = express();
const PORT = process.env.PORT || 10000;

// 🔐 Contraseña (mejor: setear en ENV: API_PASSWORD)
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// 🧠 Caché en RAM (para respuestas pequeñas)
const memoryCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 });

// 📁 Caché en disco (opcional) - cuidado con el espacio de Render
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// Límite de archivo para cachear en disco (bytes). Ajustalo según lo que quieras.
// Por ejemplo 200 MB:
const DISK_CACHE_MAX_FILE = 200 * 1024 * 1024;

// Límite máximo total de disco cache (ej: 5 GB)
const DISK_CACHE_TOTAL_LIMIT = 5 * 1024 * 1024 * 1024;

// utilidad: calcular uso disco
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
  const { total, list } = getDiskUsage();
  if (total <= DISK_CACHE_TOTAL_LIMIT) return;
  // borrar los más viejos
  const sorted = list.sort((a, b) => a.mtime - b.mtime);
  let cur = total;
  for (const f of sorted) {
    try {
      fs.unlinkSync(f.path);
      cur -= f.size;
    } catch (e) {
      console.error("Error borrando cache disco:", e);
    }
    if (cur <= DISK_CACHE_TOTAL_LIMIT) break;
  }
}

// gzip/brotli
app.use(compression());

// Middleware auth para /proxy
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Ruta /proxy/* acepta:
/*
  - /proxy/https://ejemplo.com/video.mp4?password=...
  - o /proxy?url=https...&password=...
*/
app.get("/proxy/*", proxyHandler);
app.get("/proxy", proxyHandler);

async function proxyHandler(req, res) {
  try {
    // obtener URL destino (soporta /proxy/https://... y /proxy?url=...)
    let target = req.params && req.params[0];
    if (!target) target = req.query.url;
    if (!target) {
      return res.status(400).json({ error: "Falta la URL de destino" });
    }
    // url puede llegar con slashes, decode
    target = decodeURIComponent(target);

    console.log("OBTENER:", target, " Range:", req.headers.range || "");

    // nombre de archivo para cache (base64 seguro)
    const cacheName = Buffer.from(target).toString("base64url") + ".cache";
    const cachePath = path.join(CACHE_DIR, cacheName);

    // 1) Si está en RAM -> devolver
    const mem = memoryCache.get(target);
    if (mem) {
      console.log("Sirviendo desde RAM:", target);
      // setear headers guardados
      for (const k of Object.keys(mem.headers || {})) {
        res.setHeader(k, mem.headers[k]);
      }
      res.status(mem.status || 200);
      return pipelineAsync(stream.Readable.from(mem.body), res);
    }

    // 2) Si existe en disco y la petición no tiene Range -> devolver desde disco
    if (fs.existsSync(cachePath) && !req.headers.range) {
      console.log("Sirviendo desde DISCO:", target);
      const stats = fs.statSync(cachePath);
      res.setHeader("content-length", stats.size);
      // content-type no podemos saber salvo que lo guardemos; dejar que el browser lo infiera
      const fileStream = fs.createReadStream(cachePath);
      return pipelineAsync(fileStream, res);
    }

    // 3) Traer desde upstream en streaming (respetando Range)
    const fetchOptions = {
      // forward headers mínimas
      headers: {},
      // no redirect handling special
    };
    if (req.headers.range) fetchOptions.headers.Range = req.headers.range;
    // agregar user-agent simple
    fetchOptions.headers["user-agent"] =
      req.headers["user-agent"] || "MediaFlow-Proxy/1.0";

    const upstreamRes = await fetch(target, fetchOptions);

    // si el upstream responde 403/401/404, devolvemos su status y body (texto)
    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      const bodyText = await upstreamRes.text().catch(() => "");
      console.warn("Upstream error", upstreamRes.status, bodyText.substring(0, 200));
      res.status(upstreamRes.status).json({
        error: "Error al obtener el origen",
        status: upstreamRes.status,
        body: bodyText,
      });
      return;
    }

    // Pasar headers basicos al cliente
    const headersToForward = ["content-type", "content-length", "accept-ranges", "content-range", "cache-control"];
    for (const [k, v] of upstreamRes.headers) {
      if (headersToForward.includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    res.status(upstreamRes.status);

    // Decide si cachear: solo si tamaño conocido y < DISK_CACHE_MAX_FILE y no hay Range
    const contentLength = parseInt(upstreamRes.headers.get("content-length") || "0", 10);
    const shouldCacheToDisk = contentLength > 0 && contentLength <= DISK_CACHE_MAX_FILE && !req.headers.range;

    // Si es pequeño (ej. < 5MB) también lo guardamos en RAM para la próxima
    const RAM_CACHE_LIMIT = 5 * 1024 * 1024; // 5MB
    const shouldCacheToRAM = contentLength > 0 && contentLength <= RAM_CACHE_LIMIT && !req.headers.range;

    // Convertir Fetch's web.ReadableStream a Node Readable si hace falta
    let upstreamNodeStream;
    if (typeof upstreamRes.body.pipe === "function") {
      // ya es Node stream
      upstreamNodeStream = upstreamRes.body;
    } else {
      // es WHATWG stream -> convertir
      upstreamNodeStream = stream.Readable.from(upstreamRes.body);
    }

    if (shouldCacheToDisk) {
      // creamos un archivo temporal y pipeamos upstream -> disco y upstream -> cliente simultáneo
      const tmpPath = cachePath + ".tmp";
      const writeStream = fs.createWriteStream(tmpPath);

      // usamos pipeline duplicado: duplicar stream a dos destinos con PassThrough
      const pass = new stream.PassThrough();
      // upstream -> pass
      upstreamNodeStream.pipe(pass);

      // pass -> cliente AND pass -> file
      const passToFile = new stream.PassThrough();
      pass.pipe(passToFile);
      pass.pipe(res); // cliente
      const filePromise = pipelineAsync(passToFile, writeStream)
        .then(() => {
          // mover tmp a final
          fs.renameSync(tmpPath, cachePath);
          enforceDiskLimit();
          console.log("Guardado en cache disco:", cachePath);
        })
        .catch((e) => {
          console.warn("Error guardando cache disco:", e);
          // cleanup
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch(e){/*ignore*/ }
        });

      // Además, si debe guardarse en RAM (archivo muy pequeño), acumular en buffer
      if (shouldCacheToRAM) {
        const chunks = [];
        const r2 = new stream.PassThrough();
        pass.pipe(r2);
        r2.on("data", (c) => chunks.push(c));
        r2.on("end", () => {
          const all = Buffer.concat(chunks);
          const headersObj = {};
          for (const [k, v] of upstreamRes.headers) headersObj[k] = v;
          memoryCache.set(target, { headers: headersObj, body: [all], status: upstreamRes.status });
          console.log("Guardado en RAM:", target);
        });
      }

      // esperar a que termine envío al cliente
      // Si el cliente corta la conexión, pipeline se romperá y se manejará abajo.
      upstreamNodeStream.on("error", (e) => {
        console.error("Error stream upstream:", e);
      });
      return;
    } else {
      // No cache en disco: pipe directo upstream -> cliente.
      // Si queremos guardar en RAM (muy pequeño), duplicamos
      if (shouldCacheToRAM) {
        const chunks = [];
        const r = new stream.PassThrough();
        upstreamNodeStream.pipe(r);
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => {
          const all = Buffer.concat(chunks);
          const headersObj = {};
          for (const [k, v] of upstreamRes.headers) headersObj[k] = v;
          memoryCache.set(target, { headers: headersObj, body: [all], status: upstreamRes.status });
          console.log("Guardado en RAM:", target);
        });
        return pipelineAsync(r, res);
      } else {
        // directo, sin buffers
        return pipelineAsync(upstreamNodeStream, res);
      }
    }
  } catch (err) {
    console.error("Error interno en proxy:", err);
    try {
      if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy" });
      else res.end();
    } catch (e) {}
  }
}

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD: ${!!process.env.API_PASSWORD ? "SET" : "DEFAULT"})`);
});
