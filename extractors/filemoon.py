# extractors/filemoon.py
from .base import BaseExtractor, ExtractorError
import requests

class FilemoonExtractor(BaseExtractor):
    name = "filemoon"

    def __init__(self, timeout: int = 10):
        self.timeout = timeout

    def extract(self, url: str) -> dict:
        """
        Stub seguro: verifica que la URL responda y devuelve metadata básica.
        No intenta evadir protecciones. Ideal para probar que el extractor
        está registrado y devuelve algo legible.
        """
        try:
            if "filemoon" not in url.lower():
                raise ExtractorError("La URL no parece pertenecer a filemoon")

            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Referer": "https://filemoon.sx/"
            }

            # Primero HEAD (rápido), fallback a GET si HEAD falla
            try:
                r = requests.head(url, allow_redirects=True, timeout=self.timeout, headers=headers)
            except Exception:
                r = requests.get(url, stream=True, allow_redirects=True, timeout=self.timeout, headers=headers)

            status = getattr(r, "status_code", None)
            final_url = getattr(r, "url", url)
            ct = r.headers.get("Content-Type", "") if hasattr(r, "headers") else ""
            cl = r.headers.get("Content-Length") if hasattr(r, "headers") else None

            info = {
                "destination_url": final_url,
                "http_status": status,
                "content_type": ct,
                "size": int(cl) if cl and cl.isdigit() else None,
                "note": "Stub: resolución final del embed NO implementada por seguridad. Si el HEAD detecta video, se devuelve directo."
            }

            # Si el recurso es video detectado por HEAD devolvemos info directa
            if status == 200 and ct.startswith("video/"):
                info["note"] = "Directo detectado en HEAD"
                return info

            # No se encontró recurso directo: devolvemos error claro
            raise ExtractorError("No se detectó recurso de video directo. Implementar parser del embed si tienes derecho legal a hacerlo.")

        except ExtractorError:
            raise
        except Exception as e:
            raise ExtractorError(f"Error en Filemoon extractor: {e}")

# exportar instancia (loader lo detecta)
extractor = FilemoonExtractor()
