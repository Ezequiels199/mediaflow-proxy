const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/ping", (req, res) => {
  res.send("ok");
});

app.use("/", createProxyMiddleware({
  target: "https://tu-backend.com", // <-- acá poné la URL real a la que querés conectarte
  changeOrigin: true
}));

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
