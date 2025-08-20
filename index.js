import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";
import pinoHttp from "pino-http";
import http from "http";
import https from "https";
import url from "url";

// ====== CONFIG BÁSICA ======
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.API_KEY || process.env.API_PASSWORD || "superclave123"; // tu clave
// Si querés fijar un upstream por defecto, podés setearlo en env:
// UPSTREAM_DEFAULT=https://dominio-del-host
const UPSTREAM_DEFAULT = process.env.UPSTREAM_DEFAULT || null;

// ====== AGENTES KEEP-ALIVE (mejora latencia y throughput) ======
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 256,         // más concurrencia
  maxFreeSockets: 64,
  timeout: 0               // no cierres antes de tiempo
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 256,
  maxFreeSockets: 64,
  timeout: 0,
  rejectUnauthorized: false // tolera certificados raros de algunos hosts
});

// ====== APP ======
const app = express();

// Log rápido y de bajo overhead
app.use(pinoHttp({ redact: ["req.headers.authorization", "req.headers.cookie"] }));

// CORS para que Stremio/app integrada pueda pegarle
app.use(cors({ origin: true, credentials: false }));

// No comprimir video: evita CPU y cuellos
app.disable("x-powered-by");

// Ping/health
app.get("/", (req, res) => {
  res.type("text/plain").send("MediaFlow Proxy OK");
});

// ====== MIDDLEWARE DE SEGURIDAD SIMPLE POR PASSWORD ======
app.use((req, res, next) => {
  const q = req.query || {};
  if (!PASSWORD || q.api_password === PASSWORD) return next();
  res.status(401).json({ ok: false, error: "Unauthorized" });
});

// ====== PROXY DE STREAM con soporte RANGE ======
// Uso: /proxy?url=https://host/video.mp4&api_password=xxxx
// También acepta /proxy/<url-encodeado>
app.use("/proxy", async (req, res, next) => {
  try {
    let target = req.query.url;
    if (!target && req.path && req.path !== "/") {
      // /proxy/https%3A%2F%2F…
      const raw = decodeURIComponent(req.path.slice(1));
      if (raw.startsWith("http://") || raw.startsWith("https://")) target = raw;
    }
    if (!target && UPSTREAM_DEFAULT) target = UPSTREAM_DEFAULT;
    if (!target) return res.status(400).json({ ok: false, error: "Missing ?url" });

    // Validación básica
    const parsed = url.parse(target);
    if (!/^https?:$/.test(parsed.protocol || "")) {
      return res.status(400).json({ ok: false, error: "Only http/https" });
    }

    // Cabeceras que ayudan a streaming/RANGE
    // (dejamos pasar Range, If-Range, etc.)
    const headersToForward = [
      "range","if-range","accept","user-agent","referer","origin",
      "accept-language","cookie","authorization","accept-encoding"
    ];
    const xfwdHeaders = {};
    for (const h of headersToForward) {
      if (req.headers[h]) xfwdHeaders[h] = req.headers[h];
    }

    // Evitar compresión del upstream para chunks predecibles
    xfwdHeaders["accept-encoding"] = "identity";

    // Control de caché: deja que el cliente cachee si quiere
    res.setHeader("Cache-Control", "public, max-age=120, s-maxage=120, stale-while-revalidate=60");

    // Proxy middleware creado al vuelo para este destino
    return createProxyMiddleware({
      target: `${parsed.protocol}//${parsed.host}`,
      changeOrigin: true,
      secure: false,
      ws: false,
      followRedirects: true,
      // IMPORTANTÍSIMO para streams grandes
      selfHandleResponse: false,
      preserveHeaderKeyCase: true,
      proxyTimeout: 300000, // 5 min sin datos
      timeout: 0,           // no cortar nosotros
      headers: xfwdHeaders,
      agent: parsed.protocol === "https:" ? httpsAgent : httpAgent,
      onProxyReq: (proxyReq, req2, res2) => {
        // Pasa el path y query original al host de destino
        // Si usamos ?url=, necesitamos enviar el path real del target:
        proxyReq.path = parsed.path || "/";
        // A veces los hosts necesitan un referer/origin válido (por hotlink):
        if (!proxyReq.getHeader("referer") && parsed.hostname) {
          proxyReq.setHeader("referer", `${parsed.protocol}//${parsed.host}/`);
        }
      },
      onProxyRes: (proxyRes, req2, res2) => {
        // Asegurar cabeceras de video correctas
        // Mantener Accept-Ranges/Content-Range/Content-Length del upstream
        // No tocar Content-Type si viene definido
        if (!proxyRes.headers["accept-ranges"]) {
          // Algunos hosts no la mandan pero soportan range igual
          res2.setHeader("Accept-Ranges", "bytes");
        }
        // No dejar que el upstream re-comprima
        res2.removeHeader?.("Content-Encoding");
      },
      logLevel: "warn"
    })(req, res, next);
  } catch (e) {
    req.log?.error(e);
    res.status(500).json({ ok: false, error: "proxy_error" });
  }
});

// ====== 404 amigable ======
app.use((req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`MediaFlow proxy listening on :${PORT}`);
});
