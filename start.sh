#!/usr/bin/env bash
set -e

# optional: upgrade pip
# python -m pip install --upgrade pip

# arrancar uvicorn
exec uvicorn mediaflow_proxy.main:app --host 0.0.0.0 --port ${PORT:-8888}
