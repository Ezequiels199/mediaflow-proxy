#!/usr/bin/env bash
set -euo pipefail

# Actualizar pip (evita la advertencia)
python -m pip install --upgrade pip

# Instalar dependencias
pip install -r requirements.txt

# Forzar que python busque módulos en el directorio actual (si usás imports locales)
export PYTHONPATH="${PYTHONPATH:-}:$(pwd)"

# Ejecutar uvicorn (ajusta main:app si tu app tiene otro nombre)
exec uvicorn main:app --host 0.0.0.0 --port "${PORT:-10000}" --workers 1
