import express from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 3000;

// Seguridad y rendimiento
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(compression());

// Contraseña (env var)
const API_PASSWORD = process.env.API_PASSWORD || "clave123";

// Limita requests para evitar abuso
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use(limiter);

// Middleware de contraseña para rutas /proxy
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// Forzar HTTPS en producción
app.use((req, res, next) => {
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] !== "https") {
    return res.redirect("https://" + req.headers.host + req.url);
  }
  next();
});

// Ruta de test
app.get("/proxy/ip", (req, res) => {
  res.json({
    ok: true,
    ip: req.ip,
    service: "🚀 MediaFlow Proxy PRO activo",
  });
});

// Ruta para proxy de streams
app.get("/proxy/stream", (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Falta parámetro ?url=" });
  res.json({
    ok: true,
    proxy: "MediaFlow Proxy PRO",
    target: url,
  });
});

// Arranque
app.listen(PORT, () => {
  console.log(`✅ Servidor PRO corriendo en puerto ${PORT}`);
});
