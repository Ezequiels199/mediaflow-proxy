# extractors/example.py

from .base import BaseExtractor

class ExampleExtractor(BaseExtractor):
    name = "example"

    def extract(self, url: str) -> dict:
        return {
            "status": "ok",
            "server": self.name,
            "video_url": "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
        }
