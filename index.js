// index.js - MediaFlow Proxy Moderno (Node.js 22)

import express from "express";
import compression from "compression";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 Contraseña configurable (por seguridad usa variable de entorno en producción)
const API_PASSWORD = process.env.API_PASSWORD || "8080";

// 🗄️ Caché en memoria (6 horas)
const memoryCache = new NodeCache({ stdTTL: 21600, checkperiod: 120 });

// 📂 Carpeta de cache en disco
const CACHE_DIR = path.join(__dirname, "disk_cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

// 📏 Límite total de caché en disco (20GB)
const DISK_CACHE_LIMIT = 20 * 1024 * 1024 * 1024;

// 🛠 Función para calcular uso actual del disco
function getDiskUsage() {
  const files = fs.readdirSync(CACHE_DIR);
  let totalSize = 0;
  const fileList = files.map((file) => {
    const filePath = path.join(CACHE_DIR, file);
    const stats = fs.statSync(filePath);
    totalSize += stats.size;
    return { file, filePath, size: stats.size, mtime: stats.mtime };
  });
  return { totalSize, fileList };
}

// 🛠 Función para liberar espacio si se excede el límite
function enforceDiskLimit() {
  let { totalSize, fileList } = getDiskUsage();
  if (totalSize <= DISK_CACHE_LIMIT) return;

  console.log("⚠️ Caché en disco excedida, limpiando...");
  fileList.sort((a, b) => a.mtime - b.mtime); // borra los más viejos
  for (const file of fileList) {
    fs.unlinkSync(file.filePath);
    totalSize -= file.size;
    if (totalSize <= DISK_CACHE_LIMIT) break;
  }
}

// ⚡ Middlewares
app.use(compression({ level: 6 }));

// 🔒 Middleware de autenticación
app.use("/proxy", (req, res, next) => {
  const pass =
    req.query.password ||
    req.query.api_password ||
    req.headers["x-api-password"];
  if (pass !== API_PASSWORD) {
    return res.status(401).json({ error: "Contraseña inválida" });
  }
  next();
});

// 🚀 Proxy moderno
app.get("/proxy/*", async (req, res) => {
  try {
    const targetUrl = decodeURIComponent(req.params[0]);
    if (!targetUrl) {
      return res.status(400).json({ error: "Falta la URL de destino" });
    }

    const fileName = Buffer.from(targetUrl).toString("base64") + ".cache";
    const filePath = path.join(CACHE_DIR, fileName);

    // ✅ Primero RAM
    if (memoryCache.has(targetUrl)) {
      console.log("⚡ Sirviendo desde RAM:", targetUrl);
      const cached = memoryCache.get(targetUrl);
      res.writeHead(200, cached.headers);
      return res.end(cached.body);
    }

    // ✅ Luego disco
    if (fs.existsSync(filePath)) {
      console.log("💾 Sirviendo desde DISCO:", targetUrl);
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": "video/mp4" });
      return res.end(data);
    }

    // ⬇️ Descargar de internet usando fetch nativo
    console.log("🌍 Descargando desde origen:", targetUrl);
    const response = await fetch(targetUrl, {
      headers: { Range: req.headers.range || "" },
    });

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ error: `Error al obtener: ${response.statusText}` });
    }

    const headers = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // 📥 Buffer dinámico (optimizado para gigas)
    let bodyBuffer = Buffer.alloc(0);
    for await (const chunk of response.body) {
      bodyBuffer = Buffer.concat([bodyBuffer, chunk]);
    }

    // Guardar en RAM
    memoryCache.set(targetUrl, { headers, body: bodyBuffer });

    // Guardar en disco
    fs.writeFileSync(filePath, bodyBuffer);
    enforceDiskLimit();

    // Enviar al cliente
    res.writeHead(response.status, headers);
    res.end(bodyBuffer);
  } catch (err) {
    console.error("❌ Error en proxy:", err);
    res.status(500).json({ error: "Error en el proxy" });
  }
});

// 🟢 Inicio
app.listen(PORT, () => {
  console.log(`🚀 MediaFlow PRO (Node 22) en http://localhost:${PORT}`);
});
