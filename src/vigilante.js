import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import { procesarCatalogo } from './motor-catalogo.js';
import { procesarImagenSiEsNecesario } from './utils/procesador-archivos.js';

const INBOX = path.resolve(process.env.PATH_INBOX);

export function iniciarVigilante() {
    const watcher = chokidar.watch(INBOX, {
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 }
    });

    watcher.on('add', async (ruta) => {
        console.log(`[Vigilante] Nuevo archivo detectado: ${path.basename(ruta)}`);
        
        // Lógica de detección: ¿Es un archivo suelto o parte de una carpeta?
        // En este modo bimodal, asumiremos que si llega al Inbox, es para procesamiento masivo.
        // Aquí podrías añadir lógica para extraer metadatos básicos de archivos (ISBN desde nombre, etc)
        const datosDummy = {
            titulo: path.parse(ruta).name, // Título provisional
            tipo_recurso: 'libro',
            cdu: '000',
            idioma: 'es',
            formatos: ['papel']
        };

        // Procesamiento automático hacia destino CDU
        const destinoFinal = path.join(process.env.PATH_CDU, '000', 'libros', 'masivo', path.basename(ruta));
        await fs.mkdir(path.dirname(destinoFinal), { recursive: true });
        
        await procesarImagenSiEsNecesario(ruta, destinoFinal);
        
        // Persistencia
        await procesarCatalogo(datosDummy);
        console.log(`[Vigilante] Catalogación masiva completada para: ${path.basename(ruta)}`);
    });
}