/**
 * Gestión de UBICACIONES (ámbito / estantería) como si fueran colecciones de estanterías — sin pérdida
 * de datos: la "pertenencia" de un libro a una estantería es su `ubicacion.{ambito,estanteria}` (strings),
 * que es la FUENTE DE VERDAD. Una colección `ubicaciones` guarda solo METADATOS (estanterías pre-creadas
 * vacías, NFC) — análoga a `colecciones` para las revistas/series.
 *
 *   crear      — da de alta estanterías (una o en lote) en un ámbito (registro; pueden quedar vacías).
 *   renombrar  — renombra un ámbito o una estantería (reescribe los docs + el registro).
 *   mover      — mueve una estantería a otro ámbito.
 *   fusionar   — vuelca los libros de una estantería en otra (destino) y borra la de origen.
 *   explotar   — deja los libros SIN ubicación (ámbito+estantería → 'Sin asignar') y borra el registro.
 *   eliminar   — borra una estantería/ámbito del registro solo si no le quedan libros.
 *   asignar    — pone una ubicación a un conjunto de documentos (alta masiva desde Búsqueda).
 *   nfc        — registra el UID de la etiqueta NFC de una estantería/ámbito.
 */
import { ObjectId } from 'mongodb';

const SIN = 'Sin asignar';
const norm = (s) => String(s ?? '').trim();
const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const cmp = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
// Clave de estantería en el registro: null a nivel ámbito; el nombre si es una estantería real.
const claveEst = (e) => { const v = norm(e); return (v && v !== SIN) ? v : null; };

// Árbol para la página de gestión: ámbito → estanterías, con conteos (de los docs) + NFC (del registro).
export async function listarUbicacionesGestion(db) {
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const [agg, registro] = await Promise.all([
        bib.aggregate([
            { $group: { _id: { a: '$ubicacion.ambito', e: '$ubicacion.estanteria' }, n: { $sum: 1 } } },
        ]).toArray(),
        reg.find({}).toArray(),
    ]);
    const mapa = new Map();
    const getAmb = (a) => { if (!mapa.has(a)) mapa.set(a, { ambito: a, n: 0, nfc: null, ests: new Map() }); return mapa.get(a); };
    const getEst = (A, e) => { if (!A.ests.has(e)) A.ests.set(e, { estanteria: e, n: 0, nfc: null }); return A.ests.get(e); };
    for (const x of agg) {
        const a = norm(x._id.a) || SIN, e = norm(x._id.e) || SIN;
        if (a === SIN) continue;                 // los libros sin ámbito no son una estantería gestionable
        const A = getAmb(a); A.n += x.n;
        if (e !== SIN) getEst(A, e).n += x.n;
    }
    for (const r of registro) {                  // mezclar registro: estanterías vacías pre-creadas + NFC
        const a = norm(r.ambito); if (!a) continue;
        const A = getAmb(a); const e = claveEst(r.estanteria);
        if (e == null) { if (r.nfc_uid) A.nfc = r.nfc_uid; }
        else { const E = getEst(A, e); if (r.nfc_uid) E.nfc = r.nfc_uid; }
    }
    return [...mapa.values()]
        .map((A) => ({ ambito: A.ambito, n: A.n, nfc: A.nfc, estanterias: [...A.ests.values()].sort((x, y) => cmp(x.estanteria, y.estanteria)) }))
        .sort((x, y) => cmp(x.ambito, y.ambito));
}

// Crear estanterías (una o en lote) en un ámbito. Si `estanterias` viene vacío, registra el ámbito.
export async function crearUbicaciones(db, { ambito, estanterias = [] } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const reg = db.collection('ubicaciones');
    const lista = [...new Set((Array.isArray(estanterias) ? estanterias : []).map(norm).filter(Boolean))];
    let creadas = 0;
    const claves = lista.length ? lista : [null];
    for (const e of claves) {
        const r = await reg.updateOne({ ambito: a, estanteria: e },
            { $setOnInsert: { ambito: a, estanteria: e, fecha_creacion: new Date() } }, { upsert: true });
        if (r.upsertedCount) creadas++;
    }
    return { ok: true, creadas, total: lista.length };
}

// Renombrar un ámbito (estanteria vacía) o una estantería concreta. Reescribe docs + registro.
export async function renombrarUbicacion(db, { ambito, estanteria, nuevoAmbito, nuevaEstanteria } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const e = claveEst(estanteria);
    if (e == null) {
        const na = norm(nuevoAmbito); if (!na) return { ok: false, motivo: 'nuevo ámbito requerido' };
        if (na === a) return { ok: true, modificados: 0 };
        const r = await bib.updateMany({ 'ubicacion.ambito': a }, { $set: { 'ubicacion.ambito': na, fecha_actualizacion: new Date() } });
        for (const row of await reg.find({ ambito: a }).toArray()) {
            await reg.updateOne({ ambito: na, estanteria: row.estanteria },
                { $setOnInsert: { ambito: na, estanteria: row.estanteria, fecha_creacion: new Date() }, $set: { nfc_uid: row.nfc_uid || null } }, { upsert: true });
            await reg.deleteOne({ _id: row._id });
        }
        return { ok: true, modificados: r.modifiedCount };
    }
    const ne = norm(nuevaEstanteria); if (!ne) return { ok: false, motivo: 'nuevo nombre requerido' };
    if (ne === e) return { ok: true, modificados: 0 };
    const r = await bib.updateMany({ 'ubicacion.ambito': a, 'ubicacion.estanteria': e }, { $set: { 'ubicacion.estanteria': ne, fecha_actualizacion: new Date() } });
    const old = await reg.findOne({ ambito: a, estanteria: e });
    await reg.updateOne({ ambito: a, estanteria: ne },
        { $setOnInsert: { ambito: a, estanteria: ne, fecha_creacion: new Date() }, $set: { nfc_uid: old?.nfc_uid || null } }, { upsert: true });
    if (old) await reg.deleteOne({ _id: old._id });
    return { ok: true, modificados: r.modifiedCount };
}

