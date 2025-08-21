# extractors/base.py
from abc import ABC, abstractmethod

class ExtractorError(Exception):
    pass

class BaseExtractor(ABC):
    """
    Clase base: los extractores deben heredar de esto e implementar extract(url)
    """
    name: str = "base"

    @abstractmethod
    def extract(self, url: str) -> dict:
        """
        Debe devolver un dict JSON-serializable con al menos:
        - destination_url
        - content_type
        - format
        - size (opcional)
        - note (opcional)
        O lanzar ExtractorError en caso de fallo.
        """
        raise NotImplementedError
