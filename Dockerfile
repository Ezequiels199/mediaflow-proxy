# Usa una imagen oficial de Python
FROM python:3.11-slim

# evitar preguntas interactivas
ENV DEBIAN_FRONTEND=noninteractive
ENV PATH="/root/.cargo/bin:${PATH}"

# instalar dependencias del sistema necesarias para lxml, aiohttp, etc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    curl \
    git \
    pkg-config \
    libxml2-dev \
    libxslt1-dev \
    zlib1g-dev \
    libffi-dev \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# instalar rust (rustup) para paquetes que requieren compilación con Rust (maturin/pyo3)
# -y para no preguntar
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y

# asegurar que cargo/rust estén en el PATH
ENV PATH="/root/.cargo/bin:${PATH}"

# actualizar pip, wheel y setuptools
RUN pip install --upgrade pip setuptools wheel

# crear directorio de trabajo
WORKDIR /app

# copiar e instalar dependencias primero (cache layer)
COPY requisitos.txt requirements.txt ./ 2>/dev/null || true
# si tu requirements se llama "requirements.txt" usa esa; en tu repo veo "requisitos.txt" también
# intenta instalar lo que exista
RUN if [ -f "requisitos.txt" ]; then pip install --no-cache-dir -r requisitos.txt; fi \
 && if [ -f "requirements.txt" ]; then pip install --no-cache-dir -r requirements.txt; fi

# copiar el resto de la app
COPY . .

# Exponer puerto (ajustalo si usás otro)
EXPOSE 8000

# Comando por defecto (ajustalo según cómo inicies tu app)
# Si usás uvicorn directamente: ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
CMD ["gunicorn", "-k", "uvicorn.workers.UvicornWorker", "main:app", "--bind", "0.0.0.0:8000", "--workers", "1"]
