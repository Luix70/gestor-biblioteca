import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { procesarCatalogo } from './motor-catalogo.js';
import { procesarImagenSiEsNecesario } from './utils/procesador-archivos.js';
import { extraerMetadatosNombre } from './utils/parser-nombre.js';
import { extraerMetadatosEpub } from './utils/lector-epub.js';

const INBOX = process.env.PATH_INBOX || './Inbox';

export function iniciarVigilante() {
    console.log(`[Vigilante] Enganchando directorio (MODO POLLING): ${INBOX}`);

    const watcher = chokidar.watch(INBOX, {
        persistent: true,
        usePolling: true,         // <--- FORZAMOS POLLING
        interval: 1000,           // Mirará cada 1 segundo
        binaryInterval: 1000,
        depth: 0,
        awaitWriteFinish: { 
            stabilityThreshold: 2000, 
            pollInterval: 500 
        }
    });

    watcher.on('add', async (ruta) => {
        // Ignoramos si no es un archivo que nos interesa
        if (path.extname(ruta) === '') return;

        console.log(`[Vigilante] Archivo detectado, esperando liberación: ${path.basename(ruta)}`);
        
        try {
            // Unwatch temporal para evitar que el polling vuelva a leer el mismo archivo
            await watcher.unwatch(ruta);
            
            const nombreArchivo = path.basename(ruta);
            const extension = path.extname(ruta).toLowerCase().replace('.', '');
            
            // Lógica de metadatos...
            let datos;
            if (extension === 'epub') {
                try { datos = await extraerMetadatosEpub(ruta); } 
                catch (e) { datos = extraerMetadatosNombre(nombreArchivo); }
            } else {
                datos = extraerMetadatosNombre(nombreArchivo);
            }

            const payload = {
                ...datos,
                tipo_recurso: 'libro',
                cdu: '000',
                idioma: 'es',
                formatos: [extension === 'epub' ? 'epub' : 'digital'],
                sinopsis: datos.sinopsis || ""
            };

            const resultado = await procesarCatalogo(payload);
            const identificador = resultado.isbn || resultado.insertedId.toString();
            const destinoFinal = path.join(process.env.PATH_CDU, '000', 'libros', identificador, nombreArchivo);
            
            await fs.mkdir(path.dirname(destinoFinal), { recursive: true });
            await procesarImagenSiEsNecesario(ruta, destinoFinal);
            
            console.log(`✅ [Vigilante] Catalogado con éxito: "${payload.titulo}"`);

        } catch (err) {
            console.error(`❌ [Vigilante] Error procesando "${path.basename(ruta)}":`, err.message);
            // Si falla, volvemos a añadirlo al watch para reintento
            watcher.add(ruta);
        }
    });
}