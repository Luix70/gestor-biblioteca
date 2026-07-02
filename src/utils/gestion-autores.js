/**
 * Gestión de la colección `autores` para la página «Autores» del panel (buscar · ficha · editar · fusionar
 * · foto). Sin pérdida de datos: FUSIONAR mueve las referencias de `biblioteca.autores` al autor destino,
 * conserva las grafías absorbidas en `nombres_alternativos` y borra los autores ya vacíos (es la versión
 * INTERACTIVA de lo que hace por lotes `scripts/backfill-autores.js`).
 *
 * La colección `autores` NO tiene validador $jsonSchema (es laxa): campos usados aquí →
 *   { nombre, nombres_alternativos?: string[], nacimiento?: number, fallecimiento?: number,
 *     biografia?: string, foto?: string (ruta /recursos/…), fotos?: string[] }
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { DIR_CDU } from '../mantenimiento/util-mantenimiento.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Escapa una cadena para incrustarla literal en una RegExp (búsqueda por nombre, tolerante a mayúsculas).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Proyección pública de un autor (sin campos internos) para las listas y la ficha.
const PROY_AUTOR = {
    nombre: 1, nombres_alternativos: 1, nacimiento: 1, fallecimiento: 1, biografia: 1, foto: 1, fotos: 1,
};

// Nº de documentos que referencian a cada autor de una lista de ids (una sola agregación → Map id→n).
async function conteosDeLibros(db, ids) {
    const conteos = new Map();
    if (!ids.length) return conteos;
    const filas = await db.collection('biblioteca').aggregate([
        { $match: { autores: { $in: ids } } },
        { $unwind: '$autores' },
        { $match: { autores: { $in: ids } } },
        { $group: { _id: '$autores', n: { $sum: 1 } } },
    ]).toArray();
    for (const f of filas) conteos.set(String(f._id), f.n);
    return conteos;
}

// Sub-filtros «tiene / no tiene» un campo de texto (foto, biografia), para los selectores del panel.
// valor: 'si' = presente y no vacío · 'no' = ausente/nulo/vacío · '' = no filtra.
function condicionCampo(campo, valor) {
    if (valor === 'si') return { [campo]: { $exists: true, $nin: [null, ''] } };
    if (valor === 'no') return { $or: [{ [campo]: { $exists: false } }, { [campo]: null }, { [campo]: '' }] };
    return null;
}

/**
 * Lista/busca autores con el nº de libros de cada uno. Parámetros opcionales:
 *   · q      — texto (nombre o grafía alternativa, tolerante a mayúsculas).
 *   · foto   — 'si' | 'no' | '' : con / sin foto.
 *   · bio    — 'si' | 'no' | '' : con / sin biografía.
 *   · orden  — 'libros' (por nº de obras, desc; por defecto) | 'nombre' (alfabético).
 * SIN búsqueda muestra los autores QUE TIENEN LIBROS (los miles de nombres del volcado sin libros son
 * ruido aquí; aparecen al buscarlos por nombre). Los filtros foto/bio se aplican en ambos casos.
 */
export async function listarAutores(db, { q = '', limite = 300, foto = '', bio = '', orden = 'libros' } = {}) {
    const tope = Math.min(1000, Math.max(1, limite));
    const consulta = String(q || '').trim();
    const and = [condicionCampo('foto', foto), condicionCampo('biografia', bio)].filter(Boolean);

    let autores;
    if (consulta) {
        // Búsqueda por texto sobre el nombre o las grafías alternativas (+ filtros foto/bio).
        const rx = new RegExp(escapeRegex(consulta), 'i');
        const filtro = { $or: [{ nombre: rx }, { nombres_alternativos: rx }] };
        if (and.length) filtro.$and = and;
        const docs = await db.collection('autores').find(filtro, { projection: PROY_AUTOR }).limit(tope * 2).toArray();
        const conteos = await conteosDeLibros(db, docs.map((a) => a._id));
        autores = docs.map((a) => ({ ...a, _id: String(a._id), n_libros: conteos.get(String(a._id)) || 0 }));
    } else {
        // Autores realmente usados (con libros) + filtros foto/bio.
        const usados = await db.collection('biblioteca')
            .aggregate([{ $unwind: '$autores' }, { $group: { _id: '$autores', n: { $sum: 1 } } }]).toArray();
        const conteo = new Map(usados.map((u) => [String(u._id), u.n]));
        const ids = usados.map((u) => u._id).filter(Boolean);
        if (!ids.length) return [];
        const filtro = { _id: { $in: ids } };
        if (and.length) filtro.$and = and;
        const docs = await db.collection('autores').find(filtro, { projection: PROY_AUTOR }).toArray();
        autores = docs.map((a) => ({ ...a, _id: String(a._id), n_libros: conteo.get(String(a._id)) || 0 }));
    }

    if (orden === 'nombre') {
        autores.sort((x, y) => String(x.nombre || '').localeCompare(String(y.nombre || '')));
    } else {
        autores.sort((x, y) => y.n_libros - x.n_libros || String(x.nombre || '').localeCompare(String(y.nombre || '')));
    }
    return autores.slice(0, tope);
}

