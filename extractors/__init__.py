# extractors/__init__.py
"""
Autodiscovery y registro de extractores.
Carga todos los .py en esta carpeta (salvo que empiecen con _)
y registra instancias que exporten `extractor` o clases que hereden de BaseExtractor.
"""

from __future__ import annotations
import importlib
import logging
import pkgutil
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

extractors: Dict[str, object] = {}

def _get_base_extractor():
    try:
        from .base import BaseExtractor
        return BaseExtractor
    except Exception:
        return None

def _register_from_module(module_name: str):
    full_name = f"{__package__}.{module_name}"
    try:
        mod = importlib.import_module(full_name)
    except Exception as e:
        logger.exception(f"[extractors] Error importando {full_name}: {e}")
        return

    # 1) variable 'extractor'
    if hasattr(mod, "extractor"):
        inst = getattr(mod, "extractor")
        name = getattr(inst, "name", None) or module_name
        extractors[name.lower()] = inst
        logger.info(f"[extractors] Registrado -> {name.lower()} (via variable 'extractor')")
        return

    # 2) buscar clases que hereden BaseExtractor
    BaseExtractor = _get_base_extractor()
    if BaseExtractor:
        for attr in dir(mod):
            obj = getattr(mod, attr)
            try:
                if isinstance(obj, type) and issubclass(obj, BaseExtractor) and obj is not BaseExtractor:
                    try:
                        inst = obj()
                    except Exception as e:
                        logger.exception(f"[extractors] No se pudo instanciar {obj} en {full_name}: {e}")
                        continue
                    key = getattr(inst, "name", None) or module_name
                    extractors[key.lower()] = inst
                    logger.info(f"[extractors] Registrado -> {key.lower()} (via clase BaseExtractor)")
                    return
            except Exception:
                continue

    # 3) fallback: clases que terminen en Extractor
    for attr in dir(mod):
        obj = getattr(mod, attr)
        if isinstance(obj, type) and attr.lower().endswith("extractor"):
            try:
                inst = obj()
                key = getattr(inst, "name", attr)
                extractors[key.lower()] = inst
                logger.info(f"[extractors] Registrado (fallback) -> {key.lower()}")
                return
            except Exception as e:
                logger.exception(f"[extractors] Error fallback instanciando {attr} en {full_name}: {e}")
                continue

    logger.debug(f"[extractors] {full_name} importado, no se detectó extractor.")

def load_all_extractors():
    pkg_dir = Path(__file__).parent
    for finder, name, ispkg in pkgutil.iter_modules([str(pkg_dir)]):
        if name.startswith("_"):
            continue
        _register_from_module(name)
    logger.info(f"[extractors] Cargados: {', '.join(sorted(extractors.keys()))}")

def get_extractor(name: str) -> Optional[object]:
    if not name:
        return None
    return extractors.get(name.lower())

def available_extractors() -> list[str]:
    return sorted(extractors.keys())

# Auto-load al importar el paquete
try:
    load_all_extractors()
except Exception as e:
    logger.exception(f"[extractors] Error en carga inicial: {e}")

__all__ = ["extractors", "get_extractor", "available_extractors", "load_all_extractors"]
