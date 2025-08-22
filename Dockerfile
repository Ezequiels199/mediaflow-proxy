# Dockerfile para mediaflow-proxy (main.py en la raíz)
FROM python:3.13.5-slim

# Variables de entorno
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=8888
ENV PATH="/home/mediaflow_proxy/.local/bin:$PATH"

# Directorio de trabajo
WORKDIR /mediaflow_proxy

# Crear usuario no-root
RUN useradd -m mediaflow_proxy \
    && chown -R mediaflow_proxy:mediaflow_proxy /mediaflow_proxy

# Cambiar a usuario no-root
USER mediaflow_proxy

# Instalar poetry en el home del usuario
RUN pip install --user --no-cache-dir poetry

# Copiar pyproject y poetry.lock (para cachear capa de docker)
COPY --chown=mediaflow_proxy:mediaflow_proxy pyproject.toml poetry.lock* /mediaflow_proxy/

# Configurar poetry e instalar dependencias (sin instalar el paquete en modo editable)
RUN poetry config virtualenvs.in-project true \
    && poetry install --no-interaction --no-ansi --no-root --only main

# Copiar todo el proyecto
COPY --chown=mediaflow_proxy:mediaflow_proxy . /mediaflow_proxy

# Exponer puerto
EXPOSE 8888

# Comando final (usa main:app porque main.py está en la raíz)
CMD ["sh", "-c", "exec poetry run gunicorn main:app -w 4 -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:${PORT:-8888} --timeout 120 --max-requests 500 --max-requests-jitter 200 --access-logfile - --error-logfile - --log-level info --forwarded-allow-ips \"${FORWARDED_ALLOW_IPS:-127.0.0.1}\""]
