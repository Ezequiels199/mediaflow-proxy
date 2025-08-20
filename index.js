/**
 * index.js
 * Proxy de streaming + cache (Node 18+)
 *
 * Reemplaza tu index.js con este. Configurar env var:
 *   API_PASSWORD=superclave123
 *
 * Nota: algunos hosts (Akamai, Mixdrop, Streamtape...) pueden seguir bloqueando
 * ciertos recursos aunque se envíen headers "tipo navegador". Eso depende del CDN.
 */

const express = require("express");
const compression = require("compression");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pipeline } = require("stream");
const { promisify } = require("util");
const streamPipeline = promisify(pipeline);
const { PassThrough } = require("stream");

const app = express();
const PORT = process.env.PORT || 3000;

// Contraseña (preferible definir en ENV)
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";

// Caché en RAM para objetos pequeños (6 horas)
const memoryCache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 120 });

// Carpeta disco
const CACHE_DIR = path.join(process.cwd(), "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Límite disco (en bytes) — ajustar según tu plan (20GB por defecto)
const DISK_CACHE_LIMIT = parseInt(process.env.DISK_CACHE_LIMIT || String(20 * 1024 * 1024 * 1024), 10);

// Tamaño máximo para almacenar en RAM (ej: 10 MB)
const MAX_RAM_CACHE_BYTES = 10 * 1024 * 1024;

// Headers "tipo navegador" por defecto (reduce bloqueos)
function defaultBrowserHeaders(referer) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    Referer: referer || undefined,
  };
}

// Util: hash para nombre de archivo
function hashName(input) {
  return crypto.createHash("md5").update(input).digest("hex");
}

// Obtener uso disco
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

// Limpiar disco por LRU si supera límite
function enforceDiskLimit() {
  try {
    const { total, list } = getDiskUsage();
    if (total <= DISK_CACHE_LIMIT) return;
    console.log("⚠️ Disk cache exceeded. Cleaning oldest files...");
    list.sort((a, b) => a.mtime - b.mtime);
    let current = total;
    for (const item of list) {
      try {
        fs.unlinkSync(item.path);
        current -= item.size;
        if (current <= DISK_CACHE_LIMIT) break;
      } catch (e) {
        console.warn("No se pudo borrar archivo de cache:", item.path, e.message);
      }
    }
  } catch (e) {
    console.error("Error en enforceDiskLimit:", e);
  }
}

// Middleware: compresión y body parsers si necesitás
app.use(compression());

