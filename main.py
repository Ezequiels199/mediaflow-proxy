// index.mjs
import express from "express";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { fetch } from "undici";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";
import LRU from "lru-cache";
import url from "node:url";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";

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

// ====== CACHÉ MEJORADO ======
const ramCache = new LRU({
  max: MAX_RAM_CACHE_MB * 1024 * 1024,
  length: (v) => (v?.body?.length || 0) + JSON.stringify(v.headers || {}).length + 100, // overhead estimado
  ttl: 1000 * 60 * 60 * CACHE_TTL_HOURS,
  updateAgeOnGet: true,
  allowStale: false,
});

// Caché separado para manifiestos (más pequeño, más tiempo)
const manifestCache = new LRU({
  max: 50 * 1024 * 1024, // 50MB solo para manifiestos
  length: (v) => v?.body?.length || 0,
  ttl: 1000 * 60 * 60 * 2, // 2h para manifiestos (cambian menos)
  updateAgeOnGet: true,
});

// ====== UTILIDADES MEJORADAS ======
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.ts', '.m2ts', '.vob', '.ogv', '.3gp', '.f4v'
]);

const SUPPORTED_PLAYLIST_EXTENSIONS = new Set([
  '.m3u8', '.m3u', '.mpd'
]);

function isVideoUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = parsed.pathname.toLowerCase().split('.').pop();
    return SUPPORTED_VIDEO_EXTENSIONS.has(`.${ext}`);
  } catch {
    return false;
  }
}

