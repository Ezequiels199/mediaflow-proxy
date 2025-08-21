# extractors/factory.py
import importlib
import pkgutil
import inspect
import os

from .base import BaseExtractor, ExtractorError

EXTRACTORS_PKG = "extractors"

def _iter_modules():
    pkg = importlib.import_module(EXTRACTORS_PKG)
    pkg_path = pkg.__path__
    for finder, name, ispkg in pkgutil.iter_modules(pkg_path):
        if name.startswith("_"):
            continue
        yield name

def get_extractor_names():
    return sorted(list(_iter_modules()))

def load_extractor(name: str) -> BaseExtractor:
    # importar el módulo dentro de extractors
    try:
        mod = importlib.import_module(f"{EXTRACTORS_PKG}.{name}")
    except ModuleNotFoundError:
        raise ExtractorError(f"No existe extractor llamado '{name}'")

    # buscar una clase que herede BaseExtractor o una variable 'extractor' instancia
    # preferimos una instancia llamada 'extractor'
    if hasattr(mod, "extractor"):
        inst = mod.extractor
        if not isinstance(inst, BaseExtractor):
            raise ExtractorError(f"El objeto 'extractor' en {name} no es BaseExtractor")
        return inst

    # si no hay instancia, buscamos clase pública que herede BaseExtractor
    for _, obj in inspect.getmembers(mod, inspect.isclass):
        if issubclass(obj, BaseExtractor) and obj is not BaseExtractor:
            return obj()

    raise ExtractorError(f"Ningún extractor válido encontrado en el módulo '{name}'")