// Mover una estantería completa a otro ámbito (conserva su nombre y su NFC).
export async function moverEstanteria(db, { ambito, estanteria, nuevoAmbito } = {}) {
    const a = norm(ambito), e = claveEst(estanteria), na = norm(nuevoAmbito);
    if (!a || !e || !na) return { ok: false, motivo: 'faltan datos' };
    if (na === a) return { ok: true, modificados: 0 };
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const r = await bib.updateMany({ 'ubicacion.ambito': a, 'ubicacion.estanteria': e }, { $set: { 'ubicacion.ambito': na, fecha_actualizacion: new Date() } });
    const old = await reg.findOne({ ambito: a, estanteria: e });
    await reg.updateOne({ ambito: na, estanteria: e },
        { $setOnInsert: { ambito: na, estanteria: e, fecha_creacion: new Date() }, $set: { nfc_uid: old?.nfc_uid || null } }, { upsert: true });
    if (old) await reg.deleteOne({ _id: old._id });
    return { ok: true, modificados: r.modifiedCount };
}

// Fusionar una estantería (origen) en otra (destino). Vuelca sus libros y borra el origen del registro.
export async function fusionarEstanteria(db, { ambito, estanteria, destinoAmbito, destinoEstanteria } = {}) {
    const a = norm(ambito), e = claveEst(estanteria), da = norm(destinoAmbito), de = claveEst(destinoEstanteria);
    if (!a || !e || !da || !de) return { ok: false, motivo: 'faltan datos' };
    if (a === da && e === de) return { ok: false, motivo: 'origen y destino iguales' };
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const r = await bib.updateMany({ 'ubicacion.ambito': a, 'ubicacion.estanteria': e },
        { $set: { 'ubicacion.ambito': da, 'ubicacion.estanteria': de, fecha_actualizacion: new Date() } });
    await reg.deleteOne({ ambito: a, estanteria: e });
    await reg.updateOne({ ambito: da, estanteria: de }, { $setOnInsert: { ambito: da, estanteria: de, fecha_creacion: new Date() } }, { upsert: true });
    return { ok: true, movidos: r.modifiedCount };
}

// Explotar: los libros de la estantería (o de todo el ámbito) quedan SIN ubicación. Borra del registro.
export async function explotarUbicacion(db, { ambito, estanteria } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const e = claveEst(estanteria);
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const filtro = e != null ? { 'ubicacion.ambito': a, 'ubicacion.estanteria': e } : { 'ubicacion.ambito': a };
    const r = await bib.updateMany(filtro, { $set: { 'ubicacion.ambito': SIN, 'ubicacion.estanteria': SIN, fecha_actualizacion: new Date() } });
    if (e != null) await reg.deleteOne({ ambito: a, estanteria: e });
    else await reg.deleteMany({ ambito: a });
    return { ok: true, liberados: r.modifiedCount };
}

// Eliminar del registro una estantería/ámbito — solo si no le quedan libros (si no, explótala o muévelos).
export async function eliminarUbicacion(db, { ambito, estanteria } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const e = claveEst(estanteria);
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const filtro = e != null ? { 'ubicacion.ambito': a, 'ubicacion.estanteria': e } : { 'ubicacion.ambito': a };
    const n = await bib.countDocuments(filtro);
    if (n > 0) return { ok: false, motivo: `tiene ${n} libro(s): explótala o muévelos primero` };
    if (e != null) await reg.deleteOne({ ambito: a, estanteria: e });
    else await reg.deleteMany({ ambito: a });
    return { ok: true };
}

// Asignar una ubicación a un conjunto de documentos (alta masiva desde la Búsqueda).
export async function asignarUbicacion(db, { ids = [], ambito, estanteria } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const e = claveEst(estanteria);
    const oids = (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);
    if (!oids.length) return { ok: false, motivo: 'sin documentos' };
    const bib = db.collection('biblioteca'), reg = db.collection('ubicaciones');
    const r = await bib.updateMany({ _id: { $in: oids } },
        { $set: { ubicacion: { ambito: a, estanteria: e || SIN }, fecha_actualizacion: new Date() } });
    await reg.updateOne({ ambito: a, estanteria: e }, { $setOnInsert: { ambito: a, estanteria: e, fecha_creacion: new Date() } }, { upsert: true });
    return { ok: true, n: r.modifiedCount, ambito: a, estanteria: e || SIN };
}

// Registrar el UID de la etiqueta NFC de una estantería/ámbito (la escritura del tag es en el cliente).
export async function registrarNfcUbicacion(db, { ambito, estanteria, uid } = {}) {
    const a = norm(ambito); if (!a) return { ok: false, motivo: 'ámbito requerido' };
    const e = claveEst(estanteria);
    const reg = db.collection('ubicaciones');
    await reg.updateOne({ ambito: a, estanteria: e },
        { $setOnInsert: { ambito: a, estanteria: e, fecha_creacion: new Date() }, $set: { nfc_uid: norm(uid) || null, nfc_grabada: true } }, { upsert: true });
    return { ok: true };
}
