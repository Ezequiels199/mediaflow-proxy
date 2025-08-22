#!/usr/bin/env python3
"""
MediaFlow Proxy - Optimizado para Render (versión Python / FastAPI)

Características principales:
- Diseñado para entornos con memoria limitada (Render gratuito).
- Streaming directo para archivos grandes (>50 MB).
- Cache en RAM apenas para manifiestos y archivos pequeños, con control por tamaño.
- Bypass de compresión para contenido multimedia.
- Protección SSRF por resolución de DNS y verificación de rangos privados.
- Rate limiting sencillo en memoria por IP.
- HMAC tokens para permitir acceso temporal sin exponer la contraseña.
- Control de concurrencia (semaforo) para no saturar la instancia.
- Endpoints: /proxy, /health, /stats, /keepalive
- Expuesto como ASGI app (FastAPI) lista para ejecutarse con uvicorn.
"""

from __future__ import annotations

import asyncio
import gc
import hmac
import hashlib
import ipaddress
import logging
import os
import time
from collections import deque
from typing import AsyncGenerator, Dict, Optional, Tuple
from urllib.parse import urlparse

import httpx
from cachetools import TTLCache
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from starlette.middleware.cors import CORSMiddleware

# ----- Logging -----
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("mediaflow-render-python")

# ----- Config (overrides vía env) -----
PORT = int(os.getenv("PORT", "10000"))
PASSWORD = os.getenv("MEDIAFLOW_PASSWORD", "mipassword")
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
MAX_RAM_CACHE_MB = min(int(os.getenv("MAX_RAM_CACHE_MB", "64")), 64)  # límite sensato
CACHE_TTL_HOURS = int(os.getenv("CACHE_TTL_HOURS", "2"))
MAX_CACHE_ITEM_SIZE_MB = int(os.getenv("MAX_CACHE_ITEM_SIZE_MB", "2"))
LARGE_FILE_THRESHOLD_MB = int(os.getenv("LARGE_FILE_THRESHOLD_MB", "50"))

REQUEST_TIMEOUT = float(os.getenv("REQUEST_TIMEOUT", "45.0"))  # segundos
MAX_RETRIES = int(os.getenv("MAX_RETRIES", "2"))
MAX_REDIRECTS = int(os.getenv("MAX_REDIRECTS", "3"))

ENABLE_RATE_LIMIT = os.getenv("ENABLE_RATE_LIMIT", "true").lower() != "false"
RATE_LIMIT_WINDOW_SEC = int(os.getenv("RATE_LIMIT_WINDOW_SEC", "60"))
RATE_LIMIT_MAX_PER_WINDOW = int(os.getenv("RATE_LIMIT_MAX_PER_WINDOW", "60"))

USER_AGENT = os.getenv("ORIGIN_UA", "Mozilla/5.0 (StremioMediaFlow/Render)")
TOKEN_TTL_SEC = int(os.getenv("TOKEN_TTL_SEC", "600"))
HMAC_SECRET = os.getenv("MANIFEST_HMAC_SECRET", PASSWORD + "_render_secret")

MAX_CONCURRENT_UPSTREAM = int(os.getenv("MAX_CONCURRENT_UPSTREAM", "8"))
UPSTREAM_SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_UPSTREAM)

# ----- Caches -----
# Cache de manifiestos / small bodies: TTL + size control (simple)
MANIFEST_CACHE_MAX_BYTES = MAX_RAM_CACHE_MB * 1024 * 1024
MANIFEST_CACHE_TTL = 60 * 60 * CACHE_TTL_HOURS

# Usamos TTLCache para expiración por tiempo, pero controlaremos tamaño manualmente.
_manifest_cache: TTLCache = TTLCache(maxsize=10000, ttl=MANIFEST_CACHE_TTL)  # key -> dict(headers, body)
_manifest_cache_total_bytes = 0

# Micro cache para metadatos pequeños
_micro_cache: TTLCache = TTLCache(maxsize=2000, ttl=60 * 5)

# Rate limit state: ip -> deque[timestamps]
_rate_state: Dict[str, deque] = {}

# ----- HTTPX Async Client global -----
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(REQUEST_TIMEOUT),
    limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    headers={"User-Agent": USER_AGENT},
    follow_redirects=False
)

