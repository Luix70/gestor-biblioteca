/**
 * Edición MANUAL de un documento desde la ficha (fase de revisión humana). Lista BLANCA de campos; resuelve
 * autores/editorial por NOMBRE (check-then-create), valida ISBN/ISSN (descarta los malformados para no
 * romper el $jsonSchema) y nunca borra el título (campo requerido). El flag `locked` protege el documento
 * del Conformador. No mueve ficheros (un cambio de CDU re-aloja luego con el Conformador/sanear).
 */
import { ObjectId } from 'mongodb';
import { validarISBN, validarISSN } from './identificadores.js';

const TEXTO = ['subtitulo', 'idioma', 'numero_edicion', 'cdu', 'dewey', 'lcc', 'lccn', 'sinopsis', 'obra_titulo'];
const NUM = ['año_edicion', 'paginas', 'volumen_numero'];

async function resolverAutores(db, nombres) {
    const out = [];
    for (const n of nombres) {
        const t = String(n).trim(); if (!t) continue;
        const ex = await db.collection('autores').findOne({ nombre: t });
        out.push(ex ? ex._id : (await db.collection('autores').insertOne({ nombre: t })).insertedId);
    }
    return out;
}
async function resolverEditorial(db, nombre) {
    const t = String(nombre || '').trim(); if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}

export async function editarDocumento(db, id, campos = {}) {
    if (!ObjectId.isValid(id)) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {};
    const avisos = [];

    // Título: requerido por el esquema → solo se actualiza si viene NO vacío (nunca se borra).
    if ('titulo' in campos && String(campos.titulo).trim()) set.titulo = String(campos.titulo).trim();

    for (const k of TEXTO) {
        if (!(k in campos)) continue;
        const v = String(campos[k] ?? '').trim();
        if (v) set[k] = v; else unset[k] = '';
    }
    for (const k of NUM) {
        if (!(k in campos)) continue;
        const raw = campos[k];
        if (raw === '' || raw == null) { unset[k] = ''; continue; }
        const v = parseInt(raw, 10);
        if (Number.isFinite(v)) set[k] = v; else unset[k] = '';
    }

    // Identificadores: validar checksum; si es inválido, NO se guarda (aviso) para no violar el esquema.
    if ('isbn' in campos) {
        const v = String(campos.isbn || '').trim();
        if (!v) unset.isbn = '';
        else { const ok = validarISBN(v); if (ok) set.isbn = ok; else avisos.push(`ISBN inválido (ignorado): ${v}`); }
    }
    if ('issn' in campos) {
        const v = String(campos.issn || '').trim();
        if (!v) unset.issn = '';
        else { const ok = validarISSN(v); if (ok) set.issn = ok; else avisos.push(`ISSN inválido (ignorado): ${v}`); }
    }

    if ('autores' in campos) {
        const arr = (Array.isArray(campos.autores) ? campos.autores : String(campos.autores || '').split(',')).map(s => s.trim()).filter(Boolean);
        if (arr.length) set.autores = await resolverAutores(db, arr); else unset.autores = '';
    }
    if ('editorial' in campos) {
        const e = await resolverEditorial(db, campos.editorial);
        if (e) set.editorial = e; else unset.editorial = '';
    }
    if ('palabras_clave' in campos) {
        const arr = (Array.isArray(campos.palabras_clave) ? campos.palabras_clave : String(campos.palabras_clave || '').split(',')).map(s => s.trim()).filter(Boolean);
        if (arr.length) set.palabras_clave = arr; else unset.palabras_clave = '';
    }
    if (campos.ubicacion) {
        set.ubicacion = {
            ambito: String(campos.ubicacion.ambito || '').trim() || 'Sin asignar',
            estanteria: String(campos.ubicacion.estanteria || '').trim() || 'Sin asignar',
        };
    }
    if ('locked' in campos) set.locked = !!campos.locked;
    if ('estado_verificacion' in campos && ['pendiente', 'completado'].includes(campos.estado_verificacion)) set.estado_verificacion = campos.estado_verificacion;

    if (!Object.keys(set).length && !Object.keys(unset).length) return { ok: true, sinCambios: true, avisos };
    set.fecha_actualizacion = new Date();
    const upd = {};
    if (Object.keys(set).length) upd.$set = set;
    if (Object.keys(unset).length) upd.$unset = unset;
    const r = await db.collection('biblioteca').updateOne({ _id: new ObjectId(id) }, upd);
    if (!r.matchedCount) return { ok: false, motivo: 'documento no encontrado' };
    return { ok: true, avisos };
}
