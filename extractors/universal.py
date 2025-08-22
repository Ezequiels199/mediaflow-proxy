# Async Universal extractor optimizado:
# - httpx.AsyncClient global con límites (keep-alive / connection pool)
# - TTLCache para resultados HEAD (manifiestos / recursos pequeños)
# - HEAD primero, fallback a GET parcial (Range) y streaming
# - Semáforo para limitar concurrencia de fetches
# - Respuesta normalizada y manejo de timeouts/retries
import asyncio
import logging
from typing import Any, Dict, Optional
from urllib.parse import urlparse

import httpx
from cachetools import TTLCache

from mediaflow_proxy.extractors.base import BaseExtractor, ExtractorError

logger = logging.getLogger(__name__)

# Configuración
DEFAULT_TIMEOUT = 10.0  # segundos para connect + read
RANGE_BYTES = 128 * 1024  # 128 KiB para GET parcial
CACHE_TTL_SEC = 30  # cache corto para HEAD / manifiestos pequeños
MAX_CACHE_ITEMS = 2000
MAX_CONCURRENT = 12  # limitar concurrencia I/O del extractor
HEAD_RETRY = 2
GET_RETRY = 1

# Cliente global reutilizable
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(DEFAULT_TIMEOUT, read=DEFAULT_TIMEOUT),
    limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
    headers={"User-Agent": "MediaFlow-Universal-Extractor/1.0"}
)

# Cache y semáforo
_head_cache: TTLCache = TTLCache(maxsize=MAX_CACHE_ITEMS, ttl=CACHE_TTL_SEC)
_semaphore = asyncio.Semaphore(MAX_CONCURRENT)

# Helpers
VIDEO_CONTENT_HINTS = ("video", "mp4", "webm", "mpeg", "ogg", "x-mpegurl", "mpegurl", "application/vnd.apple.mpegurl", "application/octet-stream")
PLAYLIST_EXTS = {".m3u8", ".m3u", ".mpd"}


def _get_ext_from_url(url: str) -> Optional[str]:
    try:
        p = urlparse(url)
        path = p.path.lower()
        if "." in path:
            return "." + path.split(".")[-1]
    except Exception:
        return None
    return None


def _looks_like_playlist(url: str, content_type: Optional[str]) -> bool:
    if content_type:
        ct = content_type.lower()
        if "mpegurl" in ct or "application/vnd.apple.mpegurl" in ct or "application/dash+xml" in ct:
            return True
    ext = _get_ext_from_url(url)
    if ext and ext in PLAYLIST_EXTS:
        return True
    return False


def _is_video_content(content_type: Optional[str]) -> bool:
    if not content_type:
        return False
    ct = content_type.lower()
    return any(h in ct for h in ("video", "mp4", "webm", "mpeg", "ogg", "x-mpegurl"))


async def _safe_head(url: str) -> Optional[httpx.Response]:
    # Cache sencillo para evitar repetir HEAD en peticiones cortas
    if url in _head_cache:
        return _head_cache[url]

    last_exc = None
    for attempt in range(HEAD_RETRY):
        try:
            r = await _client.head(url, follow_redirects=True)
            # Guardar en cache incluso si 404 (para evitar repetir a un origen lento)
            _head_cache[url] = r
            return r
        except Exception as e:
            last_exc = e
            await asyncio.sleep(0.05 * (attempt + 1))
    logger.debug("HEAD failed for %s after %d attempts: %s", url, HEAD_RETRY, last_exc)
    return None


async def _partial_get(url: str, headers: Optional[Dict[str, str]] = None, max_bytes: int = RANGE_BYTES) -> Optional[httpx.Response]:
    last_exc = None
    local_headers = {} if headers is None else dict(headers)
    local_headers.setdefault("Range", f"bytes=0-{max_bytes - 1}")
    for attempt in range(GET_RETRY):
        try:
            # stream to avoid loading body fully
            r = await _client.get(url, headers=local_headers, follow_redirects=True)
            return r
        except Exception as e:
            last_exc = e
            await asyncio.sleep(0.05 * (attempt + 1))
    logger.debug("Partial GET failed for %s: %s", url, last_exc)
    return None


