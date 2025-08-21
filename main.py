import os
from fastapi import FastAPI, Query, HTTPException
from fastapi.responses import JSONResponse
from extractors.factory import get_extractor
import uvicorn

app = FastAPI(title="MediaFlow Proxy Adaptado", version="1.0")

# 🔑 Contraseña (podés cambiarla en la variable de entorno API_PASSWORD)
API_PASSWORD = os.getenv("API_PASSWORD", "8080")

@app.get("/")
async def root():
    return {"status": "ok", "message": "MediaFlow Proxy Adaptado 🚀"}

@app.get("/proxy")
async def proxy(
    url: str = Query(..., description="URL del video"),
    password: str = Query(..., description="Contraseña de acceso"),
):
    if password != API_PASSWORD:
        raise HTTPException(status_code=401, detail="Contraseña incorrecta")

    try:
        extractor = get_extractor(url)
        if not extractor:
            raise HTTPException(status_code=400, detail="Extractor no encontrado")

        result = await extractor.extract(url)
        return JSONResponse(content=result)

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error en el proxy: {str(e)}")

if __name__ == "__main__":
    port = int(os.getenv("PORT", 10000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
