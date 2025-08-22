[build-system]
requires = ["setuptools", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "mediaflow-proxy"
version = "0.0.1"
description = "MediaFlow Proxy (fork)"
authors = [{name="tu nombre"}]
dependencies = [
  "fastapi>=0.95.0",
  "uvicorn[standard]>=0.22.0",
  "httpx>=0.24.0",
  "requests>=2.28.0",
  "cloudscraper==1.2.71",
  "cachetools>=5.2.0",
  "beautifulsoup4>=4.12.2",
  "lxml>=4.9.2",
  "aiofiles>=23.1.0",
  "python-multipart>=0.0.6"
]

[project.scripts]
mediaflow-proxy = "main:main"
