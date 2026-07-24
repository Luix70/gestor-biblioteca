/**
 * ASIGNACIÓN EN LOTE de metadatos a una SELECCIÓN de documentos del catálogo. Cada operación reutiliza la
 * MISMA maquinaria que la edición de UN documento —resolverPersona (nombre→ObjectId, insensible a mayúsculas/
 * acentos, crea si es nuevo), editarDocumento (que ya reubica la carpeta al cambiar la CDU)— para no tener una
 * segunda implementación que pueda divergir (el fallo recurrente de este proyecto).
 *
 * SEMÁNTICA (elegida a conciencia):
 *   · autor y contribuidor → ADITIVOS ($addToSet): en un lote NUNCA se pisa la autoría existente (sería
 *     destructivo sin querer). Un libro sin autor recibe el nuevo; uno que ya tenía autor gana un coautor.
 *     Para quitar/cambiar rol están las acciones de la página de Autores.
 *   · editorial → REEMPLAZA: un documento tiene UNA editorial.
 *   · cdu → REEMPLAZA + REUBICA la carpeta (vía editarDocumento) y marca cdu_manual (el Conformador no la pisa).
 */
import { ObjectId } from 'mongodb';
import { resolverPersona } from './resolver-persona.js';
import { editarDocumento } from './editar-doc.js';
import { indexarDoc } from './indice-busqueda.js';
import { ROLES_VALIDOS } from './contribuciones.js';

const oid = (x) => (ObjectId.isValid(String(x)) ? new ObjectId(String(x)) : null);
const oids = (ids) => (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);

/** Resuelve una persona por id (si viene de un selector y existe) o por nombre (resolverPersona: crea si es nuevo). */
async function resolverPersonaFlex(db, { persona, personaId } = {}) {
    if (personaId && oid(personaId)) {
        const ex = await db.collection('autores').findOne({ _id: oid(personaId) }, { projection: { _id: 1 } });
        if (ex) return ex._id;
    }
    const nombre = String(persona || '').trim();
    if (!nombre) return null;
    return resolverPersona(db, nombre);
}

/** Resuelve una editorial por id, o por nombre con match INSENSIBLE a mayúsculas/acentos (evita duplicar «Cambridge»/«cambridge»). */
async function resolverEditorialFlex(db, { editorial, editorialId } = {}) {
    if (editorialId && oid(editorialId)) {
        const ex = await db.collection('editoriales').findOne({ _id: oid(editorialId) }, { projection: { _id: 1 } });
        if (ex) return ex._id;
    }
    const nombre = String(editorial || '').trim();
    if (!nombre) return null;
    const ex = await db.collection('editoriales').findOne({ nombre }, { collation: { locale: 'es', strength: 1 } });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

const reindexar = async (db, lista) => { for (const id of lista) await indexarDoc(db, id).catch(() => {}); };

/** AÑADE a `persona` como AUTOR de cada documento (aditivo; no duplica). */
export async function asignarAutorLote(db, ids, params) {
    const pid = await resolverPersonaFlex(db, params);
    if (!pid) return { ok: false, motivo: 'indica un autor (nombre)' };
    const lista = oids(ids);
    if (!lista.length) return { ok: false, motivo: 'no hay documentos seleccionados' };
    const r = await db.collection('biblioteca').updateMany({ _id: { $in: lista } },
        { $addToSet: { autores: pid }, $set: { fecha_actualizacion: new Date() } });
    await reindexar(db, lista);
    return { ok: true, aplicados: r.modifiedCount, persona: String(pid) };
}

/** AÑADE a `persona` como CONTRIBUIDOR con `rol` (traductor/ilustrador/prologuista…) en cada documento (aditivo; no duplica). */
export async function asignarContribuidorLote(db, ids, params) {
    const rol = String(params?.rol || '');
    if (rol === 'autor') return { ok: false, motivo: 'para el rol «autor» usa Asignar autor' };
    if (!ROLES_VALIDOS.includes(rol)) return { ok: false, motivo: `rol no válido: ${rol}` };
    const pid = await resolverPersonaFlex(db, params);
    if (!pid) return { ok: false, motivo: 'indica una persona (nombre)' };
    const lista = oids(ids);
    if (!lista.length) return { ok: false, motivo: 'no hay documentos seleccionados' };
    // $addToSet con el objeto exacto {persona,rol} deduplica la MISMA persona en el MISMO rol.
    const r = await db.collection('biblioteca').updateMany({ _id: { $in: lista } },
        { $addToSet: { contribuciones: { persona: pid, rol } }, $set: { fecha_actualizacion: new Date() } });
    await reindexar(db, lista);
    return { ok: true, aplicados: r.modifiedCount, rol };
}

/** FIJA la editorial de cada documento (reemplaza: un doc tiene una editorial). */
export async function asignarEditorialLote(db, ids, params) {
    const eid = await resolverEditorialFlex(db, params);
    if (!eid) return { ok: false, motivo: 'indica una editorial (nombre)' };
    const lista = oids(ids);
    if (!lista.length) return { ok: false, motivo: 'no hay documentos seleccionados' };
    const r = await db.collection('biblioteca').updateMany({ _id: { $in: lista } },
        { $set: { editorial: eid, fecha_actualizacion: new Date() } });
    await reindexar(db, lista);
    return { ok: true, aplicados: r.modifiedCount, editorial: String(eid) };
}

/**
 * FIJA la CDU de cada documento y REUBICA su carpeta. Se hace documento a documento con editarDocumento porque
 * la reubicación implica mover ficheros y remapear ruta_base/portada/imágenes: es la misma cirugía que la
 * edición manual, no un simple $set. Marca cdu_manual (el Conformador no la vuelve a calcular).
 */
export async function asignarCduLote(db, ids, cdu) {
    const c = String(cdu || '').trim();
    if (!c) return { ok: false, motivo: 'indica una CDU' };
    const lista = (Array.isArray(ids) ? ids : []).map((x) => String(x)).filter((x) => ObjectId.isValid(x));
    if (!lista.length) return { ok: false, motivo: 'no hay documentos seleccionados' };
    let aplicados = 0, fallidos = 0, reubicadas = 0;
    const errores = [];
    for (const id of lista) {
        try {
            const r = await editarDocumento(db, id, { cdu: c });
            if (r.ok) {
                aplicados++;
                if ((r.avisos || []).some((a) => /CDU →|movidos|reubic/i.test(a))) reubicadas++;
            } else { fallidos++; if (r.motivo) errores.push(r.motivo); }
        } catch (e) { fallidos++; errores.push(e.message); }
    }
    return { ok: true, aplicados, fallidos, reubicadas, errores: errores.slice(0, 3) };
}
