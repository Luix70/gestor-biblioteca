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
 * @param contribuciones array [{nombre, rol}] ya resueltos (traductor/ilustrador/…)
 */
export function aRegistroLegible(doc, { autores = [], editorial = null, contribuciones = [] } = {}) {
    const legible = { ...doc };
    legible._id = String(doc._id);
    legible.autores = autores;
    if (editorial) legible.editorial = editorial; else delete legible.editorial;
    // Contribuciones por NOMBRE (no ObjectId). Fuera el campo de trabajo y el crudo con persona-ObjectId.
    delete legible.contribuciones_nombres;
    if (Array.isArray(contribuciones) && contribuciones.length) legible.contribuciones = contribuciones;
    else delete legible.contribuciones;
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

/** Resuelve los nombres de autores/editorial/contribuciones de un documento (consultas puntuales a la BD). */
export async function resolverNombres(db, doc) {
    const autorIds = (doc.autores || []).filter(Boolean);
    const contribIds = (doc.contribuciones || []).map(c => c && c.persona).filter(Boolean);
    const todos = [...autorIds, ...contribIds];
    const personaDocs = todos.length
        ? await db.collection('autores').find({ _id: { $in: todos } }, { projection: { nombre: 1 } }).toArray()
        : [];
    const amap = new Map(personaDocs.map(a => [String(a._id), a.nombre]));
    const autores = autorIds.map(id => amap.get(String(id)) || String(id));
    // Contribuciones (traductor/ilustrador/…) con el nombre resuelto de cada persona.
    const contribuciones = (doc.contribuciones || [])
        .filter(c => c && c.persona)
        .map(c => ({ rol: c.rol, nombre: amap.get(String(c.persona)) || String(c.persona) }));

    let editorial = null;
    if (doc.editorial) {
        const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
        editorial = e ? e.nombre : null;
    }
    return { autores, editorial, contribuciones };
}
