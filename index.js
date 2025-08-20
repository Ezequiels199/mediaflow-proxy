// ==========================================
// MediaFlow Addon / Proxy PRO (seguro y robusto)
// ==========================================
//
// ✔ /manifest.json  -> manifiesto addon (Stremio compatible)
// ✔ /catalog/...    -> catálogos de ejemplo (no requieren scraping)
// ✔ /stream/...     -> streams de ejemplo (urls de muestra)
// ✔ /proxy          -> proxy genérico con streaming, Range, timeouts
// ✔ /proxy/ip       -> endpoint de validación (MediaFusion)
// ✔ /health         -> healthcheck
//
// NOTA IMPORTANTE:
// - No incluye resolvers/scrapers de hosts con protecciones (Mixdrop/Streamtape/Dood/etc.).
//   Puedo ayudarte con el pipeline de proxy, buffering, headers y rendimiento,
//   pero no con bypass de tokens, captchas o cifrados.
//
// Requisitos: Node 16+
// Dependencias: express, helmet, compression, cors, node-fetch, morgan, express-rate-limit
//
// Sugerido en package.json:
//   "type": "module",
//   "scripts": { "start": "node index.js" }
//
// Variables de entorno:
//   PORT             -> puerto (default 3000)
//   API_PASSWORD     -> contraseña para /proxy y /proxy/ip (default "superclave123")
//   REQUEST_TIMEOUT  -> ms para timeout de fetch (default 15000)
//   MAX_BODY_SIZE_MB -> límite body parsers (default 100)
//
// ==========================================

import express from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import fetch, { Headers } from "node-fetch";

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 3000;
const API_PASSWORD = process.env.API_PASSWORD || "superclave123";
const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 15000);
const MAX_BODY_SIZE_MB = Number(process.env.MAX_BODY_SIZE_MB || 100);

