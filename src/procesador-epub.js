import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const moduloEpub2 = require('epub2');

// Resolución dinámica: intercepta el constructor sin importar cómo lo empaquete Node.js
const EPub = moduloEpub2.EPub || moduloEpub2.default || moduloEpub2;

/**
 * Abre un archivo EPUB envolviendo sus eventos clásicos en una Promesa moderna.
 * Extrae metadatos estructurados y el buffer binario de su portada si existe.
 */
export function extraerDatosEpub(rutaEpub) {
    return new Promise((resolve, reject) => {
        let epub;
        
        // Blindaje contra fallos de instanciación
        try {
            epub = new EPub(rutaEpub);
        } catch (error) {
            return reject(new Error(`Fallo crítico de la librería EPUB: ${error.message}`));
        }

        // Capturador de fallos de lectura (archivo corrupto, zip roto...)
        epub.on('error', (err) => {
            reject(new Error(`El motor EPUB no pudo leer el archivo: ${err.message}`));
        });

        // Evento disparado automáticamente cuando el manifiesto se ha cargado en memoria
        epub.on('end', async () => {
            try {
                const info = {
                    titulo: epub.metadata.title || null,
                    editorial: epub.metadata.publisher || null,
                    autores: epub.metadata.creator || null,
                    sinopsis_nativa: epub.metadata.description || null,
                    idioma: epub.metadata.language || 'es',
                    isbn: null
                };

                // Extracción limpia del ISBN
                if (epub.metadata.identifier) {
                    const idStr = String(epub.metadata.identifier);
                    const isbnMatch = idStr.match(/(978[-0-9]{10,13})/);
                    if (isbnMatch) info.isbn = isbnMatch[0].replace(/-/g, '');
                }

                // Extracción de la Tabla de Contenidos
                if (epub.flow) {
                    info.tabla_contenidos = epub.flow.map(item => ({
                        titulo: item.title || 'Capítulo',
                        id: item.id
                    })).filter(item => item.titulo && !item.titulo.startsWith('cover'));
                }

                // Aislamiento del búfer de la portada original
                let bufferPortada = null;
                if (epub.metadata.cover) {
                    // Envolvemos también el callback asíncrono de la imagen
                    bufferPortada = await new Promise((resolveImg) => {
                        epub.getImage(epub.metadata.cover, (error, imgData) => {
                            if (error || !imgData) {
                                resolveImg(null);
                            } else {
                                resolveImg(Buffer.from(imgData));
                            }
                        });
                    });
                    
                    if (!bufferPortada) {
                        console.log('    ⚠️  Aviso: El EPUB no dispone de una imagen de portada accesible.');
                    }
                }

                // Devolvemos el control al orquestador con los datos limpios
                resolve({ info, bufferPortada });

            } catch (err) {
                reject(new Error(`Fallo estructurando metadatos: ${err.message}`));
            }
        });

        // Orden de arranque de lectura
        epub.parse();
    });
}