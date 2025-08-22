# server_render.py
"""
Wrapper ASGI para Render.
Intenta importar la app desde los puntos más comunes y expone `app`.
"""

import importlib
import sys
from fastapi import FastAPI

def try_import(module_name, attr_name="app"):
    try:
        mod = importlib.import_module(module_name)
        obj = getattr(mod, attr_name, None)
        if obj:
            print(f"[server_render] Imported {attr_name} from {module_name}")
            return obj
    except Exception as e:
        print(f"[server_render] Could not import {module_name}: {e}")
    return None

# Intenta módulos típicos donde tu app puede estar
candidates = [
    ("main", "app"),
    ("app", "app"),
    ("server", "app"),
    ("mediaflow_proxy.main", "app"),
    ("mediaflow_proxy.server", "app"),
    ("wsgi", "app"),
    ("server_render", "app"),  # improbable pero por si acaso
]

app = None
for modname, attr in candidates:
    app = try_import(modname, attr)
    if app:
        break

# Si no encontramos nada, creamos una FastAPI simple para validar despliegue
if not app:
    print("[server_render] No encontré app en los módulos habituales. Creando FastAPI básico.")
    app = FastAPI()

    @app.get("/")
    async def hello():
        return {"ok": True, "msg": "Server wrapper corriendo — crea / importa tu app real en server_render.py"}

# Para compatibilidad con gunicorn/uvicorn
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server_render:app", host="0.0.0.0", port=10000, reload=True)
