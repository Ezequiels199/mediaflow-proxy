// index.mjs
import express from "express";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { fetch } from "undici";
import { pipeline } from "node:stream/promises";
import LRU from "lru-cache";
import url from "node:url";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import dns from "node:dns/promises";
import net from "node:net";

// ====== CONFIG MEJORADA ======
const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.MEDIAFLOW_PASSWORD || "mipassword";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(o => o.trim());
const MAX_RAM_CACHE_MB = parseInt(process.env.MAX_RAM_CACHE_MB || "256", 10);
const CACHE_TTL_HOURS = parseInt(process.env.CACHE_TTL_HOURS || "6", 10);
const MAX_CACHE_ITEM_SIZE_MB = parseInt(process.env.MAX_CACHE_ITEM_SIZE_MB || "10", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const ENABLE_RATE_LIMIT = process.env.ENABLE_RATE_LIMIT !== "false";

const USER_AGENT =
  process.env.ORIGIN_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// ====== CACHÉ MEJORADO (con métricas manuales) ======
function createLRUWithMetrics(opts) {
  const cache = new LRU(opts);
  cache._metrics = { hits: 0, misses: 0, requests: 0 };
  const originalGet = cache.get.bind(cache);
  cache.get = function(key) {
    cache._metrics.requests++;
    const val = originalGet(key);
    if (val === undefined) cache._metrics.misses++;
    else cache._metrics.hits++;
    return val;
  };
  cache.getMetrics = () => {
    return {
      hits: cache._metrics.hits,
      misses: cache._metrics.misses,
      requests: cache._metrics.requests,
      // itemCount y size aproximada
      itemCount: cache.size || 0,
      // lru-cache v10 expone .calculatedSize; si no existe, 0
      size: cache.calculatedSize || 0
    };
  };
  return cache;
}

const ramCache = createLRUWithMetrics({
  max: MAX_RAM_CACHE_MB * 1024 * 1024,
  length: (v) => (v?.body?.length || 0) + JSON.stringify(v?.headers || {}).length + 100,
  ttl: 1000 * 60 * 60 * CACHE_TTL_HOURS,
  updateAgeOnGet: true,
  allowStale: false,
});

const manifestCache = createLRUWithMetrics({
  max: 50 * 1024 * 1024,
  length: (v) => v?.body?.length || 0,
  ttl: 1000 * 60 * 60 * 2,
  updateAgeOnGet: true,
});

// ====== UTILIDADES ======
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.ts', '.m2ts', '.vob', '.ogv', '.3gp', '.f4v'
]);

const SUPPORTED_PLAYLIST_EXTENSIONS = new Set([
  '.m3u8', '.m3u', '.mpd'
]);

