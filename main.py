import sys
import types
import importlib.util
from pathlib import Path
from fastapi import FastAPI, HTTPException

# Base de la app
app = FastAPI(title="Mediaflow Proxy")
BASE_DIR = Path(__file__).parent
EXTRACTORS_DIR = BASE_DIR / "extractors"

# --- Loader de extractores ---
def load_module_from_path(path: Path):
    """
    Carga un extractor desde archivo y lo registra como
    mediaflow_proxy.extractors.<nombre>
    """
    project_root = str(BASE_DIR)
    if project_root not in sys.path:
        sys.path.insert(0, project_root)

    pkg_base = "mediaflow_proxy"
    pkg_extractors = f"{pkg_base}.extractors"
    module_name = f"{pkg_extractors}.{path.stem}"

    # asegurar que exista mediaflow_proxy en sys.modules
    if pkg_base not in sys.modules:
        pkg = types.ModuleType(pkg_base)
        pkg.__path__ = [project_root]
        sys.modules[pkg_base] = pkg

    # asegurar subpaquete extractors
    if pkg_extractors not in sys.modules:
        subpkg = types.ModuleType(pkg_extractors)
        subpkg.__path__ = [str(EXTRACTORS_DIR)]
        sys.modules[pkg_extractors] = subpkg

    # cargar módulo
    spec = importlib.util.spec_from_file_location(module_name, str(path))
    if spec is None or spec.loader is None:
        raise ImportError(f"No se pudo crear spec para {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


# --- Cargar extractores al inicio ---
extractors = {}

def discover_and_load_extractors():
    if not EXTRACTORS_DIR.exists():
        print(f"⚠ Carpeta {EXTRACTORS_DIR} no existe, sin extractores.")
        return

    for file in EXTRACTORS_DIR.glob("*.py"):
        try:
            module = load_module_from_path(file)
            server_name = getattr(module, "server_name", file.stem)
            extractors[server_name] = module
            print(f"✅ Cargado extractor: {server_name}")
        except Exception as e:
            print(f"❌ Error al cargar {file.name}: {e}")

discover_and_load_extractors()

# --- Endpoints ---
@app.get("/")
def root():
    return {"status": "ok", "extractors": list(extractors.keys())}

@app.get("/resolve")
def resolve(server: str, url: str):
    module = extractors.get(server)
    if not module:
        raise HTTPException(404, f"Extractor no encontrado: {server}")

    if not hasattr(module, "extract"):
        raise HTTPException(500, f"Extractor {server} no tiene función extract()")

    try:
        return module.extract(url)
    except Exception as e:
        raise HTTPException(500, f"Error ejecutando extractor {server}: {e}")
