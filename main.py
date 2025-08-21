# main.py - Mediaflow Proxy (loader de extractores por archivo, robusto)
import os
import time
import logging
import asyncio
import importlib.util
from pathlib import Path
from typing import Dict, Any, Callable, Optional

from fastapi import FastAPI, Query, HTTPException, Depends
from pydantic import BaseModel
from starlette.responses import JSONResponse

# ---------- Config ----------
BASE_DIR = Path(__file__).parent
EXTRACTORS_DIR = BASE_DIR / "extractors"
API_PASSWORD = os.getenv("API_PASSWORD", "")  # si está vacía, no protege endpoints
LOAD_TIMEOUT = float(os.getenv("LOAD_TIMEOUT", "20"))  # timeout para extract
RESOLVE_TIMEOUT = float(os.getenv("RESOLVE_TIMEOUT", "25"))

# ---------- Logging ----------
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("mediaflow-main")

# ---------- App ----------
app = FastAPI(title="Mediaflow Proxy - Loader dinámico de extractores")

# Estructura interna: server_name -> module info
class ExtractorInfo(BaseModel):
    server_name: str
    module_path: str
    module_obj: Any
    extract_fn_name: str  # 'extract' or 'resolve'
    is_async: bool
    loaded_at: float

EXTRACTORS: Dict[str, ExtractorInfo] = {}

# ---------- Security dependency ----------
def require_password(password: Optional[str] = Query(None)):
    """Dep. FastAPI: si API_PASSWORD configurada, exige ?password=..."""
    if not API_PASSWORD:
        return True
    if not password or password != API_PASSWORD:
        raise HTTPException(status_code=401, detail="Contraseña inválida")
    return True

# ---------- Loader utilities ----------
def load_module_from_path(path: Path):
    """Carga un módulo Python dado su path y devuelve el módulo."""
    name = f"extractor_{int(time.time()*1000)}_{abs(hash(str(path))) % 100000}"
    spec = importlib.util.spec_from_file_location(name, str(path))
    if spec is None:
        raise ImportError(f"No se pudo crear spec para {path}")
    module = importlib.util.module_from_spec(spec)
    loader = spec.loader
    if loader is None:
        raise ImportError(f"No hay loader para {path}")
    loader.exec_module(module)
    return module

def discover_and_load_extractors():
    """Busca .py en extractors/ y registra extractors en EXTRACTORS."""
    EXTRACTORS.clear()
    if not EXTRACTORS_DIR.exists():
        log.warning("No existe carpeta extractors/ en %s", EXTRACTORS_DIR)
        return

    for f in sorted(EXTRACTORS_DIR.glob("*.py")):
        if f.name.startswith("_"):
            continue  # ignorar archivos privados
        try:
            module = load_module_from_path(f)
        except Exception as e:
            log.exception("Error importando %s: %s", f.name, e)
            continue

        # determinar server_name
        server_name = getattr(module, "server_name", None) or f.stem
        # preferencia de funciones: 'extract' o 'resolve'
        extract_fn = getattr(module, "extract", None) or getattr(module, "resolve", None)
        if extract_fn is None or not callable(extract_fn):
            log.warning("Módulo %s cargado pero no expone 'extract' ni 'resolve'", f.name)
            continue

        is_async = asyncio.iscoroutinefunction(extract_fn)
        info = ExtractorInfo(
            server_name=server_name,
            module_path=str(f),
            module_obj=module,
            extract_fn_name=extract_fn.__name__,
            is_async=is_async,
            loaded_at=time.time()
        )
        # si hay conflictos de nombres, avisamos y sobrescribimos
        if server_name in EXTRACTORS:
            log.warning("Sobrescribiendo extractor %s con %s", server_name, f.name)
        EXTRACTORS[server_name] = info
        log.info("Extractor registrado: %s (async=%s) desde %s", server_name, is_async, f.name)

# cargar inicialmente
discover_and_load_extractors()

# ---------- Endpoints ----------
@app.get("/", summary="Estado y lista de extractores")
def root():
    return {
        "status": "ok",
        "extractor_count": len(EXTRACTORS),
        "extractors": [
            {"name": name, "path": info.module_path, "async": info.is_async, "loaded_at": info.loaded_at}
            for name, info in EXTRACTORS.items()
        ],
    }

@app.get("/health", summary="Healthcheck")
def health():
    return {"status": "ok"}

@app.post("/reload", summary="Recargar extractores (protegido)")
def reload_extractors(password: Optional[str] = Query(None), authorized: bool = Depends(require_password)):
    """Recargar todos los extractores desde disco."""
    discover_and_load_extractors()
    return {"reloaded": True, "count": len(EXTRACTORS)}

@app.get("/resolve", summary="Resolver URL con un extractor")
async def resolve(server: str = Query(...), url: str = Query(...), password: Optional[str] = Query(None), authorized: bool = Depends(require_password)):
    """Ejecuta el extractor indicado sobre la URL."""
    info = EXTRACTORS.get(server)
    if not info:
        raise HTTPException(status_code=404, detail=f"Extractor '{server}' no encontrado")

    # obtener función actual del módulo (por si recargas dinámicamente)
    fn = getattr(info.module_obj, info.extract_fn_name, None)
    if not fn or not callable(fn):
        raise HTTPException(status_code=500, detail="Función de extractor no encontrada o no callable")

    try:
        # ejecutar con timeout
        if info.is_async:
            result = await asyncio.wait_for(fn(url), timeout=RESOLVE_TIMEOUT)
        else:
            # ejecutamos sync en thread pool para no bloquear el event loop
            loop = asyncio.get_running_loop()
            result = await asyncio.wait_for(loop.run_in_executor(None, fn, url), timeout=RESOLVE_TIMEOUT)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Timeout en extractor")
    except Exception as e:
        log.exception("Error ejecutando extractor %s: %s", server, e)
        raise HTTPException(status_code=500, detail=str(e))

    # validación mínima: debe retornar dict o lista
    if not isinstance(result, (dict, list)):
        raise HTTPException(status_code=500, detail="Extractor debe devolver dict o list")

    return JSONResponse({"status": "ok", "server": server, "result": result})

# ---------- Run helper (solo si ejecutás python main.py) ----------
def run():
    import uvicorn
    port = int(os.getenv("PORT", "10000"))
    # no forzamos workers aquí; mejor usar gunicorn en producción
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=False, log_level="info")

if __name__ == "__main__":
    run()
