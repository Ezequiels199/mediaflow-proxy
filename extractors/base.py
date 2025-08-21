class BaseExtractor:
    """
    Clase base para todos los extractores.
    """
    def extract(self, url: str) -> dict:
        raise NotImplementedError("El extractor debe implementar el método extract")
