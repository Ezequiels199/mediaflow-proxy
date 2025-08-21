# extractors/streamtape.py
import re
import time
import base64
import requests
from urllib.parse import urljoin, urlparse

# Config
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
TIMEOUT = 12
MAX_RETRIES = 2
SLEEP_RETRY = 1.0

def _get(url, headers=None, allow_redirects=True):
    headers = headers or {}
    headers.setdefault("User-Agent", USER_AGENT)
    try:
        return requests.get(url, headers=headers, timeout=TIMEOUT, allow_redirects=allow_redirects)
    except Exception as e:
        raise

def _try_fetch_with_retries(url, headers=None, allow_redirects=True):
    last_exc = None
    for i in range(MAX_RETRIES + 1):
        try:
            return _get(url, headers=headers, allow_redirects=allow_redirects)
        except Exception as e:
            last_exc = e
            if i < MAX_RETRIES:
                time.sleep(SLEEP_RETRY * (i + 1))
            else:
                raise last_exc

def _absolute(base, maybe_rel):
    try:
        return urljoin(base, maybe_rel)
    except:
        return maybe_rel

def extract(target_url):
    """
    Extractor robusto para StreamTape.
    Devuelve dict: {'url': <direct_url>, 'headers': {..}} o {'error': '...'}
    """
    try:
        parsed = urlparse(target_url)
        base = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else "https://streamtape.com"

        # 1) GET la página principal (embed o enlace)
        try:
            r = _try_fetch_with_retries(target_url, headers={"User-Agent": USER_AGENT, "Referer": base})
        except Exception as e:
            return {"error": f"No se pudo descargar la página: {str(e)}"}

        text = r.text or ""

        # 2) Pattern más común: /get_video?... (relative o absolute)
        m = re.search(r'(/get_video\?[^"\'\s<>]+)', text)
        if not m:
            # buscar también la versión completa con domain
            m = re.search(r'(https?://[^"\'\s<>]*?/get_video\?[^"\'\s<>]+)', text)

        if m:
            gv = _absolute(base, m.group(1))
            try:
                r2 = _try_fetch_with_retries(gv, headers={"User-Agent": USER_AGENT, "Referer": target_url}, allow_redirects=True)
            except Exception as e:
                return {"error": f"Error al pedir get_video: {str(e)}"}

            # Si devuelve JSON con url:
            try:
                j = r2.json()
                if isinstance(j, dict):
                    # buscar campo "url" u otras claves comunes
                    for k in ("url","file","video","link"):
                        if k in j and j[k]:
                            final = j[k]
                            return {"url": final, "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}
            except Exception:
                pass

            # Si r2 redirigió a la url final, r2.url será ella
            final_url = r2.url
            # si en el body vino un link directo, extraemos
            mm = re.search(r'(https?://[^\s"\'<>]+(?:\.mp4|/get_video\?[^"\'<>]+|/d/[^"\'<>]+))', r2.text or "")
            if mm:
                final_url = mm.group(1)

            return {"url": final_url, "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}

        # 3) Buscar enlace directo a .mp4 en la página (a veces lo inyectan)
        m2 = re.search(r'(https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*)', text)
        if m2:
            return {"url": m2.group(1), "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}

        # 4) Buscar atob("...") base64 codificado con url adentro (patrón usado por algunos)
        m3 = re.search(r'atob\(["\']([A-Za-z0-9+/=]+)["\']\)', text)
        if m3:
            try:
                decoded = base64.b64decode(m3.group(1)).decode('utf-8', errors='ignore')
                mm = re.search(r'(https?://[^\s"\'<>]+(?:\.mp4|/get_video\?[^"\'<>]+))', decoded)
                if mm:
                    return {"url": mm.group(1), "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}
            except Exception:
                pass

        # 5) Buscar scripts con "src" que contengan get_video (otro patrón)
        m4 = re.search(r'src\s*=\s*["\']([^"\']*get_video[^"\']*)["\']', text, re.IGNORECASE)
        if m4:
            gv = _absolute(base, m4.group(1))
            try:
                r2 = _try_fetch_with_retries(gv, headers={"User-Agent": USER_AGENT, "Referer": target_url}, allow_redirects=True)
                # si redirige, use r2.url
                return {"url": r2.url, "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}
            except Exception as e:
                return {"error": f"Error al seguir script get_video: {str(e)}"}

        # 6) Intentar extraer desde el "data" o variables JS que contengan /get_video
        mm2 = re.search(r'["\'](\/get_video\?id=[^"\']+)["\']', text)
        if mm2:
            gv = _absolute(base, mm2.group(1))
            try:
                r2 = _try_fetch_with_retries(gv, headers={"User-Agent": USER_AGENT, "Referer": target_url}, allow_redirects=True)
                return {"url": r2.url, "headers": {"User-Agent": USER_AGENT, "Referer": target_url}}
            except Exception as e:
                return {"error": f"Error al pedir get_video (pattern 6): {str(e)}"}

        # Si llegamos acá, no encontramos nada
        return {"error": "No se detectó enlace reproducible en la página (pattern not found)"}

    except Exception as e:
        return {"error": f"Error inesperado: {str(e)}"}
