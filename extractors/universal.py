# extractors/universal.py
import requests
from .base import BaseExtractor, ExtractorError

class UniversalExtractor(BaseExtractor):
    name = "universal"

    def extract(self, url: str) -> dict:
        try:
            h = requests.head(url, allow_redirects=True, timeout=10)
            ct = h.headers.get("Content-Type", "") if h.status_code == 200 else ""
            cl = h.headers.get("Content-Length")
            if any(x in ct for x in ["video", "mp4", "webm", "mpeg", "ogg", "application/vnd.apple.mpegurl", "application/x-mpegURL"]):
                return {
                    "destination_url": h.url,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else "unknown",
                    "size": int(cl) if cl else None,
                    "note": "detectado por universal (HEAD)"
                }

            # fallback: buscar en GET small chunk
            r = requests.get(url, stream=True, timeout=10)
            ct = r.headers.get("Content-Type", "")
            cl = r.headers.get("Content-Length")
            if r.status_code == 200 and any(x in ct for x in ["video", "mp4", "webm", "mpeg", "ogg"]):
                return {
                    "destination_url": r.url,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else "unknown",
                    "size": int(cl) if cl else None,
                    "note": "detectado por universal (GET)"
                }

            raise ExtractorError("No parece un recurso de video directo (según headers)")
        except Exception as e:
            raise ExtractorError(str(e))

# si querés usar una instancia ya creada
extractor = UniversalExtractor()
