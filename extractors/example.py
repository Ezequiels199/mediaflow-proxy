# extractors/ejemplo.py
from .base import BaseExtractor

class EjemploExtractor(BaseExtractor):
    name = "ejemplo"

    @classmethod
    def matches(cls, url: str) -> bool:
        # Si querés que responda a cualquier MP4:
        return url.endswith(".mp4")

    @classmethod
    def extract(cls, url: str):
        # Simple: devuelve la url original como destination
        return {
            "destination_url": url,
            "content_type": "video/mp4",
            "format": "mp4",
            "extractor": cls.name
        }