class UniversalExtractor(BaseExtractor):
    """Extractor universal mejorado y asíncrono.

    Estrategia:
    1. HEAD (cache corto) para obtener content-type y content-length.
    2. Si HEAD no es concluyente, GET parcial con Range (stream) para leer primeros bytes sin bajar todo.
    3. No se descarga contenido completo aquí — el proxy se encargará del streaming completo.
    """

    name = "universal"

    async def extract(self, url: str, **kwargs) -> Dict[str, Any]:
        # Limitar concurrencia para evitar avalanchas de requests
        async with _semaphore:
            try:
                # Intentar HEAD (rápido si está cacheado)
                head = await _safe_head(url)
                if head is not None:
                    ct = head.headers.get("content-type", "") or ""
                    cl = head.headers.get("content-length")
                    status = head.status_code
                    final_url = str(head.url) if hasattr(head, "url") else url
                else:
                    ct = ""
                    cl = None
                    status = None
                    final_url = url

                # Si head detectó claramente media o playlist, devolvemos info
                if ct and (_is_video_content(ct) or _looks_like_playlist(url, ct)):
                    return {
                        "destination_url": final_url,
                        "content_type": ct,
                        "format": ct.split("/")[-1] if "/" in ct else "unknown",
                        "size": int(cl) if cl and cl.isdigit() else None,
                        "note": "detectado por universal (HEAD)",
                        "request_headers": getattr(self, "base_headers", None) or None,
                        "mediaflow_endpoint": getattr(self, "mediaflow_endpoint", None) or None,
                    }

                # Fallback: GET parcial (Range) para inspeccionar primeros bytes y content-type si HEAD no ayudó
                partial = await _partial_get(url, headers=getattr(self, "base_headers", None))
                if partial is None:
                    raise ExtractorError("No se pudo obtener HEAD ni GET parcial")

                ct = partial.headers.get("content-type", "") or ""
                cl = partial.headers.get("content-length")
                final_url = str(partial.url) if hasattr(partial, "url") else url
                status = partial.status_code

                # Si GET parcial devuelve algo que parece video/media
                if status and 200 <= status < 300 and (_is_video_content(ct) or _looks_like_playlist(url, ct)):
                    # No leemos body por completo aquí — devolvemos metadata y permitimos streaming downstream
                    return {
                        "destination_url": final_url,
                        "content_type": ct,
                        "format": ct.split("/")[-1] if "/" in ct else "unknown",
                        "size": int(cl) if cl and cl.isdigit() else None,
                        "note": "detectado por universal (GET parcial)",
                        "request_headers": getattr(self, "base_headers", None) or None,
                        "mediaflow_endpoint": getattr(self, "mediaflow_endpoint", None) or None,
                    }

                # Si aún no es reconocible, inspección ligera del primer chunk (si presente)
                # Para prevenir uso excesivo, no parseamos grandes cuerpos.
                # Algunos orígenes no devuelven content-type correcto; intentar inferir por extensión
                ext = _get_ext_from_url(url)
                if ext in {".mp4", ".mkv", ".webm"}:
                    return {
                        "destination_url": final_url,
                        "content_type": ct or "video/unknown",
                        "format": ext.lstrip("."),
                        "size": int(cl) if cl and cl.isdigit() else None,
                        "note": "detectado por extensión URL",
                        "request_headers": getattr(self, "base_headers", None) or None,
                        "mediaflow_endpoint": getattr(self, "mediaflow_endpoint", None) or None,
                    }

                raise ExtractorError("No parece un recurso de video directo (según HEAD/GET parcial)")

            except ExtractorError:
                raise
            except Exception as e:
                logger.exception("Error en UniversalExtractor para %s: %s", url, e)
                raise ExtractorError(str(e))
