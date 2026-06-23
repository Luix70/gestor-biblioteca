# Base estable y activa. Node 18 por compatibilidad con CPUs antiguas (Intel Atom D525).
FROM node:18-bullseye-slim

# Dependencias: casi todo JS puro. La única nativa es better-sqlite3 (lee el Fichero local
# OL+BNE), pero se instala como BINARIO PRECOMPILADO (prebuild-install lo descarga), así que
# NO hace falta toolchain (python3/build-essential) en la imagen. Es C plano, sin SIMD/AVX, así
# que corre en el Atom D525 (hasta SSSE3) como poppler. OJO: better-sqlite3 va PINNED a la línea
# v11 — la v12+ exige Node 20+ y deja de publicar prebuilt para Node 18 (este base) → fallaría.
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