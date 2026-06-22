import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * PAPELERA DE RECICLAJE — política "nunca borrar".
 * En vez de eliminar ficheros (fs.rm/unlink), se MUEVEN a Recycling/<serial>/ para que un borrado
 * indebido sea SIEMPRE recuperable (el incidente que motivó esto: la limpieza del Inbox borró los
 * tomos 2..N de una obra multivolumen). El usuario vacía la papelera a mano cuando quiera.
 *
 * Cada llamada crea UNA subcarpeta serializada `Recycling/<NNNNNN>_<fecha>[_etiqueta]/` (ordenable,
 * sin colisión) y conserva los nombres originales. Mueve con copia+verificación+borrado: los
 * destinos de la app son bind mounts distintos del Inbox (fs.rename daría EXDEV) y, sobre todo,
 * el original NUNCA se borra si la copia no quedó íntegra → es imposible perder datos.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');

/** Carpeta de la papelera (env > default), resuelta en cada uso (override por PATH_RECICLAJE). */
function dirReciclaje() {
    const v = process.env.PATH_RECICLAJE || 'Recycling';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
}

function nombreSeguro(s) {
    return String(s || '')
        .replace(/[<>:"/\\|?*'\n\r]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '').slice(0, 50);
}

// El serial es monotónico: se reanuda desde el máximo ya presente en la papelera (sobrevive a
// reinicios), cacheado por carpeta para no re-listar el directorio en cada reciclaje.
let cacheSerial = { dir: null, max: 0 };

async function siguienteSubcarpeta(dir, etiqueta) {
    if (cacheSerial.dir !== dir) {
        let max = 0;
        try {
            for (const e of await fs.readdir(dir, { withFileTypes: true })) {
                const m = e.isDirectory() && e.name.match(/^(\d{1,9})/);
                if (m) max = Math.max(max, parseInt(m[1], 10));
            }
        } catch { /* aún no existe */ }
        cacheSerial = { dir, max };
    }
    const n = String(++cacheSerial.max).padStart(6, '0');
    const ts = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const et = nombreSeguro(etiqueta);
    return path.join(dir, `${n}_${ts}${et ? '_' + et : ''}`);
}

/**
 * Mueve a la papelera los ficheros indicados (sustituto seguro de fs.rm para datos del usuario).
 * Ignora los que no existen. Best-effort: nunca lanza (no debe romper la ingesta).
 * @param {string|string[]} rutas
 * @param {string} [etiqueta]  pista para nombrar la subcarpeta (p. ej. el documento que se limpia)
 * @returns {Promise<string|null>} la subcarpeta usada, o null si no había nada que reciclar.
 */
export async function reciclar(rutas, etiqueta = '') {
    const lista = [...new Set((Array.isArray(rutas) ? rutas : [rutas]).filter(Boolean))];
    const existentes = [];
    for (const r of lista) {
        try { if ((await fs.stat(r)).isFile()) existentes.push(r); } catch { /* no existe */ }
    }
    if (!existentes.length) return null;

    const dir = dirReciclaje();
    const sub = await siguienteSubcarpeta(dir, etiqueta);
    try { await fs.mkdir(sub, { recursive: true }); }
    catch (e) { console.error(`♻️  Papelera inaccesible (${e.message}): se CONSERVAN los originales.`); return null; }

    for (const r of existentes) {
        let destino = path.join(sub, path.basename(r));
        if (await fs.access(destino).then(() => true).catch(() => false)) {
            const ext = path.extname(destino), base = path.basename(destino, ext);
            destino = path.join(sub, `${base}.${Date.now()}${ext}`);
        }
        try {
            await fs.copyFile(r, destino);
            const [o, d] = await Promise.all([fs.stat(r), fs.stat(destino)]);
            if (o.size === d.size) {
                await fs.chmod(r, 0o666).catch(() => {});
                await fs.rm(r, { force: true }).catch(() => {});
            } else {
                console.error(`♻️  Papelera: copia incompleta de ${path.basename(r)} → se CONSERVA el original.`);
            }
        } catch (e) {
            console.error(`♻️  Papelera: no se pudo reciclar ${path.basename(r)} (${e.message}) → se CONSERVA.`);
        }
    }
    return sub;
}
