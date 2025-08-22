# extractors/filemoon.py
import re
import requests
from .base import BaseExtractor, ExtractorError

class FilemoonExtractor(BaseExtractor):
    name = "filemoon"

    def extract(self, url: str) -> dict:
        try:
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
                "Referer": "https://filemoon.sx/"
            }

            r = requests.get(url, headers=headers, timeout=15)
            if r.status_code != 200:
                raise ExtractorError(f"Filemoon devolvió {r.status_code}")

            # Buscar posibles patrones
            video_url = None
            patterns = [
                r'file:\s*"([^"]+)"',
                r'sources\s*:\s*\[\{file:\s*"([^"]+)"',
                r'src\s*=\s*"([^"]+\.m3u8)"'
            ]
            for pat in patterns:
                m = re.search(pat, r.text)
                if m:
                    video_url = m.group(1)
                    break

            if not video_url:
                raise ExtractorError("No se pudo extraer el enlace directo de Filemoon")

            # Determinar content-type
            if ".m3u8" in video_url:
                ctype = "application/x-mpegURL"
                fmt = "hls"
            else:
                ctype = "video/mp4"
                fmt = "mp4"

            return {
                "destination_url": video_url,
                "content_type": ctype,
                "format": fmt,
                "note": "extraído desde Filemoon"
            }

        except Exception as e:
            raise ExtractorError(f"Error en Filemoon extractor: {str(e)}")

extractor = FilemoonExtractor()