// Seguridad + perf
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: false, // para evitar problemas con respuestas proxied
}));
app.use(compression());
app.use(cors({
  origin: "*",
  methods: ["GET", "HEAD", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Range", "User-Agent", "Accept", "Accept-Encoding", "X-Requested-With"]
}));

// Parsers (aunque casi todo es GET/stream)
app.use(express.json({ limit: `${MAX_BODY_SIZE_MB}mb` }));
app.use(express.urlencoded({ extended: true, limit: `${MAX_BODY_SIZE_MB}mb` }));

// Logs
app.use(morgan(":method :url :status :res[content-length] - :response-time ms"));

// Rate limit (protege tu instancia gratis)
const limiter = rateLimit({
  windowMs: 60_000, // 1 min
  max: 120,         // 120 req/min por IP
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ---------- Utilidades ----------
function authOk(req) {
  const pass = req.query.api_password || req.headers["x-api-password"];
  return pass === API_PASSWORD;
}

function unauthorized(res) {
  return res.status(401).json({ error: "Unauthorized" });
}

function buildForwardHeaders(req) {
  const h = new Headers();
  // User-Agent “realista” para evitar bloqueos tontos
  h.set("User-Agent", req.headers["user-agent"] || "Mozilla/5.0 (MediaFlow-Proxy)");
  // Range passthrough (para saltar en el video)
  if (req.headers.range) h.set("Range", req.headers.range);
  // Aceptación/brotli/gzip
  if (req.headers["accept"]) h.set("Accept", req.headers["accept"]);
  if (req.headers["accept-encoding"]) h.set("Accept-Encoding", req.headers["accept-encoding"]);
  if (req.headers["accept-language"]) h.set("Accept-Language", req.headers["accept-language"]);
  if (req.headers["referer"]) h.set("Referer", req.headers["referer"]);
  if (req.headers["origin"]) h.set("Origin", req.headers["origin"]);
  // Cookies opcionales si las pasás explícitamente (¡cuidado!)
  if (req.headers["x-forward-cookies"]) h.set("Cookie", String(req.headers["x-forward-cookies"]));
  return h;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function passThroughHeaders(srcHeaders, res) {
  // Encabezados útiles para streaming
  const keys = [
    "content-type",
    "content-length",
    "accept-ranges",
    "content-range",
    "cache-control",
    "last-modified",
    "etag",
    "expires"
  ];
  for (const k of keys) {
    const v = srcHeaders.get(k);
    if (v) res.setHeader(k, v);
  }
  // No-cache por defecto si el origen no define
  if (!srcHeaders.get("cache-control")) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
  }
}

// ---------- Endpoints básicos ----------
app.get("/", (_req, res) => {
  res.json({
    name: "MediaFlow Proxy PRO",
    status: "ok",
    endpoints: {
      manifest: "/manifest.json",
      health: "/health",
      proxy: "/proxy?url=...&api_password=...",
      ipCheck: "/proxy/ip?api_password=..."
    }
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", uptime: process.uptime() });
});

// Validación para MediaFusion (lo que te tiraba 404)
app.get("/proxy/ip", (req, res) => {
  if (!authOk(req)) return unauthorized(res);
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    req.connection?.remoteAddress ||
    "0.0.0.0";
  res.json({ ip, status: "ok" });
});

// ---------- Proxy genérico (STREAMING) ----------
// Uso: /proxy?url=https://dominio/video.mp4&api_password=superclave123
// Soporta Range, timeouts, y pasa headers clave.
app.get("/proxy", async (req, res) => {
  try {
    if (!authOk(req)) return unauthorized(res);
    const targetUrl = req.query.url;
    if (!targetUrl || typeof targetUrl !== "string") {
      return res.status(400).json({ error: "Falta parámetro ?url=" });
    }

    // HEAD (opcional) para obtener metadatos rápidos si pedís ?head=1
    if (req.query.head === "1") {
      const headResp = await fetchWithTimeout(targetUrl, {
        method: "HEAD",
        headers: buildForwardHeaders(req)
      });
      if (!headResp.ok) {
        return res.status(headResp.status).json({ error: `HEAD ${headResp.status}` });
      }
      const info = {
        contentType: headResp.headers.get("content-type"),
        contentLength: headResp.headers.get("content-length"),
        acceptRanges: headResp.headers.get("accept-ranges"),
        lastModified: headResp.headers.get("last-modified"),
        etag: headResp.headers.get("etag")
      };
      return res.json(info);
    }

    // GET streaming
    const upstream = await fetchWithTimeout(targetUrl, {
      method: "GET",
      headers: buildForwardHeaders(req),
      redirect: "follow"
    });

    // Si el origen responde 206 (parcial), lo respetamos
    res.status(upstream.status);

    passThroughHeaders(upstream.headers, res);

    // Pipea cuerpo (stream grande)
    if (upstream.body) {
      upstream.body.on("error", (e) => {
        console.error("Upstream stream error:", e?.message || e);
        if (!res.headersSent) res.status(502);
        res.end();
      });
      upstream.body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    const code = err.name === "AbortError" ? 504 : 500;
    console.error("Proxy error:", err?.message || err);
    res.status(code).json({ error: code === 504 ? "Gateway Timeout" : "Proxy error" });
  }
});

// ---------- Manifiesto (addon) ----------
const manifest = {
  id: "org.mediaflow.proxypro",
  version: "1.0.0",
  name: "MediaFlow Proxy PRO",
  description: "Addon de ejemplo + proxy robusto (sin scrapers de terceros).",
  resources: ["catalog", "stream"],
  types: ["movie", "series"],
  idPrefixes: ["mf"],
  catalogs: [
    { type: "movie", id: "mf_movies", name: "MediaFlow Movies" },
    { type: "series", id: "mf_series", name: "MediaFlow Series" }
  ]
};

app.get("/manifest.json", (_req, res) => {
  res.json(manifest);
});

// ---------- Catálogos de ejemplo (no scraping) ----------
app.get("/catalog/:type/:id.json", (req, res) => {
  const { type, id } = req.params;

  if (type === "movie" && id === "mf_movies") {
    return res.json({
      metas: [
        {
          id: "mf:movie:demo1",
          type: "movie",
          name: "Demo Movie 1",
          poster: "https://via.placeholder.com/300x450?text=Demo+Movie+1"
        },
        {
          id: "mf:movie:demo2",
          type: "movie",
          name: "Demo Movie 2",
          poster: "https://via.placeholder.com/300x450?text=Demo+Movie+2"
        }
      ]
    });
  }

  if (type === "series" && id === "mf_series") {
    return res.json({
      metas: [
        {
          id: "mf:series:demoS1",
          type: "series",
          name: "Demo Series 1",
          poster: "https://via.placeholder.com/300x450?text=Demo+Series+1"
        }
      ]
    });
  }

  return res.json({ metas: [] });
});

// ---------- Streams de ejemplo ----------
// No resuelve hosts protegidos. Si tenés un MP4/HLS tuyo, podés usar /proxy para servirlo.
app.get("/stream/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;

  // Acá armamos una respuesta de ejemplo para que Stremio vea streams
  // Si querés usar tu propio archivo directo, ponelo en `url` o en `proxyUrl`.
  const demoDirect = "https://raw.githubusercontent.com/akiranmp/sample-videos/master/video/mp4/720/big_buck_bunny_720p_1mb.mp4";

  const proxyBase = `${req.protocol}://${req.get("host")}`;

  const streams = [
    {
      name: "Direct (demo)",
      title: "MP4 directo (demo)",
      url: demoDirect
    },
    {
      name: "Proxy (demo)",
      title: "MP4 vía proxy (Range soportado)",
      // protegé el proxy con api_password
      url: `${proxyBase}/proxy?url=${encodeURIComponent(demoDirect)}&api_password=${encodeURIComponent(API_PASSWORD)}`
    }
  ];

  // Si quisieras diferenciar por ID: (ejemplo)
  if (id.includes("demo2")) {
    // HLS de muestra (si el player lo soporta)
    const hls = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    streams.unshift({
      name: "HLS (demo)",
      title: "HLS directo (demo)",
      url: hls
    });
  }

  return res.json({ streams });
});

// ---------- Manejo de errores ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not Found" });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err?.stack || err);
  res.status(500).json({ error: "Internal Server Error" });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO escuchando en puerto ${PORT}`);
  console.log(`ℹ  Health:      http://localhost:${PORT}/health`);
  console.log(`ℹ  Manifest:    http://localhost:${PORT}/manifest.json`);
  console.log(`ℹ  IP Check:    http://localhost:${PORT}/proxy/ip?api_password=${API_PASSWORD}`);
  console.log(`ℹ  Proxy demo:  http://localhost:${PORT}/proxy?url=https://...&api_password=${API_PASSWORD}`);
});
