const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();
const PORT = process.env.PORT || 3000;

// Endpoint de prueba
app.get("/ping", (req, res) => {
  res.send("ok");
});

// Proxy hacia Webstreamr (ejemplo)
app.use(
  "/proxy",
  createProxyMiddleware({
    target: "https://webstreamr.hayd.uk",
    changeOrigin: true,
    pathRewrite: { "^/proxy": "" }
  })
);

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
