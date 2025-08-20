// src/index.js
import express from "express";
import cors from "cors";
import morgan from "morgan";
import compression from "compression";
import helmet from "helmet";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";
import LRU from "lru-cache";
import pLimit from "p-limit";
import { RateLimiterMemory } from "rate-limiter-flexible";
import { pipeline } from "node:stream/promises";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { URL } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Config ----------
const DEFAULT_UA =
  process.env.DEFAULT_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Whitelist (coma separada). Ej: "mixdrop.co,streamtape.com,cdn.ejemplo.com"
// Usa "*" bajo tu responsabilidad (no recomendado).
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
  .split(",")
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Máx. streams simultáneos hacia upstream para evitar saturar la instancia
const CONCURRENCY = Number(process.env.CONCURRENCY || 6);

// Tamaños máximos aceptados (para respuestas “no stream”, p.ej. /fetch)
const MAX_TEXT_BYTES = Number(process.env.MAX_TEXT_BYTES || 5 * 1024 * 1024); // 5MB

// Tiempo de espera por request a upstream y número de reintentos
const REQ_TIMEOUT_MS = Number(process.env.REQ_TIMEOUT_MS || 25_000);
const RETRIES = Number(process.env.RETRIES || 2);

// ---------- Seguridad básica ----------
app.set("trust proxy", true);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: "512kb" }));

// Logging
app.use(morgan("combined"));

// Rate limit (IP): 120 req / 2 min
const rateLimiter = new RateLimiterMemory({
  points: 120,
  duration: 120,
});
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch {
    res.status(429).send("Too Many Requests");
  }
});

// Concurrencia
const limit = pLimit(CONCURRENCY);

// Cache de METADATA (no del binario): headers, length, etc.
const metaCache = new LRU({
  max: 1000,
  ttl: 10 * 60 * 1000, // 10 min
});

// Cookie jar por IP (evita mezclar sesiones entre usuarios)
const jarByIp = new LRU({
  max: 1000,
  ttl: 60 * 60 * 1000, // 1 h
});
const getJar = ip => {
  let jar = jarByIp.get(ip);
  if (!jar) {
    jar = new CookieJar();
    jarByIp.set(ip, jar);
  }
  return jar;
};

// Axios “envuelto” con cookies y timeouts
const buildClient = jar =>
  wrapper(
    axios.create({
      jar,
      withCredentials: true,
      maxRedirects: 5,
      timeout: REQ_TIMEOUT_MS,
      // importantísimo para streaming: no transformar en JSON/text por defecto
      decompress: true,
      validateStatus: s => s >= 200 && s < 400, // permitimos 206/3xx
    })
  );

