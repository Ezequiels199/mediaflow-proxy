#!/usr/bin/env node
/**
 * MediaFlow Proxy - Optimizado para Render Plan Gratuito
 * - Gestión agresiva de memoria para límites de 512MB
 * - Streaming directo para archivos grandes (>50MB)
 * - Cache inteligente solo para manifiestos y archivos pequeños
 * - Compression bypass para contenido multimedia
 * - Rate limiting adaptativo según recursos disponibles
 */

import express from "express";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { fetch } from "undici";
import { pipeline } from "node:stream/promises";
import LRU from "lru-cache";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import dns from "node:dns/promises";
import net from "node:net";
import process from "node:process";

// ====== CONFIG OPTIMIZADO PARA RENDER GRATUITO ======
const PORT = Number(process.env.PORT || 10000);
const PASSWORD = process.env.MEDIAFLOW_PASSWORD || "mipassword";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());

// Configuración agresiva de memoria para Render gratuito
const MAX_RAM_CACHE_MB = Math.min(Number(process.env.MAX_RAM_CACHE_MB || 64), 64); // Máximo 64MB
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 2); // Cache más corto
const MAX_CACHE_ITEM_SIZE_MB = 2; // Solo archivos muy pequeños en cache
const LARGE_FILE_THRESHOLD_MB = 50; // Stream directo para archivos >50MB

// Timeouts optimizados para Render
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000); // Más tiempo
const MAX_RETRIES = 2; // Menos reintentos para ahorrar recursos
const MAX_REDIRECTS = 3; // Reducir redirects para velocidad

// Rate limiting adaptativo
const ENABLE_RATE_LIMIT = process.env.ENABLE_RATE_LIMIT !== "false";
const USER_AGENT = process.env.ORIGIN_UA || "Mozilla/5.0 (StremioMediaFlow/Render)";
const TOKEN_TTL_SEC = Number(process.env.TOKEN_TTL_SEC || 600); // 10 minutos para archivos grandes

// Configuración de concurrencia para Render gratuito
const MAX_CONCURRENT_REQUESTS = 8;
let activeRequests = 0;
const requestQueue = [];

// ====== HELPERS OPTIMIZADOS ======
const SUPPORTED_VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v',
  '.ts', '.m2ts', '.vob', '.ogv', '.3gp', '.f4v'
]);
const SUPPORTED_PLAYLIST_EXTENSIONS = new Set(['.m3u8', '.m3u', '.mpd']);

function isPlaylistUrl(u) {
  try {
    const p = new URL(u);
    const parts = p.pathname.toLowerCase().split('.');
    const ext = parts.length > 1 ? '.' + parts.pop() : '';
    return SUPPORTED_PLAYLIST_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}

function isLargeVideoFile(url, contentLength) {
  const threshold = LARGE_FILE_THRESHOLD_MB * 1024 * 1024;
  if (typeof contentLength === 'number' && contentLength > threshold) return true;
  
  try {
    const p = new URL(url);
    const ext = p.pathname.toLowerCase().split('.').pop();
    return SUPPORTED_VIDEO_EXTENSIONS.has('.' + ext);
  } catch {
    return false;
  }
}

function shouldBypassCache(url, headers, contentLength) {
  // Siempre bypass para Range requests (streaming parcial)
  if (headers.range) return true;
  
  // Bypass para archivos grandes
  if (isLargeVideoFile(url, contentLength)) return true;
  
  // Bypass si excede límite de cache
  if (typeof contentLength === 'number' && contentLength > MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024) {
    return true;
  }
  
  return false;
}

// ====== GESTIÓN DE CONCURRENCIA PARA RENDER ======
function canAcceptRequest() {
  return activeRequests < MAX_CONCURRENT_REQUESTS;
}

function queueRequest(req, res, handler) {
  if (canAcceptRequest()) {
    activeRequests++;
    return handler(req, res).finally(() => activeRequests--);
  }
  
  // Si no hay capacidad, rechazar con 503
  return res.status(503).json({ 
    error: 'Servidor saturado, reintente en unos segundos',
    retryAfter: 5 
  });
}

// ====== MONITOREO DE MEMORIA PARA RENDER ======
function getMemoryUsage() {
  const usage = process.memoryUsage();
  return {
    used: Math.round(usage.rss / 1024 / 1024), // MB
    heap: Math.round(usage.heapUsed / 1024 / 1024),
    limit: 512 // Límite Render gratuito
  };
}

function shouldTriggerGC() {
  const mem = getMemoryUsage();
  return mem.used > 400; // Trigger GC si usa >400MB
}

// ====== SSRF PROTECTION OPTIMIZADA ======
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
    if (net.isIP(host)) {
      return PRIVATE_RANGES_RE.some(r => r.test(host));
    }
    
    // DNS lookup con timeout corto para Render
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    
    try {
      const addrs = await Promise.race([
        dns.resolve4(host).catch(() => []),
        dns.resolve6(host).catch(() => [])
      ]);
      clearTimeout(timeout);
      
      if (addrs.length === 0) return true;
      return addrs.some(ip => PRIVATE_RANGES_RE.some(r => r.test(ip)));
    } catch {
      clearTimeout(timeout);
      return true;
    }
  } catch {
    return true;
  }
}

