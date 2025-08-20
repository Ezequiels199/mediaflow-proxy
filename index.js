import express from "express";
import helmet from "helmet";
import compression from "compression";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "superclave123";

// Seguridad y compresión
app.use(helmet());
app.use(compression());

// Middleware para archivos grandes (streams largos)
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// Middleware de autenticación
app.use((req, res, next) => {
  const key = req.query.api_password;
  if (key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Ruta base
app.get("/", (req, res) => {
  res.json({ status: "MediaFlow proxy funcionando ✅" });
});

// --- Resolver rápido MixDrop ---
app.get("/resolver/mixdrop", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Falta parámetro ?url=" });

    const html = await fetch(url).then(r => r.text());
    const match = html.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
    if (match) {
      return res.json({ stream: match[1] });
    } else {
      return res.status(404).json({ error: "No se encontró stream en MixDrop" });
    }
  } catch (err) {
    res.status(500).json({ error: "Error resolviendo MixDrop", details: err.message });
  }
});

// --- Resolver rápido StreamTape ---
app.get("/resolver/streamtape", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Falta parámetro ?url=" });

    const html = await fetch(url).then(r => r.text());
    const match = html.match(/document\.getElementById\('videolink'\)\.innerHTML\s*=\s*"([^"]+)"/);
    if (match) {
      const finalUrl = "https:" + match[1].replace(/&amp;/g, "&");
      return res.json({ stream: finalUrl });
    } else {
      return res.status(404).json({ error: "No se encontró stream en StreamTape" });
    }
  } catch (err) {
    res.status(500).json({ error: "Error resolviendo StreamTape", details: err.message });
  }
});

// Proxy de prueba
app.get("/proxy/ip", (req, res) => {
  res.json({ ip: req.ip, api: "ok" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
