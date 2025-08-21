# streamtape.py
import re
from typing import Dict, Any, Optional
import requests

# Ajustá user agent si querés (algunos hosts requieren UA "real")
DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

# Si tu framework exige una clase basada en BaseExtractor, importala.
# Si no la tenés, esto seguirá funcionando como EXTRACTOR exportado.
try:
    from mediaflow_proxy.base import BaseExtractor, ExtractorError
except Exception:
    # definición mínima local para evitar crash si no hay paquete
    class ExtractorError(Exception):
        pass
    class BaseExtractor:
        pass


class StreamtapeExtractor(BaseExtractor):
    """
    Extractor robusto para Streamtape.
    Uso: colocar este archivo en mediaflow_proxy/extractors/streamtape.py
    La fábrica del proxy buscará la clase 'Extractor' abajo y la registrará.
    """

    name = "streamtape"

    def _safe_get(self, url: str, referer: Optional[str] = None, timeout: int = 12) -> requests.Response:
        headers = DEFAULT_HEADERS.copy()
        if referer:
            headers["Referer"] = referer
        return requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)

    def _safe_head(self, url: str, referer: Optional[str] = None, timeout: int = 12) -> requests.Response:
        headers = DEFAULT_HEADERS.copy()
        if referer:
            headers["Referer"] = referer
        return requests.head(url, headers=headers, timeout=timeout, allow_redirects=True)

    def _find_get_video_direct(self, html: str) -> Optional[str]:
        """
        Busca una URL completa tipo https://streamtape.com/get_video?... en el HTML.
        """
        m = re.search(r"https?://(?:www\.)?streamtape\.com/get_video\?[^'\"\s<]+", html)
        if m:
            return m.group(0)
        # también puede aparecer como path relativo /get_video?...
        m2 = re.search(r"(?:/get_video\?[^'\"\s<]+)", html)
        if m2:
            return "https://streamtape.com" + m2.group(0)
        return None

    def _find_params_id_ip(self, html: str) -> Optional[str]:
        """
        Heurística: buscar cadenas que contengan id=... y ip=... (similar a implementaciones comunes).
        Devuelve el string de query (ej: id=XYZ&ip=1.2.3.4...).
        """
        # buscar fragmentos que tengan id= y ip=
        # patrón menos estricto para adaptarse a variaciones:
        candidates = re.findall(r"(id=[^'\"\s>]+?&[^'\"\s>]*?ip=[^'\"\s>]+)", html, flags=re.IGNORECASE)
        if candidates:
            # devolver el primer candidato que parezca completo
            return candidates[0]
        # fallback: buscar id=... solo (algunas versiones)
        candidates2 = re.findall(r"(id=[^'\"\s>]+)", html, flags=re.IGNORECASE)
        if candidates2:
            return candidates2[0]
        return None

    def extract(self, url: str, **kwargs) -> Dict[str, Any]:
        """
        Intenta resolver un video Streamtape y devuelve un dict con:
          - destination_url: URL final reproducible (normalmente get_video?... o CDN)
          - content_type (si pudo determinar)
          - size (Content-Length si pudo obtener)
          - note: info extra
        Lanza ExtractorError en caso de fallo.
        """
        referer = url
        try:
            # 1) GET la página
            resp = self._safe_get(url, referer=referer)
        except Exception as e:
            raise ExtractorError(f"Error descargando página Streamtape: {e}")

        if resp.status_code != 200:
            raise ExtractorError(f"Streamtape: página respondió {resp.status_code}")

        html = resp.text

        # 2) Buscar get_video directo primero
        final = self._find_get_video_direct(html)
        note = "found get_video direct"
        # 3) Si no aparece, intentar heurística id=...&ip=...
        if not final:
            params = self._find_params_id_ip(html)
            if params:
                # asegurar que params no contengan comillas
                params = params.strip().strip("'\"")
                final = f"https://streamtape.com/get_video?{params}"
                note = "built get_video from id/ip params"

        if not final:
            # 4) última opción: buscar URLs con get_video en scripts minimizados
            m3 = re.search(r"get_video\?([^'\"\s<]+)", html)
            if m3:
                q = m3.group(1)
                final = f"https://streamtape.com/get_video?{q}"
                note = "built get_video from script pattern"

        if not final:
            raise ExtractorError("No se pudo extraer get_video desde la página (heurísticas fallaron)")

        # 5) Probar HEAD al final para verificar que sea accesible y sacar Content-Type/Length
        try:
            head = self._safe_head(final, referer=referer)
            # si HEAD devuelve 405 o parecido, intentar GET con stream para confirmar
            if head.status_code not in (200, 206):
                # intentar GET streaming
                g = requests.get(final, headers={**DEFAULT_HEADERS, "Referer": referer}, stream=True, timeout=12, allow_redirects=True)
                status_for_meta = g.status_code
                headers_for_meta = g.headers
            else:
                status_for_meta = head.status_code
                headers_for_meta = head.headers
        except Exception:
            # si falla el HEAD, no lo descartamos: devolvemos final y nota
            return {
                "destination_url": final,
                "content_type": None,
                "size": None,
                "note": f"{note} (HEAD falló, se devuelve URL sin metadatos)"
            }

        # si status OK, extraer content-type y size
        content_type = headers_for_meta.get("Content-Type")
        content_length = headers_for_meta.get("Content-Length")
        size = int(content_length) if content_length and content_length.isdigit() else None

        if status_for_meta not in (200, 206):
            # aún así devolvemos la URL pero avisamos
            return {
                "destination_url": final,
                "content_type": content_type,
                "size": size,
                "note": f"{note} (HEAD/GET status {status_for_meta})"
            }

        return {
            "destination_url": final,
            "content_type": content_type,
            "size": size,
            "note": note
        }


# Para la fábrica que importará 'Extractor' como clase
class Extractor(StreamtapeExtractor):
    pass
