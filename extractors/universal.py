# extractors/universal.py
# Extractor universal: detecta y valida enlaces directos a vídeos (.mp4, .m3u8, .mkv, .webm, etc.)
# Convención: exporta `Extractor` (clase) que la fábrica instanciará.

import re
import mimetypes
from typing import Optional
import httpx

# lista de extensiones que consideramos vídeo/stream
VIDEO_EXTS = {
    "mp4", "mkv", "webm", "avi", "mov", "flv", "m3u8", "ts", "ogv", "ogg", "mpd", "3gp"
}

# regex para buscar enlaces a vídeos en HTML (primera coincidencia)
RE_VIDEO_LINK = re.compile(
    r'https?://[^\'" >]+?\.(?:mp4|m3u8|webm|mkv|avi|mov|flv|ts|ogv|mpd|3gp)(?:\?[^\'"\s>]*)?',
    re.IGNORECASE
)

class UniversalExtractor:
    """
    Extractor universal ligero:
    - can_handle(url) devuelve True si la URL parece apuntar a un vídeo/playlist (por extensión u host)
    - extract(url) intenta verificar el recurso y devuelve metadata + url final reproducible
    """

    server_name = "universal"

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout
        # user-agent simple para evitar bloqueos básicos
        self.headers = {"User-Agent": "Mozilla/5.0 (compatible; mediaflow-proxy/1.0)"}

    def _get_ext_from_url(self, url: str) -> Optional[str]:
        path = url.split("?", 1)[0]
        if "." in path:
            ext = path.rsplit(".", 1)[-1].lower()
            if ext:
                return ext
        return None

    def can_handle(self, url: str) -> bool:
        """Heurística rápida para decidir si este extractor puede manejar la URL.
        - True si la extensión es una de VIDEO_EXTS o si el url contiene 'm3u8' u hosts conocidos.
        """
        ext = self._get_ext_from_url(url)
        if ext in VIDEO_EXTS:
            return True
        lowered = url.lower()
        if "m3u8" in lowered or "manifest.mpd" in lowered:
            return True
        # detectar hosts comunes de vídeo/genéricos (filtro liviano)
        host_indicators = ("stream", "video", "cdn", "mixdrop", "streamtape", "dood", "filemoon", "fembed", "vidcloud")
        if any(h in lowered for h in host_indicators):
            return True
        return False

    def _head_or_get_headers(self, url: str) -> httpx.Response:
        """Intenta HEAD; si falla o no soportado, hace GET (stream) pero sin descargar el cuerpo entero."""
        # Primero HEAD
        try:
            with httpx.Client(headers=self.headers, follow_redirects=True, timeout=self.timeout) as client:
                r = client.head(url)
                # algunos servidores devuelven 405 (Method Not Allowed) para HEAD
                if r.status_code in (200, 206):
                    return r
                if r.status_code == 405:
                    # fallback a GET stream (solo pedir cabeceras en streaming)
                    r2 = client.get(url, stream=True)
                    return r2
                # si otros códigos (3xx ya resueltos por follow_redirects), devolvemos r
                return r
        except Exception as e_head:
            # fallback: GET stream si HEAD falla
            try:
                with httpx.Client(headers=self.headers, follow_redirects=True, timeout=self.timeout) as client:
                    r = client.get(url, stream=True)
                    return r
            except Exception as e_get:
                # re-lanzamos el último error para que el caller lo capture
                raise e_get

    def _find_video_in_html(self, html: str) -> Optional[str]:
        m = RE_VIDEO_LINK.search(html)
        if m:
            return m.group(0)
        return None

    def extract(self, url: str) -> dict:
        """
        Intento principal:
        1) HEAD -> si content-type es video/* o app/vnd.apple.mpegurl => devolver meta.
        2) Si HEAD no fiable o devuelve HTML -> GET (stream) y buscar enlaces directos en HTML.
        Resultado: dict con keys:
          - destination_url (url final a reproducir)
          - content_type
          - format
          - size (bytes o None)
          - note (info)
        """
        # 1) validación rápida por extensión
        ext = self._get_ext_from_url(url)
        try:
            r = self._head_or_get_headers(url)
        except Exception as e:
            return {"error": "No se pudo conectar al URL", "detail": str(e)}

        status = getattr(r, "status_code", None)
        headers = getattr(r, "headers", {}) or {}

        # comprobar status aceptable (200 OK o 206 Partial Content)
        if status not in (200, 206):
            # si status es 403 o 401, devolver mensaje claro
            return {"error": f"HTTP {status}", "detail": "No se puede acceder al recurso (auth/forbidden?)."}

        content_type = headers.get("content-type", "")
        content_length = headers.get("content-length")
        size = None
        try:
            if content_length and content_length.isdigit():
                size = int(content_length)
        except Exception:
            size = None

        # Normalizar content-type (solo la parte principal)
        if content_type:
            content_type = content_type.split(";")[0].strip().lower()

        # Si el content type indica vídeo o HLS -> devolver directamente
        if content_type.startswith("video/") or "mpegurl" in content_type or "application/vnd.apple.mpegurl" in content_type or (ext and ext in VIDEO_EXTS):
            final_format = ext if ext else (mimetypes.guess_extension(content_type) or "").lstrip(".")
            return {
                "destination_url": url,
                "content_type": content_type or None,
                "format": final_format or None,
                "size": size,
                "note": "directo (HEAD/GET detectó recurso de vídeo)"
            }

        # Si content-type es HTML u otro o vacío, intentar leer fragmento de HTML para buscar enlaces a vídeo
        # Hacemos una petición GET con stream y leemos solo los primeros KB (no descargamos archivo entero)
        try:
            with httpx.Client(headers=self.headers, follow_redirects=True, timeout=self.timeout) as client:
                resp = client.get(url, timeout=self.timeout)
                if resp.status_code not in (200, 206):
                    return {"error": f"HTTP {resp.status_code} en GET", "detail": "No se pudo recuperar HTML inicial."}
                body = resp.text[:200000]  # leemos máximo 200KB de HTML para buscar URLs
                found = self._find_video_in_html(body)
                if found:
                    # si encontramos mp4/m3u8 en el HTML devolvemos esa URL (y tratamos de HEAD esa URL)
                    try:
                        head2 = self._head_or_get_headers(found)
                        ct2 = (head2.headers.get("content-type") or "").split(";")[0].lower()
                        cl2 = head2.headers.get("content-length")
                        size2 = int(cl2) if cl2 and cl2.isdigit() else None
                    except Exception:
                        ct2 = None
                        size2 = None
                    fext = self._get_ext_from_url(found) or ""
                    return {
                        "destination_url": found,
                        "content_type": ct2,
                        "format": fext or None,
                        "size": size2,
                        "note": "encontrado en HTML (regex)"
                    }
                else:
                    return {
                        "error": "No se detectó recurso de vídeo en HTML",
                        "content_type": content_type or None,
                        "format": ext or None,
                        "size": size
                    }
        except Exception as e:
            return {"error": "Error leyendo HTML o analizando página", "detail": str(e)}

# export para la factory
Extractor = UniversalExtractor
