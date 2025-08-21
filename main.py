# main.py
import pkgutil
import importlib
import inspect
import logging
from pathlib import Path
from typing import Dict, Any, Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

# importar la clase base (asegurate de que extractors/base.py exista)
from extractors.base import BaseExtractor, ExtractorError

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mediaflow-proxy")

app = FastAPI(title="MediaFlow Proxy - Extractors loader")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET","POST","OPTIONS"],
    allow_headers=["*"]
)

# Registro de extractores: name -> class
EXTRACTORS: Dict[str, BaseExtractor] = {}

def load_extractors():
    """Carga dinámicamente todos los .py en la carpeta extractors/"""
    pkg_path = Path(__file__).parent / "extractors"
    logger.info("Cargando extractores desde: %s", pkg_path)
    for finder, name, ispkg in pkgutil.iter_modules([str(pkg_path)]):
        if name.startswith("_"):
            continue
        module_name = f"extractors.{name}"
        try:
            m = importlib.import_module(module_name)
        except Exception as e:
            logger.exception("Error al importar %s: %s", module_name, e)
            continue

        # buscar clases
        for _, obj in inspect.getmembers(m, inspect.isclass):
            # sólo considerar clases definidas en este módulo
            if obj.__module__ != m.__name__:
                continue
            # Acepta clases que hereden BaseExtractor o que tengan name+extract
            try:
                if issubclass(obj, BaseExtractor) and obj is not BaseExtractor:
                    if hasattr(obj, "name") and hasattr(obj, "extract"):
                        EXTRACTORS[obj.name] = obj
                        logger.info("Extractor cargado: %s -> %s", obj.name, module_name)
                else:
                    # fallback: clase que tenga name y método extract
                    if hasattr(obj, "name") and callable(getattr(obj, "extract", None)):
                        EXTRACTORS[obj.name] = obj
                        logger.info("Extractor (fallback) cargado: %s -> %s", obj.name, module_name)
            except Exception as e:
                logger.exception("Error registrando clase %s: %s", obj, e)

# cargar en arranque
load_extractors()

@app.get("/list")
def list_extractors():
    return {"extractors": list(EXTRACTORS.keys())}

@app.get("/resolve")
def resolve(
    server: Optional[str] = Query(None, description="Nombre del extractor (ejemplo, mixdrop...)"),
    url: str = Query(..., description="URL a resolver")
) -> Dict[str, Any]:
    if server:
        if server not in EXTRACTORS:
            raise HTTPException(status_code=404, detail=f"Extractor no encontrado: {server}")
        extractor_cls = EXTRACTORS[server]
        try:
            result = extractor_cls.extract(url)
            return result
        except ExtractorError as ee:
            raise HTTPException(status_code=502, detail=str(ee))
        except NotImplementedError as ne:
            raise HTTPException(status_code=500, detail=str(ne))
        except Exception as e:
            logger.exception("Error extrayendo con %s: %s", server, e)
            raise HTTPException(status_code=500, detail="Error interno al extraer")
    else:
        # autoselección: probar matches()
        for name, cls in EXTRACTORS.items():
            try:
                matches = False
                if hasattr(cls, "matches"):
                    matches = cls.matches(url)
                if matches:
                    try:
                        return cls.extract(url)
                    except Exception as e:
                        logger.exception("Error extrayendo con %s: %s", name, e)
                        continue
            except Exception:
                continue
        raise HTTPException(status_code=404, detail="No se encontró extractor que soporte esta URL")

@app.get("/health")
def health():
    return {"status": "ok", "extractors_loaded": len(EXTRACTORS)}
