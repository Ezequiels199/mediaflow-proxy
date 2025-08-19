# Usa directamente la imagen del proxy ya construido
FROM mhdzumair/mediaflow-proxy:latest

# Render automáticamente asigna la variable PORT
ENV PORT=3000

# Expone el puerto
EXPOSE 3000

# Comando de inicio
CMD ["node", "server.js"]
