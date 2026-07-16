/**
 * Agrupado MANUAL de documentos desde el panel (selección múltiple en la Búsqueda):
 *   · asignarColeccion — mete N documentos en una colección (existente o NUEVA): cabecera de revista o
 *     serie de libros. Para una colección de revista, calcula la clave del número y lo registra en el
 *     inventario de la cabecera.
 *   · asignarObra — mete N documentos como TOMOS de una obra multivolumen (existente o NUEVA).
 * Solo toca Mongo (vínculos coleccion/obra); el agrupado es lógico — las vistas de obra/colección los
 * muestran juntos. No mueve ficheros. Reutiliza resolverCabecera/resolverObra (check-then-create).
 */
import { ObjectId } from 'mongodb';
import { resolverCabecera, registrarNumeroEnColeccion } from './colecciones.js';
import { resolverObra, registrarVolumenEnObra, reconstruirInventarioObra } from './obras.js';
import { claveNumero } from './revistas.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

export async function asignarColeccion(db, ids = [], { coleccionId = null, nombre = null, tipo = null } = {}) {
    const col = db.collection('colecciones');
    let _id, nom = nombre, t = tipo;
    if (coleccionId) {
        const c = await col.findOne({ _id: oid(coleccionId) });
        if (!c) return { ok: false, motivo: 'colección no encontrada' };
        _id = c._id; nom = c.nombre; t = c.tipo || t || 'libro';
    } else if (nombre && String(nombre).trim()) {
        t = t === 'revista' ? 'revista' : 'libro';
        const r = await resolverCabecera(db, { nombre: String(nombre).trim(), tipo: t });
        if (!r._id) return { ok: false, motivo: 'no se pudo crear la colección' };
        _id = r._id; nom = String(nombre).trim();
    } else return { ok: false, motivo: 'indica una colección existente o un nombre nuevo' };

    const bib = db.collection('biblioteca');
    let n = 0;
    // Series de LIBROS: auto-numerar (coleccion_numero) los miembros SIN número, continuando desde el
    // máximo actual (igual que el serieAuto de motor-catalogo). Las revistas usan clave_numero (fecha).
    let maxLibro = 0;
    if (t !== 'revista') {
        for (const m of await bib.find({ coleccion: _id }, { projection: { coleccion_numero: 1 } }).toArray()) {
            const x = parseInt(m.coleccion_numero, 10); if (Number.isFinite(x) && x > maxLibro) maxLibro = x;
        }
    }
    const previas = new Set();   // colecciones de las que salen los documentos
    for (const id of ids) {
        const _doc = oid(id); if (!_doc) continue;
        const doc = await bib.findOne({ _id: _doc });
        if (!doc) continue;
        if (doc.coleccion && String(doc.coleccion) !== String(_id)) previas.add(String(doc.coleccion));
        const set = { coleccion: _id, coleccion_nombre: nom, fecha_actualizacion: new Date() };
        if (t === 'revista') { const cn = claveNumero(doc); if (cn) set.clave_numero = cn; }
        else {
            const propio = parseInt(doc.coleccion_numero, 10);
            if (Number.isFinite(propio)) { if (propio > maxLibro) maxLibro = propio; } // conserva el suyo
            else set.coleccion_numero = String(++maxLibro);                            // siguiente de la serie
        }
        await bib.updateOne({ _id: doc._id }, { $set: set });
        if (t === 'revista') await registrarNumeroEnColeccion(db, _id, {
            clave: set.clave_numero || null, 'año': doc.año_edicion ?? null, mes: doc.mes_publicacion ?? null, numero_issue: doc.numero_issue ?? null,
        }, doc._id);
        n++;
    }
    // La colección ANTERIOR que se quede sin miembros se borra (fantasma que solo estorba en estanterías y
    // selectores). Mismo criterio que en obras.
    let vaciadas = 0;
    for (const p of previas) {
        if ((await bib.countDocuments({ coleccion: oid(p) })) === 0) { await col.deleteOne({ _id: oid(p) }); vaciadas++; }
    }
    return { ok: true, n, coleccion: { _id: String(_id), nombre: nom, tipo: t }, vaciadas };
}

export async function asignarObra(db, ids = [], { obraId = null, titulo = null } = {}) {
    const obras = db.collection('obras');
    let _id, tit = titulo;
    if (obraId) {
        const o = await obras.findOne({ _id: oid(obraId) });
        if (!o) return { ok: false, motivo: 'obra no encontrada' };
        _id = o._id; tit = o.titulo;
    } else if (titulo && String(titulo).trim()) {
        const r = await resolverObra(db, { titulo: String(titulo).trim() });
        if (!r._id) return { ok: false, motivo: 'no se pudo crear la obra' };
        _id = r._id; tit = String(titulo).trim();
    } else return { ok: false, motivo: 'indica una obra existente o un título nuevo' };

    const bib = db.collection('biblioteca');
    let n = 0;
    const previas = new Set();   // obras de las que salen los tomos: hay que dejarlas coherentes
    for (const id of ids) {
        const _doc = oid(id); if (!_doc) continue;
        const doc = await bib.findOne({ _id: _doc });
        if (!doc) continue;
        if (doc.obra && String(doc.obra) !== String(_id)) previas.add(String(doc.obra));
        // MOVER a otra obra: `obra_titulo` se REEMPLAZA y `volumen_numero` se CONSERVA (el tomo 3 sigue siendo
        // el 3 en su nueva obra; renumerar a ciegas sería peor que dejarlo). tipo_recurso:'libro' porque un
        // tomo de una obra multivolumen lo es por definición.
        await bib.updateOne({ _id: doc._id }, { $set: { obra: _id, obra_titulo: tit, tipo_recurso: 'libro', fecha_actualizacion: new Date() } });
        await registrarVolumenEnObra(db, _id, doc.volumen_numero ?? null, doc._id);
        n++;
    }
    // DESVINCULAR de la obra anterior: sin esto el tomo seguía listado en las DOS (su inventario no se tocaba)
    // y la obra vieja nunca se quedaba «vacía». Si se vacía, se borra: una obra sin tomos es un fantasma.
    for (const p of previas) {
        const quedan = await bib.countDocuments({ obra: oid(p) });
        if (quedan === 0) await obras.deleteOne({ _id: oid(p) });
        else await reconstruirInventarioObra(db, oid(p)).catch(() => {});
    }
    return { ok: true, n, obra: { _id: String(_id), titulo: tit }, vaciadas: previas.size };
}
