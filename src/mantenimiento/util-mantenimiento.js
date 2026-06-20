import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rutaCatalogo } from '../utils/rutas.js';
import { aMARCXML } from '../marc21.js';

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
export const DIR_CDU = (() => {
    const v = process.env.PATH_CDU || 'CDU';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
})();

// Extensiones del archivo "original" del recurso (no las imágenes/sidecars que generamos).
export const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];

// Zonas "aparcadas" donde puede sobrevivir un original que desapareció de su carpeta CDU.
// NO incluye el Inbox (zona viva: la vigila el watcher) ni el árbol CDU.
const resolverZona = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const ZONAS_RESPALDO = [
    resolverZona('PATH_REINTENTOS', 'Reintentos'),
    resolverZona('PATH_CUARENTENA', 'Cuarentena'),
    resolverZona('PATH_ER_ROOM', '_ER Room'),
];

// Índice cacheado nombreBase → rutaAbsoluta de las zonas de respaldo. Se reconstruye cada
// INDICE_TTL_MS (la restauración COPIA, no mueve, así que el índice no se invalida en la pasada).
const INDICE_TTL_MS = 5 * 60 * 1000;
let _indiceRespaldo = null;
let _indiceTS = 0;

async function indexarDir(raiz, indice) {
    let entradas;
    try { entradas = await fs.readdir(raiz, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        const ruta = path.join(raiz, e.name);
        if (e.isDirectory()) { await indexarDir(ruta, indice); continue; }
        if (!EXT_DOC.includes(path.extname(e.name).toLowerCase())) continue;
        if (!indice.has(e.name)) indice.set(e.name, ruta); // gana la primera zona (prioridad por orden)
    }
}

async function indiceRespaldo() {
    if (_indiceRespaldo && Date.now() - _indiceTS < INDICE_TTL_MS) return _indiceRespaldo;
    const idx = new Map();
    for (const dir of ZONAS_RESPALDO) await indexarDir(dir, idx);
    _indiceRespaldo = idx;
    _indiceTS = Date.now();
    return idx;
}

/**
 * Si a la carpeta le falta el fichero original, lo localiza por nombre en las zonas de respaldo
 * y lo copia de vuelta (NO destructivo: temporal → verifica tamaño → rename; deja el respaldo
 * intacto). Devuelve { origen, bytes } si restauró algo, o null.
 *
 * @param carpeta  carpeta CDU del documento
 * @param nombres  nombres candidatos del original (doc.nombre_archivo + archivos_originales)
 */
export async function restaurarOriginalSiFalta(carpeta, nombres) {
    const cands = (nombres || []).filter(Boolean);
    if (!cands.length) return null;
    const idx = await indiceRespaldo();
    const origen = cands.map(n => idx.get(n)).find(Boolean);
    if (!origen) return null;

    const st = await fs.stat(origen).catch(() => null);
    if (!st || st.size <= 0) return null;

    const destino = path.join(carpeta, path.basename(origen));
    const tmp = path.join(carpeta, `.tmp-restore-${Date.now()}-${path.basename(origen)}`);
    try {
        await fs.copyFile(origen, tmp);
        const stTmp = await fs.stat(tmp);
        if (stTmp.size !== st.size) { await fs.rm(tmp, { force: true }).catch(() => {}); return null; }
        await fs.rename(tmp, destino);
        return { origen, bytes: st.size };
    } catch {
        await fs.rm(tmp, { force: true }).catch(() => {});
        return null;
    }
}

/** Carpeta del recurso en el árbol CDU. Usa ruta_base si existe; si no, la re-deriva. */
export function carpetaDeDoc(doc) {
    if (doc.ruta_base && doc.ruta_base.startsWith('/recursos/')) {
        const rel = doc.ruta_base.slice('/recursos/'.length).split('/');
        return path.join(DIR_CDU, ...rel);
    }
    const rc = rutaCatalogo({ cdu: doc.cdu, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id, año_edicion: doc.año_edicion, mes_publicacion: doc.mes_publicacion, titulo: doc.titulo });
    return path.join(DIR_CDU, rc.relativa);
}

/** Base web (/recursos/...) de la carpeta del recurso, para construir rutas de imagen. */
export function webDeDoc(doc) {
    if (doc.ruta_base) return doc.ruta_base;
    return rutaCatalogo({ cdu: doc.cdu, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id, año_edicion: doc.año_edicion, mes_publicacion: doc.mes_publicacion, titulo: doc.titulo }).web;
}

/** ¿Existe la carpeta del recurso en ESTA máquina? (Los ficheros viven donde corre la app —
 *  el NAS. Si no existe, no debemos sellar el documento: lo hará la máquina que sí los tiene.) */
export async function carpetaExiste(carpeta) {
    return fs.access(carpeta).then(() => true).catch(() => false);
}

/** Ruta absoluta del archivo original (epub/pdf/...) dentro de la carpeta, o null. */
export async function archivoOriginal(carpeta) {
    let entradas;
    try { entradas = await fs.readdir(carpeta); } catch { return null; }
    const f = entradas.find(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
    return f ? path.join(carpeta, f) : null;
}

/** Número de páginas de un PDF vía pdfinfo (poppler), o null si no está disponible. */
export async function numeroPaginasPdf(ruta) {
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: 30000 });
        const m = stdout.match(/Pages:\s*(\d+)/i);
        return m ? Number(m[1]) : null;
    } catch {
        return null;
    }
}

