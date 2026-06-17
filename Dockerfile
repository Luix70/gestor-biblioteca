# Usamos una base estable y activa
FROM node:18-bullseye-slim

# Los repositorios de bullseye sí están activos
RUN apt-get update && apt-get install -y \
    python3 \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Usamos la bandera --no-warnings para evitar colisiones con el procesador viejo
CMD ["node", "--no-warnings", "src/app.js"]