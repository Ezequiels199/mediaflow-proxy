// index.js - Servidor proxy multimedia con Express
const express = require('express');
const compression = require('compression');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 8080;

// Contraseña de autenticación (por defecto '8080', o usar PROXY_PASSWORD en env)
const PASSWORD = process.env.PROXY_PASSWORD || '8080';

// Directorio donde se guardará la caché en disco
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR);
}

// Middleware de compresión con gzip/brotli, nivel 6
app.use(compression({ level: 6 }));

// Middleware de autenticación HTTP Basic
app.use((req, res, next) => {
    // No proteger ruta de salud
    if (req.path === '/health') return next();

    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Autenticación requerida');
    }
    // Ejemplo de header: "Basic dXNlcjpwYXNz"
    const token = authHeader.split(' ')[1] || '';
    const [user, pass] = Buffer.from(token, 'base64').toString().split(':');
    if (pass !== PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic');
        return res.status(401).send('Credenciales inválidas');
    }
    // Credenciales correctas
    next();
});

// Endpoint de salud (status 200 OK)
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Endpoint de debug de autenticación (requiere auth, confirma si funcionó)
app.get('/debug-auth', (req, res) => {
    res.send('Autenticación exitosa');
});

// Función para obtener el tamaño total de archivos en un directorio (asíncrona)
function getDirectorySize(dir) {
    const files = fs.readdirSync(dir);
    let total = 0;
    for (const file of files) {
        const stats = fs.statSync(path.join(dir, file));
        if (stats.isFile()) {
            total += stats.size;
        }
    }
    return total;
}

// Función LRU de limpieza de caché: elimina archivos antiguos si se supera 20GB
function pruneCache() {
    const MAX_SIZE = 20 * 1024 * 1024 * 1024; // 20 GB
    let totalSize = getDirectorySize(CACHE_DIR);
    if (totalSize <= MAX_SIZE) return;
    // Obtener lista de archivos con fechas de último acceso (atime)
    let files = fs.readdirSync(CACHE_DIR).map(f => {
        const filePath = path.join(CACHE_DIR, f);
        const stats = fs.statSync(filePath);
        return { path: filePath, atime: stats.atimeMs, size: stats.size };
    });
    // Ordenar por fecha de acceso ascendente (más antiguos primero)
    files.sort((a, b) => a.atime - b.atime);
    // Eliminar hasta que quede dentro del límite
    for (const file of files) {
        if (totalSize <= MAX_SIZE) break;
        try {
            fs.unlinkSync(file.path);
            totalSize -= file.size;
        } catch (err) {
            console.error('Error borrando caché:', err);
        }
    }
}

// Función principal de proxy: maneja GET /proxy/*
async function handleProxy(req, res) {
    // Obtener la URL destino: prioridad a query param
    let targetUrl = req.query.url;
    if (!targetUrl) {
        // Si no está en query, tomar desde la ruta: /proxy/<encodedURL>
        // decodeURIComponent para permitir caracteres especiales
        targetUrl = decodeURIComponent(req.path.slice(7)); // eliminar '/proxy/'
    }
    if (!targetUrl) {
        return res.status(400).send('Falta la URL en la ruta o query');
    }

    // Validar que la URL comience con http:// o https://
    if (!/^https?:\/\//i.test(targetUrl)) {
        return res.status(400).send('URL inválida (debe incluir http:// o https://)');
    }

    // Nombre de archivo en caché derivado de la URL (base64 para evitar conflictos)
    const cacheKey = Buffer.from(targetUrl).toString('base64');
    const cachePath = path.join(CACHE_DIR, cacheKey);

    // Si está en caché de disco y existe el archivo, servirlo directamente
    if (fs.existsSync(cachePath)) {
        // Actualizar fecha de acceso (LRU)
        const now = new Date();
        fs.utimesSync(cachePath, now, now);
        // Obtener info de archivo
        const stats = fs.statSync(cachePath);
        // Configurar headers (al menos tipo de contenido)
        // Podemos leer e inferir tipo, pero por simplicidad: usar  octect-stream.
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', stats.size);
        // Responder con el stream del archivo caché
        return fs.createReadStream(cachePath).pipe(res);
    }

    // No está en caché en disco: realizar petición al origen
    // Elegir cliente http o https según la URL
    const client = targetUrl.startsWith('https') ? https : http;
    const options = new URL(targetUrl);
    // Propagar encabezado Range si existe (soporte de streaming parcial)
    if (req.headers.range) {
        options.headers = { Range: req.headers.range };
    }

    client.get(options, (remoteRes) => {
        // Si la respuesta es un error (>=300), no la cacheamos
        if (remoteRes.statusCode >= 400) {
            return res.status(remoteRes.statusCode).send(remoteRes.statusMessage);
        }
        // Revisar tipo de contenido
        const contentType = remoteRes.headers['content-type'] || '';
        // Cabeceras: pasar al cliente (status y headers)
        res.writeHead(remoteRes.statusCode, remoteRes.headers);

        // Preparar streams duplicados: uno para cliente, otro para guardar en disco
        const pass = new PassThrough();
        remoteRes.pipe(pass);

        // Escribir cache en disco (creando stream de escritura)
        const cacheFile = fs.createWriteStream(cachePath);
        pass.pipe(cacheFile).on('finish', () => {
            // Una vez guardado, podriamos actualizar stats o log (opcional)
            pruneCache();
        });

        // Enviar al cliente
        pass.pipe(res);

    }).on('error', (err) => {
        console.error('Error en proxy hacia', targetUrl, err);
        res.status(500).send('Error al solicitar recurso remoto');
    });
}

// Rutas proxy: acepta /proxy?url=... y /proxy/<url>
app.get('/proxy', handleProxy);
app.get('/proxy/*', handleProxy);

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Proxy multimedia escuchando en puerto ${PORT}`);
});
