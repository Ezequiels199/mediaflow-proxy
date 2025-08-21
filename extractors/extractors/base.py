# extractors/base.py

from abc import ABC, abstractmethod

class BaseExtractor(ABC):
    name = "base"

    @abstractmethod
    def extract(self, url: str) -> dict:
        """
        Dado un URL, devuelve un diccionario con la info del video.
        """
        pass
