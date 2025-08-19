import express from "express";

const app = express();

// Variables de entorno
const PORT = process.env.PORT || 8080;
const SUPER_SECRET = process.env.SUPER_SECRET || "mipassword";
const API_KEY = process.env.API_KEY || "miclave";

// 🔹 Ruta que MediaFusion usa para validar el proxy
app.get("/proxy/ip", (req, res) => {
  const password = req.query.api_password;

  if (password !== SUPER_SECRET) {
    return res.status(401).send("No autorizado");
  }

  res.json({ ip: req.ip, status: "OK" });
});

// 🔹 Manifest de tu addon
app.get("/manifest.json", (req, res) => {
  res.json({
    id: "org.mediaflow.addon",
    version: "1.0.0",
    name: "Mi Addon MediaFlow",
    description: "Addon para Stremio via MediaFusion",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: []
  });
});

// 🔹 Ejemplo de endpoint de streams (lo podés ampliar después)
app.get("/stream/:type/:id.json", (req, res) => {
  res.json({
    streams: [
      {
        title: "Ejemplo stream",
        url: "https://example.com/video.mp4"
      }
    ]
  });
});

// Servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
