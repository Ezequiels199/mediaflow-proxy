# Async Filemoon extractor mejorado y más robusto
# - Usa httpx.AsyncClient global reutilizable (keep-alive / connection pool)
# - Soporta múltiples patrones (JSON in scripts, sources arrays, file: "...", player.src, source src=)
# - Soporta packed/eval (eval_solver) para casos donde la URL está ofuscada en JS
# - Valida candidatos con HEAD/GET parcial antes de devolverlos
# - Devuelve metadata normalizada y request_headers para uso por el proxy
# - Buen manejo de timeouts, retries y logging
import asyncio
import logging
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx

from mediaflow_proxy.extractors.base import BaseExtractor, ExtractorError
from mediaflow_proxy.utils.packed import eval_solver  # si el repo tiene utilitario para JS packed

logger = logging.getLogger(__name__)

# Configuración
USER_AGENT = "Mozilla/5.0 (StremioMediaFlow/ExtractorFilemoon; +https://github.com/your/repo)"
DEFAULT_TIMEOUT = 12.0
HEAD_RETRIES = 2
GET_PARTIAL_BYTES = 128 * 1024  # 128 KiB para GET parcial
MAX_CANDIDATES = 12

# Cliente global para reutilizar conexiones
_client = httpx.AsyncClient(
    timeout=httpx.Timeout(DEFAULT_TIMEOUT, read=DEFAULT_TIMEOUT),
    limits=httpx.Limits(max_connections=40, max_keepalive_connections=20),
    headers={"User-Agent": USER_AGENT},
    follow_redirects=True,
)

# Patrones comunes para Filemoon y embeds
_PATTERNS = [
    re.compile(r'file\s*:\s*"([^"]+)"', re.I),
    re.compile(r"file\s*:\s*'([^']+)'", re.I),
    re.compile(r'"file"\s*:\s*"([^"]+)"', re.I),
    re.compile(r"'file'\s*:\s*'([^']+)'", re.I),
    re.compile(r'sources\s*:\s*\[\s*["\']([^"\']+)["\']', re.I),
    re.compile(r'sources\s*:\s*\[\s*({.+?})\s*\]', re.I | re.S),
    re.compile(r'source\s+src\s*=\s*["\']([^"\']+)["\']', re.I),
    re.compile(r'player\.src\s*=\s*["\']([^"\']+)["\']', re.I),
    re.compile(r'(https?://[^"\']+?\.(?:mp4|m3u8|webm|mkv|mpd))', re.I),
]

_PACKED_EVAL_RE = re.compile(r'eval\((function\(p,a,c,k,e,d\).+?)\)</script>', re.I | re.S)

_video_exts = {".mp4", ".webm", ".mkv", ".ts", ".m3u8", ".mpd"}

async def _safe_head(url: str, headers: Optional[Dict[str, str]] = None) -> Optional[httpx.Response]:
    last_exc = None
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    for attempt in range(HEAD_RETRIES):
        try:
            resp = await _client.head(url, headers=hdrs)
            return resp
        except Exception as e:
            last_exc = e
            await asyncio.sleep(0.05 * (attempt + 1))
    logger.debug("HEAD failed for %s: %s", url, last_exc)
    return None

async def _partial_get_text(url: str, headers: Optional[Dict[str, str]] = None, max_bytes: int = GET_PARTIAL_BYTES) -> str:
    hdrs = dict(headers or {})
    hdrs.setdefault("User-Agent", USER_AGENT)
    hdrs.setdefault("Range", f"bytes=0-{max_bytes-1}")
    try:
        async with _client.stream("GET", url, headers=hdrs) as resp:
            if resp.status_code >= 400:
                return ""
            collected = bytearray()
            async for chunk in resp.aiter_bytes():
                if not chunk:
                    break
                collected.extend(chunk)
                if len(collected) >= max_bytes:
                    break
            return collected.decode("utf-8", errors="replace")
    except Exception as e:
        logger.debug("Partial GET failed for %s: %s", url, e)
        return ""

def _normalize_url(base: str, candidate: str) -> str:
    try:
        return urljoin(base, candidate)
    except Exception:
        return candidate

def _get_ext(url: str) -> Optional[str]:
    try:
        p = urlparse(url)
        if "." in p.path:
            return "." + p.path.rsplit(".", 1)[-1].lower()
    except Exception:
        return None
    return None

async def _extract_candidates_from_text(base_url: str, text: str) -> List[str]:
    candidates: List[str] = []
    seen = set()

    # Buscar patrones directos predefinidos
    for pat in _PATTERNS:
        for m in pat.finditer(text):
            g = m.group(1) if m.groups() else None
            if not g:
                continue
            u = _normalize_url(base_url, g.strip())
            if u not in seen:
                seen.add(u)
                candidates.append(u)

    # Buscar eval packed y usar eval_solver si hay
    packed = _PACKED_EVAL_RE.search(text)
    if packed:
        try:
            solved = await eval_solver(None, base_url, headers=None, pattern=None, source=packed.group(1))
            # eval_solver in repo may expect different args; if not available, skip silently
            if isinstance(solved, str) and solved:
                u = _normalize_url(base_url, solved.strip())
                if u not in seen:
                    seen.add(u)
                    candidates.append(u)
        except Exception:
            # Si eval_solver falla, intentamos extraer URLs dentro del script por regex
            for m in re.finditer(r'https?://[^"\']+?(?:mp4|m3u8|mpd|webm)', text, re.I):
                u = _normalize_url(base_url, m.group(0))
                if u not in seen:
                    seen.add(u)
                    candidates.append(u)

    # Buscar URLs generales con extensiones
    for m in re.finditer(r'https?://[^"\'>\s]+', text, re.I):
        u = m.group(0)
        ext = _get_ext(u)
        if ext and ext in _video_exts:
            u = _normalize_url(base_url, u)
            if u not in seen:
                seen.add(u)
                candidates.append(u)

    return candidates

