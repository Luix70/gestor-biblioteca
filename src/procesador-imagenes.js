import sharp from 'sharp';

/**
 * Recibe un buffer de imagen crudo, aplica mejoras de iluminación, recorte automático y
 * devuelve un nuevo buffer optimizado en formato JPEG estandarizado.
 */
export async function optimizarImagenRecurso(bufferInicial) {
    try {
        console.log('    🛠️  Procesando imagen (reencuadre y mejora de contraste)...');
        
        const instanciaSharp = sharp(bufferInicial);

        // Obtenemos metadatos para decidir la rotación
        const metadata = await instanciaSharp.metadata();

        // FLUJO DE OPTIMIZACIÓN
        return await instanciaSharp
           
            .rotate()                   // Auto-rota basándose en EXIF si lo tiene
            .resize({ width: 1000 })   // Estandariza ancho a 1000px (mantiene aspecto)
            .normalize()                // Ajuste de niveles base (brillo y contraste)
            .gamma()                    // Corrección gamma ligera para sombras
            .toFormat('jpeg', { quality: 80, progressive: true }) // Convierte a JPEG optimizado
            .toBuffer();

    } catch (error) {
        console.error('⚠️  Error en procesamiento de imagen, usando buffer original:', error.message);
        return bufferInicial; // Fallback: devolvemos la imagen original si falla el revelado
    }
}