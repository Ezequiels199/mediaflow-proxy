import express from "express";
import helmet from "helmet";
import compression from "compression";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());
app.use(compression());

// ---------------- PROXY DIRECTO ----------------
app.get("/proxy", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("Falta ?url=");

    res.redirect(targetUrl);
  } catch (err) {
    console.error("Proxy error:", err);
    res.status(500).send("Error interno en proxy");
  }
});

// ---------------- MIXDROP ----------------
app.get("/mixdrop", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).send("Falta ?id=");

    const url = `https://mixdrop.co/f/${id}`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) return res.status(404).send("Error al acceder a Mixdrop");

    const html = await response.text();
    const match = html.match(/MDCore\.wurl\s*=\s*"([^"]+)"/);
    if (!match) return res.status(404).send("No se pudo extraer video de Mixdrop");

    const videoUrl = "https:" + match[1];
    res.redirect(videoUrl);
  } catch (err) {
    console.error("Mixdrop error:", err);
    res.status(500).send("Error interno en Mixdrop");
  }
});

// ---------------- STREAMTAPE ----------------
app.get("/streamtape", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).send("Falta ?id=");

    const url = `https://streamtape.com/v/${id}`;
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!response.ok) return res.status(404).send("Error al acceder a Streamtape");

    const html = await response.text();
    const match = html.match(/'robotlink'\)\.innerHTML\s=\s'<a href="([^"]+)"/);
    if (!match) return res.status(404).send("No se pudo extraer video de Streamtape");

    const videoUrl = "https:" + match[1];
    res.redirect(videoUrl);
  } catch (err) {
    console.error("Streamtape error:", err);
    res.status(500).send("Error interno en Streamtape");
  }
});

// ---------------- DOODSTREAM (multi-dominios) ----------------
const doodDomains = [
  "dood.ws",
  "dood.watch",
  "doodstream.com",
  "dood.to",
  "dood.so",
  "dood.cx"
];

app.get("/dood", async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).send("Falta ?id=");

    // Probar con cada dominio hasta encontrar uno válido
    for (const domain of doodDomains) {
      const url = `https://${domain}/e/${id}`;
      try {
        const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!response.ok) continue;

        const html = await response.text();
        const match = html.match(/window\.open\("([^"]+)"/);
        if (match) {
          const videoUrl = "https:" + match[1];
          return res.redirect(videoUrl);
        }
      } catch (e) {
        continue; // probar con el siguiente dominio
      }
    }

    res.status(404).send("No se pudo extraer video de DoodStream (ningún dominio respondió)");
  } catch (err) {
    console.error("DoodStream error:", err);
    res.status(500).send("Error interno en DoodStream");
  }
});

// ---------------- ROOT ----------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    ejemploMixdrop: "/mixdrop?id=XXXX",
    ejemploStreamtape: "/streamtape?id=YYYY",
    ejemploDoodStream: "/dood?id=ZZZZ",
    ejemploProxy: "/proxy?url=https://dominio.com/archivo.mp4"
  });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