// Middleware: autenticación (para /proxy)
app.use("/proxy", (req, res, next) => {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"] ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : undefined);

  if (!API_PASSWORD) {
    console.warn("⚠️ API_PASSWORD no está seteada en env. Usando fallback (no seguro).");
  }

  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Ruta: /proxy/<URL_ENCODEADA_O_DIRECTA>
app.get("/proxy/*", async (req, res) => {
  try {
    // target puede venir como /proxy/https://dominio/... (req.params[0])
    let target = req.params[0] || req.query.url;
    if (!target) {
      return res.status(400).json({ error: "Falta URL objetivo" });
    }

    // A veces el navegador envía el path con espacios codificados; decodificamos
    try {
      target = decodeURIComponent(target);
    } catch (e) {
      // ignore
    }

    // comprobar esquema
    if (!/^https?:\/\//i.test(target)) {
      return res.status(400).json({ error: "La URL objetivo debe empezar por http:// o https://" });
    }

    // nombre de cache
    const name = hashName(target) + ".cache";
    const filePath = path.join(CACHE_DIR, name);

    // Forward Range if present
    const rangeHeader = req.headers.range;

    // Primero: intentar RAM cache para respuestas pequeñas
    const ramCached = memoryCache.get(target);
    if (ramCached && !rangeHeader) {
      console.log("Sirviendo desde RAM:", target);
      // enviar headers guardados (sin campos problemáticos)
      for (const [k, v] of Object.entries(ramCached.headers || {})) {
        if (k.toLowerCase() === "transfer-encoding") continue;
        res.setHeader(k, v);
      }
      res.status(200).send(ramCached.body);
      return;
    }

    // Segundo: si existe archivo en disco y NO hay Range -> usarlo
    if (fs.existsSync(filePath) && !rangeHeader) {
      console.log("Sirviendo desde DISCO:", target);
      const stat = fs.statSync(filePath);
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      const read = fs.createReadStream(filePath);
      return streamPipeline(read, res).catch((err) => {
        console.error("Error al enviar desde disco:", err);
        if (!res.headersSent) res.status(500).json({ error: "Error al leer cache disco" });
      });
    }

    // Si llegamos acá: hacemos fetch al origen con headers de navegador
    console.log("Descargando desde origen:", target, rangeHeader ? "(Range)" : "");
    const upstreamHeaders = {
      ...defaultBrowserHeaders(req.get("referer") || target),
      ...(rangeHeader ? { Range: rangeHeader } : {}),
      // Pasamos algunos headers del cliente si son relevantes
      "Accept": req.headers.accept || "*/*",
    };

    // Usar global fetch (Node 18+). Si no está, esto fallará.
    if (typeof fetch !== "function") {
      throw new Error("fetch no disponible en este runtime. Usar Node 18+ o instalar node-fetch.");
    }

    const upstreamResp = await fetch(target, {
      method: "GET",
      headers: upstreamHeaders,
      // timeout no nativo: se puede manejar vía AbortController si se quiere
    });

    // Si origen responde con error (401/403/4xx/5xx) devolvemos información
    if (!upstreamResp.ok) {
      const bodyText = await upstreamResp.text().catch(() => "");
      console.warn("Upstream responded with status", upstreamResp.status);
      return res.status(upstreamResp.status).json({
        error: `Error al obtener el origen`,
        status: upstreamResp.status,
        body: bodyText,
      });
    }

    // Reenviamos headers importantes al cliente
    upstreamResp.headers.forEach((value, key) => {
      // proteger de headers que rompen el envío
      if (key.toLowerCase() === "content-encoding") return; // let compression middleware decidir
      if (key.toLowerCase() === "transfer-encoding") return;
      res.setHeader(key, value);
    });
    res.setHeader("Access-Control-Allow-Origin", "*");

    // Si el contenido es pequeño, lo cacheamos en RAM y disco opcionalmente.
    const contentLength = Number(upstreamResp.headers.get("content-length") || 0);
    const shouldCacheInRam = contentLength > 0 && contentLength <= MAX_RAM_CACHE_BYTES && !rangeHeader;

    // Si es pequeño -> buffer completo en memoria (rápido para varios requests)
    if (shouldCacheInRam) {
      const buffer = Buffer.from(await upstreamResp.arrayBuffer());
      // guardar en RAM
      memoryCache.set(target, {
        headers: Object.fromEntries(upstreamResp.headers.entries()),
        body: buffer,
      });
      // guardar en disco también (opcional)
      try {
        fs.writeFileSync(filePath, buffer);
        enforceDiskLimit();
      } catch (e) {
        console.warn("No se pudo escribir cache disco (pequeño):", e.message);
      }
      res.status(upstreamResp.status).send(buffer);
      return;
    }

    // Para archivos grandes: hacemos streaming. Duplicamos el stream:
    // response.body -> pipe a res AND a archivo en disco (si se quiere).
    const bodyStream = upstreamResp.body;
    if (!bodyStream) {
      return res.status(500).json({ error: "Origen no devolvió body" });
    }

    // Si queremos cachear en disco (archivo grande), lo escribimos mientras enviamos.
    // NOTA: esto puede consumir espacio en disco; enforceDiskLimit() después.
    const writeToDisk = true; // ajustar según preferencia
    let fileWriteStream = null;
    if (writeToDisk) {
      try {
        fileWriteStream = fs.createWriteStream(filePath);
      } catch (e) {
        console.warn("No se pudo crear write stream disco:", e.message);
        fileWriteStream = null;
      }
    }

    // duplicador: passtrough para enviar al cliente
    const clientPass = new PassThrough();

    // si tenemos fileWriteStream, también hacemos pipe hacia allá
    bodyStream.pipe(clientPass);
    if (fileWriteStream) {
      bodyStream.pipe(fileWriteStream).on("error", (err) => {
        console.warn("Error escribiendo cache disco (stream):", err.message);
      });
    }

    // Enviar al cliente con pipeline para capturar errores
    res.status(upstreamResp.status);
    streamPipeline(clientPass, res).catch((err) => {
      // Si el cliente corta la conexión, puede caer aquí
      console.warn("Error en pipeline cliente:", err.message);
      // cleanup: si fileWriteStream existe y el archivo es parcial, lo dejamos o borramos según pref
      try {
        if (fileWriteStream) fileWriteStream.close();
      } catch (e) {}
    });

    // Cuando termine de escribir al disco, aplicamos política de limpieza
    if (fileWriteStream) {
      fileWriteStream.on("finish", () => {
        enforceDiskLimit();
      });
    }
  } catch (err) {
    console.error("Error interno en proxy:", err && err.stack ? err.stack : err);
    // si ya se enviaron headers, intenta terminar la conexión; sino responde JSON
    try {
      if (!res.headersSent) res.status(500).json({ error: "Error interno en proxy" });
      else res.end();
    } catch (e) {}
  }
});

// Ruta simple para comprobar que está vivo
app.get("/", (req, res) => {
  res.json({ ok: true, note: "MediaFlow Proxy (robusto). Protegido por contraseña." });
});

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en :${PORT} (API_PASSWORD: ${API_PASSWORD ? "SET" : "NOT SET"})`);
});
