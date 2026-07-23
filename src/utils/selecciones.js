/**
 * SELECCIONES PERSONALES — agrupaciones ARBITRARIAS y curadas por el usuario («Libros para leer este verano»,
 * «Recomendados», «Pendientes de encuadernar»). Un documento puede estar en VARIAS a la vez.
 *
 * POR QUÉ NO SE REUTILIZA `colecciones`: una colección NO es una agrupación, es una construcción de IDENTIDAD
 * y de disposición en disco — un número de revista se deduplica por (coleccion, clave_numero) y su carpeta es
 * `revistas/<cabecera>/<año>`. El documento necesita conocer su colección EN LA INGESTA para calcular su
 * identidad y su ruta, así que invertir esa relación rompería justo la maquinaria antipérdida. Además la
 * cardinalidad 1:1 ahí es CORRECTA (un número pertenece a una sola cabecera). Y «Cambridge University Press»
 * ya está cubierto por `editorial`, que es entidad propia.
 *
 * AQUÍ, EN CAMBIO, SÍ SE INVIERTE LA RELACIÓN: la pertenencia vive en el documento de la SELECCIÓN (`docs[]`),
 * no en el libro. En este concepto no hay identidad, ni carpeta, ni ingesta de por medio, así que invertir no
 * cuesta nada: añadir/quitar es un $addToSet/$pull y el pipeline ni se entera. La consulta inversa («¿en qué
 * selecciones está este libro?») la resuelve el índice sobre `docs`.
 *
 * El COMENTARIO de una selección NO vive aquí: reutiliza las FICHAS DE LECTURA con `ambito:'seleccion'`
 * (texto rico, saneado, con imágenes) — es «una ficha de lectura de la colección», como pidió el usuario.
 */
import { ObjectId } from 'mongodb';

const oid = (v) => (ObjectId.isValid(String(v)) ? new ObjectId(String(v)) : null);
/** Normaliza una lista de ids (CSV o array) a ObjectId únicos. */
export function idsValidos(lista) {
    const arr = Array.isArray(lista) ? lista : String(lista || '').split(',');
    const vistos = new Set();
    const out = [];
    for (const x of arr) {
        const o = oid(String(x).trim());
        if (o && !vistos.has(String(o))) { vistos.add(String(o)); out.push(o); }
    }
    return out;
}

const limpiar = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Todas las selecciones con su nº de documentos (para la página «Selecciones»). */
export async function listarSelecciones(db) {
    const filas = await db.collection('selecciones').aggregate([
        { $project: { nombre: 1, descripcion: 1, fecha_creacion: 1, fecha_actualizacion: 1, portada: 1, n: { $size: { $ifNull: ['$docs', []] } } } },
        { $sort: { fecha_actualizacion: -1 } },
    ]).toArray();
    return filas;
}

/** Crea una selección. `docs` (opcional) = miembros iniciales — así nace ya poblada desde el catálogo. */
export async function crearSeleccion(db, { nombre, descripcion, docs } = {}) {
    const nom = limpiar(nombre, 120);
    if (!nom) return { ok: false, motivo: 'la selección necesita un nombre' };
    const ahora = new Date();
    const sel = {
        nombre: nom,
        descripcion: limpiar(descripcion, 2000),
        docs: idsValidos(docs),
        fecha_creacion: ahora,
        fecha_actualizacion: ahora,
    };
    const r = await db.collection('selecciones').insertOne(sel);
    return { ok: true, _id: String(r.insertedId), nombre: sel.nombre, n: sel.docs.length };
}

/** Renombra / re-describe una selección (los miembros se tocan con anadirDocs/quitarDocs). */
export async function editarSeleccion(db, id, { nombre, descripcion } = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const set = { fecha_actualizacion: new Date() };
    if (nombre !== undefined) {
        const nom = limpiar(nombre, 120);
        if (!nom) return { ok: false, motivo: 'el nombre no puede quedar vacío' };
        set.nombre = nom;
    }
    if (descripcion !== undefined) set.descripcion = limpiar(descripcion, 2000);
    const r = await db.collection('selecciones').updateOne({ _id }, { $set: set });
    if (!r.matchedCount) return { ok: false, motivo: 'selección no encontrada' };
    return { ok: true };
}

/** Borra la selección. NO toca los documentos: una selección es solo una vista, nunca contiene los libros. */
export async function borrarSeleccion(db, id) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const r = await db.collection('selecciones').deleteOne({ _id });
    if (!r.deletedCount) return { ok: false, motivo: 'selección no encontrada' };
    // Se llevan por delante también sus fichas de lectura (el «comentario» de la selección ya no aplica).
    await db.collection('fichas_lectura').deleteMany({ ambito: 'seleccion', ref: _id }).catch(() => {});
    return { ok: true };
}

/** AÑADE documentos ($addToSet: nunca duplica, así que «añadir otra vez» es inofensivo). */
export async function anadirDocs(db, id, ids) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const nuevos = idsValidos(ids);
    if (!nuevos.length) return { ok: false, motivo: 'no se recibió ningún documento' };
    const r = await db.collection('selecciones').findOneAndUpdate(
        { _id },
        { $addToSet: { docs: { $each: nuevos } }, $set: { fecha_actualizacion: new Date() } },
        { returnDocument: 'after' },
    );
    const sel = r?.value ?? r;
    if (!sel) return { ok: false, motivo: 'selección no encontrada' };
    return { ok: true, nombre: sel.nombre, n: (sel.docs || []).length, anadidos: nuevos.length };
}

/** QUITA documentos de la selección (los libros no se tocan). */
export async function quitarDocs(db, id, ids) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const fuera = idsValidos(ids);
    if (!fuera.length) return { ok: false, motivo: 'no se recibió ningún documento' };
    const r = await db.collection('selecciones').findOneAndUpdate(
        { _id }, { $pull: { docs: { $in: fuera } }, $set: { fecha_actualizacion: new Date() } }, { returnDocument: 'after' },
    );
    const sel = r?.value ?? r;
    if (!sel) return { ok: false, motivo: 'selección no encontrada' };
    return { ok: true, n: (sel.docs || []).length };
}

/** Una selección con sus datos (los documentos se piden al catálogo con ?seleccion=<id>, que ya pagina). */
export async function fichaSeleccion(db, id) {
    const _id = oid(id);
    if (!_id) return null;
    const sel = await db.collection('selecciones').findOne({ _id });
    if (!sel) return null;
    return { ...sel, n: (sel.docs || []).length };
}

/** Ids de los documentos de una selección (los usa el filtro del catálogo). [] si no existe. */
export async function docsDeSeleccion(db, id) {
    const _id = oid(id);
    if (!_id) return [];
    const sel = await db.collection('selecciones').findOne({ _id }, { projection: { docs: 1 } });
    return sel?.docs || [];
}

/** ¿En qué selecciones está este documento? (consulta inversa, la resuelve el índice sobre `docs`). */
export async function seleccionesDeDoc(db, docId) {
    const _id = oid(docId);
    if (!_id) return [];
    return db.collection('selecciones')
        .find({ docs: _id }, { projection: { nombre: 1 } })
        .sort({ nombre: 1 })
        .toArray();
}
