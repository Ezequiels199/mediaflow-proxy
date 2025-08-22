#!/usr/bin/env bash
set -euo pipefail

# Start script para uvicorn (FastAPI)
# Permite que Render/Heroku/otros usen $PORT
PORT="${PORT:-10000}"
# Opciones recomendadas:
# --proxy-headers: si está detrás de proxy (Render lo provee)
# --limit-concurrency y --limit-max-requests podrían configurarse si necesitás reinicios por leak
exec uvicorn server_render:app \
  --host 0.0.0.0 \
  --port "${PORT}" \
  --workers 1 \
  --log-level info \
  --proxy-headers
