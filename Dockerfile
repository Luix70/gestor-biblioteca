# Base estable y activa. Node 18 por compatibilidad con CPUs antiguas (Intel Atom D525).
FROM node:18-bullseye-slim

# Sin dependencias nativas (se eliminó sharp): no hace falta toolchain de compilación
# (python3/build-essential). npm install solo trae JavaScript puro, sin instrucciones SIMD
# que el Atom D525 (hasta SSSE3, sin SSE4.2/AVX) no soporta.
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

CMD ["node", "--no-warnings", "src/app.js"]