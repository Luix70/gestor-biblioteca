import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Calcula el SHA-256 de un archivo en modo streaming (sin cargar el contenido en memoria).
 * Seguro incluso con PDFs grandes en el NAS con RAM limitada.
 */
export function calcularHashArchivo(ruta) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = fs.createReadStream(ruta);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
