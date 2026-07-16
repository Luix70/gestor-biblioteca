/**
 * Gestión MANUAL de grupos (colecciones / obras) para la fase de revisión humana — sin pérdida de datos:
 * solo cambian VÍNCULOS en Mongo (coleccion/obra de los documentos) y se borra el padre ABSTRACTO (que no
 * tiene ficheros propios). Los documentos miembros y sus ficheros NO se tocan.
 *
 *   fusionar*  — mueve los miembros de varios grupos a uno destino y borra los vacíos.
 *   explotar*  — libera los miembros como documentos sueltos (quita el vínculo) y borra el grupo.
 *   eliminar*Vacia — borra un grupo solo si no le quedan miembros.
 */
import { ObjectId } from 'mongodb';
import { claveNumero } from './revistas.js';
import { registrarNumeroEnColeccion } from './colecciones.js';
import { registrarVolumenEnObra, reconstruirInventarioObra } from './obras.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// ── COLECCIONES ───────────────────────────────────────────────────────────────
export async function fusionarColecciones(db, ids = [], destinoId) {
    const col = db.collection('colecciones'), bib = db.collection('biblioteca');
    const dest = oid(destinoId) && await col.findOne({ _id: oid(destinoId) });
    if (!dest) return { ok: false, motivo: 'colección destino no encontrada' };
    const otras = ids.map(oid).filter(x => x && String(x) !== String(dest._id));
    let movidos = 0;
    for (const cid of otras) {
        for (const doc of await bib.find({ coleccion: cid }).toArray()) {
            const set = { coleccion: dest._id, coleccion_nombre: dest.nombre, fecha_actualizacion: new Date() };
            if (dest.tipo === 'revista') { const cn = claveNumero(doc); if (cn) set.clave_numero = cn; }
            await bib.updateOne({ _id: doc._id }, { $set: set });
            if (dest.tipo === 'revista') await registrarNumeroEnColeccion(db, dest._id, {
                clave: set.clave_numero || null, 'año': doc.año_edicion ?? null, mes: doc.mes_publicacion ?? null, numero_issue: doc.numero_issue ?? null,
            }, doc._id);
            movidos++;
        }
        await col.deleteOne({ _id: cid });   // colección abstracta vacía → fuera
    }
    return { ok: true, movidos, fusionadas: otras.length, destino: { _id: String(dest._id), nombre: dest.nombre } };
}

export async function explotarColeccion(db, id) {
    const col = db.collection('colecciones'), bib = db.collection('biblioteca');
    const c = oid(id) && await col.findOne({ _id: oid(id) });
    if (!c) return { ok: false, motivo: 'colección no encontrada' };
    const r = await bib.updateMany({ coleccion: c._id }, { $unset: { coleccion: '', coleccion_nombre: '', clave_numero: '', coleccion_numero: '' }, $set: { fecha_actualizacion: new Date() } });
    await col.deleteOne({ _id: c._id });
    return { ok: true, liberados: r.modifiedCount, nombre: c.nombre };
}

export async function eliminarColeccionVacia(db, id) {
    const col = db.collection('colecciones'), bib = db.collection('biblioteca');
    if (!oid(id)) return { ok: false, motivo: 'id inválido' };
    const n = await bib.countDocuments({ coleccion: oid(id) });
    if (n > 0) return { ok: false, motivo: `tiene ${n} miembro(s): explótala o muévelos primero` };
    await col.deleteOne({ _id: oid(id) });
    return { ok: true };
}