/**
 * Ficha de un autor: sus datos + los libros en los que interviene (los que lo tienen en `autores`),
 * ordenados por año y título. Devuelve null si no existe.
 */
export async function fichaAutor(db, id) {
    const _id = oid(id);
    if (!_id) return null;
    const autor = await db.collection('autores').findOne({ _id }, { projection: PROY_AUTOR });
    if (!autor) return null;
    const libros = await db.collection('biblioteca')
        .find({ autores: _id }, { projection: { titulo: 1, portada: 1, 'año_edicion': 1, cdu: 1, tipo_recurso: 1, nsfw: 1 } })
        .sort({ 'año_edicion': 1, titulo: 1 })
        .toArray();
    return {
        autor: { ...autor, _id: String(autor._id) },
        libros: libros.map((l) => ({ ...l, _id: String(l._id) })),
    };
}

/**
 * Edita los datos biográficos de un autor. Un campo vacío se BORRA (`$unset`) para no dejar nulos sueltos.
 * `nombres_alternativos` llega como array (ya troceado en el cliente); se limpia y deduplica, y nunca
 * incluye el propio nombre principal.
 */
export async function editarAutor(db, id, cambios = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const autor = await db.collection('autores').findOne({ _id });
    if (!autor) return { ok: false, motivo: 'autor no encontrado' };

    const set = { fecha_actualizacion: new Date() };
    const unset = {};

    if ('nombre' in cambios) {
        const n = String(cambios.nombre || '').trim();
        if (n) set.nombre = n; // el nombre principal no se borra: si viene vacío, se ignora
    }
    if ('biografia' in cambios) {
        const b = String(cambios.biografia || '').trim();
        if (b) set.biografia = b; else unset.biografia = '';
    }
    for (const campo of ['nacimiento', 'fallecimiento']) {
        if (campo in cambios) {
            const v = parseInt(cambios[campo], 10);
            if (Number.isFinite(v)) set[campo] = v; else unset[campo] = '';
        }
    }
    if ('nombres_alternativos' in cambios) {
        const nombrePrincipal = (set.nombre || autor.nombre || '').trim();
        const alt = [...new Set(
            (Array.isArray(cambios.nombres_alternativos) ? cambios.nombres_alternativos : [])
                .map((s) => String(s || '').trim())
                .filter((s) => s && s !== nombrePrincipal),
        )];
        if (alt.length) set.nombres_alternativos = alt; else unset.nombres_alternativos = '';
    }

    const upd = { $set: set };
    if (Object.keys(unset).length) upd.$unset = unset;
    await db.collection('autores').updateOne({ _id }, upd);
    return { ok: true };
}

/**
 * FUSIONA varios autores en uno destino (B): dirección A→B. Conserva el nombre de B; los nombres de las
 * A (y sus grafías alternativas) pasan a `nombres_alternativos` de B; se rellenan huecos de B (fechas/bio/
 * foto) con lo que tengan las A; TODOS los documentos de las A se reasignan a B (deduplicando el array
 * `autores`); y se borran las A. Idempotente y sin pérdida (los libros y sus ficheros no se tocan).
 */
