# mediaflow_proxy/main.py
import os
import hashlib
import logging
from typing import Optional, Dict

from fastapi import FastAPI, HTTPException, Request, Header, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseSettings, AnyHttpUrl, ValidationError
import httpx

try:
    from cachetools import TTLCache
except Exception:
    TTLCache = None  # opcional, si no está instalado el caching no fallará

# --- Configuración ---
class Settings(BaseSettings):
    API_PASSWORD: Optional[str] = None
    PORT: int = int(os.getenv("PORT", 8888))
    CACHE_TTL: int = int(os.getenv("CACHE_TTL", 300))  # segundos
    CACHE_MAX: int = int(os.getenv("CACHE_MAX", 128))
    REQUEST_TIMEOUT: int = int(os.getenv("REQUEST_TIMEOUT", 30))

    class Config:
        env_file = ".env"

settings = Settings()

# --- Logging ---
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("mediaflow-proxy")

# --- Cache (opcional) ---
if TTLCache:
    cache = TTLCache(maxsize=settings.CACHE_MAX, ttl=settings.CACHE_TTL)
else:
    cache = None

app = FastAPI(title="MediaFlow Proxy (robusto)", version="0.1.0")

# --- Autenticación simple (si seteaste API_PASSWORD) ---
def check_password(x_api_password: Optional[str] = Header(None)):
    if settings.API_PASSWORD:
        if not x_api_password or x_api_password != settings.API_PASSWORD:
            raise HTTPException(status_code=401, detail="Unauthorized")

# --- Health endpoints ---
@app.get("/health")
async def health():
    return {"status": "ok"}

@app.get("/ready")
async def ready():
    return {"ready": True}

# --- Utilidades ---
def _cache_key(url: str, headers: Dict[str, str]) -> str:
    key = url + "|" + "|".join(f"{k}:{v}" for k, v in sorted(headers.items()))
    return hashlib.sha256(key.encode()).hexdigest()

def _allowed_resp_headers(headers: Dict[str, str]) -> Dict[str, str]:
    # Filtra headers que convenga devolver
    allowed = {}
    for k, v in headers.items():
        lk = k.lower()
        if lk in ("content-type", "content-length", "accept-ranges", "content-range", "cache-control"):
            allowed[k] = v
    return allowed

# --- Endpoint proxy (stream) ---
@app.get("/proxy")
async def proxy(url: str, request: Request, authorization: Optional[str] = Header(None), _=Depends(check_password)):
    """
    Proxy simple para GET streaming. Parámetro:
      - url: URL completa al recurso (http(s)://...)
    Se pueden pasar cabeceras como Range; se reenvían las más relevantes.
    Para autenticación global setear API_PASSWORD en .env y enviar header X-API-PASSWORD.
    """
    # Validación básica de URL
    try:
        AnyHttpUrl.validate(url)
    except ValidationError:
        raise HTTPException(status_code=400, detail="URL inválida")

    # Recolectar headers relevantes para reenviar
    forward_headers = {}
    if "range" in request.headers:
        forward_headers["Range"] = request.headers["range"]
    # añadir user-agent por si hace falta
    forward_headers["User-Agent"] = request.headers.get("user-agent", "mediaflow-proxy/1.0")

    # Caching pequeño: sólo cacheamos respuestas sin Range y que quepan en memoria
    cache_key = _cache_key(url, forward_headers)
    if cache and "range" not in forward_headers:
        if cache_key in cache:
            logger.info("cache HIT for %s", url)
            cached = cache[cache_key]
            headers = cached["headers"]
            content = cached["content"]
            return StreamingResponse(iter([content]), headers=headers, media_type=headers.get("content-type"))

    timeout = httpx.Timeout(settings.REQUEST_TIMEOUT, connect=settings.REQUEST_TIMEOUT)
    limits = httpx.Limits(max_keepalive_connections=5, max_connections=20)
    async with httpx.AsyncClient(timeout=timeout, limits=limits, follow_redirects=True) as client:
        try:
            # Hacemos stream de la respuesta del origen
            resp = await client.get(url, headers=forward_headers, stream=True)
        except httpx.RequestError as e:
            logger.exception("httpx request error: %s", e)
            raise HTTPException(status_code=502, detail=f"Error al solicitar origen: {e}")

        # Si el origen devuelve un error, lo devolvemos también
        if resp.status_code >= 400:
            detail = await resp.aread()
            raise HTTPException(status_code=resp.status_code, detail=f"Origen error: {detail[:200]}")

        # preparar headers permitidos
        out_headers = _allowed_resp_headers(resp.headers)
        media_type = resp.headers.get("content-type")

        async def stream_generator():
            try:
                async for chunk in resp.aiter_bytes(chunk_size=65536):
                    yield chunk
            finally:
                await resp.aclose()

        # Si es pequeño y no viene Range, podemos cachear todo
        if cache and "range" not in forward_headers:
            # intentamos leer hasta cierto tamaño para cachear
            try:
                content = await resp.aread()
                out_headers = _allowed_resp_headers(resp.headers)
                cache[cache_key] = {"headers": out_headers, "content": content}
                logger.info("cached %s (len=%d)", url, len(content))
                return StreamingResponse(iter([content]), headers=out_headers, media_type=media_type)
            except Exception:
                # si falla la lectura por streaming, usar el generator
                logger.info("no se pudo cachear, usando stream")
                return StreamingResponse(stream_generator(), headers=out_headers, media_type=media_type)

        return StreamingResponse(stream_generator(), headers=out_headers, media_type=media_type)
