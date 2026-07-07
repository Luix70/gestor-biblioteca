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

// Manifiesto por subcarpeta: registra el ORIGEN de cada elemento reciclado para poder RESTAURARLO a su
// sitio (como la Papelera de Windows). Sin él, una entrada antigua no se puede restaurar automáticamente.
export const MANIFIESTO_PAPELERA = '.papelera.json';
const existe = (p) => fs.access(p).then(() => true).catch(() => false);

async function anotarManifiesto(sub, entradas) {
    if (!entradas.length) return;
    const f = path.join(sub, MANIFIESTO_PAPELERA);
    let data = { creado: new Date().toISOString(), items: [] };
    try { data = JSON.parse(await fs.readFile(f, 'utf8')); } catch { /* nuevo */ }
    data.items.push(...entradas);
    try { await fs.writeFile(f, JSON.stringify(data, null, 2)); } catch { /* best-effort: no rompe el reciclaje */ }
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

    const movidos = [];
    for (const r of existentes) {
        let destino = path.join(sub, path.basename(r));
        if (await existe(destino)) {
            const ext = path.extname(destino), base = path.basename(destino, ext);
            destino = path.join(sub, `${base}.${Date.now()}${ext}`);
        }
        try {
            await fs.copyFile(r, destino);
            const [o, d] = await Promise.all([fs.stat(r), fs.stat(destino)]);
            if (o.size === d.size) {
                await fs.chmod(r, 0o666).catch(() => {});
                await fs.rm(r, { force: true }).catch(() => {});
                movidos.push({ rel: path.basename(destino), origen: path.resolve(r), tipo: 'file' });
            } else {
                console.error(`♻️  Papelera: copia incompleta de ${path.basename(r)} → se CONSERVA el original.`);
            }
        } catch (e) {
            console.error(`♻️  Papelera: no se pudo reciclar ${path.basename(r)} (${e.message}) → se CONSERVA.`);
        }
    }
    await anotarManifiesto(sub, movidos); // registra los orígenes para poder restaurar
    return sub;
}

/**
 * Mueve una CARPETA ENTERA a la Papelera CONSERVANDO su estructura y su nombre, de modo que restaurarla
 * sea tan fácil como volver a moverla a su sitio (p. ej. un depósito de Cuarentena de vuelta a su
 * categoría). `subruta` la coloca bajo esa ruta relativa dentro del serial (p. ej. la categoría).
 * Copia → verifica → borra el origen (nunca pierde datos: si la copia falla, conserva el original).
 * @returns {Promise<string|null>} la carpeta destino, o null si no se pudo.
 */
export async function reciclarCarpeta(dirOrigen, etiqueta = '', subruta = '') {
    try { if (!(await fs.stat(dirOrigen)).isDirectory()) return null; } catch { return null; }
    const dir = dirReciclaje();
    const sub = await siguienteSubcarpeta(dir, etiqueta);
    const destino = path.join(sub, subruta ? path.basename(String(subruta)) : '', path.basename(dirOrigen));
    try {
        await fs.mkdir(path.dirname(destino), { recursive: true });
        await fs.cp(dirOrigen, destino, { recursive: true });
        if (!(await fs.stat(destino)).isDirectory()) throw new Error('copia no verificada');
        await fs.rm(dirOrigen, { recursive: true, force: true });
        await anotarManifiesto(sub, [{ rel: path.relative(sub, destino), origen: path.resolve(dirOrigen), tipo: 'dir' }]);
        return destino;
    } catch (e) {
        console.error(`♻️  Papelera (carpeta): no se pudo reciclar ${path.basename(dirOrigen)} (${e.message}) → se CONSERVA.`);
        return null;
    }
}

/**
 * RESTAURA una subcarpeta de la Papelera a su ubicación original (usando el manifiesto). Como la Papelera
 * de Windows: reconstruye el fichero/carpeta EXACTAMENTE donde estaba. Copia→verifica→borra de la Papelera;
 * NUNCA pisa algo que ya exista en el destino (esa entrada se conserva y se informa como conflicto). Al
 * terminar, si la subcarpeta queda vacía se elimina; si quedaron pendientes, reescribe el manifiesto con ellos.
 * @returns {Promise<{ok:boolean, motivo?:string, restaurados?:number, conflictos?:string[], errores?:string[]}>}
 */
export async function restaurar(sub) {
    const carpeta = path.join(dirReciclaje(), path.basename(String(sub || '')));
    let manifiesto;
    try { manifiesto = JSON.parse(await fs.readFile(path.join(carpeta, MANIFIESTO_PAPELERA), 'utf8')); }
    catch { return { ok: false, motivo: 'Sin manifiesto de origen: esta entrada se recicló antes de registrarlo; no se puede restaurar automáticamente a su sitio.' }; }

    const items = Array.isArray(manifiesto.items) ? manifiesto.items : [];
    const pendientes = [], conflictos = [], errores = [];
    let restaurados = 0;
    for (const it of items) {
        const fuente = path.join(carpeta, it.rel || '');
        const destino = it.origen;
        if (!destino || !(await existe(fuente))) { errores.push(`${it.rel}: no encontrado en la papelera`); pendientes.push(it); continue; }
        if (await existe(destino)) { conflictos.push(destino); pendientes.push(it); continue; } // no pisar
        try {
            await fs.mkdir(path.dirname(destino), { recursive: true });
            if (it.tipo === 'dir') {
                await fs.cp(fuente, destino, { recursive: true });
                if (!(await fs.stat(destino)).isDirectory()) throw new Error('copia no verificada');
                await fs.rm(fuente, { recursive: true, force: true });
            } else {
                await fs.copyFile(fuente, destino);
                const [o, d] = await Promise.all([fs.stat(fuente), fs.stat(destino)]);
                if (o.size !== d.size) throw new Error('copia incompleta');
                await fs.rm(fuente, { force: true });
            }
            restaurados++;
        } catch (e) { errores.push(`${it.rel}: ${e.message}`); pendientes.push(it); }
    }

    // Limpieza: si no queda nada útil (solo el manifiesto), elimina la subcarpeta; si quedaron pendientes,
    // reescribe el manifiesto con ellos (para reintentar/ver los conflictos).
    const restantes = (await fs.readdir(carpeta).catch(() => [])).filter((n) => n !== MANIFIESTO_PAPELERA);
    if (!restantes.length) {
        await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
    } else {
        manifiesto.items = pendientes;
        await fs.writeFile(path.join(carpeta, MANIFIESTO_PAPELERA), JSON.stringify(manifiesto, null, 2)).catch(() => {});
    }
    return { ok: true, restaurados, conflictos, errores };
}