// ====== TOKENS HMAC OPTIMIZADOS ======
const HMAC_SECRET = process.env.MANIFEST_HMAC_SECRET || PASSWORD + '_render_secret';

function signUrlToken(urlStr, ttlSec = TOKEN_TTL_SEC) {
  const expires = Math.floor(Date.now() / 1000) + Number(ttlSec);
  const mac = crypto.createHmac('sha256', HMAC_SECRET).update(`${urlStr}|${expires}`).digest('hex');
  return `${expires}:${mac}`;
}

function verifyUrlToken(urlStr, token) {
  try {
    if (!token) return false;
    const [expiresStr, mac] = token.split(':');
    const expires = Number(expiresStr);
    if (!expires || !mac) return false;
    if (Math.floor(Date.now() / 1000) > expires) return false;
    const expected = crypto.createHmac('sha256', HMAC_SECRET).update(`${urlStr}|${expires}`).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
  } catch {
    return false;
  }
}

// ====== CACHE SUPER OPTIMIZADO PARA RENDER ======
const manifestCache = new LRU({
  max: MAX_RAM_CACHE_MB * 1024 * 1024,
  length: (value) => value?.body?.length || 0,
  ttl: 1000 * 60 * 60 * CACHE_TTL_HOURS,
  updateAgeOnGet: true
});

// Cache solo para manifiestos y archivos pequeños críticos
const microCache = new LRU({
  max: 10 * 1024 * 1024, // Solo 10MB para metadatos
  length: (value) => JSON.stringify(value).length,
  ttl: 1000 * 60 * 5, // 5 minutos
  updateAgeOnGet: true
});

// ====== FETCH OPTIMIZADO PARA ARCHIVOS GRANDES ======
async function safeFetchForLargeFiles(urlStr, options = {}) {
  let currentUrl = urlStr;
  let redirectCount = 0;
  
  while (redirectCount < MAX_REDIRECTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    
    try {
      const response = await fetch(currentUrl, {
        ...options,
        redirect: 'manual',
        signal: controller.signal,
        // Headers optimizados para archivos grandes
        headers: {
          ...options.headers,
          'Accept-Encoding': 'identity', // Sin compresión para video
          'Connection': 'keep-alive'
        }
      });
      
      clearTimeout(timeout);
      
      if ([301, 302, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error('Redirect without location');
        
        currentUrl = new URL(location, currentUrl).toString();
        redirectCount++;
        continue;
      }
      
      return { response, finalUrl: currentUrl };
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }
  
  throw new Error('Too many redirects');
}

// ====== APP SETUP OPTIMIZADO ======
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Rate limiting adaptativo basado en memoria disponible
if (ENABLE_RATE_LIMIT) {
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: (req, res) => {
      const mem = getMemoryUsage();
      // Reducir límites si la memoria está alta
      return mem.used > 300 ? 60 : 120;
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes, reintente en unos minutos' }
  }));
}

