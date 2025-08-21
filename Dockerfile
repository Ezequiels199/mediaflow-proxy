# Usar Python oficial
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

# instalar dependencias de sistema necesarias para compilar ruedas si hace falta
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential \
     gcc \
     libxml2-dev \
     libxslt1-dev \
     zlib1g-dev \
     libffi-dev \
     libssl-dev \
     pkg-config \
     curl \
     cargo \
     rustc \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# copiar requirements primero para aprovechar cache
COPY requirements.txt /app/requirements.txt

# pip actualizado y luego instalar requirements
RUN python -m pip install --upgrade pip setuptools wheel
RUN pip install --no-cache-dir -r /app/requirements.txt

# copiar el resto del proyecto
COPY . /app

# puerto por defecto; Render inyecta $PORT, usamos fallback 10000
ENV PORT 10000

# Comando de inicio — usa la variable de entorno PORT si está definida
ENTRYPOINT ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
