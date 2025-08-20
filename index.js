// index.js
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const cors = require("cors");
const morgan = require("morgan");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3000;

// ⚙️ Variables de entorno
const PASSWORD = process.env.PROXY_PASSWORD || "8080";
const TARGET = process.env.PROXY_TARGET || "https://sample-videos.com";

// Cache (5 min)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 320 });

// Middlewares
app.use(cors());
app.use(morgan("tiny"));

// 🔒 Autenticación
app.use((req, res, next) => {
  if (req.query.password !== PASSWORD) {
    return res.status(401).json({ ok: false, error: "Contraseña incorrecta ❌" });
  }
  next();
});

// 📺 Proxy con cache
app.use(
  "/video",
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    pathRewrite: { "^/video": "" },
    selfHandleResponse: true, // Para cache
    onProxyRes: async (proxyRes, req, res) => {
      let body = Buffer.from([]);
      proxyRes.on("data", (chunk) => {
        body = Buffer.concat([body, chunk]);
      });
      proxyRes.on("end", () => {
        // Guardamos en cache
        cache.set(req.url, body);
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(body);
      });
    },
    onError: (err, req, res) => {
      console.error("❌ Proxy error:", err.message);
      res.status(500).json({ ok: false, error: "Error en el proxy" });
    },
  })
);

// 🚀 Endpoint raíz
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "MediaFlow Proxy PRO 🚀",
    usage: `/video/...file...?password=${PASSWORD}`,
  });
});

// Servir desde cache si existe
app.use((req, res, next) => {
  const cached = cache.get(req.url);
  if (cached) {
    console.log("⚡ Sirviendo desde cache:", req.url);
    return res.end(cached);
  }
  next();
});

// Start
app.listen(PORT, () => {
  console.log(`✅ MediaFlow corriendo en http://localhost:${PORT}`);
});
