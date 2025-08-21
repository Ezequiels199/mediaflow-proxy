# src/mediaflow_proxy/extractors/__init__.py
"""
Loader dinámico de extractors.

- Detecta todos los .py de la carpeta (excepto __init__.py y archivos que empiecen por _).
- Preferencia de detección por:
    1) clase Extractor -> instanciar
    2) variable 'extractor' -> usar
    3) función 'extract(url, **kwargs)' -> envolver en un objeto con método extract
- Asegura que 'universal' quede al final como fallback.
"""

from importlib import import_module
from pathlib import Path
import traceback
import logging

logger = logging.getLogger("mediaflow.extractors")
logger.setLevel(logging.INFO)

_extractors = {}
_pkg = __package__  # debe ser 'mediaflow_proxy.extractors' cuando se instale desde src/
_base = Path(__file__).parent

for p in sorted(_base.glob("*.py")):
    if p.name.startswith("_") or p.name == "__init__.py":
        continue

    modname = p.stem
    try:
        mod = import_module(f"{_pkg}.{modname}")
    except Exception as e:
        logger.warning(f"Fallo importando extractor '{modname}': {e}")
        logger.debug(traceback.format_exc())
        continue

    inst = None

    # 1) clase Extractor
    if hasattr(mod, "Extractor"):
        try:
            cls = getattr(mod, "Extractor")
            inst = cls()  # intentamos instanciar
        except Exception as e:
            logger.warning(f"No se pudo instanciar Extractor() en {modname}: {e}")
            logger.debug(traceback.format_exc())
            inst = None

    # 2) variable 'extractor' (instancia ya creada)
    if inst is None and hasattr(mod, "extractor"):
        inst = getattr(mod, "extractor")

    # 3) función 'extract' -> envolverla en un objeto compatible
    if inst is None and hasattr(mod, "extract") and callable(getattr(mod, "extract")):
        fn = getattr(mod, "extract")
        def make_wrapper(fn_inner, name=modname):
            class FuncWrapper:
                name = name
                def extract(self, url, **kwargs):
                    return fn_inner(url, **kwargs)
            return FuncWrapper()
        try:
            inst = make_wrapper(fn)
        except Exception as e:
            logger.warning(f"No se pudo envolver función extract() en {modname}: {e}")
            logger.debug(traceback.format_exc())
            inst = None

    if inst is not None:
        _extractors[modname] = inst
        logger.info(f"Montado extractor: {modname}")
    else:
        logger.info(f"Extractor {modname} detectado pero no usable (skip)")

# Forzar que 'universal' quede al final (si existe)
if "universal" in _extractors:
    universal_inst = _extractors.pop("universal")
    _extractors["universal"] = universal_inst

# Mapeo público de extractors
extractors = _extractors

__all__ = ["extractors"]
