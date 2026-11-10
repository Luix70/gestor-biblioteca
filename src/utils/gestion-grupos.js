/**
 * Gestión MANUAL de grupos (colecciones / obras) para la fase de revisión humana — sin pérdida de datos:
 * solo cambian VÍNCULOS en Mongo (coleccion/obra de los documentos) y se borra el padre ABSTRACTO (que no
 * tiene ficheros propios). Los documentos miembros y sus ficheros NO se tocan.
 *
 *   fusionar*  — mueve los miembros de varios grupos a uno destino y borra los vacíos. (Obras: los tomos
 *                absorbidos se mudan además a la carpeta de la obra destino, con su CDU — ver fusionarObras.)
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
    const avisos = [];
    for (const obid of otras) {
        // Los títulos de la obra absorbida pasan a `titulos_alt` del destino: un tomo que llegue más tarde con
        // ese nombre se cuelga del destino en vez de recrear la obra que se acaba de fusionar.
        const absorbida = await obras.findOne({ _id: obid }, { projection: { titulo: 1, titulos_alt: 1 } });
        const alt = [absorbida?.titulo, ...(absorbida?.titulos_alt || [])].filter(x => x && x !== dest.titulo);
        if (alt.length) await obras.updateOne({ _id: dest._id }, { $addToSet: { titulos_alt: { $each: alt } } });
        for (const doc of await bib.find({ obra: obid }).toArray()) {
            const set = { obra: dest._id, obra_titulo: dest.titulo, fecha_actualizacion: new Date() };
            if (dest.isbn_obra) set.isbn_obra = dest.isbn_obra;
            const update = { $set: set };
            // Cada tomo absorbido se muda a la carpeta de la obra destino (la carpeta refleja la ficha): si no,
            // la obra queda unida en la base pero partida en dos ramas del árbol CDU.
            const mudanza = await mudarTomoAObra(db, doc, dest).catch((e) => ({ avisos: [`no se pudo mover su carpeta: ${e.message}`] }));
            Object.assign(set, mudanza.set || {});
            if (mudanza.avisos?.length) update.$push = { alertas_agente: { $each: mudanza.avisos } };
            await bib.updateOne({ _id: doc._id }, update);
            await registrarVolumenEnObra(db, dest._id, doc.volumen_numero ?? null, doc._id);
            if (mudanza.set?.ruta_base) {
                const { regenerarSidecarsDoc } = await import('./registro.js');
                const { carpetaDeDoc } = await import('../mantenimiento/util-mantenimiento.js');
                const nuevo = { ...doc, ...set };
                await regenerarSidecarsDoc(db, nuevo, carpetaDeDoc(nuevo)).catch(() => {});
            }
            avisos.push(...(mudanza.avisos || []).map((a) => `«${doc.titulo}»: ${a}`));
            movidos++;
        }
        await obras.deleteOne({ _id: obid });
    }
    // Inventario rehecho desde los tomos: si dos obras traían el mismo número, el segundo queda «sin número»
    // (revisión) en vez de pisar al primero en el inventario.
    if (otras.length) await reconstruirInventarioObra(db, dest._id);
    return { ok: true, movidos, fusionadas: otras.length, avisos, destino: { _id: String(dest._id), titulo: dest.titulo } };
}

/**
 * Muda la carpeta de un tomo a la carpeta de la obra `dest` («…/obras/<obra>/<vol-N>»), con la CDU de la obra
 * (todos los tomos comparten classmark). Devuelve `{ set, avisos }` con lo que hay que guardar en el tomo; no
 * escribe el documento. No mueve nada si: el tomo ya vive allí, la obra destino no tiene aún carpeta (ningún tomo
 * con «/obras/»), la carpeta del tomo no está en este disco, o el tomo tiene CDU manual distinta (decisión tuya).
 * Si en el destino ya hay una carpeta con ese nombre (otro tomo con el mismo número), usa «<nombre>-<id6>».
 */
async function mudarTomoAObra(db, doc, dest) {
    const { carpetaDeDoc, carpetaExiste, moverCarpetaConVerificacion } = await import('../mantenimiento/util-mantenimiento.js');
    const baseDe = (web) => { const m = String(web || '').match(/^(.*\/obras\/[^/]+)\//); return m ? m[1] : null; };
    const otro = await db.collection('biblioteca').findOne(
        { obra: dest._id, _id: { $ne: doc._id }, ruta_base: /\/obras\// }, { projection: { ruta_base: 1 } });
    const baseDestino = baseDe(otro?.ruta_base);
    if (!baseDestino || !doc.ruta_base || doc.ruta_base.startsWith(baseDestino + '/')) return { set: {}, avisos: [] };

    const cduObra = dest.cdu || null;
    if (doc.cdu_manual && cduObra && doc.cdu !== cduObra) {
        return { set: {}, avisos: [`unido a la obra «${dest.titulo}», pero su carpeta no se mueve: tiene CDU manual «${doc.cdu}» y la obra «${cduObra}».`] };
    }
    const origen = carpetaDeDoc(doc);
    if (!(await carpetaExiste(origen))) {
        return { set: {}, avisos: [`unido a la obra «${dest.titulo}»; su carpeta no está en este disco: no se mueve.`] };
    }

    let hoja = doc.ruta_base.split('/').pop();
    let rutaNueva = `${baseDestino}/${hoja}`;
    if (await carpetaExiste(carpetaDeDoc({ ruta_base: rutaNueva }))) {
        hoja = `${hoja}-${String(doc._id).slice(-6)}`;
        rutaNueva = `${baseDestino}/${hoja}`;
    }
    const destino = carpetaDeDoc({ ruta_base: rutaNueva });
    const ficheros = [doc.portada, ...(doc.imagenes || []).map((i) => i.ruta)].filter(Boolean).map((p) => p.split('/').pop());
    await moverCarpetaConVerificacion(origen, destino, ficheros);
    // La carpeta de la obra vieja queda vacía tras mudar su último tomo: rmdir solo borra un directorio VACÍO.
    const { rmdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    if (baseDe(doc.ruta_base)) await rmdir(dirname(origen)).catch(() => {});

    // Carpeta movida = ruta_base + portada + imágenes + textos/audios, juntos (si no, el carrusel se rompe).
    const vieja = doc.ruta_base;
    const remap = (p) => (p && p.startsWith(vieja + '/') ? rutaNueva + p.slice(vieja.length) : p);
    const remapLista = (l) => l.map((x) => ({ ...x, ruta: remap(x.ruta) }));
    const set = { ruta_base: rutaNueva };
    if (doc.portada) set.portada = remap(doc.portada);
    if (doc.imagenes?.length) set.imagenes = remapLista(doc.imagenes);
    if (doc.textos?.length) set.textos = remapLista(doc.textos);
    if (doc.audios?.length) set.audios = remapLista(doc.audios);
    const avisos = [`Unido a la obra «${dest.titulo}»: carpeta movida a «${rutaNueva}».`];
    if (cduObra && doc.cdu !== cduObra) {
        set.cdu = cduObra;
        avisos.push(`CDU «${doc.cdu}» → «${cduObra}», la de su obra.`);
    }
    return { set, avisos };
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
