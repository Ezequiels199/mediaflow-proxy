# Usa la imagen ya lista del proxy
FROM mhdzumair/mediaflow-proxy:latest

# Render asigna la variable PORT
ENV PORT=3000

# Expone el puerto
EXPOSE 3000
