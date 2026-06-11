// src/utils/procesador-archivos.js
import sharp from 'sharp';
import fs from 'fs/promises';

export async function procesarImagenSiEsNecesario(rutaTemporal, destinoFinal) {
    const metadata = await sharp(rutaTemporal).metadata();
    const stats = await fs.stat(rutaTemporal);
    
    // Umbrales
    const TAMANO_MAX_MB = 1.5; 
    const RESOLUCION_MAX_PX = 1500;
    
    const esLigero = stats.size < (TAMANO_MAX_MB * 1024 * 1024);
    const esResolucionAdecuada = metadata.width <= RESOLUCION_MAX_PX && metadata.height <= RESOLUCION_MAX_PX;
    const esJpeg = metadata.format === 'jpeg';

    if (esLigero && esResolucionAdecuada && esJpeg) {
        // Optimización no necesaria: Operación atómica de movimiento
        await fs.rename(rutaTemporal, destinoFinal);
    } else {
        // Requiere optimización: "Seguro de vida" activado
        await sharp(rutaTemporal)
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80, progressive: true })
            .toFile(destinoFinal);
        await fs.unlink(rutaTemporal);
    }
}
