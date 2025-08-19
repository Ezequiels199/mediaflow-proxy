FROM node:18

# Crea carpeta de la app
WORKDIR /app

# Copia los archivos del proyecto
COPY . .

# Instala dependencias
RUN npm install

# Render asigna el puerto en la variable de entorno PORT
ENV PORT=3000

# Expone el puerto
EXPOSE 3000

# Inicia la app
CMD ["npm", "start"]
