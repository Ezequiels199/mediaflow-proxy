import express from "express";
import compression from "compression";
import fetch from "node-fetch";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 Contraseña (puedes cambiarla)
const API_PASSWORD = "superclave123";

// 🗄️ Cache en memoria (3 horas)
const memoryCache = new NodeCache({ stdTTL: 10800, checkperiod: 120 });

// Compresión gzip/brotli
app.use(compression({ level: 6 }));

// Middleware de autenticación
app.use("/proxy", (req, res, next) => {
  const pass = req.query.password || req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// ========================
// 📌 LEGAL RESOLVERS 😉
// ========================

async function resolverDirecto(url) {
  // sirve para cualquier mp4/mkv/m3u8 público
  return url;
}

async function resolverMixdrop(url) {
  // Simulación legal 😉
  if (url.includes("mixdrop")) {
    return url; // en la realidad deberías resolverlo, aquí lo devolvemos directo
  }
  return null;
}

async function resolverStreamtape(url) {
  if (url.includes("streamtape")) {
    return url;
  }
  return null;
}

// ========================
// 📌 PROXY
// ========================
app.get("/proxy/*", async (req, res) => {
  try {
    const targetUrl = req.params[0];
    if (!targetUrl) {
      return res.status(400).json({ error: "Falta la URL de destino" });
    }

    // resolvemos "LEGALMENTE" 😉
    let resolvedUrl =
      (await resolverDirecto(targetUrl)) ||
      (await resolverMixdrop(targetUrl)) ||
      (await resolverStreamtape(targetUrl));

    if (!resolvedUrl) {
      return res.status(404).json({ error: "URL no soportada" });
    }

    // Cache en memoria
    if (memoryCache.has(resolvedUrl)) {
      console.log("✅ Sirviendo desde RAM:", resolvedUrl);
      const cached = memoryCache.get(resolvedUrl);
      res.writeHead(200, cached.headers);
      return res.end(cached.body);
    }

    console.log("⬇️ Descargando desde origen:", resolvedUrl);
    const response = await fetch(resolvedUrl, {
      headers: { Range: req.headers.range || "" },
    });

    const headers = {};
    response.headers.forEach((v, k) => (headers[k] = v));

    let bodyBuffer = Buffer.from([]);
    for await (const chunk of response.body) {
      bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
    }

    // guardar en RAM
    memoryCache.set(resolvedUrl, { headers, body: bodyBuffer });

    res.writeHead(response.status, headers);
    res.end(bodyBuffer);
  } catch (err) {
    console.error("❌ Error en proxy:", err);
    res.status(500).json({ error: "Error en el proxy" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor LEGAL corriendo en http://localhost:${PORT}`);
});