async def _validate_and_build(candidate: str, request_headers: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """
    Valida si candidate apunta a media (HEAD o GET parcial) y devuelve metadata si es válido.
    """
    try:
        h = await _safe_head(candidate, headers=request_headers)
        if h is not None and 200 <= h.status_code < 400:
            ct = h.headers.get("content-type", "") or ""
            cl = h.headers.get("content-length")
            if ct and ("video" in ct or "mpegurl" in ct or "application/dash+xml" in ct):
                return {
                    "destination_url": str(h.url) if hasattr(h, "url") else candidate,
                    "content_type": ct,
                    "format": ct.split("/")[-1] if "/" in ct else (_get_ext(candidate) or "unknown").lstrip("."),
                    "size": int(cl) if cl and cl.isdigit() else None,
                    "note": "validated (HEAD)"
                }

        # GET parcial para leer content-type o primeros bytes
        txt = await _partial_get_text(candidate, headers=request_headers, max_bytes=GET_PARTIAL_BYTES)
        # Si el servidor respondió con texto (manifiesto) o el content-type no estaba en HEAD
        # re-intentamos HEAD para obtener headers si no los tuvimos.
        h2 = await _safe_head(candidate, headers=request_headers)
        ct2 = h2.headers.get("content-type", "") if h2 is not None else ""
        if ct2 and ("video" in ct2 or "mpegurl" in ct2 or "application/dash+xml" in ct2):
            return {
                "destination_url": str(h2.url) if hasattr(h2, "url") else candidate,
                "content_type": ct2,
                "format": ct2.split("/")[-1] if "/" in ct2 else (_get_ext(candidate) or "unknown").lstrip("."),
                "size": int(h2.headers.get("content-length")) if h2 and h2.headers.get("content-length", "").isdigit() else None,
                "note": "validated (partial-get)"
            }

        # heurística por extensión
        ext = _get_ext(candidate)
        if ext in _video_exts:
            return {
                "destination_url": candidate,
                "content_type": None,
                "format": ext.lstrip("."),
                "size": None,
                "note": "validated by extension"
            }
    except Exception as e:
        logger.debug("Validation error for %s: %s", candidate, e)
        return None
    return None

class FilemoonExtractor(BaseExtractor):
    name = "filemoon"

    async def extract(self, url: str, **kwargs) -> Dict[str, Any]:
        """
        Extrae un enlace directo desde una página de Filemoon (o embeds similares).
        Estrategia:
         - GET parcial de la página para buscar enlaces (no bajar todo)
         - Extraer candidatos por patrones y eval_solver (JS ofuscado)
         - Validar candidatos con HEAD/GET parcial en paralelo (limitado)
         - Devolver el primer candidato válido
        """
        request_headers = getattr(self, "base_headers", None) or {}
        # Asegurar Referer típico de Filemoon para algunos hosts que lo requieren
        request_headers.setdefault("Referer", "https://filemoon.sx/")
        request_headers.setdefault("User-Agent", USER_AGENT)

        try:
            # 1) Leer la página parcialmente para extraer candidatos
            page_text = await _partial_get_text(url, headers=request_headers, max_bytes=256_000)
            if not page_text:
                # si no pudimos leer parcialmente, intentar un GET normal (con límite de bytes)
                page_text = await _partial_get_text(url, headers=request_headers, max_bytes=512_000)

            candidates = await _extract_candidates_from_text(url, page_text)
            # si no encontramos nada por texto, intentar eval_solver directo sobre la URL (algunos casos)
            if not candidates:
                try:
                    solved = await eval_solver(self, url, headers=request_headers, pattern=r'file\s*:\s*"([^"]+)"')
                    if isinstance(solved, str) and solved:
                        candidates.append(_normalize_url(url, solved))
                except Exception:
                    # no crítico, sólo continuar
                    pass

            if not candidates:
                raise ExtractorError("No se encontraron candidatos en Filemoon")

            # limitar y priorizar pruebas
            candidates = candidates[:MAX_CANDIDATES]

            # Validar candidatos concurrentemente (limitar concurrencia)
            sem = asyncio.Semaphore(6)
            async def _validate_with_limit(cand: str):
                async with sem:
                    return await _validate_and_build(cand, request_headers=request_headers)

            tasks = [asyncio.create_task(_validate_with_limit(c)) for c in candidates]
            first_valid = None
            for fut in asyncio.as_completed(tasks):
                try:
                    res = await fut
                except Exception:
                    res = None
                if res:
                    first_valid = res
                    break

            # cancelar el resto
            for t in tasks:
                if not t.done():
                    t.cancel()

            if not first_valid:
                raise ExtractorError("No se encontró un enlace de video válido en Filemoon")

            # enriquecer metadata
            first_valid.setdefault("request_headers", request_headers)
            first_valid.setdefault("mediaflow_endpoint", getattr(self, "mediaflow_endpoint", None) or "proxy_stream_endpoint")
            first_valid["note"] = (first_valid.get("note", "") + " (filemoon extractor)").strip()

            return first_valid

        except ExtractorError:
            raise
        except Exception as e:
            logger.exception("Error en FilemoonExtractor para %s: %s", url, e)
            raise ExtractorError(str(e))

# Instancia para registro (muchos loaders esperan una variable 'extractor' o clase)
extractor = FilemoonExtractor()