# ----- Utilities -----
PRIVATE_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _get_client_ip(request: Request) -> str:
    # Confía en X-Forwarded-For si hay 'trust proxy' en el deployment; Render suele proveerla
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    return request.client.host if request.client else "127.0.0.1"


async def resolve_host(host: str, timeout: float = 2.0) -> Tuple[str, ...]:
    """
    Resolve host to IP addresses (both A and AAAA) with timeout.
    Si falla o vacía, devolvemos tupla vacía (safe-fail upstream check).
    """
    loop = asyncio.get_event_loop()
    try:
        fut4 = loop.getaddrinfo(host, None, family=0, type=0, proto=0)
        # getaddrinfo devuelve ambos v4/v6; limit via timeout
        res = await asyncio.wait_for(fut4, timeout=timeout)
        ips = []
        for r in res:
            sockaddr = r[4]
            ip = sockaddr[0]
            ips.append(ip)
        return tuple(dict.fromkeys(ips))  # dedupe preserving order
    except Exception:
        return tuple()


def is_ip_private(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
        return any(ip in net for net in PRIVATE_NETWORKS)
    except Exception:
        # Si parse falla, considerarlo privado por seguridad
        return True


async def is_host_private_or_local(host: str) -> bool:
    # Si host ya es IP, comprobarla directamente
    try:
        if ipaddress.ip_address(host):
            return is_ip_private(host)
    except Exception:
        pass

    # Resuelve nombre
    addrs = await resolve_host(host, timeout=2.0)
    if not addrs:
        # DNS falla -> bloquear por seguridad
        return True
    return any(is_ip_private(a) for a in addrs)


def sign_url_token(url: str, ttl: int = TOKEN_TTL_SEC) -> str:
    expires = int(time.time()) + int(ttl)
    mac = hmac.new(HMAC_SECRET.encode(), f"{url}|{expires}".encode(), hashlib.sha256).hexdigest()
    return f"{expires}:{mac}"


def verify_url_token(url: str, token: Optional[str]) -> bool:
    if not token or ":" not in token:
        return False
    try:
        expires_str, mac = token.split(":", 1)
        expires = int(expires_str)
    except Exception:
        return False
    if int(time.time()) > expires:
        return False
    expected = hmac.new(HMAC_SECRET.encode(), f"{url}|{expires}".encode(), hashlib.sha256).hexdigest()
    # timing-safe compare
    try:
        return hmac.compare_digest(expected, mac)
    except Exception:
        return False


def _should_bypass_cache(url: str, headers: dict, content_length: Optional[int]) -> bool:
    if headers.get("range"):
        return True
    if content_length and content_length > LARGE_FILE_THRESHOLD_MB * 1024 * 1024:
        return True
    if content_length and content_length > MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024:
        return True
    return False


def _manifest_cache_get(key: str):
    return _manifest_cache.get(key)


def _manifest_cache_set(key: str, value: dict):
    """
    Guardamos controlando el total de bytes. Si sobrepasamos MANIFEST_CACHE_MAX_BYTES
    expulsamos en LRU (cachetools TTLCache no expulsa por tamaño, por eso hacemos simple LRU-like).
    Aquí usamos TTLCache: maxsize es en items; mantendremos contador manual para bytes.
    """
    global _manifest_cache_total_bytes
    body = value.get("body")
    size = len(body) if body is not None else 0
    # Evitar cachear items muy grandes
    if size > MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024:
        return False

    # Expulsar items viejos/aleatorios hasta que haya espacio
    while _manifest_cache_total_bytes + size > MANIFEST_CACHE_MAX_BYTES and len(_manifest_cache) > 0:
        # popitem no está en TTLCache; usamos popitem() de dict-like impl (no guaranteed LRU).
        try:
            k, v = _manifest_cache.popitem()
            _manifest_cache_total_bytes -= len(v.get("body", b""))
        except Exception:
            break

    _manifest_cache[key] = value
    _manifest_cache_total_bytes += size
    return True


def _rate_limit_check(ip: str) -> bool:
    if not ENABLE_RATE_LIMIT:
        return True
    now = time.time()
    dq = _rate_state.get(ip)
    if dq is None:
        dq = deque()
        _rate_state[ip] = dq
    # drop old timestamps
    while dq and dq[0] <= now - RATE_LIMIT_WINDOW_SEC:
        dq.popleft()
    if len(dq) >= RATE_LIMIT_MAX_PER_WINDOW:
        return False
    dq.append(now)
    return True


async def _safe_fetch_stream(url: str, headers: dict, max_redirects: int = MAX_REDIRECTS) -> Tuple[httpx.Response, str]:
    """
    Fetch usando httpx sin seguir automáticamente redirects (control manual),
    retorna la respuesta final y la final URL.
    """
    current = url
    redirects = 0
    last_exc = None
    while True:
        try:
            # Usamos semáforo para limitar concurrencia hacia upstream
            async with UPSTREAM_SEMAPHORE:
                r = await _client.get(current, headers=headers, timeout=REQUEST_TIMEOUT, follow_redirects=False)
            # Manejo simple de redirect
            if r.status_code in (301, 302, 303, 307, 308) and redirects < max_redirects:
                loc = r.headers.get("location")
                if not loc:
                    raise HTTPException(status_code=502, detail="Redirect sin location")
                current = httpx.URL(loc, base_url=current).to_string()
                redirects += 1
                continue
            return r, current
        except Exception as e:
            last_exc = e
            # reintentos limitados
            if redirects >= MAX_RETRIES:
                logger.debug("safe_fetch_stream exception: %s", e)
                raise HTTPException(status_code=502, detail="Upstream fetch error")
            redirects += 1
            await asyncio.sleep(0.1)


async def _stream_response_generator(resp: httpx.Response) -> AsyncGenerator[bytes, None]:
    """
    Convierte iter_bytes() del httpx Response en un async generator para StreamingResponse.
    """
    try:
        async for chunk in resp.aiter_bytes():
            if chunk:
                yield chunk
    except Exception as e:
        logger.debug("streaming generator error: %s", e)
        # Propagamos cierre silencioso; el cliente recibirá lo que llegó.


# ----- FastAPI app -----
app = FastAPI(title="MediaFlow Proxy Render (Python)")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if "*" in ALLOWED_ORIGINS else ALLOWED_ORIGINS,
    allow_methods=["GET", "HEAD", "OPTIONS"],
    allow_headers=["Content-Type", "Range", "Authorization", "X-API-Password"],
    expose_headers=["Content-Length", "Content-Range", "Accept-Ranges", "X-Cache", "X-Proxy-Status"],
)

