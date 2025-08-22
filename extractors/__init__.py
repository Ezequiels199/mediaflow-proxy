# extractors/__init__.py
"""
Auto-discovery y registro de extractores.
Coloca aquí este archivo y pon cada extractor como:
 - filemoon.py    (con una variable `extractor = FilemoonExtractor()` ó una clase que herede de BaseExtractor)
 - streamtape.py
 - mixdrop.py
 - doodstream.py
 etc.

Este módulo:
 - importa cada módulo en extractors/
 - busca `extractor` o la primera clase que herede de BaseExtractor
 - registra la instancia en `extractors` con su nombre (inst.name o el nombre del archivo)
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from pathlib import Path
from typing import Dict, Optional

logger = logging.getLogger(__name__)

# Diccionario de name -> instancia del extractor
extractors: Dict[str, object] = {}

# Helper para intentar obtener BaseExtractor (si falla, seguimos igualmente)
def _get_base_extractor():
    try:
        # import relativo al paquete
        from .base import BaseExtractor
        return BaseExtractor
    except Exception:
        return None


def _register_from_module(module_name: str):
    """
    Importa el módulo `extractors.<module_name>` y trata de obtener:
      1) una variable `extractor`
      2) la primera clase que herede de BaseExtractor
    Registra la instancia en el dict global `extractors` bajo su .name (o module_name).
    """
    full_name = f"{__package__}.{module_name}"
    try:
        mod = importlib.import_module(full_name)
    except Exception as e:
        logger.exception(f"[extractors] Error importando {full_name}: {e}")
        return

    # 1) si el módulo define 'extractor', preferimos eso
    if hasattr(mod, "extractor"):
        inst = getattr(mod, "extractor")
        # intentar obtener nombre legible
        name = getattr(inst, "name", None) or getattr(inst, "__class__", None)
        if isinstance(name, str):
            key = name.lower()
        else:
            key = module_name.lower()
        extractors[key] = inst
        logger.info(f"[extractors] Registrado (var extractor) -> {key}")
        return

    # 2) buscar primera clase que herede de BaseExtractor
    BaseExtractor = _get_base_extractor()
    if BaseExtractor is not None:
        for attr in dir(mod):
            obj = getattr(mod, attr)
            try:
                if isinstance(obj, type) and issubclass(obj, BaseExtractor) and obj is not BaseExtractor:
                    try:
                        inst = obj()
                    except Exception as e:
                        logger.exception(f"[extractors] Error al instanciar {obj} en {full_name}: {e}")
                        continue
                    key = getattr(inst, "name", None) or module_name
                    extractors[key.lower()] = inst
                    logger.info(f"[extractors] Registrado (clase BaseExtractor) -> {key.lower()}")
                    return
            except Exception:
                # issubclass puede fallar si obj no es clase; lo ignoramos
                continue

    # 3) fallback: buscar cualquier objeto llamado XXXExtractor y crear si es clase
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

    logger.debug(f"[extractors] Módulo {full_name} importado pero no se detectó extractor válido.")


def load_all_extractors():
    """
    Itera los .py del paquete actual y registra extractores.
    """
    pkg_dir = Path(__file__).parent
    for finder, name, ispkg in pkgutil.iter_modules([str(pkg_dir)]):
        # ignorar archivos privados
        if name.startswith("_"):
            continue
        _register_from_module(name)

    logger.info(f"[extractors] Cargados: {', '.join(sorted(extractors.keys()))}")


def get_extractor(name: str) -> Optional[object]:
    """
    Devuelve la instancia del extractor por su nombre (case-insensitive) o None.
    """
    if not name:
        return None
    return extractors.get(name.lower())


def available_extractors() -> list[str]:
    """Lista de nombres disponibles."""
    return sorted(extractors.keys())


# Ejecutar autoload al importar el paquete
try:
    load_all_extractors()
except Exception as e:
    logger.exception(f"[extractors] Error en load_all_extractors: {e}")


# Exports
__all__ = ["extractors", "get_extractor", "available_extractors", "load_all_extractors"]
