import express from "express";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import axios from "axios";
import LRU from "lru-cache";

const app = express();

// 🔧 Config
const PORT = process.env.PORT || 8080;
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || "mipassword";

// ⚙️ Cliente HTTP con cookies y timeouts
const jar = new CookieJar();
const http = wrapper(axios.create({
  jar,
  timeout: 20000,           // 20 segundos
  maxRedirects: 5,          // seguir redirecciones
  validateStatus: () => true
}));

// 🧠 Caché simple (cabeceras y URL final) 60s
const cache = new LRU({
  max: 500,
  ttl: 60 * 1000
});

// User-Agent realista
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

// 📝 log básico
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ✅ raíz
app.get("/", (_req, res) => {
  res.send("🚀 MediaFlow Proxy robusto corriendo");
});

// ✅ ping para MediaFusion (validación rápida)
app.get("/proxy/ip", (req, res) => {
  const pwd = req.query.api_password || "";
  if (pwd !== SUPER_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }
  res.json({ status: "OK", ip: req.ip });
});

// 🔎 fetch diagnóstico
app.get("/fetch", async (req, res) => {
  try {
    const pwd = req.query.api_password || "";
    if (pwd !== SUPER_PASSWORD) return res.status(401).json({ error: "No autorizado" });

    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Falta ?url=" });

    const referer = req.query.referer || target;
    const cacheKey = `fetch:${target}|${referer}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ cached: true, ...cached });

    const r = await http.get(target, {
      headers: {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
        "Referer": referer,
        "Origin": new URL(referer).origin
      },
      responseType: "text"
    });

    const preview = typeof r.data === "string" ? r.data.slice(0, 600) : JSON.stringify(r.data).slice(0, 600);
    const payload = {
      status: r.status,
      finalUrl: r.request?.res?.responseUrl || r.request?.path || target,
      headers: r.headers,
      preview
    };
    cache.set(cacheKey, payload);
    res.json(payload);
  } catch (e) {
    console.error("fetch error", e.message);
    res.status(500).json({ error: "Error en fetch", details: e.message });
  }
});

// 🎬 stream proxy mejorado para videos grandes
app.get("/stream", async (req, res) => {
  try {
    const pwd = req.query.api_password || "";
    if (pwd !== SUPER_PASSWORD) return res.status(401).json({ error: "No autorizado" });

    const target = req.query.url;
    if (!target) return res.status(400).json({ error: "Falta ?url=" });

    const referer = req.query.referer || target;

    // Headers hacia el servidor original
    const headers = {
      "User-Agent": UA,
      "Accept": "*/*",
      "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
      "Referer": referer,
      "Origin": new URL(referer).origin
    };

    // Soporte Range (pedacitos del video)
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const response = await http.get(target, {
      headers,
      responseType: "stream"
    });

    // Pasamos todas las cabeceras que nos sirvan
    Object.entries(response.headers).forEach(([k, v]) => {
      if (k && v) res.setHeader(k, v);
    });

    res.status(response.status);

    // 🚰 Pipe directo (sin guardar en RAM/disco)
    response.data.pipe(res);

    response.data.on("error", (err) => {
      console.error("❌ Error en stream:", err.message);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
  } catch (e) {
    console.error("❌ Stream error", e.message);
    if (!res.headersSent) res.status(502).json({ error: "Error en stream", details: e.message });
    else res.end();
  }
});

// 404 JSON
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada", path: req.originalUrl });
});

// 🚀 start
app.listen(PORT, () => console.log(`✅ Proxy robusto escuchando en :${PORT}`));
