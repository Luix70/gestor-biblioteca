/**
 * Cliente del WORKER de Descubrir (fichero-worker.js). Mantiene UN worker perezoso y de larga vida que
 * resuelve las búsquedas de texto en el Fichero (58,7 M) en su propio hilo, para no bloquear el event
 * loop del panel (better-sqlite3 es síncrono). Petición/respuesta por id con un Map de promesas pendientes
 * y un timeout (una consulta patológica no debe colgar la petición HTTP).
 *
 * Degradación elegante: si el worker no arranca, `descubrirEnFichero` devuelve null y el endpoint avisa
 * de que Descubrir no está disponible (igual que cuando falta el .db o el índice FTS).
 */
import { Worker } from 'worker_threads';

let worker = null, intentado = false, siguiente = 1;
const pendientes = new Map();
const TIMEOUT_MS = Number(process.env.DESCUBRIR_TIMEOUT_MS || 20000);

function asegurarWorker() {
    if (worker || intentado) return worker;
    intentado = true;
    try {
        worker = new Worker(new URL('./fichero-worker.js', import.meta.url));
        worker.on('message', (m) => {
            const p = pendientes.get(m.id);
            if (!p) return;
            pendientes.delete(m.id);
            clearTimeout(p.t);
            if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error || 'fallo en el worker del Fichero'));
        });
        // Si el worker muere: rechazar lo pendiente y permitir un re-spawn en la próxima llamada.
        const caer = (e) => {
            for (const p of pendientes.values()) { clearTimeout(p.t); p.reject(e || new Error('worker del Fichero terminó')); }
            pendientes.clear(); worker = null; intentado = false;
        };
        worker.on('error', caer);
        worker.on('exit', () => caer());
        worker.unref();   // no impedir que el proceso principal termine
    } catch (e) {
        console.warn(`⚠️  Descubrir: no se pudo crear el worker (${e.message}); desactivado.`);
        worker = null;
    }
    return worker;
}

/**
 * Búsqueda de texto en el Fichero EN SEGUNDO PLANO (worker).
 * @returns {Promise<Array|null>} candidatos · [] sin términos/sin resultados · null = no disponible.
 */
export function descubrirEnFichero(q, { limite = 100 } = {}) {
    const w = asegurarWorker();
    if (!w) return Promise.resolve(null);
    const id = siguiente++;
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pendientes.delete(id); reject(new Error('la búsqueda en el Fichero tardó demasiado')); }, TIMEOUT_MS);
        pendientes.set(id, { resolve, reject, t });
        w.postMessage({ id, q, limite });
    });
}
