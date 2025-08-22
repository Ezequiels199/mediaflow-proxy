#!/usr/bin/env bash
set -euo pipefail

# Configuración específica para MediaFlow Proxy
DEFAULT_HOST="${HOST:-0.0.0.0}"
DEFAULT_PORT="${PORT:-8888}"
DEFAULT_WORKERS="${WORKERS:-1}"
DEFAULT_LOG_LEVEL="${LOG_LEVEL:-info}"

# Variables específicas de MediaFlow Proxy
API_PASSWORD="${API_PASSWORD:-}"
PROXY_URL="${PROXY_URL:-}"
ALL_PROXY="${ALL_PROXY:-false}"
FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-127.0.0.1}"
ENABLE_STREAMING_PROGRESS="${ENABLE_STREAMING_PROGRESS:-false}"
DISABLE_HOME_PAGE="${DISABLE_HOME_PAGE:-false}"
DISABLE_DOCS="${DISABLE_DOCS:-false}"
DISABLE_SPEEDTEST="${DISABLE_SPEEDTEST:-false}"

# Función para mostrar ayuda
show_help() {
    echo "Script de inicio para MediaFlow Proxy"
    echo ""
    echo "Variables de entorno principales:"
    echo "  HOST                    - Host a usar (default: 0.0.0.0)"
    echo "  PORT                    - Puerto a usar (default: 8888)"
    echo "  WORKERS                 - Número de workers (default: 1)"
    echo "  LOG_LEVEL              - Nivel de log (default: info)"
    echo "  API_PASSWORD           - Contraseña para proteger la API (REQUERIDO para producción)"
    echo ""
    echo "Variables de configuración de MediaFlow Proxy:"
    echo "  PROXY_URL              - URL del proxy HTTP/HTTPS/SOCKS5"
    echo "  ALL_PROXY              - Habilitar proxy para todas las rutas (default: false)"
    echo "  FORWARDED_ALLOW_IPS    - IPs confiables para headers forwarded (default: 127.0.0.1)"
    echo "  ENABLE_STREAMING_PROGRESS - Habilitar logging de progreso (default: false)"
    echo "  DISABLE_HOME_PAGE      - Deshabilitar página de inicio (default: false)"
    echo "  DISABLE_DOCS           - Deshabilitar documentación API (default: false)"
    echo "  DISABLE_SPEEDTEST      - Deshabilitar speedtest (default: false)"
    echo ""
    echo "Ejemplo de uso:"
    echo "  API_PASSWORD=mi_password PORT=3000 WORKERS=4 ./start.sh"
    echo "  API_PASSWORD=password PROXY_URL=http://proxy:8080 ./start.sh"
    echo ""
    echo "Para más información: https://github.com/mhdzumair/mediaflow-proxy"
}

# Procesar argumentos de línea de comandos
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        --check-config)
            CHECK_CONFIG_ONLY=true
            shift
            ;;
        *)
            echo "Argumento desconocido: $1"
            show_help
            exit 1
            ;;
    esac
done

# Función para logging con colores
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp="[$(date +'%Y-%m-%d %H:%M:%S')]"
    
    case "$level" in
        "INFO")  echo -e "\033[32m$timestamp INFO:\033[0m $message" ;;
        "WARN")  echo -e "\033[33m$timestamp WARN:\033[0m $message" ;;
        "ERROR") echo -e "\033[31m$timestamp ERROR:\033[0m $message" ;;
        *)       echo "$timestamp $level: $message" ;;
    esac
}

# Verificar que Python está disponible
if ! command -v python &> /dev/null && ! command -v python3 &> /dev/null; then
    log "ERROR" "Python no está instalado o no está en el PATH"
    exit 1
fi

# Usar python3 por defecto si está disponible
PYTHON_CMD="python"
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
fi

# Verificar versión de Python (MediaFlow Proxy requiere Python 3.10+)
PYTHON_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
REQUIRED_VERSION="3.10"

if ! python3 -c "import sys; exit(0 if sys.version_info >= (3, 10) else 1)" 2>/dev/null; then
    log "ERROR" "MediaFlow Proxy requiere Python 3.10 o superior. Versión actual: $PYTHON_VERSION"
    exit 1
fi

# Verificar que el paquete mediaflow-proxy está instalado
if ! $PYTHON_CMD -c "import mediaflow_proxy" 2>/dev/null; then
    log "ERROR" "mediaflow-proxy no está instalado."
    log "INFO" "Para instalarlo ejecuta: pip install mediaflow-proxy"
    log "INFO" "O si tienes el código fuente: poetry install"
    exit 1
fi

# Verificar que uvicorn está disponible
if ! $PYTHON_CMD -c "import uvicorn" 2>/dev/null; then
    log "ERROR" "uvicorn no está instalado. Debería estar incluido con mediaflow-proxy"
    exit 1
fi

