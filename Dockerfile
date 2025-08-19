FROM mhdzumair/mediaflow-proxy:latest

# Render expone el puerto desde la variable de entorno
ENV PORT=3000
ENV API_KEY=miclave

EXPOSE 3000

CMD ["npm", "start"]