function isPlaylistUrl(url) {
  try {
    const parsed = new URL(url);
    const ext = parsed.pathname.toLowerCase().split('.').pop();
    return SUPPORTED_PLAYLIST_EXTENSIONS.has(`.${ext}`);
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

function generateCacheKey(url, headers = {}) {
  const relevantHeaders = ['range', 'accept', 'accept-encoding'];
  const headerStr = relevantHeaders
    .map(h => headers[h] || '')
    .join('|');
  return crypto
    .createHash('md5')
    .update(`${url}|${headerStr}`)
    .digest('hex');
}

// ====== RETRY LOGIC ======
async function fetchWithRetry(url, options = {}, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      
      // Solo reintentar en errores 5xx o timeouts
      if (response.ok || response.status < 500) {
        return response;
      }
      
      if (i === retries) return response; // último intento
      
      // Backoff exponencial
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      
    } catch (error) {
      if (i === retries) throw error;
      
      // Log del reintento
      console.warn(`Reintento ${i + 1}/${retries} para ${url}: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
    }
  }
}

// ====== APP SETUP MEJORADO ======
const app = express();
app.disable("x-powered-by");
app.set('trust proxy', 1); // Para rate limiting detrás de proxies

// Rate limiting
if (ENABLE_RATE_LIMIT) {
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // límite por ventana por IP
    message: { error: 'Demasiadas peticiones, intenta de nuevo más tarde' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use(limiter);
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);

app.use(compression({ 
  level: 6,
  threshold: 1024, // Solo comprimir archivos > 1KB
  filter: (req, res) => {
    // No comprimir streams de video
    const contentType = res.getHeader('content-type') || '';
    if (contentType.startsWith('video/') || contentType.startsWith('application/octet-stream')) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use(morgan("combined"));

// CORS mejorado
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,Authorization,X-Requested-With,X-API-Password");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges");
  res.setHeader("Access-Control-Max-Age", "86400"); // 24h preflight cache
  
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Health check mejorado
app.get("/", (req, res) => {
  const stats = {
    ramCache: {
      size: ramCache.size,
      itemCount: ramCache.itemCount,
      hitRatio: ramCache.calculatedSize > 0 ? (ramCache.hits / (ramCache.hits + ramCache.misses) * 100).toFixed(2) + '%' : '0%'
    },
    manifestCache: {
      size: manifestCache.size,
      itemCount: manifestCache.itemCount
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

// Endpoint de estadísticas
app.get("/stats", (req, res) => {
  if (!checkAuth(req, res)) return;
  
  res.json({
    cache: {
      ram: {
        size: ramCache.size,
        maxSize: MAX_RAM_CACHE_MB * 1024 * 1024,
        itemCount: ramCache.itemCount,
        hits: ramCache.hits || 0,
        misses: ramCache.misses || 0,
        hitRatio: ramCache.hits > 0 ? ((ramCache.hits / (ramCache.hits + ramCache.misses)) * 100).toFixed(2) + '%' : '0%'
      },
      manifest: {
        size: manifestCache.size,
        itemCount: manifestCache.itemCount
      }
    },
    system: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: process.version
    }
  });
});

// Health check simple
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", timestamp: new Date().toISOString() });
});

// ====== AUTH MEJORADA ======
function checkAuth(req, res) {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"] ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
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

// ====== PROXY GENÉRICO MEJORADO ======
app.get("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ 
      error: "URL requerida",
      usage: "/proxy?url=ENCODED_URL&password=***"
    });
  }

  try {
    // Validar URL
    new URL(target); // throws si es inválida
  } catch {
    return res.status(400).json({ error: "URL inválida" });
  }

  const cacheKey = generateCacheKey(target, req.headers);
  
  try {
    // Cache hit
    const cached = ramCache.get(cacheKey);
    if (cached && !req.headers.range) { // No cachear requests con Range
      console.log(`Cache HIT: ${target}`);
      
      Object.entries(cached.headers || {}).forEach(([k, v]) => {
        if (k.toLowerCase() !== "content-length") {
          res.setHeader(k, v);
        }
      });
      
      res.setHeader("X-Cache", "HIT");
      res.setHeader("Content-Length", cached.body.length);
      return res.status(cached.status || 200).end(cached.body);
    }

    console.log(`Cache MISS: ${target}`);
    
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept": "*/*",
      "Accept-Encoding": "identity", // Evitar compresión automática
    };
    
    // Propagar headers importantes
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers.referer) headers.Referer = req.headers.referer;
    if (req.headers.origin) headers.Origin = req.headers.origin;

    const response = await fetchWithRetry(target, { headers });

    // Headers que queremos pasar al cliente
    const passthroughHeaders = [
      "content-type", "content-length", "accept-ranges", "content-range",
      "etag", "last-modified", "cache-control", "expires"
    ];
    
    const responseHeaders = {};
    passthroughHeaders.forEach(header => {
      const value = response.headers.get(header);
      if (value) {
        res.setHeader(header, value);
        responseHeaders[header] = value;
      }
    });

    res.setHeader("X-Proxy-Status", response.status);
    res.setHeader("X-Cache", "MISS");
    res.status(response.status);

    const contentLength = Number(response.headers.get("content-length") || "0");
    const maxCacheSize = MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024;
    
    // Cachear solo si es pequeño Y no es un Range request
    if (!req.headers.range && 
        contentLength > 0 && 
        contentLength <= maxCacheSize &&
        response.ok) {
      
      const buffer = Buffer.from(await response.arrayBuffer());
      
      ramCache.set(cacheKey, {
        status: response.status,
        headers: responseHeaders,
        body: buffer,
        timestamp: Date.now()
      });
      
      return res.end(buffer);
    }

    // Stream directo para archivos grandes o Range requests
    if (response.body) {
      await pipeline(response.body, res);
    } else {
      res.end();
    }
    
  } catch (error) {
    console.error(`Proxy error for ${target}:`, error.message);
    
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: "Timeout al obtener recurso" });
    }
    
    res.status(502).json({ 
      error: "No se pudo obtener el recurso",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ====== HLS MEJORADO ======
app.get("/hls", async (req, res) => {
  if (!checkAuth(req, res)) return;
  
  const playlistUrl = req.query.url;
  if (!playlistUrl) {
    return res.status(400).json({ 
      error: "URL de playlist requerida",
      usage: "/hls?url=ENCODED_M3U8&password=***"
    });
  }

  try {
    new URL(playlistUrl);
  } catch {
    return res.status(400).json({ error: "URL de playlist inválida" });
  }

  const cacheKey = `hls:${playlistUrl}`;
  
  try {
    // Cache hit para manifiestos
    const cached = manifestCache.get(cacheKey);
    if (cached) {
      console.log(`Manifest Cache HIT: ${playlistUrl}`);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("X-Cache", "HIT");
      return res.status(200).end(cached.body);
    }

    console.log(`Manifest Cache MISS: ${playlistUrl}`);

    const response = await fetchWithRetry(playlistUrl, {
      headers: { 
        "User-Agent": USER_AGENT,
        "Accept": "application/vnd.apple.mpegurl,application/x-mpegURL,*/*"
      }
    });

    if (!response.ok) {
      return res.status(502).json({ 
        error: `El origen devolvió ${response.status}`,
        url: playlistUrl
      });
    }

    const originalText = await response.text();
    const base = playlistUrl;
    const proxyBase = `${req.protocol}://${req.get("host")}`;
    const passwordParam = `password=${encodeURIComponent(PASSWORD)}`;

    // Reescritura mejorada con mejor detección
    const rewrittenLines = originalText
      .split('\n')
      .map((line, index) => {
        const trimmed = line.trim();
        
        // Preservar comentarios y tags HLS
        if (!trimmed || trimmed.startsWith('#')) return line;
        
        // Intentar resolver URL relativa
        const absoluteUrl = toAbsolute(base, trimmed);
        if (!absoluteUrl) return line;

        // Detectar tipo de recurso y proxificar apropiadamente
        if (isPlaylistUrl(absoluteUrl)) {
          return `${proxyBase}/hls?url=${encodeURIComponent(absoluteUrl)}&${passwordParam}`;
        } else {
          return `${proxyBase}/proxy?url=${encodeURIComponent(absoluteUrl)}&${passwordParam}`;
        }
      });

    const rewrittenText = rewrittenLines.join('\n');
    const buffer = Buffer.from(rewrittenText, 'utf-8');

    // Cachear el manifiesto reescrito
    manifestCache.set(cacheKey, {
      body: buffer,
      timestamp: Date.now()
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("X-Cache", "MISS");
    res.status(200).end(buffer);
    
  } catch (error) {
    console.error(`HLS error for ${playlistUrl}:`, error.message);
    
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: "Timeout al procesar playlist" });
    }
    
    res.status(502).json({ 
      error: "No se pudo procesar la playlist HLS",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ====== HEAD REQUEST MEJORADO ======
app.head("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  
  const target = req.query.url;
  if (!target) return res.status(400).end();

  try {
    new URL(target);
  } catch {
    return res.status(400).end();
  }

  try {
    const response = await fetchWithRetry(target, {
      method: "HEAD",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "*/*"
      }
    });

    const passthroughHeaders = [
      "content-type", "content-length", "accept-ranges",
      "etag", "last-modified", "cache-control"
    ];
    
    passthroughHeaders.forEach(header => {
      const value = response.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    res.setHeader("X-Proxy-Status", response.status);
    res.status(response.status).end();
    
  } catch (error) {
    console.error(`HEAD error for ${target}:`, error.message);
    res.status(502).end();
  }
});

// ====== MANEJO DE ERRORES GLOBAL ======
app.use((error, req, res, next) => {
  console.error('Error no manejado:', error);
  res.status(500).json({ 
    error: 'Error interno del servidor',
    timestamp: new Date().toISOString()
  });
});

// ====== GRACEFUL SHUTDOWN ======
process.on('SIGTERM', () => {
  console.log('Recibida señal SIGTERM, cerrando servidor...');
  server.close(() => {
    console.log('Servidor cerrado exitosamente');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Recibida señal SIGINT, cerrando servidor...');
  server.close(() => {
    console.log('Servidor cerrado exitosamente');
    process.exit(0);
  });
});

// ====== INICIO DEL SERVIDOR ======
const server = app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO v2.0 corriendo en puerto ${PORT}`);
  console.log(`📊 Caché RAM: ${MAX_RAM_CACHE_MB}MB | Timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`🔒 Rate Limiting: ${ENABLE_RATE_LIMIT ? 'Habilitado' : 'Deshabilitado'}`);
  console.log(`🌍 CORS Origins: ${ALLOWED_ORIGINS.join(', ')}`);
});
