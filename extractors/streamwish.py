# extractors/streamwish.py
"""
Extractor "pro" para StreamWish / guxhag.com / sws-like hosts.
Estrategia:
 - intenta extraer enlaces directos (m3u8/mp4) desde HTML (scripts, JSON, atob/base64).
 - valida el candidato con HEAD para confirmar content-type.
 - fallback: intentar usar yt-dlp (si está instalado en el entorno) para resolver el enlace.
 - devuelve dict con destination_url, content_type y metadata básica.
"""

from .base import BaseExtractor, ExtractorError
import re
import requests
import base64
import json
import logging

logger = logging.getLogger(__name__)

# Intentar importar yt_dlp (opcional, potente fallback)
try:
    import yt_dlp
    _HAS_YTDLP = True
except Exception:
    _HAS_YTDLP = False


class StreamWishExtractor(BaseExtractor):
    name = "streamwish"

    def __init__(self, timeout: int = 15):
        self.timeout = timeout
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        })

    def _head_check(self, url: str):
        try:
            r = self.session.head(url, allow_redirects=True, timeout=10)
            ct = r.headers.get("Content-Type", "").lower()
            cl = r.headers.get("Content-Length")
            return r.status_code, ct, int(cl) if cl and cl.isdigit() else None, r.url
        except Exception:
            return None, None, None, url

    def _try_patterns(self, html: str):
        """
        Buscar patrones comunes en el html/js que contienen el enlace directo.
        """
        # 1) sources: [{file:"..."}] o file:"..."
        patterns = [
            r'sources\s*:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"',
            r'file\s*:\s*"([^"]+\.m3u8[^"]*)"',
            r'file\s*:\s*"([^"]+\.mp4[^"]*)"',
            r'["\'](https?://[^"\']+\.m3u8[^"\']*)["\']',
            r'["\'](https?://[^"\']+\.mp4[^"\']*)["\']'
        ]
        for p in patterns:
            m = re.search(p, html, flags=re.IGNORECASE)
            if m:
                return m.group(1)

        # 2) atob("...base64...") -> decode and search inside
        for m in re.finditer(r'atob\(["\']([^"\']+)["\']\)', html):
            try:
                decoded = base64.b64decode(m.group(1)).decode("utf-8", errors="ignore")
                # buscar url dentro del decodificado
                u = re.search(r'(https?://[^\'"\\\s]+(?:\.m3u8|\.mp4)[^\'"\\\s]*)', decoded)
                if u:
                    return u.group(1)
            except Exception:
                continue

        # 3) JSON dentro de scripts: buscar source list JSON
        for m in re.finditer(r'var\s+playerData\s*=\s*(\{.+?\});', html, flags=re.S):
            try:
                j = json.loads(m.group(1))
                # buscar file en j
                def walk(o):
                    if isinstance(o, dict):
                        for k, v in o.items():
                            if isinstance(v, str) and (v.endswith('.m3u8') or v.endswith('.mp4') or '.m3u8' in v or '.mp4' in v):
                                return v
                            res = walk(v)
                            if res:
                                return res
                    elif isinstance(o, list):
                        for it in o:
                            res = walk(it)
                            if res:
                                return res
                    return None
                found = walk(j)
                if found:
                    return found
            except Exception:
                continue

        return None

    def _yt_dlp_resolve(self, url: str):
        if not _HAS_YTDLP:
            return None
        try:
            ydl_opts = {
                "format": "best",
                "quiet": True,
                "skip_download": True,
                "nocheckcertificate": True,
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=False)
                # info may contain 'url' (direct) or 'formats'
                if info is None:
                    return None
                if "url" in info and info.get("url"):
                    return info.get("url")
                formats = info.get("formats") or []
                if formats:
                    # choose best format with http(s)
                    for f in reversed(formats):
                        u = f.get("url")
                        if u and u.startswith("http"):
                            return u
            return None
        except Exception as e:
            logger.exception("yt-dlp fallback failed: %s", e)
            return None

    def extract(self, url: str) -> dict:
        """
        Intento robusto para resolver streamwish embed.
        Devuelve dict con:
          - destination_url
          - content_type
          - format
          - size (si se detecta)
          - note
        """
        try:
            if not any(x in url.lower() for x in ("guxhag.com", "streamwish", "sws", "streamwish.to")):
                raise ExtractorError("La URL no parece pertenecer a StreamWish/guxhag")

            headers = {"Referer": url, "User-Agent": self.session.headers.get("User-Agent")}
            resp = self.session.get(url, headers=headers, timeout=self.timeout)
            if resp.status_code != 200:
                raise ExtractorError(f"Host devolvió {resp.status_code}")

            html = resp.text

            # 1) intentar extraer por patrones
            candidate = self._try_patterns(html)
            if candidate:
                # normalizar
                candidate = candidate.replace("\\/", "/")
                # validar con HEAD
                status, ct, sz, final = self._head_check(candidate)
                if ct and (ct.startswith("video/") or "application/vnd.apple.mpegurl" in ct or "vnd.apple.mpegurl" in ct or ".m3u8" in candidate):
                    return {
                        "destination_url": final,
                        "content_type": ct or ("application/x-mpegURL" if ".m3u8" in candidate else "video/mp4"),
                        "format": "hls" if ".m3u8" in candidate else "mp4",
                        "size": sz,
                        "note": "extraído vía HTML patterns"
                    }
                # si HEAD no confirma pero la URL parece válida, devolvemos con nota
                if candidate.startswith("http"):
                    return {
                        "destination_url": candidate,
                        "content_type": "application/x-mpegURL" if ".m3u8" in candidate else "video/mp4",
                        "format": "hls" if ".m3u8" in candidate else "mp4",
                        "size": None,
                        "note": "extraído por patterns (HEAD no confirmó content-type; puede requerir referer/cookies adicionales)"
                    }

            # 2) fallback: intentar detectar urls absolutas en todo el html (último recurso)
            u = re.search(r'(https?://[^\'"\\\s]+(?:\.m3u8|\.mp4)[^\'"\\\s]*)', html)
            if u:
                cand = u.group(1)
                status, ct, sz, final = self._head_check(cand)
                return {
                    "destination_url": final or cand,
                    "content_type": ct or ("application/x-mpegURL" if ".m3u8" in cand else "video/mp4"),
                    "format": "hls" if ".m3u8" in cand else "mp4",
                    "size": sz,
                    "note": "extraído por búsqueda general en HTML"
                }

            # 3) yt-dlp fallback
            if _HAS_YTDLP:
                cand = self._yt_dlp_resolve(url)
                if cand:
                    status, ct, sz, final = self._head_check(cand)
                    return {
                        "destination_url": final or cand,
                        "content_type": ct or ("application/x-mpegURL" if ".m3u8" in cand else "video/mp4"),
                        "format": "hls" if ".m3u8" in cand else "mp4",
                        "size": sz,
                        "note": "resuelto vía yt-dlp fallback"
                    }

            # nada encontrado
            raise ExtractorError("No se pudo resolver enlace directo desde StreamWish (intenta yt-dlp o headless browser si es tu contenido)")

        except ExtractorError:
            raise
        except Exception as e:
            logger.exception("Error en StreamWish extractor: %s", e)
            raise ExtractorError(f"Error en extractor streamwish: {e}")


# exportar instancia para loader automático
extractor = StreamWishExtractor()
