# extractors/base.py
from typing import Any, Dict

class ExtractorError(Exception):
    """Error específico de extractores."""
    pass

class BaseExtractor:
    """Clase base para extractores. Heredar y sobreescribir `name` y `extract`."""
    name = "base"

    @classmethod
    def matches(cls, url: str) -> bool:
        """Opcional: devuelve True si el extractor puede manejar la URL."""
        return False

    @classmethod
    def extract(cls, url: str) -> Dict[str, Any]:
        """Debe devolver un dict con keys como destination_url, content_type, etc."""
        raise NotImplementedError("Los extractores deben implementar `extract`.")
