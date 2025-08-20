const express = require('express');
const fetch = require('node-fetch');
const NodeCache = require('node-cache');
const WebTorrent = require('webtorrent');
const compression = require('compression');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');

// Cargar variables de entorno (incluida API_KEY para autenticación)
dotenv.config();
const API_KEY = process.env.API_KEY || 'clave_por_defecto';

const app = express();
app.use(compression());  // Habilitar compresión gzip/brotli0
app.use(cors());         // Habilitar CORS (acceso desde cualquier origen)

const memCache = new NodeCache({ stdTTL: 600, checkperiod: 120 }); 
const DISK_CACHE_DIR = path.join(__dirname, 'media_cache');
if (!fs.existsSync(DISK_CACHE_DIR)) fs.mkdirSync(DISK_CACHE_DIR);

const torrentClient = new WebTorrent(); // Cliente para torrents12

// Middleware de autenticación por clave/token (en cabeceras o query)
app.use((req, res, next) => {
    const token = req.headers['x-api-key'] || req.query.token;
    if (!token || token !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// Ruta para streaming HLS (archivo .m3u8)
// Reescribe las URLs de segmentos para que pasen por /proxy3
app.get('/hls', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('Missing url parameter');

    // Servir playlist desde caché de memoria si existe
    if (memCache.has(targetUrl)) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        return res.send(memCache.get(targetUrl));
    }

    try {
        const response = await fetch(targetUrl);
        if (!response.ok) return res.status(502).send('Error fetching playlist');
        const playlist = await response.text();
        const lines = playlist.split('\n');
        // Reescribir cada línea de segmento que no es comentario
        const proxiedLines = lines.map(line => {
            if (line && !line.startsWith('#')) {
                // Resolver URL absoluta del segmento HLS
                const segmentUrl = new URL(line, targetUrl).href;
                // Proxy hacia /proxy para cada segmento
                return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(segmentUrl)}`;
            }
            return line;
        });
        const modified = proxiedLines.join('\n');
        memCache.set(targetUrl, modified); // Cachear playlist reescrito
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(modified);
    } catch (err) {
        console.error('HLS error:', err);
        res.status(500).send('Internal server error');
    }
});

// Ruta genérica /proxy para streaming de archivos (mp4, mkv, .ts, etc.)
// Soporta HTTP Range (descargas parciales)4 y guarda en caché en disco
app.get('/proxy', async (req, res) => {
    const fileUrl = req.query.url;
    if (!fileUrl) return res.status(400).send('Missing url parameter');

    const range = req.headers.range || '';
    const opts = { headers: {} };
    if (range) opts.headers['Range'] = range;

    // Verificar caché en disco para peticiones completas (sin rango)
    const cachePath = path.join(DISK_CACHE_DIR, encodeURIComponent(fileUrl));
    if (!range && fs.existsSync(cachePath)) {
        return res.sendFile(cachePath);
    }

    try {
        const response = await fetch(fileUrl, opts);
        if (!response.ok && response.status !== 206) {
            return res.status(502).send('Error fetching file');
        }
        // Ajustar código de estado y cabeceras
        res.status(response.status);
        response.headers.forEach((value, key) => res.setHeader(key, value));
        const readStream = response.body;

        if (!range) {
            // Duplicar stream: uno al cliente y otro al disco para caché futura
            const pass = new PassThrough();
            const fileStream = fs.createWriteStream(cachePath);
            readStream.pipe(pass);
            pass.pipe(res);
            pass.pipe(fileStream);
        } else {
            // Para rangos, solo transmitir al cliente
            readStream.pipe(res);
        }
    } catch (err) {
        console.error('Proxy error:', err);
        res.status(500).send('Internal server error');
    }
});

// Streaming desde enlaces torrent (magnet)
// Selecciona el primer archivo de video (.mp4, .mkv, .avi)56
app.get('/torrent', (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).send('Missing magnet parameter');

    torrentClient.add(magnet, torrent => {
        const file = torrent.files.find(f => /\.(mp4|mkv|avi)$/i.test(f.name)) || torrent.files[0];
        res.setHeader('Content-Length', file.length);
        res.setHeader('Content-Type', 'video/mp4');
        // Streaming del archivo torrent al cliente
        file.createReadStream().pipe(res);
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Media proxy corriendo en puerto ${PORT}`);
});
