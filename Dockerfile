# Imagen base de Python moderna
FROM python:3.11-slim

# Establecer directorio de trabajo
WORKDIR /app

# Copiar dependencias primero (para aprovechar cache en builds)
COPY requirements.txt .

# Instalar dependencias
RUN pip install --no-cache-dir -r requirements.txt

# Copiar el resto del proyecto
COPY . .

# Exponer el puerto que va a usar Render
EXPOSE 10000

# Comando de inicio (Render ejecuta esto)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "10000"]
