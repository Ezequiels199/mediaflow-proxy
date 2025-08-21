# main.py
import os
import pkgutil
import importlib
import asyncio
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from typing import Any, Dict, Optional

APP_PORT = int(os.environ.get("PORT", 10000))
API_PASSWORD = os.environ.get("API_PASSWORD", "")

app = FastAPI(title="Mediaflow Proxy (minimal)", version="0.1")

# registro: nombre -> módulo del extractor
EXTRACTORS: Dict[str, Any] = {}

def load_extractors():
    """
    Carga dinámicamente todos los módulos de la carpeta 'extractors'.
    Cada módulo debe exportar:
      - server_name (str)  OR usaremos el nombre del archivo
      - async def resolve(url: str) -> dict
    """
    base_path = os.path.join(os.path.dirname(__file__), "extractors")
    if not os.path.isdir(base_path):
        app.logger = getattr(app, "logger", None)
        return

    for finder, name, ispkg in pkgutil.iter_modules([base_path]):
        try:
            mod = importlib.import_module(f"extractors.{name}")
            server = getattr(mod, "server_name", name)
            EXTRACTORS[server] = mod
        except Exception as e:
            # no abortamos todo si un extractor falla; lo mostramos en logs
            print(f"[load_extractors] error importando {name}: {e}")

# cargar en arranque
load_extractors()

class ResolveResponse(BaseModel):
    server: str
    url: str
    result: dict

def require_password(provided: Optional[str]):
    if API_PASSWORD:
        if not provided or provided != API_PASSWORD:
            raise HTTPException(status_code=401, detail="Invalid password")

@app.get("/", summary="Status")
async def status():
    return {
        "status": "ok",
        "extractors": sorted(list(EXTRACTORS.keys())),
    }

@app.get("/reload_extractors", summary="Recargar extractores")
async def reload_extractors(password: Optional[str] = Query(None)):
    require_password(password)
    EXTRACTORS.clear()
    load_extractors()
    return {"reloaded": True, "extractors": sorted(list(EXTRACTORS.keys()))}

@app.get("/resolve", response_model=ResolveResponse)
async def resolve(
    server: str = Query(..., description="Nombre del extractor (p.ej. doodstream, mixdrop)"),
    url: str = Query(..., description="URL a resolver"),
    password: Optional[str] = Query(None),
):
    """
    Resuelve la URL con el extractor indicado.
    El extractor debe exponer async def resolve(url) -> dict
    """
    require_password(password)

    mod = EXTRACTORS.get(server)
    if not mod:
        raise HTTPException(status_code=404, detail=f"Extractor '{server}' no encontrado")

    # preferimos async function named 'resolve', si existe 'extract' lo usamos
    func = getattr(mod, "resolve", None) or getattr(mod, "extract", None)
    if func is None:
        raise HTTPException(status_code=500, detail=f"Extractor '{server}' no tiene función 'resolve' o 'extract'")

    try:
        if asyncio.iscoroutinefunction(func):
            result = await func(url)
        else:
            # permitir también funciones síncronas
            result = func(url)
        return ResolveResponse(server=server, url=url, result=result or {})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en extractor '{server}': {e}")

# run with: uvicorn main:app --host 0.0.0.0 --port $PORT