/** Escribe un buffer de imagen en la carpeta con un nombre libre y devuelve { archivo, web }. */
export async function escribirImagen(carpeta, web, buffer, nombreBase) {
    let nombre = `${nombreBase}.jpg`;
    let i = 1;
    // Evita pisar un sidecar existente.
    // eslint-disable-next-line no-await-in-loop
    while (await fs.access(path.join(carpeta, nombre)).then(() => true).catch(() => false)) {
        nombre = `${nombreBase}-${++i}.jpg`;
    }
    await fs.writeFile(path.join(carpeta, nombre), buffer);
    return { archivo: path.join(carpeta, nombre), web: `${web}/${nombre}` };
}

/**
 * Mueve una carpeta CDU de forma transaccional.
 *
 * Estrategia:
 *   1. Intenta fs.rename (atómico en el mismo sistema de ficheros, sin estado intermedio).
 *   2. Si el SO devuelve EXDEV (volúmenes distintos), usa el camino seguro:
 *      a. Copia cada archivo al destino.
 *      b. Verifica que el tamaño del destino coincide exactamente con el origen.
 *      c. Verifica que los archivos referenciados por la BD (portada + imágenes) están presentes.
 *      d. Solo si TODO es correcto, elimina la carpeta origen.
 *
 * @param {string}   origen          - Ruta absoluta de la carpeta actual.
 * @param {string}   destino         - Ruta absoluta de la carpeta destino (no debe existir).
 * @param {string[]} archivosEnBD    - Lista de basenames referenciados en MongoDB (portada, imágenes).
 *                                    Se usan para la verificación de integridad en el paso (c).
 */
export async function moverCarpetaConVerificacion(origen, destino, archivosEnBD = []) {
    // Asegurar que el padre del destino existe.
    await fs.mkdir(path.dirname(destino), { recursive: true });

    // ── Intento 1: rename atómico (no hay estado intermedio que verificar) ─────────────────
    try {
        await fs.rename(origen, destino);
        return; // atómico: si no lanzó, el movimiento está completo y correcto
    } catch (e) {
        if (e.code !== 'EXDEV') throw e; // solo EXDEV nos empuja al camino largo
    }

    // ── Intento 2: copia + verificación + borrado (cross-device) ─────────────────────────
    await fs.mkdir(destino, { recursive: true });
    const archivos = await fs.readdir(origen);

    // a) Copiar
    for (const archivo of archivos) {
        await fs.copyFile(path.join(origen, archivo), path.join(destino, archivo));
    }

    // b) Verificar tamaños
    for (const archivo of archivos) {
        const [stOrig, stDest] = await Promise.all([
            fs.stat(path.join(origen, archivo)),
            fs.stat(path.join(destino, archivo)),
        ]);
        if (stOrig.size !== stDest.size) {
            await fs.rm(destino, { recursive: true, force: true });
            throw new Error(
                `Verificación fallida al mover "${archivo}": ` +
                `tamaño origen ${stOrig.size} B ≠ destino ${stDest.size} B. ` +
                `Carpeta origen conservada en "${origen}".`
            );
        }
    }

    // c) Verificar que todos los archivos enlazados en la BD están en el destino
    const nombresDestino = new Set(archivos);
    const faltantes = archivosEnBD.filter(n => n && !nombresDestino.has(n));
    if (faltantes.length) {
        await fs.rm(destino, { recursive: true, force: true });
        throw new Error(
            `Verificación fallida: archivos referenciados en BD no encontrados en destino: ` +
            `${faltantes.join(', ')}. Carpeta origen conservada en "${origen}".`
        );
    }

    // d) Todo correcto: borrar origen
    await fs.rm(origen, { recursive: true, force: true });
}

const union = (a, b, clave) => {
    const out = [...(a || [])];
    for (const x of (b || [])) if (!out.some(y => (clave ? y[clave] === x[clave] : y === x))) out.push(x);
    return out;
};

/**
 * Aplica un 'cambio' producido por una tarea: actualiza MongoDB y mantiene el registro.json/
 * .marc.xml de la carpeta en sincronía (reutilizando sus nombres ya resueltos, sin tocar Mongo
 * para los ObjectId). cambio = { set?, imagenesNuevas?, alertas? }.
 */
export async function aplicarCambio(coleccion, doc, carpeta, cambio) {
    const set = { ...(cambio.set || {}) };

    if (cambio.imagenesNuevas && cambio.imagenesNuevas.length) {
        set.imagenes = union(doc.imagenes, cambio.imagenesNuevas, 'ruta');
    }
    if (cambio.alertas && cambio.alertas.length) {
        set.alertas_agente = union(doc.alertas_agente, cambio.alertas);
    }
    if (Object.keys(set).length === 0) return;

    set.fecha_actualizacion = new Date();
    await coleccion.updateOne({ _id: doc._id }, { $set: set });

    // Sincroniza el registro en disco (si existe), partiendo de su versión con nombres legibles.
    try {
        const p = path.join(carpeta, 'registro.json');
        const actual = JSON.parse(await fs.readFile(p, 'utf8'));
        const fusionado = { ...actual, ...set };
        delete fusionado.fecha_actualizacion;
        await fs.writeFile(p, JSON.stringify(fusionado, null, 2), 'utf8');
        await fs.writeFile(path.join(carpeta, 'registro.marc.xml'), aMARCXML(fusionado), 'utf8');
    } catch { /* sin registro.json en disco: el de Mongo ya quedó actualizado */ }
}