function isVideoUrl(u) {
  try {
    const parsed = new URL(u);
    const parts = parsed.pathname.toLowerCase().split('.');
    const ext = parts.length > 1 ? '.' + parts.pop() : '';
    return SUPPORTED_VIDEO_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isPlaylistUrl(u) {
  try {
    const parsed = new URL(u);
    const parts = parsed.pathname.toLowerCase().split('.');
    const ext = parts.length > 1 ? '.' + parts.pop() : '';
    return SUPPORTED_PLAYLIST_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function toAbsolute(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

function generateCacheKey(u, headers = {}) {
  const relevantHeaders = ['range', 'accept', 'accept-encoding'];
  const headerStr = relevantHeaders
    .map(h => (headers[h] || headers[h.toLowerCase()] || ''))
    .join('|');
  return crypto.createHash('md5').update(`${u}|${headerStr}`).digest('hex');
}

function redactUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    ['token','signature','sig','expires','password','api_key','key','auth'].forEach(p => u.searchParams.delete(p));
    return u.toString();
  } catch {
    return urlStr;
  }
}

// ====== SSRF / IP PRIVADA CHECK ======
const PRIVATE_RANGES_RE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i
];

async function isIpPrivateOrLocal(host) {
  try {
    // si ya es IP directa
    if (net.isIP(host)) {
      return PRIVATE_RANGES_RE.some(r => r.test(host));
    }
    const addrs = [];
    try {
      const a = await dns.resolve4(host);
      addrs.push(...a);
    } catch {}
    try {
      const a6 = await dns.resolve6(host);
      addrs.push(...a6);
    } catch {}
    for (const ip of addrs) {
      for (const r of PRIVATE_RANGES_RE) {
        if (r.test(ip)) return true;
      }
    }
    return false;
  } catch (err) {
    console.warn("isIpPrivateOrLocal error:", err.message);
    // si hay error en la resolución, por seguridad bloquear
    return true;
  }
}

// ====== RETRY LOGIC robusta ======
async function fetchWithRetry(u, options = {}, retries = MAX_RETRIES) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(u, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      // Si status < 500 o ok -> devolvemos
      if (response.ok || response.status < 500) return response;

      // else 5xx -> reintentar salvo último intento
      lastErr = new Error(`Upstream status ${response.status}`);
      if (i === retries) return response;

      // backoff con jitter
      const backoff = Math.min(30000, Math.pow(2, i) * 1000);
      const jitter = Math.floor(Math.random() * 300);
      await new Promise(r => setTimeout(r, backoff + jitter));
    } catch (err) {
      lastErr = err;
      if (err.name === 'AbortError') {
        // timeout: si es el último intento, propagar
        if (i === retries) throw err;
      } else {
        // otros errores, reintentar si quedan intentos
        if (i === retries) throw err;
      }
      const backoff = Math.min(30000, Math.pow(2, i) * 1000);
      const jitter = Math.floor(Math.random() * 300);
      await new Promise(r => setTimeout(r, backoff + jitter));
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("fetchWithRetry fallo inesperado");
}

// ====== APP SETUP ======
const app = express();
app.disable("x-powered-by");
app.set('trust proxy', 1);

if (ENABLE_RATE_LIMIT) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Demasiadas peticiones, intenta de nuevo más tarde' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));

app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    // no comprimir video/binary
    const ct = (res.getHeader && res.getHeader('content-type')) || '';
    if (typeof ct === 'string' && (ct.startsWith('video/') || ct.startsWith('application/octet-stream'))) return false;
    return compression.filter(req, res);
  }
}));

app.use(morgan("combined"));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,Authorization,X-Requested-With,X-API-Password");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// HEALTH
app.get("/", (req, res) => {
  const ramMetrics = ramCache.getMetrics();
  const manifestMetrics = manifestCache.getMetrics();
  const stats = {
    ramCache: {
      size: ramMetrics.size,
      itemCount: ramMetrics.itemCount,
      hits: ramMetrics.hits,
      misses: ramMetrics.misses,
      requests: ramMetrics.requests,
      hitRatio: (ramMetrics.hits + ramMetrics.misses) > 0 ? ((ramMetrics.hits / (ramMetrics.hits + ramMetrics.misses)) * 100).toFixed(2) + '%' : '0%'
    },
    manifestCache: {
      size: manifestMetrics.size,
      itemCount: manifestMetrics.itemCount
    },
    uptime: process.uptime(),
    memory: process.memoryUsage()
  };

  res.json({
    ok: true,
    service: "MediaFlow Proxy PRO",
    version: "2.0.0",
    stats,
    endpoints: {
      proxy: "/proxy?url=ENCODED_URL&password=***",
      hls: "/hls?url=ENCODED_M3U8&password=***",
      health: "/health",
      stats: "/stats"
    }
  });
});

