import express from "express";

const app = express();

// ⚙️ Variables de entorno
const PORT = process.env.PORT || 8080;
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || "mipassword";

// 🟢 Middleware para logging básico
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ✅ Ruta raíz (para test rápido en navegador)
app.get("/", (req, res) => {
  res.send("🚀 Servidor MediaFlow Proxy funcionando correctamente");
});

// ✅ Ruta que MediaFusion usa para validar el proxy
app.get("/proxy/ip", (req, res) => {
  const password = req.query.api_password;

  if (password !== SUPER_PASSWORD) {
    console.warn("❌ Intento de acceso con contraseña incorrecta");
    return res.status(401).json({ error: "No autorizado" });
  }

  res.json({
    ip: req.ip,
    status: "OK",
    message: "Proxy validado correctamente ✅"
  });
});

// ✅ Manifest para Stremio
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "org.mediaflow.addon",
    version: "1.0.0",
    name: "Mi Addon MediaFlow",
    description: "Addon de ejemplo para Stremio via MediaFusion",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: []
  });
});

// ✅ Ejemplo de endpoint de streams
app.get("/stream/:type/:id.json", (req, res) => {
  const { type, id } = req.params;
  res.json({
    streams: [
      {
        title: `Stream de prueba para ${type} ${id}`,
        url: "https://example.com/video.mp4"
      }
    ]
  });
});

// 🔴 Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    error: "Ruta no encontrada",
    path: req.originalUrl
  });
});

// 🚀 Iniciar servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});