# Validaciones de configuración específicas de MediaFlow Proxy
validate_config() {
    local warnings=0
    
    # Verificar API_PASSWORD en producción
    if [[ -z "$API_PASSWORD" ]]; then
        log "WARN" "API_PASSWORD no está configurado. Esto es inseguro para producción."
        log "INFO" "Se recomienda configurar API_PASSWORD para proteger contra acceso no autorizado."
        ((warnings++))
    fi
    
    # Verificar configuración de FORWARDED_ALLOW_IPS
    if [[ "$FORWARDED_ALLOW_IPS" == "*" ]]; then
        log "WARN" "FORWARDED_ALLOW_IPS está configurado como '*'. Esto es inseguro para producción."
        log "INFO" "Se recomienda especificar IPs específicas de proxies confiables."
        ((warnings++))
    fi
    
    # Verificar configuración de proxy
    if [[ -n "$PROXY_URL" && "$ALL_PROXY" == "true" ]]; then
        log "INFO" "Proxy configurado para todas las rutas: $PROXY_URL"
    elif [[ -n "$PROXY_URL" ]]; then
        log "INFO" "Proxy configurado: $PROXY_URL (usar ALL_PROXY=true para habilitar en todas las rutas)"
    fi
    
    # Verificar puerto disponible
    if command -v netstat &> /dev/null; then
        if netstat -tuln 2>/dev/null | grep -q ":$DEFAULT_PORT "; then
            log "WARN" "El puerto $DEFAULT_PORT parece estar en uso"
            ((warnings++))
        fi
    fi
    
    return $warnings
}

# Validar configuración
log "INFO" "Validando configuración de MediaFlow Proxy..."
validate_config
validation_warnings=$?

if [[ "${CHECK_CONFIG_ONLY:-false}" == "true" ]]; then
    log "INFO" "Verificación de configuración completada con $validation_warnings advertencias"
    exit 0
fi

# Mostrar configuración del servidor
log "INFO" "Iniciando MediaFlow Proxy con la siguiente configuración:"
log "INFO" "  Host: $DEFAULT_HOST"
log "INFO" "  Puerto: $DEFAULT_PORT"
log "INFO" "  Workers: $DEFAULT_WORKERS"
log "INFO" "  Log Level: $DEFAULT_LOG_LEVEL"
log "INFO" "  Python: $PYTHON_CMD ($PYTHON_VERSION)"
log "INFO" "  Forwarded Allow IPs: $FORWARDED_ALLOW_IPS"
log "INFO" "  API Password: $([ -n "$API_PASSWORD" ] && echo "✓ Configurado" || echo "✗ No configurado")"
log "INFO" "  Streaming Progress: $ENABLE_STREAMING_PROGRESS"
log "INFO" "  Home Page: $([ "$DISABLE_HOME_PAGE" == "true" ] && echo "Deshabilitada" || echo "Habilitada")"
log "INFO" "  API Docs: $([ "$DISABLE_DOCS" == "true" ] && echo "Deshabilitadas" || echo "Habilitadas")"
log "INFO" "  Speed Test: $([ "$DISABLE_SPEEDTEST" == "true" ] && echo "Deshabilitado" || echo "Habilitado")"

if [[ -n "$PROXY_URL" ]]; then
    log "INFO" "  Proxy URL: $PROXY_URL (All Proxy: $ALL_PROXY)"
fi

# Mostrar URLs de acceso
log "INFO" ""
log "INFO" "URLs de acceso una vez iniciado el servidor:"
log "INFO" "  Página principal: http://$DEFAULT_HOST:$DEFAULT_PORT/"
log "INFO" "  Documentación API: http://$DEFAULT_HOST:$DEFAULT_PORT/docs"
log "INFO" "  Speed Test: http://$DEFAULT_HOST:$DEFAULT_PORT/speedtest.html"
log "INFO" ""

# Función para manejar señales de terminación
cleanup() {
    log "INFO" "Deteniendo MediaFlow Proxy..."
    exit 0
}

trap cleanup SIGTERM SIGINT

# Preparar argumentos de uvicorn
UVICORN_ARGS=(
    "mediaflow_proxy.main:app"
    "--host" "$DEFAULT_HOST"
    "--port" "$DEFAULT_PORT"
    "--workers" "$DEFAULT_WORKERS"
    "--log-level" "$DEFAULT_LOG_LEVEL"
    "--forwarded-allow-ips" "$FORWARDED_ALLOW_IPS"
    "--access-log"
)

# Añadir colores solo si el terminal los soporta
if [[ -t 1 ]]; then
    UVICORN_ARGS+=("--use-colors")
fi

# Mostrar comando final (para debugging)
if [[ "${DEBUG:-false}" == "true" ]]; then
    log "INFO" "Comando uvicorn: uvicorn ${UVICORN_ARGS[*]}"
fi

# Arrancar uvicorn
log "INFO" "Iniciando servidor MediaFlow Proxy..."
exec uvicorn "${UVICORN_ARGS[@]}"