// STATS endpoint
app.get("/stats", (req, res) => {
  if (!checkAuth(req, res)) return;
  const ramMetrics = ramCache.getMetrics();
  const manifestMetrics = manifestCache.getMetrics();
  res.json({
    cache: {
      ram: {
        itemCount: ramMetrics.itemCount,
        size: ramMetrics.size,
        hits: ramMetrics.hits,
        misses: ramMetrics.misses,
        requests: ramMetrics.requests,
        hitRatio: (ramMetrics.hits + ramMetrics.misses) > 0 ? ((ramMetrics.hits / (ramMetrics.hits + ramMetrics.misses)) * 100).toFixed(2) + '%' : '0%'
      },
      manifest: {
        itemCount: manifestMetrics.itemCount,
        size: manifestMetrics.size
      }
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version
    }
  });
});

// ====== AUTH ======
function checkAuth(req, res) {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"] ||
    (req.headers["authorization"] ? req.headers["authorization"].replace("Bearer ", "") : "") ||
    "";
  if (pass !== PASSWORD) {
    res.status(401).json({
      error: "Autenticación requerida",
      message: "Proporciona la contraseña via ?password=, ?api_password=, header X-API-Password o Authorization Bearer"
    });
    return false;
  }
  return true;
}

// ====== PROXY GENÉRICO ======
app.get("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: "URL requerida", usage: "/proxy?url=ENCODED_URL&password=***" });
  }

  try {
    const parsed = new URL(target);
    const host = parsed.hostname;
    if (await isIpPrivateOrLocal(host)) {
      return res.status(403).json({ error: "Destino no permitido (dirección privada)" });
    }
  } catch {
    return res.status(400).json({ error: "URL inválida" });
  }

  const cacheKey = generateCacheKey(target, req.headers);

  try {
    const cached = ramCache.get(cacheKey);
    if (cached && !req.headers.range) {
      // servir desde caché
      Object.entries(cached.headers || {}).forEach(([k, v]) => {
        if (k.toLowerCase() !== "content-length") res.setHeader(k, v);
      });
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Length", cached.body.length);
      return res.status(cached.status || 200).end(cached.body);
    }

    console.log(`Cache MISS: ${redactUrl(target)}`);

    const headers = {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Encoding": "identity"
    };

    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers.referer) headers.Referer = req.headers.referer;
    if (req.headers.origin) headers.Origin = req.headers.origin;

    const response = await fetchWithRetry(target, { headers, redirect: "follow" });

    const passthroughHeaders = [
      "content-type", "content-length", "accept-ranges", "content-range",
      "etag", "last-modified", "cache-control", "expires"
    ];

    const responseHeaders = {};
    for (const header of passthroughHeaders) {
      const value = response.headers.get(header);
      if (value) {
        res.setHeader(header, value);
        responseHeaders[header] = value;
      }
    }

    res.setHeader("X-Proxy-Status", String(response.status));
    res.setHeader("X-Cache", "MISS");
    res.status(response.status);

    const contentLength = Number(response.headers.get("content-length") || "0");
    const maxCacheSize = MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024;

    if (!req.headers.range && contentLength > 0 && contentLength <= maxCacheSize && response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      ramCache.set(cacheKey, {
        status: response.status,
        headers: responseHeaders,
        body: buffer,
        timestamp: Date.now()
      });
      return res.end(buffer);
    }

    // stream directo
    if (response.body) {
      await pipeline(response.body, res);
    } else {
      res.end();
    }

  } catch (error) {
    console.error(`Proxy error for ${redactUrl(target)}:`, error?.message || error);
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: "Timeout al obtener recurso" });
    }
    res.status(502).json({
      error: "No se pudo obtener el recurso",
      details: process.env.NODE_ENV === 'development' ? (error?.message || String(error)) : undefined
    });
  }
});