// Helmet optimizado para streaming
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// Compression inteligente - skip para video
app.use(compression({
  level: 1, // Compresión mínima para ahorrar CPU
  filter: (req, res) => {
    const contentType = res.getHeader('content-type') || '';
    // No comprimir contenido multimedia
    if (contentType.startsWith('video/') || 
        contentType.startsWith('audio/') ||
        contentType.includes('application/octet-stream')) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// Logging mínimo para Render
app.use(morgan('combined', {
  skip: (req, res) => req.path === '/' || req.path === '/health'
}));

// CORS optimizado
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range,Authorization,X-API-Password');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ====== ENDPOINTS ======

// Health check optimizado
app.get(['/', '/health'], (req, res) => {
  const mem = getMemoryUsage();
  res.json({
    ok: true,
    service: 'MediaFlow Proxy Render',
    memory: `${mem.used}MB / ${mem.limit}MB`,
    activeRequests,
    uptime: Math.floor(process.uptime()),
    cacheSize: Math.round(manifestCache.calculatedSize / 1024 / 1024) + 'MB'
  });
});

// Stats con auth
app.get('/stats', (req, res) => {
  const pass = req.query.password || req.headers['x-api-password'];
  if (pass !== PASSWORD) {
    return res.status(401).json({ error: 'Auth required' });
  }
  
  const mem = getMemoryUsage();
  res.json({
    memory: mem,
    activeRequests,
    uptime: process.uptime(),
    cache: {
      manifest: Math.round(manifestCache.calculatedSize / 1024 / 1024) + 'MB',
      micro: Math.round(microCache.calculatedSize / 1024) + 'KB'
    }
  });
});

// ====== PROXY PRINCIPAL OPTIMIZADO PARA ARCHIVOS GRANDES ======
app.get('/proxy', (req, res) => {
  return queueRequest(req, res, async (req, res) => {
    try {
      const targetUrl = req.query.url;
      if (!targetUrl) {
        return res.status(400).json({ error: 'URL requerida' });
      }

      // Validaciones de seguridad
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        return res.status(400).json({ error: 'Esquema no válido' });
      }

      const host = new URL(targetUrl).hostname;
      if (await isIpPrivateOrLocal(host)) {
        return res.status(403).json({ error: 'IP privada no permitida' });
      }

      // Auth check
      const token = req.query.token || req.query.t;
      const password = req.query.password || req.headers['x-api-password'];
      
      if (!token && password !== PASSWORD) {
        return res.status(401).json({ error: 'Auth requerida' });
      }
      
      if (token && !verifyUrlToken(targetUrl, token)) {
        return res.status(401).json({ error: 'Token inválido' });
      }

      // Headers para upstream
      const upstreamHeaders = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*'
      };

      // Preservar Range header para streaming parcial
      if (req.headers.range) {
        upstreamHeaders.Range = req.headers.range;
      }

      console.log(`Proxying: ${targetUrl.substring(0, 100)}...`);

      // Fetch upstream
      const { response } = await safeFetchForLargeFiles(targetUrl, {
        headers: upstreamHeaders
      });

      if (!response.ok) {
        return res.status(response.status).json({ 
          error: `Upstream error: ${response.status}` 
        });
      }

      const contentLength = parseInt(response.headers.get('content-length') || '0');
      const contentType = response.headers.get('content-type') || '';

      // Headers de respuesta
      const passthroughHeaders = [
        'content-type', 'content-length', 'accept-ranges', 
        'content-range', 'etag', 'last-modified'
      ];

      for (const header of passthroughHeaders) {
        const value = response.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      }

      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Proxy-Status', response.status);

      // Decisión de caching vs streaming directo
      if (shouldBypassCache(targetUrl, req.headers, contentLength)) {
        // Stream directo para archivos grandes
        console.log(`Streaming large file: ${Math.round(contentLength/1024/1024)}MB`);
        res.setHeader('X-Cache', 'BYPASS-LARGE');
        
        res.status(response.status);
        
        if (response.body) {
          try {
            await pipeline(response.body, res);
          } catch (err) {
            console.warn('Streaming error:', err.message);
          }
        } else {
          res.end();
        }
      } else {
        // Cache pequeño para manifiestos y archivos chicos
        const cacheKey = crypto.createHash('md5').update(targetUrl).digest('hex');
        
        try {
          const buffer = await response.arrayBuffer();
          const data = Buffer.from(buffer);
          
          // Cache si es suficientemente pequeño
          if (data.length < MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024) {
            manifestCache.set(cacheKey, {
              headers: Object.fromEntries(response.headers.entries()),
              body: data,
              timestamp: Date.now()
            });
            res.setHeader('X-Cache', 'STORED');
          } else {
            res.setHeader('X-Cache', 'MISS-TOO-LARGE');
          }
          
          res.status(response.status);
          res.end(data);
        } catch (err) {
          console.error('Buffer error:', err.message);
          res.status(502).json({ error: 'Error buffering response' });
        }
      }

      // Garbage collection si es necesario
      if (shouldTriggerGC() && global.gc) {
        setImmediate(() => global.gc());
      }

    } catch (error) {
      console.error('Proxy error:', error.message);
      
      if (error.name === 'AbortError') {
        return res.status(504).json({ error: 'Timeout' });
      }
      
      return res.status(502).json({ 
        error: 'Proxy failed',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });
});

// Keepalive endpoint para evitar cold starts
app.get('/keepalive', (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: Date.now(),
    memory: getMemoryUsage().used + 'MB'
  });
});

// ====== GRACEFUL SHUTDOWN OPTIMIZADO ======
const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}, starting graceful shutdown...`);
  
  const timeout = setTimeout(() => {
    console.log('Forcing shutdown...');
    process.exit(1);
  }, 10000); // 10 segundos máximo para Render
  
  // Esperar que terminen las requests activas
  const checkActive = () => {
    if (activeRequests === 0) {
      clearTimeout(timeout);
      console.log('Graceful shutdown complete');
      process.exit(0);
    } else {
      console.log(`Waiting for ${activeRequests} active requests...`);
      setTimeout(checkActive, 500);
    }
  };
  
  checkActive();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ====== START SERVER ======
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`MediaFlow Proxy Render optimizado ejecutándose en puerto ${PORT}`);
  console.log(`Memoria máxima cache: ${MAX_RAM_CACHE_MB}MB`);
  console.log(`Threshold archivos grandes: ${LARGE_FILE_THRESHOLD_MB}MB`);
  
  // Warmup automático
  setTimeout(() => {
    fetch(`http://localhost:${PORT}/health`).catch(() => {});
  }, 1000);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
