import fs from 'fs/promises';
import path from 'path';
import { aMARCXML } from '../marc21.js';

/**
 * Construye la versión LEGIBLE de un documento para los sidecars (registro.json / .marc.xml):
 * autores y editorial van por NOMBRE (no ObjectId), igual que en la ingesta. Se descartan los
 * campos internos y los valores nulos.
 *
 * @param doc            documento de MongoDB (autores/editorial como ObjectId)
 * @param autores        array de nombres ya resueltos
 * @param editorial      nombre de la editorial ya resuelto (o null)
 */
export function aRegistroLegible(doc, { autores = [], editorial = null } = {}) {
    const legible = { ...doc };
    legible._id = String(doc._id);
    legible.autores = autores;
    if (editorial) legible.editorial = editorial; else delete legible.editorial;
    // La colección se muestra por su nombre denormalizado (coleccion_nombre); fuera el ObjectId.
    delete legible.coleccion;
    // Campos internos que no van al sidecar.
    delete legible.mantenimiento;
    delete legible.mantenimiento_firma;
    delete legible._portadas_remotas;
    for (const k of Object.keys(legible)) {
        const v = legible[k];
        if (v === undefined || v === null || v === '') delete legible[k];
    }
    return legible;
}

/** Escribe registro.json y registro.marc.xml en la carpeta a partir del objeto legible. */
export async function escribirSidecars(carpeta, legible) {
    await fs.writeFile(path.join(carpeta, 'registro.json'), JSON.stringify(legible, null, 2), 'utf8');
    await fs.writeFile(path.join(carpeta, 'registro.marc.xml'), aMARCXML(legible), 'utf8');
}

/** Resuelve los nombres de autores/editorial de un documento (consultas puntuales a la BD). */
export async function resolverNombres(db, doc) {
    const ids = (doc.autores || []).filter(Boolean);
    const autorDocs = ids.length
        ? await db.collection('autores').find({ _id: { $in: ids } }).toArray()
        : [];
    const amap = new Map(autorDocs.map(a => [String(a._id), a.nombre]));
    const autores = ids.map(id => amap.get(String(id)) || String(id));

    let editorial = null;
    if (doc.editorial) {
        const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
        editorial = e ? e.nombre : null;
    }
    return { autores, editorial };
}
