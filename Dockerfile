# Base estable y activa. Node 18 por compatibilidad con CPUs antiguas (Intel Atom D525).
FROM node:18-bullseye-slim

# Sin dependencias nativas de Node (se eliminó sharp): no hace falta toolchain de compilación
# (python3/build-essential). npm install solo trae JavaScript puro, sin instrucciones SIMD
# que el Atom D525 (hasta SSSE3, sin SSE4.2/AVX) no soporta.
#
# poppler-utils aporta pdftoppm para rasterizar portadas de PDF. Es un binario de SISTEMA
# (no un .node): detecta el CPU en tiempo de ejecución (pixman cae a SSE2/SSSE3) y por eso
# SÍ funciona en el Atom, al contrario que sharp/libvips.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "--no-warnings", "src/app.js"]