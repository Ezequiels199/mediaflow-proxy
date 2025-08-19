FROM mhdzumair/mediaflow-proxy:latest

# Definimos el puerto que Render debe usar
ENV PORT=8080

# Exponemos el puerto 8080
EXPOSE 8080

# Comando de inicio
CMD ["npm", "start"]
