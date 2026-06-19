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
const DIR_CDU = (() => {
    const v = process.env.PATH_CDU || 'CDU';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
})();

// Extensiones del archivo "original" del recurso (no las imágenes/sidecars que generamos).
export const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];

/** Carpeta del recurso en el árbol CDU. Usa ruta_base si existe; si no, la re-deriva. */
export function carpetaDeDoc(doc) {
    if (doc.ruta_base && doc.ruta_base.startsWith('/recursos/')) {
        const rel = doc.ruta_base.slice('/recursos/'.length).split('/');
        return path.join(DIR_CDU, ...rel);
    }
    const rc = rutaCatalogo({ cdu: doc.cdu, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id });
    return path.join(DIR_CDU, rc.relativa);
}

/** Base web (/recursos/...) de la carpeta del recurso, para construir rutas de imagen. */
export function webDeDoc(doc) {
    if (doc.ruta_base) return doc.ruta_base;
    return rutaCatalogo({ cdu: doc.cdu, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id }).web;
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
