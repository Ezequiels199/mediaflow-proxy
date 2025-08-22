#!/usr/bin/env node
/**
 * MediaFlow Proxy - Professional edition for Stremio
 * - Hardened SSRF protection (scheme, DNS resolution, private IP checks)
 * - Controlled redirect following with validation
 * - HLS manifest rewriting without exposing password (HMAC tokens)
 * - RAM LRU cache with metrics + cache-stampede protection (dedupe)
 * - Stream-safe proxying with Range support and proper headers passthrough
 * - Configurable and env-driven
 * - Structured logging and graceful shutdown with active request draining
 *
 * Dependencies:
 *   - express
 *   - compression
 *   - helmet
 *   - morgan
 *   - undici
 *   - lru-cache
 *   - express-rate-limit
 *
 * Optional (recommended):
 *   - prom-client (for Prometheus metrics on /metrics)
 *
 * Notes for Stremio:
 *   - /hls rewrites playlist URIs to /hls or /proxy but uses a signed token param
 *     instead of embedding the raw password to avoid leaking credentials.
 *   - The token contains expiry + HMAC(url|expiry) and is validated by /proxy and /hls.
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

// ====== CONFIG ======
const PORT = Number(process.env.PORT || 10000);
const PASSWORD = process.env.MEDIAFLOW_PASSWORD || "mipassword";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
const MAX_RAM_CACHE_MB = Number(process.env.MAX_RAM_CACHE_MB || 256);
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || 6);
const MAX_CACHE_ITEM_SIZE_MB = Number(process.env.MAX_CACHE_ITEM_SIZE_MB || 10);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const ENABLE_RATE_LIMIT = process.env.ENABLE_RATE_LIMIT !== "false";
const USER_AGENT = process.env.ORIGIN_UA || "Mozilla/5.0 (StremioMediaFlow)";
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 6);
const TOKEN_TTL_SEC = Number(process.env.TOKEN_TTL_SEC || 300); // 5 minutes default
const ENABLE_PROMETHEUS = process.env.ENABLE_PROMETHEUS === "true";

// ====== HELPERS & SAFETY ======
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

function toAbsolute(base, relative) {
  try {
    return new URL(relative, base).toString();
  } catch {
    return null;
  }
}

function redactUrl(original) {
  try {
    const u = new URL(original);
    ['password','token','signature','sig','api_key','key','auth','expires'].forEach(k => u.searchParams.delete(k));
    return u.toString();
  } catch {
    return original;
  }
}

function generateCacheKey(urlStr, headers = {}) {
  const relevant = ['range', 'accept', 'accept-encoding'];
  const headerStr = relevant.map(h => (headers[h] || headers[h.toLowerCase()] || '')).join('|');
  return crypto.createHash('md5').update(`${urlStr}|${headerStr}`).digest('hex');
}

// validate scheme is only http / https
function hasAllowedScheme(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
}

// ====== SSRF / PRIVATE IP CHECK ======
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
    const addrs = [];
    try { addrs.push(...await dns.resolve4(host)); } catch {}
    try { addrs.push(...await dns.resolve6(host)); } catch {}
    if (addrs.length === 0) {
      // If nothing resolves, for safety consider it "private/unresolvable"
      return true;
    }
    for (const ip of addrs) {
      for (const r of PRIVATE_RANGES_RE) {
        if (r.test(ip)) return true;
      }
    }
    return false;
  } catch (err) {
    // on DNS errors, be conservative
    console.warn("isIpPrivateOrLocal error:", err?.message || err);
    return true;
  }
}

// ====== TOKEN (HMAC) FOR MANIFEST REWRITES ======
const HMAC_SECRET = process.env.MANIFEST_HMAC_SECRET || PASSWORD || 'fallback-secret';
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
    // constant-time compare
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(mac, 'hex'));
  } catch {
    return false;
  }
}

// ====== CACHE (LRU) with metrics & stampede protection ======
function createLRUWithMetrics(opts) {
  const cache = new LRU(opts);
  cache._metrics = { hits: 0, misses: 0, requests: 0, bytesStored: 0 };
  const origGet = cache.get.bind(cache);
  cache.get = function(key) {
    cache._metrics.requests++;
    const v = origGet(key);
    if (v === undefined) cache._metrics.misses++;
    else cache._metrics.hits++;
    return v;
  };
  const origSet = cache.set.bind(cache);
  cache.set = function(key, value) {
    if (value && value.body) cache._metrics.bytesStored += (value.body.length || 0);
    return origSet(key, value);
  };
  cache.getMetrics = () => ({
    hits: cache._metrics.hits,
    misses: cache._metrics.misses,
    requests: cache._metrics.requests,
    itemCount: cache.size || 0,
    size: cache.calculatedSize || cache._metrics.bytesStored || 0
  });
  return cache;
}

const ramCache = createLRUWithMetrics({
  max: MAX_RAM_CACHE_MB * 1024 * 1024,
  length: v => (v?.body?.length || 0) + JSON.stringify(v?.headers || {}).length + 100,
  ttl: 1000 * 60 * 60 * CACHE_TTL_HOURS,
  updateAgeOnGet: true
});
const manifestCache = createLRUWithMetrics({
  max: 50 * 1024 * 1024,
  length: v => v?.body?.length || 0,
  ttl: 1000 * 60 * 60 * 2,
  updateAgeOnGet: true
});

// Stampede protection: cacheKey -> Promise
const fetchLocks = new Map();

// Active request count for graceful shutdown
let activeRequests = 0;

// ====== FETCH WITH RETRIES + REDIRECT CONTROL ======
async function safeFetch(urlStr, options = {}, { allowRedirects = true, maxRedirects = MAX_REDIRECTS } = {}) {
  // We implement manual redirect following to validate each Location
  let currentUrl = urlStr;
  let attempts = 0;
  let lastErr = null;

  while (true) {
    attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const resp = await fetch(currentUrl, {
        ...options,
        redirect: 'manual', // we follow redirects manually
        signal: controller.signal
      });
      clearTimeout(timeout);

      // If redirect status and we should follow
      if (allowRedirects && [301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get('location');
        if (!loc) throw new Error(`Redirect without Location from ${currentUrl}`);
        const next = toAbsolute(currentUrl, loc);
        if (!next) throw new Error('Invalid redirect location');
        if (!hasAllowedScheme(next)) throw new Error('Redirect to disallowed scheme');
        const nextHost = new URL(next).hostname;
        if (await isIpPrivateOrLocal(nextHost)) throw new Error('Redirect target resolves to private IP');
        if (attempts > maxRedirects) throw new Error('Too many redirects');
        // continue with next
        currentUrl = next;
        // loop will retry
        continue;
      }

      // Non-redirect response
      return { response: resp, finalUrl: currentUrl };
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;
      // retries for network/5xx up to MAX_RETRIES with exponential backoff
      if (attempts > MAX_RETRIES) {
        throw lastErr;
      }
      const backoff = Math.min(30000, Math.pow(2, attempts) * 1000);
      const jitter = Math.floor(Math.random() * 300);
      await new Promise(r => setTimeout(r, backoff + jitter));
      // retry same URL or following redirect logic again
    }
  }
}

// ====== APP SETUP ======
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

if (ENABLE_RATE_LIMIT) {
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' }
  }));
}

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(compression({ level: 6 }));
app.use(morgan('combined'));

// CORS middleware
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*') || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Range,Authorization,X-Requested-With,X-API-Password');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,X-Proxy-Status,X-Cache');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple metrics collector if prom-client available
let promClient = null;
if (ENABLE_PROMETHEUS) {
  try {
    promClient = await import('prom-client');
    promClient.collectDefaultMetrics?.();
  } catch (err) {
    console.warn('prom-client not available, skipping /metrics', err?.message || err);
    promClient = null;
  }
}

// HEALTH
app.get('/', (req, res) => {
  const ram = ramCache.getMetrics();
  const manifest = manifestCache.getMetrics();
  res.json({
    ok: true,
    service: 'MediaFlow Proxy PRO',
    version: '3.0.0',
    stats: {
      ramCache: ram,
      manifestCache: manifest,
      activeRequests,
      uptime: process.uptime(),
      memory: process.memoryUsage()
    },
    endpoints: {
      proxy: '/proxy?url=ENCODED_URL (or token)',
      hls: '/hls?url=ENCODED_M3U8 (or token)',
      stats: '/stats',
      metrics: ENABLE_PROMETHEUS ? '/metrics' : '(disabled)'
    }
  });
});

// STATS (requires password)
app.get('/stats', (req, res) => {
  if (!checkAuth(req, res)) return;
  const ram = ramCache.getMetrics();
  const manifest = manifestCache.getMetrics();
  res.json({
    cache: { ram, manifest },
    activeRequests,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    config: {
      maxRamMB: MAX_RAM_CACHE_MB,
      maxCacheItemMB: MAX_CACHE_ITEM_SIZE_MB,
      requestTimeoutMs: REQUEST_TIMEOUT_MS
    }
  });
});

if (promClient) {
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', promClient.register.contentType);
      return res.end(await promClient.register.metrics());
    } catch (err) {
      return res.status(500).end(err?.message || String(err));
    }
  });
}

// ====== AUTH helpers ======
function extractPassword(req) {
  return (
    req.query.password ||
    req.query.api_password ||
    req.headers['x-api-password'] ||
    (req.headers['authorization'] ? req.headers['authorization'].replace(/^Bearer\s+/i, '') : '') ||
    ''
  );
}

function checkAuth(req, res) {
  const pass = extractPassword(req);
  if (pass !== PASSWORD) {
    res.status(401).json({ error: 'Autenticación requerida' });
    return false;
  }
  return true;
}

// Validates either password or token for provided targetUrl
function checkAuthOrToken(req, res, targetUrl) {
  // token param support for rewritten manifests
  const token = req.query.token || req.query.t;
  if (token) {
    if (verifyUrlToken(targetUrl, token)) return true;
    res.status(401).json({ error: 'Token inválido o expirado' });
    return false;
  }
  return checkAuth(req, res);
}

// ====== PROXY core ======
async function canCacheResponse(response, req, contentLength, maxCacheSize) {
  if (!response.ok) return false;
  if (req.headers.range) return false;
  if (typeof contentLength === 'number' && contentLength > 0 && contentLength <= maxCacheSize) return true;
  return false;
}

async function fetchAndMaybeCache(target, req, res, cacheKey) {
  // stampede protection: only one buffer+cache operation per key
  if (ramCache.get(cacheKey)) {
    return ramCache.get(cacheKey);
  }

  if (fetchLocks.has(cacheKey)) {
    // wait for existing lock to resolve
    return await fetchLocks.get(cacheKey);
  }

  const promise = (async () => {
    // Construct upstream headers
    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    };
    if (req.headers.range) headers.Range = req.headers.range;
    if (req.headers.referer) headers.Referer = req.headers.referer;
    if (req.headers.origin) headers.Origin = req.headers.origin;

    const { response, finalUrl } = await safeFetch(target, { headers, redirect: 'manual' });

    // collect passthrough headers
    const passthrough = [
      'content-type', 'content-length', 'accept-ranges', 'content-range',
      'etag', 'last-modified', 'cache-control', 'expires'
    ];
    const responseHeaders = {};
    for (const h of passthrough) {
      const v = response.headers.get(h);
      if (v) {
        responseHeaders[h] = v;
      }
    }

    const contentLength = Number(response.headers.get('content-length') || "0");
    const maxCacheBytes = MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024;

    // Decide to buffer & cache or stream
    if (await canCacheResponse(response, req, contentLength, maxCacheBytes)) {
      // Buffer and store in RAM
      const arr = await response.arrayBuffer();
      const buffer = Buffer.from(arr);
      const entry = {
        status: response.status,
        headers: responseHeaders,
        body: buffer,
        timestamp: Date.now()
      };
      ramCache.set(cacheKey, entry);
      return entry;
    } else {
      // No cacheable result; create a streaming wrapper object with response and headers
      return { streamResponse: response, headers: responseHeaders, status: response.status };
    }
  })();

  fetchLocks.set(cacheKey, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    fetchLocks.delete(cacheKey);
  }
}

// ====== /proxy handler ======
app.get('/proxy', async (req, res) => {
  activeRequests++;
  try {
    const rawTarget = req.query.url;
    if (!rawTarget) return res.status(400).json({ error: 'url query required' });

    if (!hasAllowedScheme(rawTarget)) {
      return res.status(400).json({ error: 'Unsupported URL scheme' });
    }

    const targetHost = new URL(rawTarget).hostname;
    if (await isIpPrivateOrLocal(targetHost)) {
      return res.status(403).json({ error: 'Destino no permitido (IP privada/local)' });
    }

    if (!checkAuthOrToken(req, res, rawTarget)) return;

    const cacheKey = generateCacheKey(rawTarget, req.headers);
    // Try serve from RAM cache (only for full object hits)
    const cached = ramCache.get(cacheKey);
    if (cached && !req.headers.range) {
      // Serve cached copy
      Object.entries(cached.headers || {}).forEach(([k, v]) => {
        if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
      });
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Length', cached.body.length);
      res.setHeader('X-Proxy-Status', String(cached.status || 200));
      return res.status(cached.status || 200).end(cached.body);
    }

    // MISS - fetch upstream and maybe cache
    console.info('Cache MISS for', redactUrl(rawTarget));
    res.setHeader('X-Cache', 'MISS');

    // fetch and maybe cache
    const entry = await fetchAndMaybeCache(rawTarget, req, res, cacheKey);

    if (entry.body) {
      // buffered/cached entry
      Object.entries(entry.headers || {}).forEach(([k, v]) => {
        if (k.toLowerCase() !== 'content-length') res.setHeader(k, v);
      });
      res.setHeader('Content-Length', entry.body.length);
      res.setHeader('X-Proxy-Status', String(entry.status || 200));
      return res.status(entry.status || 200).end(entry.body);
    } else if (entry.streamResponse) {
      // stream directly
      const upstream = entry.streamResponse;
      // passthrough headers
      for (const [k, v] of upstream.headers) {
        // avoid overriding content-length when chunked streaming
        res.setHeader(k, v);
      }
      res.setHeader('X-Proxy-Status', String(entry.status || 200));
      // Set status on response (important for partial content)
      res.status(entry.status || 200);
      if (upstream.body) {
        try {
          await pipeline(upstream.body, res);
        } catch (err) {
          // client aborted or upstream error
          console.warn('Streaming pipeline error:', err?.message || err);
        }
      } else {
        res.end();
      }
      return;
    } else {
      return res.status(502).json({ error: 'Upstream error' });
    }
  } catch (err) {
    console.error('Proxy error:', err?.stack || err);
    if (err.name === 'AbortError') return res.status(504).json({ error: 'Timeout fetching upstream' });
    return res.status(502).json({ error: 'Failed to fetch resource', details: process.env.NODE_ENV === 'development' ? err?.message : undefined });
  } finally {
    activeRequests--;
  }
});

// HEAD support
app.head('/proxy', async (req, res) => {
  const rawTarget = req.query.url;
  if (!rawTarget) return res.status(400).end();
  try {
    if (!hasAllowedScheme(rawTarget)) return res.status(400).end();
    const host = new URL(rawTarget).hostname;
    if (await isIpPrivateOrLocal(host)) return res.status(403).end();
    if (!checkAuthOrToken(req, res, rawTarget)) return;

    const { response } = await safeFetch(rawTarget, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    const passthrough = ['content-type', 'content-length', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
    for (const h of passthrough) {
      const v = response.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader('X-Proxy-Status', String(response.status));
    return res.status(response.status).end();
  } catch (err) {
    console.error('HEAD error:', err?.message || err);
    return res.status(502).end();
  }
});

// ====== HLS manifest rewriting ======
app.get('/hls', async (req, res) => {
  activeRequests++;
  try {
    const playlistUrl = req.query.url;
    if (!playlistUrl) return res.status(400).json({ error: 'url query required' });

    if (!hasAllowedScheme(playlistUrl)) return res.status(400).json({ error: 'Unsupported URL scheme' });

    const host = new URL(playlistUrl).hostname;
    if (await isIpPrivateOrLocal(host)) {
      return res.status(403).json({ error: 'Destino no permitido (IP privada/local)' });
    }

    // allow either token tied to this playlist OR password
    if (!checkAuthOrToken(req, res, playlistUrl)) return;

    const cacheKey = `hls:${crypto.createHash(