# Health
@app.get("/")
@app.get("/health")
async def health():
    mem = _get_memory_usage()
    return {
        "ok": True,
        "service": "MediaFlow Proxy Render (Python)",
        "memory_mb": mem["used"],
        "active_upstream": MAX_CONCURRENT_UPSTREAM - UPSTREAM_SEMAPHORE._value if hasattr(UPSTREAM_SEMAPHORE, "_value") else 0,
        "uptime_seconds": int(time.time() - START_TIME),
        "cache_items": len(_manifest_cache)
    }


# Stats (protegido)
@app.get("/stats")
async def stats(password: Optional[str] = None, request: Request = None):
    # acepta ?password= o header x-api-password
    p = password or (request.headers.get("x-api-password") if request else None)
    if p != PASSWORD:
        raise HTTPException(status_code=401, detail="Auth required")
    mem = _get_memory_usage()
    return {
        "memory": mem,
        "uptime_seconds": int(time.time() - START_TIME),
        "cache_bytes": _manifest_cache_total_bytes,
        "cache_items": len(_manifest_cache),
        "rate_state_keys": len(_rate_state)
    }


# Proxy endpoint
@app.get("/proxy")
async def proxy(request: Request):
    client_ip = _get_client_ip(request)
    if not _rate_limit_check(client_ip):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")

    target = request.query_params.get("url")
    if not target:
        raise HTTPException(status_code=400, detail="URL requerida")
    if not target.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="Esquema no válido")

    # SSRF check
    host = urlparse(target).hostname
    if not host:
        raise HTTPException(status_code=400, detail="Host no válido")
    if await is_host_private_or_local(host):
        raise HTTPException(status_code=403, detail="IP/host privada no permitida")

    # Auth: token o password
    token = request.query_params.get("token") or request.query_params.get("t")
    password = request.query_params.get("password") or request.headers.get("x-api-password")
    if not token and password != PASSWORD:
        raise HTTPException(status_code=401, detail="Auth requerida")
    if token and not verify_url_token(target, token):
        raise HTTPException(status_code=401, detail="Token inválido")

    # Upstream headers
    upstream_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*"
    }
    # Preserve Range
    if "range" in request.headers:
        upstream_headers["Range"] = request.headers["range"]

    # Try microcache first (by url)
    cache_key = hashlib.md5(target.encode()).hexdigest()
    cached = _manifest_cache_get(cache_key)
    if cached and not _should_bypass_cache(target, request.headers, cached.get("size")):
        logger.info("Serving from manifest cache: %s", target[:120])
        headers = cached.get("headers", {})
        body = cached.get("body", b"")
        return Response(content=body, status_code=200, headers=headers)

    # Fetch upstream (with control)
    try:
        resp, final_url = await _safe_fetch_stream(target, headers=upstream_headers)
    except HTTPException as he:
        raise he
    except Exception as e:
        logger.exception("Upstream fetch failed: %s", e)
        raise HTTPException(status_code=502, detail="Upstream fetch failed")

    if resp.status_code >= 400:
        raise HTTPException(status_code=resp.status_code, detail=f"Upstream returned {resp.status_code}")

    # Determine content-length and type
    content_length = None
    try:
        content_length = int(resp.headers.get("content-length") or 0)
    except Exception:
        content_length = None
    content_type = resp.headers.get("content-type", "")

    # Set passthrough headers
    headers_out = {}
    for h in ("content-type", "content-length", "accept-ranges", "content-range", "etag", "last-modified"):
        v = resp.headers.get(h)
        if v:
            headers_out[h] = v
    headers_out["X-Proxy-Status"] = str(resp.status_code)

    # Decide streaming vs buffer+cache
    bypass = _should_bypass_cache(target, dict(request.headers), content_length)
    if bypass:
        # Stream response directly (StreamingResponse from generator)
        logger.info("Streaming upstream (bypass cache): %s", target[:120])
        # StreamingResponse requires an async generator or iterator
        async def streamer():
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk

        return StreamingResponse(streamer(), status_code=resp.status_code, headers=headers_out, media_type=content_type or None)
    else:
        # Buffer small response into memory and possibly cache
        try:
            body = await resp.aread()
        except Exception as e:
            logger.exception("Error reading upstream body: %s", e)
            raise HTTPException(status_code=502, detail="Error reading upstream body")

        # Store in manifest cache if small enough
        if len(body) <= MAX_CACHE_ITEM_SIZE_MB * 1024 * 1024:
            val = {"headers": headers_out, "body": body, "size": len(body), "ts": time.time()}
            _manifest_cache_set(cache_key, val)
            headers_out["X-Cache"] = "STORED"
        else:
            headers_out["X-Cache"] = "MISS-TOO-LARGE"

        return Response(content=body, status_code=resp.status_code, headers=headers_out, media_type=content_type or None)


