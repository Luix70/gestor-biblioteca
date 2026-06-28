/**
 * WORKER THREAD de Descubrir: ejecuta la búsqueda de TEXTO en el Fichero (fichero.db, 58,7 M) FUERA del
 * hilo principal. Imprescindible porque better-sqlite3 es SÍNCRONO: una consulta FTS pesada en el hilo
 * principal bloquearía el event loop y CONGELARÍA el panel entero (incl. la búsqueda en tu biblioteca).
 * Aquí la consulta corre en este hilo aparte y el resultado vuelve por mensaje. El cliente está en
 * fichero-descubrir.js. (El lookup por ISBN de la INGESTA sigue en el hilo principal: es ~0,07 ms.)
 */
import { parentPort } from 'worker_threads';
import { buscarTextoEnFichero } from './buscador-local.js';

parentPort.on('message', async (msg) => {
    const { id, q, limite } = msg || {};
    try {
        const result = await buscarTextoEnFichero(q, { limite });
        parentPort.postMessage({ id, ok: true, result });
    } catch (e) {
        parentPort.postMessage({ id, ok: false, error: e.message });
    }
});