export async function fusionarAutores(db, destinoId, ids = []) {
    const colAutores = db.collection('autores');
    const colBiblio = db.collection('biblioteca');

    const destino = oid(destinoId) && await colAutores.findOne({ _id: oid(destinoId) });
    if (!destino) return { ok: false, motivo: 'autor destino no encontrado' };

    // Autores a absorber = los indicados, menos el destino (no se absorbe a sí mismo).
    const absorbidosIds = [...new Set(ids.map(String))]
        .map(oid)
        .filter((x) => x && String(x) !== String(destino._id));
    if (!absorbidosIds.length) return { ok: false, motivo: 'no hay otros autores que fusionar' };

    const absorbidos = await colAutores.find({ _id: { $in: absorbidosIds } }).toArray();
    if (!absorbidos.length) return { ok: false, motivo: 'los autores a fusionar no existen' };

    // Reunir grafías alternativas (nombre de cada A + sus alternativos + los que ya tuviera B), sin el nombre de B.
    const alt = new Set(destino.nombres_alternativos || []);
    let nacimiento = destino.nacimiento || null;
    let fallecimiento = destino.fallecimiento || null;
    let biografia = destino.biografia || null;
    let foto = destino.foto || null;
    const fotos = new Set(destino.fotos || []);
    for (const a of absorbidos) {
        if (a.nombre) alt.add(a.nombre);
        (a.nombres_alternativos || []).forEach((x) => alt.add(x));
        if (!nacimiento && a.nacimiento) nacimiento = a.nacimiento;
        if (!fallecimiento && a.fallecimiento) fallecimiento = a.fallecimiento;
        if (!biografia && a.biografia) biografia = a.biografia;
        if (!foto && a.foto) foto = a.foto;
        (a.fotos || []).forEach((x) => fotos.add(x));
    }
    alt.delete(destino.nombre);
    alt.delete('');

    // Actualizar el destino con lo reunido.
    const set = { fecha_actualizacion: new Date() };
    if (alt.size) set.nombres_alternativos = [...alt].sort();
    if (nacimiento) set.nacimiento = nacimiento;
    if (fallecimiento) set.fallecimiento = fallecimiento;
    if (biografia) set.biografia = biografia;
    if (foto) set.foto = foto;
    if (fotos.size) set.fotos = [...fotos];
    await colAutores.updateOne({ _id: destino._id }, { $set: set });

    // Reasignar en biblioteca: cada doc que referencie a una A pasa a referenciar a B (dedup del array).
    const absorbedSet = new Set(absorbidosIds.map(String));
    const docs = await colBiblio.find({ autores: { $in: absorbidosIds } }, { projection: { autores: 1 } }).toArray();
    let reasignados = 0;
    for (const doc of docs) {
        const nuevos = [];
        const visto = new Set();
        for (const aid of doc.autores || []) {
            const rep = absorbedSet.has(String(aid)) ? destino._id : aid;
            const k = String(rep);
            if (!visto.has(k)) { visto.add(k); nuevos.push(rep); }
        }
        await colBiblio.updateOne({ _id: doc._id }, { $set: { autores: nuevos, fecha_actualizacion: new Date() } });
        reasignados++;
    }

    // Borrar las A (ya sin referencias).
    await colAutores.deleteMany({ _id: { $in: absorbidosIds } });

    return {
        ok: true,
        destino: { _id: String(destino._id), nombre: destino.nombre },
        fusionados: absorbidos.length,
        reasignados,
        alternativos: set.nombres_alternativos || destino.nombres_alternativos || [],
    };
}

// data URL o base64 puro → { buf, ext } (jpg|png|webp) o null. (Mismo criterio que utils/imagenes-doc.js.)
const MAX_FOTO_BYTES = 12 * 1024 * 1024;
function decodificarImagen(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    const m = b64.match(/^data:image\/(jpe?g|png|webp);base64,(.+)$/i);
    const data = m ? m[2] : b64.replace(/^data:[^,]*,/, '');
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { return null; }
    if (!buf.length || buf.length > MAX_FOTO_BYTES) return null;
    const t = m ? m[1].toLowerCase() : 'jpeg';
    return { buf, ext: t === 'png' ? 'png' : t === 'webp' ? 'webp' : 'jpg' };
}

/**
 * Guarda una foto (base64) del autor bajo `CDU/_autores/<id>/` (servido por /recursos), la marca como
 * foto principal y la añade a `fotos[]`. Devuelve la ruta web de la foto.
 */
export async function guardarFotoAutor(db, id, base64) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const autor = await db.collection('autores').findOne({ _id });
    if (!autor) return { ok: false, motivo: 'autor no encontrado' };
    const d = decodificarImagen(base64);
    if (!d) return { ok: false, motivo: 'imagen inválida (jpg/png/webp, máx. 12 MB)' };

    const carpeta = path.join(DIR_CDU, '_autores', String(_id));
    await fs.mkdir(carpeta, { recursive: true });
    const nombre = `foto-${Date.now()}.${d.ext}`;
    await fs.writeFile(path.join(carpeta, nombre), d.buf);
    const web = `/recursos/_autores/${_id}/${nombre}`;

    const fotos = [...new Set([...(autor.fotos || []), web])];
    await db.collection('autores').updateOne(
        { _id },
        { $set: { foto: web, fotos, fecha_actualizacion: new Date() } },
    );
    return { ok: true, foto: web, fotos };
}
