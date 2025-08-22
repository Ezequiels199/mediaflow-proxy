#!/usr/bin/env bash
set -euo pipefail

# Configuración para Render
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-10000}"
WORKERS="${WORKERS:-1}"

# Variables de MediaFlow Proxy
API_PASSWORD="${API_PASSWORD:-}"
FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-*}"

# Logging
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1"
}

log "=== MediaFlow Proxy en Render ==="
log "Host: $HOST"
log "Puerto: $PORT" 
log "Workers: $WORKERS"
log "API Password: $([ -n "$API_PASSWORD" ] && echo "✓ Configurado" || echo "✗ FALTA CONFIGURAR")"

# Verificar Python
if ! command -v python3 &> /dev/null; then
    log "ERROR: Python3 no disponible"
    exit 1
fi

# Verificar instalación
if ! python3 -c "import mediaflow_proxy" 2>/dev/null; then
    log "ERROR: mediaflow-proxy no instalado"
    log "INFO: Instalando desde requirements.txt..."
    pip install -r requirements.txt || exit 1
fi

# Advertencia sobre password
if [[ -z "$API_PASSWORD" ]]; then
    log "ADVERTENCIA: Configura API_PASSWORD en Render"
fi

# Iniciar servidor
log "Iniciando MediaFlow Proxy..."
exec uvicorn mediaflow_proxy.main:app \
    --host "$HOST" \
    --port "$PORT" \
    --workers "$WORKERS" \
    --forwarded-allow-ips "$FORWARDED_ALLOW_IPS" \
    --access-log
