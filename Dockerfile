FROM node:22-bookworm-slim

# Instalar dependencias del sistema necesarias para procesamiento de imágenes y PDF
RUN apt-get update && apt-get install -y \
    vips-dev fftw-dev build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copiar archivos de dependencias primero
COPY package*.json ./

# Instalar dependencias dentro del contenedor
RUN npm install

# Copiar el resto del código
COPY . .

# Comando de inicio
CMD ["npm", "start"]