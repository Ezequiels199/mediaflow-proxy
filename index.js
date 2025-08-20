// index.js
import express from "express";
import helmet from "helmet";
import compression from "compression";
import cors from "cors";
import morgan from "morgan";
import axios from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar } from "tough-cookie";

const app = express();
const PORT = process.env.PORT || 3000;

// Seguridad básica
app.use(helmet());

// Compresión de respuestas
app.use(compression());

// Permitir CORS (todas las URLs)
app.use(cors());

// Logs de requests
app.use(morgan("dev"));

// Middleware para parsear JSON
app.use(express.json());

// Cliente HTTP con soporte de cookies
const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

// Ruta de prueba
app.get("/", (req, res) => {
  res.json({ status: "✅ Servidor corriendo PRO", time: new Date() });
});

// Ruta para consumir una URL externa y devolver su contenido
app.get("/proxy", async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: "Falta parámetro ?url=" });

    const response = await client.get(url, { responseType: "stream" });

    // Pipe del stream al cliente
    response.data.pipe(res);
  } catch (err) {
    console.error("Error en /proxy:", err.message);
    res.status(500).json({ error: "No se pudo procesar la URL externa" });
  }
});

// Ruta para testear cookies
app.get("/cookies", async (req, res) => {
  try {
    await client.get("https://httpbin.org/cookies/set?mycookie=test123");
    const cookieResp = await client.get("https://httpbin.org/cookies");
    res.json(cookieResp.data);
  } catch (err) {
    console.error("Error en /cookies:", err.message);
    res.status(500).json({ error: "No se pudo manejar cookies" });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor PRO corriendo en puerto ${PORT}`);
});
