# extractors/example.py
from .base import BaseExtractor, ExtractorError
import requests
from bs4 import BeautifulSoup
import re

class ExampleExtractor(BaseExtractor):
    name = "ejemplo"

    def extract(self, url: str) -> dict:
        """
        Ejemplo: busca URLs directas a mp4, m3u8 o <source> en la página.
        """
        try:
            r = requests.get(url, timeout=10)
            if r.status_code != 200:
                raise ExtractorError("Página no disponible")

            text = r.text

            # buscar .mp4 o .m3u8 en el HTML con regex
            m = re.search(r'https?://[^\s"\'<>]+(?:\.m3u8|\.mp4|\.webm)', text)
            if m:
                candidate = m.group(0)
                # quick HEAD to confirm
                h = requests.head(candidate, allow_redirects=True, timeout=8)
                ct = h.headers.get("Content-Type", "")
                return {
                    "destination_url": h.url,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else "unknown",
                    "size": int(h.headers.get("Content-Length")) if h.headers.get("Content-Length") else None,
                    "note": "example: encontrado por regex"
                }

            # buscar <source> con bs4
            soup = BeautifulSoup(text, "lxml")
            src = soup.find("source")
            if src and src.get("src"):
                candidate = src["src"]
                h = requests.head(candidate, allow_redirects=True, timeout=8)
                return {
                    "destination_url": h.url,
                    "content_type": h.headers.get("Content-Type",""),
                    "format": h.headers.get("Content-Type","").split("/")[-1] if "/" in h.headers.get("Content-Type","") else "unknown",
                    "size": int(h.headers.get("Content-Length")) if h.headers.get("Content-Length") else None,
                    "note": "example: encontrado en <source>"
                }

            raise ExtractorError("No se encontró mp4/m3u8 en la página (ejemplo)")
        except Exception as e:
            raise ExtractorError(str(e))

extractor = ExampleExtractor()