// ====== HLS ======
app.get("/hls", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const playlistUrl = req.query.url;
  if (!playlistUrl) {
    return res.status(400).json({ error: "URL de playlist requerida", usage: "/hls?url=ENCODED_M3U8&password=***" });
  }

  try {
    const parsed = new URL(playlistUrl);
    const host = parsed.hostname;
    if (await isIpPrivateOrLocal(host)) {
      return res.status(403).json({ error: "Destino no permitido (dirección privada)" });
    }
  } catch {
    return res.status(400).json({ error: "URL de playlist inválida" });
  }

  const cacheKey = `hls:${playlistUrl}`;

  try {
    const cached = manifestCache.get(cacheKey);
    if (cached) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("X-Cache", "HIT");
      return res.status(200).end(cached.body);
    }

    console.log(`Manifest Cache MISS: ${redactUrl(playlistUrl)}`);

    const response = await fetchWithRetry(playlistUrl, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
      },
      redirect: "follow"
    });

    if (!response.ok) {
      return res.status(502).json({ error: `El origen devolvió ${response.status}`, url: playlistUrl });
    }

    const originalText = await response.text();
    const base = playlistUrl;
    const proxyBase = `${req.protocol}://${req.get("host")}`;
    const passwordParam = `password=${encodeURIComponent(PASSWORD)}`;

    const rewrittenLines = originalText.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      const absoluteUrl = toAbsolute(base, trimmed);
      if (!absoluteUrl) return line;

      if (isPlaylistUrl(absoluteUrl)) {
        return `${proxyBase}/hls?url=${encodeURIComponent(absoluteUrl)}&${passwordParam}`;
      } else {
        return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}&${passwordParam}`;
      }
    });

    const rewrittenText = rewrittenLines.join('\n');
    const buffer = Buffer.from(rewrittenText, 'utf-8');

    manifestCache.set(cacheKey, { body: buffer, timestamp: Date.now() });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("X-Cache", "MISS");
    res.status(200).end(buffer);

  } catch (error) {
    console.error(`HLS error for ${redactUrl(playlistUrl)}:`, error?.message || error);
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: "Timeout al procesar playlist" });
    }
    res.status(502).json({
      error: "No se pudo procesar la playlist HLS",
      details: process.env.NODE_ENV === 'development' ? (error?.message || String(error)) : undefined
    });
  }
});

// ====== HEAD request ======
app.head("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const target = req.query.url;
  if (!target) return res.status(400).end();

  try {
    const parsed = new URL(target);
    const host = parsed.hostname;
    if (await isIpPrivateOrLocal(host)) {
      return res.status(403).end();
    }
  } catch {
    return res.status(400).end();
  }

  try {
    const response = await fetchWithRetry(target, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT, "Accept": "*/*" },
      redirect: "follow"
    });

    const passthroughHeaders = ["content-type", "content-length", "accept-ranges", "etag", "last-modified", "cache-control"];
    passthroughHeaders.forEach(header => {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    res.setHeader("X-Proxy-Status", String(response.status));
    return res.status(response.status).end();

  } catch (error) {
    console.error(`HEAD error for ${redactUrl(target)}:`, error?.message || error);
    return res.status(502).end();
  }
});

// ====== GLOBAL ERROR HANDLER ======
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err?.stack || err);
  res.status(500).json({
    error: 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

// ====== START SERVER y GRACEFUL SHUTDOWN ======
const server = app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO v2.0 corriendo en puerto ${PORT}`);
  console.log(`📊 Caché RAM: ${MAX_RAM_CACHE_MB}MB | Timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`🔒 Rate Limiting: ${ENABLE_RATE_LIMIT ? 'Habilitado' : 'Deshabilitado'}`);
  console.log(`🌍 CORS Origins: ${ALLOWED_ORIGINS.join(', ')}`);
});

function tryCloseAndExit() {
  if (!server) {
    console.log("Server no inicializado aun, saliendo");
    process.exit(0);
  }
  console.log('Cerrando servidor...');
  server.close(err => {
    if (err) {
      console.error('Error cerrando server:', err);
      process.exit(1);
    }
    console.log('Servidor cerrado exitosamente');
    process.exit(0);
  });
}

process.on('SIGTERM', tryCloseAndExit);
process.on('SIGINT', tryCloseAndExit);