# Keepalive
@app.get("/keepalive")
async def keepalive():
    mem = _get_memory_usage()
    return {"ok": True, "timestamp": int(time.time()), "memory_mb": mem["used"]}


# Graceful shutdown
@app.on_event("shutdown")
async def shutdown_event():
    logger.info("Shutting down: closing httpx client and performing GC")
    try:
        await _client.aclose()
    except Exception:
        pass
    if should_trigger_gc():
        gc.collect()


# ----- helpers related to memory/gc & startup -----
START_TIME = time.time()


def _get_memory_usage():
    usage = {}
    mem = os.getpid()  # placeholder; use process.memory_info in psutil if available
    # We avoid psutil dependency for Render free; use resource via proc if available else fallback
    try:
        import resource
        ru = resource.getrusage(resource.RUSAGE_SELF)
        # ru.ru_maxrss is in kilobytes on Linux (varies by platform)
        rss_kb = getattr(ru, "ru_maxrss", 0)
        used_mb = int(rss_kb / 1024) if rss_kb else 0
    except Exception:
        used_mb = 0
    # fallback: try process.memory_info via os module not available reliably
    # Provide conservative values, Render will show actual externally
    usage["used"] = used_mb
    usage["limit"] = 512
    return usage


def should_trigger_gc():
    mem = _get_memory_usage()
    return mem["used"] and mem["used"] > 400 and hasattr(gc, "collect")


# ----- Run guard (si se ejecuta directamente) -----
if __name__ == "__main__":
    import uvicorn

    logger.info("Starting MediaFlow Proxy Render (Python) on port %s", PORT)
    uvicorn.run("server_render:app", host="0.0.0.0", port=PORT, log_level="info", workers=1)