// ── OBRAS ───────────────────────────────────────────────────────────────────
export async function fusionarObras(db, ids = [], destinoId) {
    const obras = db.collection('obras'), bib = db.collection('biblioteca');
    const dest = oid(destinoId) && await obras.findOne({ _id: oid(destinoId) });
    if (!dest) return { ok: false, motivo: 'obra destino no encontrada' };
    const otras = ids.map(oid).filter(x => x && String(x) !== String(dest._id));
    let movidos = 0;
    for (const obid of otras) {
        for (const doc of await bib.find({ obra: obid }).toArray()) {
            await bib.updateOne({ _id: doc._id }, { $set: { obra: dest._id, obra_titulo: dest.titulo, fecha_actualizacion: new Date() } });
            await registrarVolumenEnObra(db, dest._id, doc.volumen_numero ?? null, doc._id);
            movidos++;
        }
        await obras.deleteOne({ _id: obid });
    }
    return { ok: true, movidos, fusionadas: otras.length, destino: { _id: String(dest._id), titulo: dest.titulo } };
}

export async function explotarObra(db, id) {
    const obras = db.collection('obras'), bib = db.collection('biblioteca');
    const o = oid(id) && await obras.findOne({ _id: oid(id) });
    if (!o) return { ok: false, motivo: 'obra no encontrada' };
    const r = await bib.updateMany({ obra: o._id }, { $unset: { obra: '', obra_titulo: '', volumen_numero: '', volumen_titulo: '', isbn_obra: '' }, $set: { fecha_actualizacion: new Date() } });
    await obras.deleteOne({ _id: o._id });
    return { ok: true, liberados: r.modifiedCount, titulo: o.titulo };
}

/**
 * EXPULSAR documentos de su obra / colección (selección concreta, no el grupo entero como `explotar*`).
 * El documento NO se borra: queda suelto en el catálogo, con sus mismos ficheros. Se limpian SOLO los datos de
 * pertenencia (mismos campos que explotar*: en obra, también `volumen_numero`, que fuera de ella no significa
 * nada). Si el grupo se queda VACÍO se BORRA: una obra/colección sin miembros es un fantasma que solo estorba
 * en las estanterías y en los selectores.
 * @param tipo 'obra' | 'coleccion'
 */
export async function expulsarDeGrupo(db, tipo, ids = []) {
    const esObra = tipo === 'obra';
    const bib = db.collection('biblioteca');
    const grupos = db.collection(esObra ? 'obras' : 'colecciones');
    const campo = esObra ? 'obra' : 'coleccion';
    const limpiar = esObra
        ? { obra: '', obra_titulo: '', volumen_numero: '', volumen_titulo: '', isbn_obra: '' }
        : { coleccion: '', coleccion_nombre: '', clave_numero: '', coleccion_numero: '' };

    const docs = (await bib.find({ _id: { $in: ids.map(oid).filter(Boolean) } }, { projection: { [campo]: 1 } }).toArray());
    const afectados = [...new Set(docs.map(d => d[campo]).filter(Boolean).map(String))];
    if (!docs.length) return { ok: false, motivo: 'sin documentos válidos' };

    const r = await bib.updateMany({ _id: { $in: docs.map(d => d._id) } }, { $unset: limpiar, $set: { fecha_actualizacion: new Date() } });

    // Los grupos que se quedan sin miembros se borran; los que sobreviven, reconstruyen su inventario para que
    // no sigan listando tomos que ya no están.
    const vaciados = [];
    for (const g of afectados) {
        const quedan = await bib.countDocuments({ [campo]: oid(g) });
        if (quedan === 0) { await grupos.deleteOne({ _id: oid(g) }); vaciados.push(g); }
        else if (esObra) await reconstruirInventarioObra(db, oid(g)).catch(() => {});
    }
    return { ok: true, n: r.modifiedCount, vaciados: vaciados.length };
}

export async function eliminarObraVacia(db, id) {
    const obras = db.collection('obras'), bib = db.collection('biblioteca');
    if (!oid(id)) return { ok: false, motivo: 'id inválido' };
    const n = await bib.countDocuments({ obra: oid(id) });
    if (n > 0) return { ok: false, motivo: `tiene ${n} tomo(s): explótala o muévelos primero` };
    await obras.deleteOne({ _id: oid(id) });
    return { ok: true };
}
