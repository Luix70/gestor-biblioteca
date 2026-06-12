// src/utils/procesador-archivos.js
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import sharp from 'sharp';
import path from 'path';

/**
 * Mueve un archivo utilizando canalización de bytes brutos.
 * Este método es inmune a bloqueos de metadatos, atributos de Solo Lectura
 * y problemas de cruce de volúmenes (EXDEV) en NAS y Docker.
 */
async function moverArchivoSeguro(origen, destino) {
    try {
        // 1. Aseguramos que el destino esté limpio
        await fs.unlink(destino).catch(() => {});

        // 2. Canalizamos los bytes brutos directamente de la RAM al disco duro destino
        await pipeline(
            createReadStream(origen),
            createWriteStream(destino)
        );

        // 3. Limpieza del origen. 
        // Si el archivo era de "Solo Lectura", unlink puede fallar en Windows. 
        // Le forzamos los permisos antes de borrar por si acaso.
        try {
            await fs.chmod(origen, 0o666); // Quitamos el atributo Read-Only
            await fs.unlink(origen);
        } catch (errorLimpieza) {
            console.warn(`⚠️ [Archivo] El archivo fue copiado con éxito, pero Windows impidió borrar el original en Inbox: ${errorLimpieza.message}`);
        }

    } catch (error) {
        throw new Error(`Fallo crítico en el pipeline de flujos: ${error.message}`);
    }
}

export async function procesarImagenSiEsNecesario(rutaTemporal, destinoFinal) {
    const extension = path.extname(rutaTemporal).toLowerCase();
    const esImagen = ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(extension);

    if (!esImagen) {
        await moverArchivoSeguro(rutaTemporal, destinoFinal);
        return;
    }

    const metadata = await sharp(rutaTemporal).metadata();
    const stats = await fs.stat(rutaTemporal);
    
    const TAMANO_MAX_MB = 1.5; 
    const RESOLUCION_MAX_PX = 1500;
    
    const esLigero = stats.size < (TAMANO_MAX_MB * 1024 * 1024);
    const esResolucionAdecuada = metadata.width <= RESOLUCION_MAX_PX && metadata.height <= RESOLUCION_MAX_PX;
    const esJpeg = metadata.format === 'jpeg';

    if (esLigero && esResolucionAdecuada && esJpeg) {
        await moverArchivoSeguro(rutaTemporal, destinoFinal);
    } else {
        await sharp(rutaTemporal)
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80, progressive: true })
            .toFile(destinoFinal);
        
        // Limpiamos la imagen original
        await fs.chmod(rutaTemporal, 0o666).catch(() => {});
        await fs.unlink(rutaTemporal).catch(e => console.warn("Limpieza temporal omitida:", e.message));
    }
}