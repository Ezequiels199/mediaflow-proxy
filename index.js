// index.js
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = process.env.PORT || 3000;
// Cambiá TARGET_URL en Render si querés otro destino
const TARGET = process.env.TARGET_URL || "https://webstreamr.hayd.uk";

// Opcionales: seguridad
const API_KEY = process.env.API_KEY || ""; // tu clave
const PASS   = process.env.SUPERCLAVE || process.env.PASSWORD || ""; // tu contraseña

// CORS básico
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Auth opcional (x-api-key, ?key=, Authorization: Bearer, o Basic con PASS)
function auth(req, res, next) {
  if (!API_KEY && !PASS) return next();

  const keyHeader = req.header("x-api-key");
  const keyQuery =
    req.query.key || req.query.apikey || req.query.token || req.query.k;
  const authz = req.header("authorization") || "";

  const okKey =
    (API_KEY && (keyHeader === API_KEY || keyQuery === API_KEY)) ||
    (API_KEY && authz.startsWith("Bearer ") && authz.slice(7) === API_KEY);

  let okBasic = false;
  if (PASS && authz.startsWith("Basic ")) {
    const decoded = Buffer.from(authz.split(" ")[1], "base64")
      .toString()
      .split(":");
    const pass = decoded[1] || "";
    okBasic = pass === PASS;
  }

  if (okKey || okBasic) return next();

  res.set("WWW-Authenticate", "Basic realm=proxy");
  return res.status(401).json({ ok: false, error: "No autorizado" });
}

// Rutas informativas
app.get("/health", (_req, res) => res.json({ ok: true, target: TARGET }));
app.get("/", (_req, res) => {
  res.type("text").send(
    [
      "✅ MediaFlow Proxy OK",
      `→ Target: ${TARGET}`,
      API_KEY || PASS
        ? "🔐 Protegido (usa x-api-key, ?key=, Bearer o Basic)"
        : "🔓 Sin clave (podés agregar API_KEY/SUPERCLAVE en Render)",
      "Resto de rutas se envían al target."
    ].join("\n")
  );
});

// Proxy (todo lo demás)
app.use(
  auth,
  createProxyMiddleware({
    target: TARGET,
    changeOrigin: true,
    ws: true,
    secure: true,
    logLevel: "warn",
    timeout: 60_000,
    proxyTimeout: 60_000,
    pathRewrite: (path) => path
  })
);

app.listen(PORT, () => {
  console.log(`Proxy escuchando en :${PORT} → ${TARGET}`);
});