// ---------- Utilidades ----------
const isHostAllowed = async targetUrl => {
  try {
    const u = new URL(targetUrl);
    const host = u.hostname.toLowerCase();

    // Evita destinos internos (SSRF)
    const { address } = await dns.lookup(host);
    const isPrivate =
      address.startsWith("10.") ||
      address.startsWith("192.168.") ||
      address.startsWith("172.16.") ||
      address.startsWith("172.17.") ||
      address.startsWith("172.18.") ||
      address.startsWith("172.19.") ||
      address.startsWith("172.2") || // 172.20-31
      address.startsWith("127.") ||
      address === "::1";

    if (isPrivate) return false;

    if (!ALLOWED_HOSTS.length) return false;
    if (ALLOWED_HOSTS.includes("*")) return true;
    return ALLOWED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
};

const pickHeaders = (src, allow = []) => {
  const out = {};
  for (const k of allow) {
    const v = src[k];
    if (v) out[k] = v;
  }
  return out;
};

// Retry simple con backoff
const withRetry = async (fn, retries = RETRIES) => {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
};

// ---------- Rutas ----------
app.get("/", (req, res) => {
  res.type("text/plain").send("✅ Media proxy online");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ---- HEAD a upstream para obtener metadata (length, mime, etc.) ----
app.get("/head", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Falta ?url");
  if (!(await isHostAllowed(url))) return res.status(403).send("Host no permitido");

  await limit(async () => {
    const jar = getJar(req.ip);
    const client = buildClient(jar);

    const ua = req.headers["user-agent"] || DEFAULT_UA;
    const referer = req.headers["referer"] || req.query.referer;

    const key = crypto
      .createHash("sha1")
      .update(`HEAD|${url}|${ua}|${referer || ""}`)
      .digest("hex");

    if (metaCache.has(key)) {
      return res.json(metaCache.get(key));
    }

    const headers = {
      ...pickHeaders(req.headers, ["accept", "accept-language"]),
      "user-agent": ua,
      ...(referer ? { referer } : {}),
    };

    const info = await withRetry(async () => {
      const r = await client.head(url, { headers });
      return {
        status: r.status,
        length: Number(r.headers["content-length"]) || null,
        type: r.headers["content-type"] || null,
        acceptRanges: r.headers["accept-ranges"] || null,
        lastModified: r.headers["last-modified"] || null,
      };
    });

    metaCache.set(key, info);
    res.json(info);
  }).catch(err => {
    console.error(err?.response?.status, err?.message);
    res.status(502).send("HEAD upstream failed");
  });
});

// ---- Fetch de texto/json (no binario) con límite de tamaño ----
app.get("/fetch", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Falta ?url");
  if (!(await isHostAllowed(url))) return res.status(403).send("Host no permitido");

  await limit(async () => {
    const jar = getJar(req.ip);
    const client = buildClient(jar);

    const ua = req.headers["user-agent"] || DEFAULT_UA;
    const referer = req.headers["referer"] || req.query.referer;

    const headers = {
      ...pickHeaders(req.headers, ["accept", "accept-language"]),
      "user-agent": ua,
      ...(referer ? { referer } : {}),
    };

    const r = await withRetry(() =>
      client.get(url, {
        headers,
        responseType: "arraybuffer",
        maxContentLength: MAX_TEXT_BYTES,
      })
    );

    const ctype = r.headers["content-type"] || "text/plain; charset=utf-8";
    res.set("content-type", ctype);
    res.send(r.data);
  }).catch(err => {
    console.error(err?.response?.status, err?.message);
    res.status(502).send("Fetch upstream failed");
  });
});

// ---- Streaming con soporte Range (gigas) ----
app.get("/stream", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send("Falta ?url");
  if (!(await isHostAllowed(url))) return res.status(403).send("Host no permitido");

  await limit(async () => {
    const jar = getJar(req.ip);
    const client = buildClient(jar);

    const ua = req.headers["user-agent"] || DEFAULT_UA;
    const referer = req.headers["referer"] || req.query.referer;
    const range = req.headers.range;

    const baseHeaders = {
      "user-agent": ua,
      ...(referer ? { referer } : {}),
    };

    // 1) Hacemos HEAD para saber tamaño/mime (cacheado)
    const headKey = crypto
      .createHash("sha1")
      .update(`HEAD|${url}|${ua}|${referer || ""}`)
      .digest("hex");

    let meta = metaCache.get(headKey);
    if (!meta) {
      try {
        const rh = await client.head(url, { headers: baseHeaders });
        meta = {
          status: rh.status,
          length: Number(rh.headers["content-length"]) || null,
          type: rh.headers["content-type"] || "application/octet-stream",
          acceptRanges: rh.headers["accept-ranges"] || "bytes",
          lastModified: rh.headers["last-modified"] || null,
        };
        metaCache.set(headKey, meta);
      } catch (e) {
        // Si falla el HEAD, seguimos igual (no bloqueamos)
        meta = { length: null, type: "application/octet-stream", acceptRanges: "bytes" };
      }
    }

    // 2) Construimos headers hacia upstream
    const headers = { ...baseHeaders };
    if (range) headers.Range = range;

    // 3) Pedimos el stream (206 si hubo Range)
    const upstream = await withRetry(() =>
      client.get(url, {
        headers,
        responseType: "stream",
      })
    );

    // 4) Propagamos los headers relevantes
    const passthrough = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "last-modified",
      "etag",
      "cache-control",
    ];
    for (const h of passthrough) {
      const v = upstream.headers[h];
      if (v) res.setHeader(h, v);
    }

    // Si no vino content-type del upstream, usa el del HEAD
    if (!res.getHeader("content-type") && meta.type) {
      res.setHeader("content-type", meta.type);
    }
    if (!res.getHeader("accept-ranges") && meta.acceptRanges) {
      res.setHeader("accept-ranges", meta.acceptRanges);
    }

    // 5) Status 206 si hay rango, si no 200
    const statusCode = range ? 206 : 200;
    res.status(statusCode);

    // 6) Pipe eficiente (backpressure) para archivos muy grandes
    await pipeline(upstream.data, res);
  }).catch(err => {
    const status = err?.response?.status;
    console.error("STREAM ERR", status, err?.message);
    if (status === 403 || status === 401) {
      return res.status(status).send("Upstream auth required");
    }
    res.status(502).send("Stream upstream failed");
  });
});

// 404 controlado
app.use((req, res) => res.status(404).send("Not found"));

// Arranque
app.listen(PORT, () => {
  console.log(`✅ Proxy listening on :${PORT}`);
});
