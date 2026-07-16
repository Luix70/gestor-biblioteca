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
# libchm-bin aporta `extract_chmLib` para desempaquetar CHM (HTML compilado: manuales/libros) → título/
# ISBN/portada. bsdtar (libarchive-tools) ya lee además ISO9660, así que un .iso se expande como un .zip.
#
# WORD: el .docx NO necesita nada (es un ZIP OOXML: adm-zip + cheerio, JS puro). El .doc antiguo (binario OLE
# de Word 97-2003) sí: no hay parser JS razonable, así que la previsualización se delega en `catdoc` (o
# `antiword`, que upstream abandonó y puede no estar ya en el índice de Debian). Por eso se instalan APARTE y
# de forma NO FATAL: si el paquete no existe en esta versión de Debian, la imagen se construye igual y
# utils/lector-word.js DEGRADA con elegancia — el .doc se cataloga por nombre y la ficha ofrece la descarga
# (nunca se pierde: solo no se previsualiza). Mismo criterio que el resto de herramientas de sistema.
RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils libarchive-tools unar djvulibre-bin libchm-bin \
    && (apt-get install -y --no-install-recommends catdoc antiword \
        || apt-get install -y --no-install-recommends catdoc \
        || echo 'ⓘ catdoc/antiword no disponibles: los .doc se catalogarán sin previsualización (el .docx no los necesita).') \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "--no-warnings", "src/app.js"]