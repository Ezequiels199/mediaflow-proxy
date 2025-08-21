// index.mjs
import express from "express";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import { fetch } from "undici";
import { pipeline } from "node:stream/promises";
import LRU from "lru-cache";
import url from "node:url";

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.MEDIAFLOW_PASSWORD || "mipassword";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",");
const MAX_RAM_CACHE_MB = parseInt(process.env.MAX_RAM_CACHE_MB || "256", 10);
const USER_AGENT =
  process.env.ORIGIN_UA ||
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// Caché en RAM (bytes). Ideal para playlists, manifiestos, y vídeos chicos.
const ramCache = new LRU({
  max: MAX_RAM_CACHE_MB * 1024 * 1024, // MB -> bytes
  length: (v, k) => (v?.body?.length || 0) + JSON.stringify(v.headers || {}).length,
  ttl: 1000 * 60 * 60 * 6, // 6h
});

// ====== APP ======
const app = express();
app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(compression({ level: 6 }));
app.use(morgan("tiny"));

// CORS controlado
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Range,Authorization,X-Requested-With");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Salud
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "MediaFlow Proxy PRO",
    usage: "/proxy?url=ENCODED_URL&password=***  |  /hls?url=ENCODED_M3U8&password=***",
  });
});

// ====== Auth simple por password ======
function checkAuth(req, res) {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"] ||
    "";
  if (pass !== PASSWORD) {
    res.status(401).json({ error: "Contraseña inválida" });
    return false;
  }
  return true;
}

// ====== Util: normalizar URL relativa de m3u8/segmento ======
function toAbsolute(base, maybe) {
  try {
    return new url.URL(maybe, base).toString();
  } catch {
    return null;
  }
}

// ====== PROXY GENÉRICO (MP4, MKV, AVI, BIN, etc) con Range ======
app.get("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Falta ?url=" });

  try {
    // Cache hit (para objetos pequeños: manifiestos, mp4 chicos)
    const cached = ramCache.get(target);
    if (cached) {
      for (const [k, v] of Object.entries(cached.headers || {})) {
        if (k.toLowerCase() === "content-length") continue; // recalculado
        res.setHeader(k, v);
      }
      res.status(cached.status || 200);
      return res.end(cached.body);
    }

    const headers = {
      "User-Agent": USER_AGENT,
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const r = await fetch(target, {
      headers,
      redirect: "follow",
      // timeouts “razonables”
      // undici usa abort-controller si queremos, pero mantenemos simple
    });

    // Copiamos headers importantes
    const passthrough = [
      "content-type",
      "content-length",
      "accept-ranges",
      "content-range",
      "etag",
      "last-modified",
      "cache-control",
    ];
    for (const [k, v] of r.headers) {
      if (passthrough.includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    res.setHeader("X-Proxy-Origin-Status", String(r.status));

    // 206/200 passthrough streaming
    res.status(r.status);

    // Si es suficientemente pequeño (< 10MB) lo cacheamos RAM
    const contentLength = Number(r.headers.get("content-length") || "0");
    if (!Number.isNaN(contentLength) && contentLength > 0 && contentLength <= 10 * 1024 * 1024) {
      const buf = Buffer.from(await r.arrayBuffer());
      ramCache.set(target, {
        status: r.status,
        headers: Object.fromEntries([...r.headers]),
        body: buf,
      });
      return res.end(buf);
    }

    // Stream directo
    await pipeline(r.body, res);
  } catch (e) {
    console.error("Proxy error:", e);
    res.status(502).json({ error: "No se pudo obtener el recurso" });
  }
});

// ====== HLS (m3u8): reescritura de playlist y proxy de segmentos ======
app.get("/hls", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const playlistUrl = req.query.url;
  if (!playlistUrl) return res.status(400).json({ error: "Falta ?url=" });

  try {
    // Cache playlist (rápida)
    const cached = ramCache.get(playlistUrl);
    if (cached) {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.status(200);
      return res.end(cached.body);
    }

    const r = await fetch(playlistUrl, {
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    if (!r.ok) {
      return res.status(502).json({ error: `Origen devolvió ${r.status}` });
    }
    const text = await r.text();

    // Reescribir líneas que parezcan URLs de segmento u otras listas
    const base = playlistUrl;
    const origin = `${req.protocol}://${req.get("host")}`;
    const passwordParam = `password=${encodeURIComponent(PASSWORD)}`;

    const rewritten = text
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line; // tags HLS

        // intentar absolutizar
        const abs = toAbsolute(base, trimmed);
        if (!abs) return line;

        // para .m3u8 anidadas -> reescribir a /hls
        if (abs.toLowerCase().includes(".m3u8")) {
          const prox = `${origin}/hls?url=${encodeURIComponent(abs)}&${passwordParam}`;
          return prox;
        }

        // para segmentos (.ts, .mp4, .webm, etc) -> reescribir a /proxy
        const prox = `${origin}/proxy?url=${encodeURIComponent(abs)}&${passwordParam}`;
        return prox;
      })
      .join("\n");

    const buf = Buffer.from(rewritten, "utf-8");
    ramCache.set(playlistUrl, {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      body: buf,
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.status(200).end(buf);
  } catch (e) {
    console.error("HLS error:", e);
    res.status(502).json({ error: "No se pudo procesar la playlist HLS" });
  }
});

// ====== HEAD para players estrictos (Stremio lo agradece) ======
app.head("/proxy", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const target = req.query.url;
  if (!target) return res.status(400).end();

  try {
    const r = await fetch(target, {
      method: "HEAD",
      headers: { "User-Agent": USER_AGENT },
      redirect: "follow",
    });
    const passthrough = [
      "content-type",
      "content-length",
      "accept-ranges",
      "etag",
      "last-modified",
      "cache-control",
    ];
    for (const [k, v] of r.headers) {
      if (passthrough.includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    res.status(r.status).end();
  } catch (e) {
    console.error("HEAD error:", e);
    res.status(502).end();
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MediaFlow Proxy PRO en :${PORT}`);
});
