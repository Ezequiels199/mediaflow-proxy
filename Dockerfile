# Dockerfile ligero y seguro para Render (FastAPI + uvicorn)
FROM python:3.11-slim

# Evitar buffers en stdout para logs en tiempo real
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000 \
    PIP_NO_CACHE_DIR=1 \
    POETRY_VIRTUALENVS_CREATE=false

# Dependencias del SO necesarias (mínimas)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar requirments e instalar dependencias antes del código para aprovechar cache de Docker
COPY requirements.txt /app/requirements.txt
RUN pip install --upgrade pip setuptools wheel \
    && pip install -r /app/requirements.txt

# Crear usuario no-root para mayor seguridad
RUN useradd --create-home --shell /bin/bash appuser
USER appuser

# Copiar aplicación
COPY --chown=appuser:appuser . /app

# Exponer puerto por defecto de Render (usar PORT env en runtime)
EXPOSE ${PORT}

# Entrypoint: script start.sh (debe ser ejecutable)
CMD ["./start.sh"]
