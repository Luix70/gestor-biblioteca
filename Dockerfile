# Base estable y activa. Node 18 por compatibilidad con CPUs antiguas (Intel Atom D525).
FROM node:18-bullseye-slim

# Dependencias: casi todo JS puro. La única nativa es better-sqlite3 (lee el Fichero local
# OL+BNE), pero se instala como BINARIO PRECOMPILADO (prebuild-install lo descarga), así que
# NO hace falta toolchain (python3/build-essential) en la imagen. Es C plano, sin SIMD/AVX, así
# que corre en el Atom D525 (hasta SSSE3) como poppler. OJO: better-sqlite3 va PINNED a la línea
# v11 — la v12+ exige Node 20+ y deja de publicar prebuilt para Node 18 (este base) → fallaría.
#
# zxing-wasm (lectura LOCAL del código de barras ANTES de la IA, ahorra llamadas/429) es WASM puro, NO un
# addon nativo: se instala sin toolchain. OJO: su .wasm podría usar SIMD y NO instanciar en el Atom (sin
# SSE4.1); por eso el lector local DEGRADA con elegancia (si no instancia → se cae a la visión, sin romper
# nada). Sus deps type-fest/tagged-tag son SOLO TIPOS (sin código en runtime); el aviso EBADENGINE es inocuo.
#
# music-metadata (metadatos de AUDIOLIBROS: ID3v1/v2 de MP3, átomos MP4 de M4A/M4B con capítulos, FLAC/Ogg,
# y la CARÁTULA embebida) es JS PURO ESM, sin nativo/SIMD → apto para el Atom, sin toolchain. OJO: PINNED a
# la línea v9 (Node >=16); la v10+ exige Node >=20 y NO arrancaría en este base (Node 18).
#
# poppler-utils aporta pdftoppm para rasterizar portadas de PDF. Es un binario de SISTEMA
# (no un .node): detecta el CPU en tiempo de ejecución (pixman cae a SSE2/SSSE3) y por eso
# SÍ funciona en el Atom, al contrario que sharp/libvips.
#
# Descompresión de CÓMICS (.cbr RAR, .cb7 7z, .cbz ZIP) para extraer páginas/portada:
#   · libarchive-tools aporta `bsdtar` — libre (Debian MAIN), C plano (apto Atom), y CLAVE: lee RAR5
#     (el formato por defecto del RAR moderno), además de RAR4/7z/ZIP. Es el extractor principal.
#   · unar (`unar`/`lsar`, también MAIN/libre) se mantiene como RESPALDO (cubre algún RAR4/7z que
#     libarchive no lea). OJO: unar NO soporta RAR5 — de ahí que bsdtar sea el principal.
# djvulibre-bin aporta `ddjvu` para convertir un .djvu a PDF y verlo con el visor PDF del panel.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils libarchive-tools unar djvulibre-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "--no-warnings", "src/app.js"]