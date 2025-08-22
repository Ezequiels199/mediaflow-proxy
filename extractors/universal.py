"""
Async Universal extractor profesional optimizado para despliegues (Render, Docker, k8s).

Características principales:
- Cliente httpx.AsyncClient creado bajo demanda y reutilizado (pool/keep-alive).
- Configuración por variables de entorno.
- Caches TTL para HEAD y discovery (cachetools.TTLCache).
- Lectura parcial (Range / streaming) para inspección sin bajar archivos completos.
- Discover links eficiente (src/href, arrays JS, urls directas).
- Scoring y validación concurrente con semáforos para evitar saturar orígenes.
- Función `close_http_clients()` para cerrar cliente en el shutdown del servidor.
- Logging claro y ExtractorError para errores esperados.

Uso:
- Importar la clase UniversalExtractor y llamar a su método async extract(url).
- En el ciclo de vida de la app (FastAPI/Starlette) llamar a close_http_clients() en shutdown.
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import Any, Dict, List, Optional, Set, Tuple
from urllib.parse import urljoin, urlparse

import httpx
from cachetools import TTLCache

from mediaflow_proxy.extractors.base import BaseExtractor, ExtractorError

logger = logging.getLogger(__name__)

# ----------------------
# Configuración (env overrides)
# ----------------------
DEFAULT_TIMEOUT = float(os.getenv("MF_DEFAULT_TIMEOUT", "10.0"))
RANGE_BYTES = int(os.getenv("MF_RANGE_BYTES", str(128 * 1024)))
HEAD_CACHE_TTL = int(os.getenv("MF_HEAD_CACHE_TTL", "30"))
DISCOVER_CACHE_TTL = int(os.getenv("MF_DISCOVER_CACHE_TTL", "60"))
MAX_HEAD_CACHE_ITEMS = int(os.getenv("MF_MAX_HEAD_CACHE_ITEMS", "2000"))
MAX_DISCOVER_CACHE_ITEMS = int(os.getenv("MF_MAX_DISCOVER_CACHE_ITEMS", "2000"))

MAX_CONCURRENT_HEADS = int(os.getenv("MF_MAX_CONCURRENT_HEADS", "12"))
MAX_CANDIDATE_VALIDATION = int(os.getenv("MF_MAX_CANDIDATE_VALIDATION", "10"))
MAX_CANDIDATES_TO_CHECK = int(os.getenv("MF_MAX_CANDIDATES_TO_CHECK", "40"))

HEAD_RETRY = int(os.getenv("MF_HEAD_RETRY", "2"))
GET_RETRY = int(os.getenv("MF_GET_RETRY", "1"))

USER_AGENT = os.getenv("MF_USER_AGENT", "MediaFlow-Universal-Extractor/1.0")

# ----------------------
# Prioridades / heurísticas
# ----------------------
PLAYLIST_EXTS = {".m3u8", ".m3u", ".mpd"}
VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".avi", ".mov", ".ts", ".m2ts", ".ogg", ".ogv", ".m4v", ".3gp"}
HIGH_PRIORITY_DOMAINS = ("mixdrop", "streamtape", "uqload", "dlhd", "supervideo", "fastream", "vavoo")

_VIDEO_HINTS = ("video", "mp4", "webm", "mpeg", "ogg", "x-mpegurl", "mpegurl", "application/vnd.apple.mpegurl", "application/dash+xml", "application/octet-stream")
_VIDEO_EXT_RE = re.compile(r'\.(?:m3u8|m3u|mpd|mp4|webm|mkv|ts|m2ts|ogg|ogv)\b', re.I)

# ----------------------
# Cliente global (creado bajo demanda) y caches
# ----------------------
_client: Optional[httpx.AsyncClient] = None
_head_cache: TTLCache = TTLCache(maxsize=MAX_HEAD_CACHE_ITEMS, ttl=HEAD_CACHE_TTL)
_discover_cache: TTLCache = TTLCache(maxsize=MAX_DISCOVER_CACHE_ITEMS, ttl=DISCOVER_CACHE_TTL)

_head_semaphore = asyncio.Semaphore(MAX_CONCURRENT_HEADS)
_candidate_semaphore = asyncio.Semaphore(MAX_CANDIDATE_VALIDATION)


async def _ensure_client() -> httpx.AsyncClient:
    """
    Crea y devuelve un httpx.AsyncClient global si no existe.
    Úsalo desde todas las funciones async que necesiten hacer requests.
    """
    global _client
    if _client is None:
        limits = httpx.Limits(
            max_connections=int(os.getenv("MF_HTTP_MAX_CONNECTIONS", "100")),
            max_keepalive_connections=int(os.getenv("MF_HTTP_MAX_KEEPALIVE", "20")),
        )
        timeout = httpx.Timeout(float(DEFAULT_TIMEOUT), read=float(DEFAULT_TIMEOUT))
        _client = httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            headers={"User-Agent": USER_AGENT},
            follow_redirects=True,
        )
    return _client


async def close_http_clients() -> None:
    """
    Cerrar el httpx client global (llamarlo en shutdown del servidor).
    """
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception as e:
            logger.warning("Error al cerrar httpx client: %s", e)
        _client = None


# ----------------------
# Util helpers
# ----------------------
def _get_ext_from_url(url: str) -> Optional[str]:
    try:
        p = urlparse(url)
        path = p.path.lower()
        if "." in path:
            return "." + path.split(".")[-1]
    except Exception:
        return None
    return None


def _is_video_content_header(content_type: Optional[str]) -> bool:
    if not content_type:
        return False
    ct = content_type.lower()
    return any(h in ct for h in _VIDEO_HINTS)


def _looks_like_playlist(url: str, content_type: Optional[str]) -> bool:
    if content_type:
        ct = content_type.lower()
        if "mpegurl" in ct or "dash+xml" in ct:
            return True
    ext = _get_ext_from_url(url)
    if ext and ext in PLAYLIST_EXTS:
        return True
    return False


# ----------------------
# HEAD y GET parcial seguros con cache
# ----------------------
async def _safe_head(url: str) -> Optional[httpx.Response]:
    # devolver cache si existe
    if url in _head_cache:
        return _head_cache[url]

    client = await _ensure_client()
    last_exc = None
    async with _head_semaphore:
        for attempt in range(max(1, HEAD_RETRY)):
            try:
                r = await client.head(url, follow_redirects=True)
                # cachear incluso respuestas no 200 para evitar hammer al origen
                _head_cache[url] = r
                return r
            except Exception as e:
                last_exc = e
                await asyncio.sleep(0.05 * (attempt + 1))
    logger.debug("HEAD failed for %s after %d attempts: %s", url, HEAD_RETRY, last_exc)
    return None


async def _partial_get(url: str, headers: Optional[Dict[str, str]] = None, max_bytes: int = RANGE_BYTES) -> Optional[httpx.Response]:
    client = await _ensure_client()
    last_exc = None
    local_headers = dict(headers or {})
    local_headers.setdefault("Range", f"bytes=0-{max_bytes - 1}")
    async with _head_semaphore:
        for attempt in range(max(1, GET_RETRY)):
            try:
                # not streaming the body here to keep callers simple, but we limit bytes via Range header
                r = await client.get(url, headers=local_headers, follow_redirects=True)
                return r
            except Exception as e:
                last_exc = e
                await asyncio.sleep(0.05 * (attempt + 1))
    logger.debug("Partial GET failed for %s: %s", url, last_exc)
    return None


# ----------------------
# Discover links (lectura parcial y parsing ligero)
# ----------------------
_ATTR_RE = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.I)
_JS_SOURCES_RE = re.compile(r'sources\s*:\s*\[([^\]]+)\]', re.I)
_QUOTED_URL_RE = re.compile(r'["\'](https?://[^"\']+)["\']', re.I)
_URL_DIRECT_RE = re.compile(
    r'https?://[^"\'>\s]+{}'.format(r'\.(?:m3u8|m3u|mpd|mp4|webm|mkv|ts|m2ts|ogg|ogv)\b'),
    re.I,
)


async def _fetch_head_bytes(url: str, client: httpx.AsyncClient, max_bytes: int) -> str:
    """
    Hacer streaming y devolver los primeros max_bytes como texto (decodificando con fallback).
    No lanza excepciones hacia arriba, retorna "" en error.
    """
    try:
        async with client.stream("GET", url) as resp:
            if resp.status_code != 200:
                return ""
            collected = bytearray()
            async for chunk in resp.aiter_bytes():
                if not chunk:
                    break
                collected.extend(chunk)
                if len(collected) >= max_bytes:
                    break
            try:
                return collected.decode("utf-8", errors="replace")
            except Exception:
                return collected.decode("latin-1", errors="replace")
    except Exception as e:
        logger.debug("discover_links: error fetching %s: %s", url, e)
        return ""


def _extract_from_text(base_url: str, text: str) -> List[str]:
    """
    Extrae candidatos desde el texto (no ejecuta JS).
    Devuelve URLs absolutas (urljoin).
    """
    candidates: List[str] = []
    seen: Set[str] = set()

    # 1) URLs directas
    for m in _URL_DIRECT_RE.finditer(text):
        u = m.group(0)
        absu = urljoin(base_url, u)
        if absu not in seen:
            seen.add(absu)
            candidates.append(absu)

    # 2) src/href
    for m in _ATTR_RE.finditer(text):
        href = m.group(1).strip()
        if not href:
            continue
        absu = urljoin(base_url, href)
        if _VIDEO_EXT_RE.search(absu) or any(k in absu.lower() for k in ("/embed", "/player", "iframe", "stream")):
            if absu not in seen:
                seen.add(absu)
                candidates.append(absu)

    # 3) arrays JS like sources: [...]
    for m in _JS_SOURCES_RE.finditer(text):
        arr_text = m.group(1)
        for q in _QUOTED_URL_RE.finditer(arr_text):
            u = q.group(1)
            absu = urljoin(base_url, u)
            if absu not in seen:
                seen.add(absu)
                candidates.append(absu)

    # 4) cualquier URL citada que coincida con extensiones de interés
    for m in _QUOTED_URL_RE.finditer(text):
        u = m.group(1)
        if _VIDEO_EXT_RE.search(u):
            absu = urljoin(base_url, u)
            if absu not in seen:
                seen.add(absu)
                candidates.append(absu)

    return candidates


async def discover_links(url: str, max_bytes: int = 200_000, client: Optional[httpx.AsyncClient] = None) -> List[str]:
    """
    Descubre candidatos multimedia en `url`. Cachea resultados por DISCOVER_CACHE_TTL.
    """
    client = client or await _ensure_client()

    if url in _discover_cache:
        return _discover_cache[url]

    text = await _fetch_head_bytes(url, client, max_bytes)
    if not text:
        _discover_cache[url] = []
        return []

    # Run extraction in executor to avoid blocking event loop on big regex work
    loop = asyncio.get_event_loop()
    candidates = await loop.run_in_executor(None, _extract_from_text, url, text)

    normalized: List[str] = []
    seen: Set[str] = set()
    for c in candidates:
        if c not in seen:
            seen.add(c)
            normalized.append(c)

    _discover_cache[url] = normalized
    return normalized


# ----------------------
# Scoring + Validación
# ----------------------
def _score_candidate(url: str, content_type: Optional[str] = None) -> int:
    score = 0
    u = url.lower()
    ext = _get_ext_from_url(url)
    if ext in PLAYLIST_EXTS:
        score += 200
    if ext in VIDEO_EXTS:
        score += 150
    if any(s in u for s in HIGH_PRIORITY_DOMAINS):
        score += 30
    if "embed" in u or "player" in u:
        score += 15
    if content_type:
        ct = content_type.lower()
        if "mpegurl" in ct or "dash+xml" in ct:
            score += 220
        elif ct.startswith("video"):
            score += 180
    return score


async def _validate_candidate(url: str, request_headers: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """
    Validación rápida: HEAD (cacheada) y GET parcial si es necesario.
    Retorna metadata dict si válido, o None.
    """
    try:
        h = await _safe_head(url)
        if h is not None:
            ct = h.headers.get("content-type", "") or ""
            cl = h.headers.get("content-length")
            status = h.status_code
            final = str(h.url) if hasattr(h, "url") else url
            if status and 200 <= status < 400 and (_is_video_content_header(ct) or _looks_like_playlist(final, ct)):
                return {
                    "destination_url": final,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else (_get_ext_from_url(final) or "unknown").lstrip("."),
                    "size": int(cl) if cl and cl.isdigit() else None,
                    "note": "validated (HEAD)",
                }

        # GET parcial
        g = await _partial_get(url, headers=request_headers)
        if g is not None:
            ct = g.headers.get("content-type", "") or ""
            cl = g.headers.get("content-length")
            status = g.status_code
            final = str(g.url) if hasattr(g, "url") else url
            if status and 200 <= status < 400 and (
                _is_video_content_header(ct)
                or _looks_like_playlist(final, ct)
                or (_get_ext_from_url(final) in VIDEO_EXTS.union(PLAYLIST_EXTS))
            ):
                return {
                    "destination_url": final,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else (_get_ext_from_url(final) or "unknown").lstrip("."),
                    "size": int(cl) if cl and cl.isdigit() else None,
                    "note": "validated (GET partial)",
                }

        # heurística por extensión
        ext = _get_ext_from_url(url)
        if ext in VIDEO_EXTS.union(PLAYLIST_EXTS):
            return {
                "destination_url": url,
                "content_type": None,
                "format": ext.lstrip("."),
                "size": None,
                "note": "validated by extension",
            }
    except Exception as e:
        logger.debug("Candidate validation error for %s: %s", url, e)
        return None
    return None


# ----------------------
# Extractor principal
# ----------------------
class UniversalExtractor(BaseExtractor):
    name = "universal"

    async def extract(self, url: str, **kwargs) -> Dict[str, Any]:
        """
        Flujo:
         1) intentamos HEAD
         2) GET parcial
         3) discover_links + scoring + validación concurrente (primer válido)
        """
        request_headers = getattr(self, "base_headers", None) or {}
        mediaflow_endpoint = getattr(self, "mediaflow_endpoint", None) or None

        try:
            # 1) HEAD
            head = await _safe_head(url)
            if head is not None:
                ct = head.headers.get("content-type", "") or ""
                cl = head.headers.get("content-length")
                final_url = str(head.url) if hasattr(head, "url") else url
                if _is_video_content_header(ct) or _looks_like_playlist(final_url, ct):
                    return {
                        "destination_url": final_url,
                        "content_type": ct,
                        "format": ct.split("/")[-1] if "/" in ct else (_get_ext_from_url(final_url) or "unknown").lstrip("."),
                        "size": int(cl) if cl and cl.isdigit() else None,
                        "note": "detectado por universal (HEAD)",
                        "request_headers": request_headers,
                        "mediaflow_endpoint": mediaflow_endpoint,
                    }

            # 2) GET parcial
            partial = await _partial_get(url, headers=request_headers)
            if partial is not None:
                ct = partial.headers.get("content-type", "") or ""
                cl = partial.headers.get("content-length")
                final_url = str(partial.url) if hasattr(partial, "url") else url
                if _is_video_content_header(ct) or _looks_like_playlist(final_url, ct):
                    return {
                        "destination_url": final_url,
                        "content_type": ct,
                        "format": ct.split("/")[-1] if "/" in ct else (_get_ext_from_url(final_url) or "unknown").lstrip("."),
                        "size": int(cl) if cl and cl.isdigit() else None,
                        "note": "detectado por universal (GET parcial)",
                        "request_headers": request_headers,
                        "mediaflow_endpoint": mediaflow_endpoint,
                    }

            # 3) discover_links
            candidates = await discover_links(url, client=await _ensure_client())
            if not candidates:
                raise ExtractorError("No parece un recurso de video directo (HEAD/GET parcial) y no se encontraron candidatos")

            candidates = candidates[:MAX_CANDIDATES_TO_CHECK]
            scored: List[Tuple[int, str]] = []
            for c in candidates:
                c_head = _head_cache.get(c)
                c_ct = c_head.headers.get("content-type", "") if c_head is not None else None
                scored.append((_score_candidate(c, c_ct), c))

            scored.sort(key=lambda x: x[0], reverse=True)
            sorted_candidates = [c for _, c in scored]

            # validar concurrentemente
            tasks = []
            for c in sorted_candidates:
                async def _validate_with_semaphore(candidate_url: str):
                    async with _candidate_semaphore:
                        return await _validate_candidate(candidate_url, request_headers=request_headers)
                tasks.append(asyncio.create_task(_validate_with_semaphore(c)))

            first_valid: Optional[Dict[str, Any]] = None
            for fut in asyncio.as_completed(tasks):
                try:
                    res = await fut
                except asyncio.CancelledError:
                    continue
                except Exception:
                    continue
                if res:
                    first_valid = res
                    break

            # cancelar pendientes
            for t in tasks:
                if not t.done():
                    t.cancel()

            if first_valid:
                first_valid["request_headers"] = request_headers
                first_valid["mediaflow_endpoint"] = mediaflow_endpoint
                first_valid["note"] = (first_valid.get("note", "") + " (discover+validate)").strip()
                return first_valid

            raise ExtractorError("No se encontró recurso de video válido entre los candidatos detectados")

        except ExtractorError:
            raise
        except Exception as e:
            logger.exception("Error en UniversalExtractor para %s: %s", url, e)
            raise ExtractorError(str(e))
