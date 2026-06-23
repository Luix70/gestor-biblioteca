import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Captura de LOGS para el panel: un buffer en memoria (últimas N líneas, para la vista en vivo) y un
 * fichero persistente `logs/app.log` (para tamaño/purga). Lo alimenta `consola-timestamp.js`.
 * El fichero vive en /app/logs (bind mount del NAS) → persiste entre despliegues SI el rsync excluye
 * /logs (ver actualizar-GestorBiblioteca.sh). Los logs de stdout (docker) sí se pierden en cada deploy.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const DIR_LOGS = (() => {
    const v = process.env.PATH_LOGS || 'logs';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
})();
const ARCHIVO = path.join(DIR_LOGS, 'app.log');
const MAX_BUFFER = Number(process.env.LOG_BUFFER_LINEAS || 1500);   // líneas en memoria (vista en vivo)
const CAP_BYTES = Number(process.env.LOG_MAX_BYTES || 25 * 1024 * 1024); // tope de seguridad del fichero

const buffer = [];
let stream = null;
let desdeUltimoChequeo = 0;

try { fs.mkdirSync(DIR_LOGS, { recursive: true }); stream = fs.createWriteStream(ARCHIVO, { flags: 'a' }); }
catch { /* sin fichero: el buffer en memoria sigue funcionando */ }

const RE_FECHA = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/;

function reescribir(lineas) {
    try { if (stream) { stream.end(); stream = null; } } catch { /* ignora */ }
    try { fs.writeFileSync(ARCHIVO, lineas.join('\n') + (lineas.length ? '\n' : '')); } catch { /* ignora */ }
    try { stream = fs.createWriteStream(ARCHIVO, { flags: 'a' }); } catch { /* ignora */ }
}

/** Tope de seguridad: si el fichero pasa de CAP_BYTES, conserva las últimas ~5000 líneas. */
function quizasRecortar() {
    if (!stream || ++desdeUltimoChequeo < 2000) return;
    desdeUltimoChequeo = 0;
    let bytes = 0; try { bytes = fs.statSync(ARCHIVO).size; } catch { return; }
    if (bytes <= CAP_BYTES) return;
    let lineas = [];
    try { lineas = fs.readFileSync(ARCHIVO, 'utf8').split('\n'); } catch { return; }
    reescribir(lineas.slice(-5000));
}

export function anotar(linea) {
    buffer.push(linea);
    if (buffer.length > MAX_BUFFER) buffer.shift();
    if (stream) { try { stream.write(linea + '\n'); } catch { /* ignora */ } }
    quizasRecortar();
}

export function ultimasLineas(n = 300) {
    return buffer.slice(-Math.max(1, Math.min(n, MAX_BUFFER)));
}

export function infoLog() {
    let bytes = 0; try { bytes = fs.statSync(ARCHIVO).size; } catch { /* aún no */ }
    return { archivo: ARCHIVO, bytes, lineas_buffer: buffer.length, max_bytes: CAP_BYTES };
}

/** Purga el fichero: `todo:true` lo vacía; `dias:N` conserva las líneas de los últimos N días. */
export function purgarLog({ dias = null, todo = false } = {}) {
    if (todo) { reescribir([]); buffer.length = 0; return { ok: true, conservado: 'nada' }; }
    const d = Number(dias);
    if (!d || d <= 0) return { ok: false, motivo: 'indica { dias: N } o { todo: true }' };
    const cutoff = Date.now() - d * 86400000;
    let lineas = [];
    try { lineas = fs.readFileSync(ARCHIVO, 'utf8').split('\n'); } catch { return { ok: false, motivo: 'no hay fichero de log' }; }
    const conservar = lineas.filter(l => {
        const m = l.match(RE_FECHA);
        if (!m) return true; // línea sin marca (continuación) → conservar
        return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() >= cutoff;
    });
    reescribir(conservar.filter(Boolean));
    return { ok: true, conservado: `${d} día(s)`, lineas: conservar.length };
}
