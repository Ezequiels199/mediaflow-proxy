# main.py (PRO) - reemplaza tu main.py con esto
import os
import asyncio
import logging
import traceback
import importlib
import pkgutil
from importlib import resources
from typing import Dict, Any

from fastapi import FastAPI, Depends, Query, HTTPException, Security
from fastapi.security import APIKeyQuery, APIKeyHeader
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse
from starlette.staticfiles import StaticFiles

# intentamos importar settings (tu módulo). Si falla, informamos.
try:
    from mediaflow_proxy.configs import settings
except Exception:
    settings = None

# ---------------------------------------------------------
# Config / secrets
# ---------------------------------------------------------
API_PASSWORD = os.getenv("API_PASSWORD") or (settings.api_password if settings and hasattr(settings, "api_password") else None)
# Nombre del parámetro de query que usan clientes (ej: ?password=xxx)
API_PASSWORD_QUERY_NAME = os.getenv("API_PASSWORD_QUERY_NAME", "password")
# Header alternativo
API_PASSWORD_HEADER_NAME = os.getenv("API_PASSWORD_HEADER_NAME", "x-api-password")

# Security deps
api_key_query = APIKeyQuery(name=API_PASSWORD_QUERY_NAME, auto_error=False)
api_key_header = APIKeyHeader(name=API_PASSWORD_HEADER_NAME, auto_error=False)

async def verify_api_key(key_query: str = Security(api_key_query), key_header: str = Security(api_key_header)):
    """Dependency: valida la API key vía query o header o env"""
    provided = key_query or key_header
    if API_PASSWORD is None:
        # Si no hay contraseña configurada, permitimos (modo dev)
        return True
    if provided != API_PASSWORD:
        raise HTTPException(status_code=401, detail="Contraseña inválida")
    return True

# ---------------------------------------------------------
# App
# ---------------------------------------------------------
app = FastAPI(title="MediaFlow Proxy PRO", version="2.0")

# CORS minimal (ajustá orígenes en producción)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # en producción limitar
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# middleware adicional si existe en tu proyecto
try:
    from mediaflow_proxy.middleware import UIAccessControlMiddleware
    app.add_middleware(UIAccessControlMiddleware)
except Exception:
    # no crítico: si no existe, seguimos
    pass

# ---------------------------------------------------------
# Cargar routers si están disponibles
# ---------------------------------------------------------
try:
    from mediaflow_proxy.routes import (
        proxy_router,
        extractor_router,
        speedtest_router,
        playlist_builder_router,
    )
    app.include_router(proxy_router, prefix="/proxy", tags=["proxy"], dependencies=[Depends(verify_api_key)])
    app.include_router(extractor_router, prefix="/extractor", tags=["extractor"], dependencies=[Depends(verify_api_key)])
    app.include_router(speedtest_router, prefix="/speedtest", tags=["speedtest"], dependencies=[Depends(verify_api_key)])
    app.include_router(playlist_builder_router, prefix="/playlist", tags=["playlist"])
except Exception as e:
    # Si no existen routers aún, logueamos y continuamos. Evita que fallo de import bloquee el arranque.
    logging.warning(f" Routers no cargados: {e}")

# ---------------------------------------------------------
# Auto-load extractors (si usás el paquete mediaflow_proxy.extractors)
# ---------------------------------------------------------
extractor_instances: Dict[str, Any] = {}
try:
    import mediaflow_proxy.extractors as extractors_pkg
    for _, module_name, _ in pkgutil.iter_modules(extractors_pkg.__path__):
        try:
            module = importlib.import_module(f"mediaflow_proxy.extractors.{module_name}")
            if hasattr(module, "Extractor"):
                extractor_instances[module_name] = module.Extractor()
                logging.info(f"Extractor cargado: {module_name}")
        except Exception as ex:
            logging.exception(f"Error cargando extractor {module_name}: {ex}")
except Exception:
    # paquete de extractors no encontrado: seguir sin fallo
    logging.warning("No se encontró paquete mediaflow_proxy.extractors; crealo o pon los extractores en la carpeta correcta.")

# Endpoint para listar extractores cargados
@app.get("/extractors")
def list_extractors():
    return {"count": len(extractor_instances), "extractors": list(extractor_instances.keys())}

# Resolver usando extractor cargado
@app.get("/resolve")
async def resolve(server: str = Query(...), url: str = Query(...), allow: bool = Depends(verify_api_key)):
    if server not in extractor_instances:
        raise HTTPException(status_code=404, detail=f"Extractor '{server}' no encontrado")
    extractor = extractor_instances[server]
    try:
        # timeout para evitar bloqueos largos
        result = await asyncio.wait_for(extractor.extract(url), timeout=30)
        return JSONResponse({"status": "ok", "server": server, "data": result})
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout en extractor")
    except Exception as e:
        logging.exception(f"Error en extractor {server}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# Health check
@app.get("/health")
def health():
    return {"status": "ok"}

# Static (servir UI si existe)
try:
    static_path = resources.files("mediaflow_proxy").joinpath("static")
    if static_path.exists():
        app.mount("/", StaticFiles(directory=str(static_path), html=True), name="static")
except Exception:
    # Si no hay assets estáticos no pasa nada
    logging.info("No se montó carpeta static (no existe o no está empacada).")

# ---------------------------------------------------------
# Run helper: usa env PORT y WORKERS para ser portable
# ---------------------------------------------------------
def run():
    import uvicorn
    port = int(os.getenv("PORT", os.getenv("UVICORN_PORT", "10000")))
    workers = int(os.getenv("WORKERS", os.getenv("WEB_CONCURRENCY", "1")))
    # En producción preferible usar gunicorn + uvicorn worker; aquí usamos uvicorn.run si workers==1
    if workers and workers > 1:
        # consejo: en producción usá gunicorn -k uvicorn.workers.UvicornWorker
        logging.info(f"Iniciando uvicorn con {workers} workers en puerto {port}")
        uvicorn.run("main:app", host="0.0.0.0", port=port, workers=workers, log_level="info")
    else:
        logging.info(f"Iniciando uvicorn en puerto {port}")
        uvicorn.run("main:app", host="0.0.0.0", port=port, log_level="info")

if __name__ == "__main__":
    run()
