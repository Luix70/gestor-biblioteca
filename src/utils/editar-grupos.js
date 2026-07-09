/**
 * Edición MANUAL de COLECCIONES (series/cabeceras) y OBRAS (multivolumen) desde su ficha. Campos comunes:
 * descripción/presentación, editorial (por nombre → ObjectId, check-then-create), CDU y las fechas de
 * publicación (inicio/fin: p. ej. una revista de 1920 a 1960, o de 1980 a la actualidad → fin vacío).
 * Específicos: la colección lleva ISSN (autoridad de la cabecera/serie) y la obra su ISBN de obra + total
 * de tomos. Identificadores validados por checksum (los malformados se descartan con aviso, no rompen nada).
 * No mueve ficheros: un cambio de CDU de la colección/obra es de metadatos (cada miembro conserva el suyo).
 */
import { ObjectId } from 'mongodb';
import { validarISBN, validarISSN } from './identificadores.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

async function resolverEditorial(db, nombre) {
    const t = String(nombre || '').trim();
    if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}

// Año de publicación (inicio/fin): entero 1000-2100, o null (vacío = «sin dato» / «hasta la actualidad»).
function anioValido(v) {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    return (n >= 1000 && n <= 2100) ? n : NaN;
}

// Campos COMUNES a colección y obra: descripción, editorial, CDU, fecha_inicio, fecha_fin.
async function aplicarComunes(db, campos, set, unset, avisos) {
    if ('descripcion' in campos) {
        const v = String(campos.descripcion || '').trim();
        if (v) set.descripcion = v; else unset.descripcion = '';
    }
    if ('cdu' in campos) {
        const v = String(campos.cdu || '').trim();
        if (v) { set.cdu = v; set.cdu_manual = true; } else unset.cdu = '';
    }
    if ('editorial' in campos) {
        const e = await resolverEditorial(db, campos.editorial);
        if (e) set.editorial = e; else unset.editorial = '';
    }
    for (const k of ['fecha_inicio', 'fecha_fin']) {
        if (!(k in campos)) continue;
        const a = anioValido(campos[k]);
        if (a === null) unset[k] = '';
        else if (Number.isNaN(a)) avisos.push(`${k === 'fecha_inicio' ? 'Año de inicio' : 'Año de fin'} inválido (ignorado)`);
        else set[k] = a;
    }
}

async function persistir(db, coleccion, _id, set, unset, avisos) {
    if (!Object.keys(set).length && !Object.keys(unset).length) return { ok: true, sinCambios: true, avisos };
    set.fecha_actualizacion = new Date();
    const upd = {};
    if (Object.keys(set).length) upd.$set = set;
    if (Object.keys(unset).length) upd.$unset = unset;
    try {
        const r = await db.collection(coleccion).updateOne({ _id }, upd);
        if (!r.matchedCount) return { ok: false, motivo: `${coleccion === 'obras' ? 'obra' : 'colección'} no encontrada` };
    } catch (e) {
        if (/duplicate key/i.test(e.message)) return { ok: false, motivo: 'Ya existe otra con ese nombre o ISSN' };
        throw e;
    }
    return { ok: true, avisos };
}

// Tipos de colección conmutables a mano desde la ficha. `transmedia`/`audiolibros` NO están: son
// ESTRUCTURALES (su árbol en disco con `ruta_fija` y la naturaleza de sus miembros dependen del tipo).
const TIPOS_COLECCION = ['libro', 'revista'];
const TIPOS_ESTRUCTURALES = ['transmedia', 'audiolibros'];

export async function editarColeccion(db, id, campos = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {}, avisos = [];
    if ('nombre' in campos && String(campos.nombre).trim()) set.nombre = String(campos.nombre).trim(); // requerido: nunca se borra
    if ('issn' in campos) {
        const v = String(campos.issn || '').trim();
        if (!v) unset.issn = '';
        else { const ok = validarISSN(v); if (ok) set.issn = ok; else avisos.push(`ISSN inválido (ignorado): ${v}`); }
    }
    // TIPO: 'libro' (serie editorial) ↔ 'revista' (cabecera, pivote ISSN). Es SEGURO cambiarlo: `tipo` no
    // participa en el emparejado de resolverCabecera (que va por ISSN → nombre → clave canónica), así que no
    // funde ni duplica cabeceras. Solo cambia el MODELO del grupo; el tipo_recurso de cada MIEMBRO se cambia
    // aparte con «🔀 Cambiar tipo» (ficha o lote del Catálogo). `null`/ausente = legado ⇒ se trata como libro.
    if ('tipo' in campos) {
        const actual = (await db.collection('colecciones').findOne({ _id }, { projection: { tipo: 1 } }))?.tipo || null;
        const v = String(campos.tipo || '').trim().toLowerCase();
        if (TIPOS_ESTRUCTURALES.includes(actual)) avisos.push(`El tipo «${actual}» es estructural: no se cambia desde la ficha.`);
        else if (TIPOS_COLECCION.includes(v)) { if (v !== actual) set.tipo = v; }
        else if (v) avisos.push(`Tipo no admitido (ignorado): ${v}`);
    }
    await aplicarComunes(db, campos, set, unset, avisos);
    return persistir(db, 'colecciones', _id, set, unset, avisos);
}

export async function editarObra(db, id, campos = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {}, avisos = [];
    if ('titulo' in campos && String(campos.titulo).trim()) set.titulo = String(campos.titulo).trim(); // requerido
    if ('isbn_obra' in campos) {
        const v = String(campos.isbn_obra || '').trim();
        if (!v) unset.isbn_obra = '';
        else { const ok = validarISBN(v); if (ok) set.isbn_obra = ok; else avisos.push(`ISBN inválido (ignorado): ${v}`); }
    }
    if ('total_volumenes' in campos) {
        if (campos.total_volumenes === '' || campos.total_volumenes == null) unset.total_volumenes = '';
        else { const v = parseInt(campos.total_volumenes, 10); if (Number.isFinite(v) && v > 0) set.total_volumenes = v; else avisos.push('Total de tomos inválido (ignorado)'); }
    }
    await aplicarComunes(db, campos, set, unset, avisos);
    return persistir(db, 'obras', _id, set, unset, avisos);
}
