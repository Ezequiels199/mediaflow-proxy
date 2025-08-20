// resolvers.js (LEGAL - NO scrapers 😉)
// Solo normaliza y limpia URLs conocidas.
// No hace scraping ni extracción de tokens.

export async function resolveUrl(originalUrl, opts = {}) {
  if (typeof originalUrl !== "string") throw new Error("URL inválida");
  const url = originalUrl.trim();
  if (!/^https?:\/\//i.test(url)) return originalUrl;

  // --- Lista blanca opcional ---
  // const WHITELIST = ["tudominio.com", "mi-cdn.com"];
  const WHITELIST = [];
  if (WHITELIST.length > 0) {
    const host = new URL(url).hostname.toLowerCase();
    if (!WHITELIST.includes(host)) return originalUrl;
  }

  // --- Normalizaciones seguras ---
  // 1) Archivos directos
  if (/\.(mp4|mkv|webm|mov|avi|flv|mpg|mpeg)(\?.*)?$/i.test(url)) return url;
  if (url.toLowerCase().includes(".m3u8")) return url;

  // 2) Normalizar algunos proveedores conocidos
  try {
    // YouTube short -> watch
    if (/youtu\.be\/([A-Za-z0-9_-]{6,})/i.test(url)) {
      const m = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/i);
      if (m && m[1]) return `https://www.youtube.com/watch?v=${m[1]}`;
    }
    // YouTube watch
    if (/youtube\.com\/.*v=([^&]+)/i.test(url)) {
      const m = url.match(/[?&]v=([^&]+)/i);
      if (m && m[1]) return `https://www.youtube.com/watch?v=${m[1]}`;
    }
    // Vimeo
    if (/vimeo\.com\/(\d+)/i.test(url)) {
      const m = url.match(/vimeo\.com\/(\d+)/i);
      if (m && m[1]) return `https://player.vimeo.com/video/${m[1]}`;
    }
  } catch (e) {
    return originalUrl;
  }

  // 3) Ejemplo de mapping propio (descomentar si hace falta)
  // if (new URL(url).hostname === "mi-origen-propio.com") {
  //   return url.replace("https://mi-origen-propio.com/video/", "https://cdn.mi-origen.com/videos/");
  // }

  // Por defecto: no cambia nada
  return originalUrl;
}
