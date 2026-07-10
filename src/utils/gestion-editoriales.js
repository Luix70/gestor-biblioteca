/**
 * Gestión de la colección `editoriales` para la página «Editoriales» del panel (buscar · ficha · editar ·
 * logo · fusionar · borrar). GEMELA de `gestion-autores.js`, pero la editorial es un ObjectId ÚNICO por
 * documento (`biblioteca.editorial`), no un array. Sin pérdida: FUSIONAR mueve las referencias
 * `biblioteca.editorial` a la editorial destino, conserva los nombres absorbidos en `nombres_alternativos`
 * y borra las editoriales ya vacías. BORRAR solo elimina una editorial SIN libros.
 *
 * La colección `editoriales` NO tiene validador $jsonSchema (por eso estos campos son aditivos y no hace
 * falta tocar setup-mongo). Campos usados aquí →
 *   { nombre, nombres_alternativos?: string[],
 *     logo?: string (ruta /recursos/…), logos?: string[],      ← subido o elegido de un libro suyo
 *     descripcion?: string,                                     ← historia / notas
 *     fecha_fundacion?: number, fecha_disolucion?: number,      ← años (vacío = sin dato / sigue activa)
 *     ciudad?: string, pais?: string }                          ← sede
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { DIR_CDU } from '../mantenimiento/util-mantenimiento.js';
import { decodificarImagen } from './imagen-base64.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Escapa una cadena para incrustarla literal en una RegExp (búsqueda por nombre, tolerante a mayúsculas).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Ficha: todos los datos. Listado: solo lo que pinta la tarjeta (la `descripcion` puede ser larga).
const PROY_EDITORIAL = {
    nombre: 1, nombres_alternativos: 1, logo: 1, logos: 1,
    descripcion: 1, fecha_fundacion: 1, fecha_disolucion: 1, ciudad: 1, pais: 1,
};
const PROY_EDITORIAL_LISTA = {
    nombre: 1, nombres_alternativos: 1, logo: 1,
    fecha_fundacion: 1, fecha_disolucion: 1, ciudad: 1, pais: 1,
};

// Año (fundación / disolución): entero 1000-2100, o null (vacío = «sin dato» / «sigue activa»). Mismo criterio
// que `fecha_inicio`/`fecha_fin` de colecciones y obras (utils/editar-grupos.js · anioValido).
function anioValido(v) {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    return (n >= 1000 && n <= 2100) ? n : NaN;
}

// Recuento id→nº de libros por editorial (campo único `biblioteca.editorial`).
async function recuentoPorEditorial(db) {
    const pipeline = [{ $match: { editorial: { $ne: null } } }, { $group: { _id: '$editorial', n: { $sum: 1 } } }];
    const conteo = new Map();
    for (const f of await db.collection('biblioteca').aggregate(pipeline).toArray()) conteo.set(String(f._id), f.n);
    return conteo;
}

/**
 * Lista/busca editoriales con el nº de libros de cada una. Parámetros opcionales:
 *   · q     — texto (nombre o grafía alternativa, tolerante a mayúsculas).
 *   · orden — 'libros' (por nº, desc; por defecto) | 'nombre' (alfabético).
 * SIN búsqueda muestra las editoriales QUE TIENEN LIBROS (las del volcado sin libros son ruido; aparecen al
 * buscarlas por nombre).
 */
export async function listarEditoriales(db, { q = '', limite = 300, orden = 'libros' } = {}) {
    const tope = Math.min(1000, Math.max(1, limite));
    const consulta = String(q || '').trim();
    const rx = consulta ? new RegExp(escapeRegex(consulta), 'i') : null;

    const conteo = await recuentoPorEditorial(db);

    // Sin q → solo las que tienen libros. Con q → búsqueda por nombre en TODA la colección (aunque tengan 0).
    const filtro = {};
    if (!consulta) {
        const ids = [...conteo.keys()].map(oid).filter(Boolean);
        if (!ids.length) return [];
        filtro._id = { $in: ids };
    }
    if (rx) filtro.$or = [{ nombre: rx }, { nombres_alternativos: rx }];

    const cur = db.collection('editoriales').find(filtro, { projection: PROY_EDITORIAL_LISTA });
    if (consulta) cur.limit(tope * 2); // búsqueda global: acota antes de puntuar
    const docs = await cur.toArray();

    const editoriales = docs.map((e) => ({ ...e, _id: String(e._id), n_libros: conteo.get(String(e._id)) || 0 }));
    if (orden === 'nombre') {
        editoriales.sort((x, y) => String(x.nombre || '').localeCompare(String(y.nombre || '')));
    } else {
        editoriales.sort((x, y) => y.n_libros - x.n_libros || String(x.nombre || '').localeCompare(String(y.nombre || '')));
    }
    return editoriales.slice(0, tope);
}

/**
 * Ficha de una editorial: sus datos + los libros que publica (docs cuyo `editorial` == su `_id`).
 * Devuelve null si no existe.
 */
export async function fichaEditorial(db, id) {
    const _id = oid(id);
    if (!_id) return null;
    const editorial = await db.collection('editoriales').findOne({ _id }, { projection: PROY_EDITORIAL });
    if (!editorial) return null;

    const PROY = { titulo: 1, portada: 1, 'año_edicion': 1, cdu: 1, tipo_recurso: 1, naturaleza: 1, nsfw: 1, formatos: 1, 'nfc.fecha_vinculacion': 1 };
    const docs = await db.collection('biblioteca')
        .find({ editorial: _id }, { projection: PROY }).sort({ 'año_edicion': 1, titulo: 1 }).toArray();

    const libros = docs.map((l) => ({
        _id: String(l._id), titulo: l.titulo, portada: l.portada, 'año_edicion': l['año_edicion'],
        cdu: l.cdu, tipo_recurso: l.tipo_recurso, nsfw: l.nsfw,
        formatos: l.formatos || [], papel: (l.formatos || []).includes('papel'),
        comic: ['comic', 'novela-grafica', 'tebeo', 'historieta', 'manga'].includes(String(l.naturaleza || '').toLowerCase()),
        nfc: !!(l.nfc && l.nfc.fecha_vinculacion),
    }));

    return { editorial: { ...editorial, _id: String(editorial._id) }, libros };
}

/**
 * Edita una editorial: nombre (no se borra si viene vacío) + `nombres_alternativos` (array ya troceado en el
 * cliente; se limpia, deduplica y nunca incluye el propio nombre principal).
 */
export async function editarEditorial(db, id, cambios = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const editorial = await db.collection('editoriales').findOne({ _id });
    if (!editorial) return { ok: false, motivo: 'editorial no encontrada' };

    const set = { fecha_actualizacion: new Date() };
    const unset = {};

    if ('nombre' in cambios) {
        const n = String(cambios.nombre || '').trim();
        if (n) set.nombre = n; // el nombre principal no se borra
    }
    if ('nombres_alternativos' in cambios) {
        const nombrePrincipal = (set.nombre || editorial.nombre || '').trim();
        const alt = [...new Set(
            (Array.isArray(cambios.nombres_alternativos) ? cambios.nombres_alternativos : [])
                .map((s) => String(s || '').trim())
                .filter((s) => s && s !== nombrePrincipal),
        )];
        if (alt.length) set.nombres_alternativos = alt; else unset.nombres_alternativos = '';
    }

    // Campos de TEXTO libres (vacío = se borra el campo).
    const avisos = [];
    for (const k of ['descripcion', 'ciudad', 'pais']) {
        if (!(k in cambios)) continue;
        const v = String(cambios[k] ?? '').trim();
        if (v) set[k] = v; else unset[k] = '';
    }
    // AÑOS de fundación / disolución. Vacío = sin dato (disolución vacía ⇒ sigue activa).
    for (const k of ['fecha_fundacion', 'fecha_disolucion']) {
        if (!(k in cambios)) continue;
        const a = anioValido(cambios[k]);
        if (a === null) unset[k] = '';
        else if (Number.isNaN(a)) avisos.push(`${k === 'fecha_fundacion' ? 'Año de fundación' : 'Año de disolución'} inválido (ignorado)`);
        else set[k] = a;
    }
    // Coherencia: una editorial no se disuelve antes de fundarse (se avisa, no se corrige).
    const fu = set.fecha_fundacion ?? editorial.fecha_fundacion;
    const di = set.fecha_disolucion ?? editorial.fecha_disolucion;
    if (fu && di && di < fu) avisos.push(`La disolución (${di}) es anterior a la fundación (${fu}).`);

    const upd = { $set: set };
    if (Object.keys(unset).length) upd.$unset = unset;
    await db.collection('editoriales').updateOne({ _id }, upd);
    return { ok: true, avisos };
}

/**
 * Guarda el LOGO (base64) de una editorial bajo `CDU/_editoriales/<id>/` (servido por /recursos), lo marca
 * como logo principal y lo acumula en `logos[]` (así se puede volver a uno anterior). Gemelo de
 * `guardarFotoAutor`. Nunca borra el anterior: solo cambia cuál es el principal.
 */
export async function guardarLogoEditorial(db, id, base64) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const editorial = await db.collection('editoriales').findOne({ _id });
    if (!editorial) return { ok: false, motivo: 'editorial no encontrada' };
    const d = decodificarImagen(base64);
    if (!d) return { ok: false, motivo: 'imagen inválida (jpg/png/webp, máx. 12 MB)' };

    const carpeta = path.join(DIR_CDU, '_editoriales', String(_id));
    await fs.mkdir(carpeta, { recursive: true });
    const nombre = `logo-${Date.now()}.${d.ext}`;
    await fs.writeFile(path.join(carpeta, nombre), d.buf);
    const web = `/recursos/_editoriales/${_id}/${nombre}`;

    const logos = [...new Set([...(editorial.logos || []), web])];
    await db.collection('editoriales').updateOne({ _id }, { $set: { logo: web, logos, fecha_actualizacion: new Date() } });
    return { ok: true, logo: web, logos };
}

/**
 * Imágenes disponibles en los LIBROS de esta editorial (portada + carrusel), para elegir una como logo y
 * recortarla luego en el editor de imágenes. Gemelo de `imagenesDeObras` (autores).
 */
export async function imagenesDeLibros(db, id) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const docs = await db.collection('biblioteca')
        .find({ editorial: _id }, { projection: { titulo: 1, portada: 1, imagenes: 1 } })
        .limit(200)
        .toArray();
    const obras = [];
    for (const d of docs) {
        const imgs = [];
        if (d.portada) imgs.push(d.portada);
        for (const im of (d.imagenes || [])) if (im?.ruta && !imgs.includes(im.ruta)) imgs.push(im.ruta);
        if (imgs.length) obras.push({ doc_id: String(d._id), titulo: d.titulo || '', imagenes: imgs });
    }
    return { ok: true, obras };
}

/**
 * FUSIONA varias editoriales en una destino (B): dirección A→B. Conserva el nombre de B; los nombres de las
 * A (y sus grafías alternativas) pasan a `nombres_alternativos` de B; TODOS los documentos de las A pasan a
 * referenciar a B (`biblioteca.editorial` es un campo único → simple $set); y se borran las A. Sin pérdida.
 */
export async function fusionarEditoriales(db, destinoId, ids = []) {
    const colEd = db.collection('editoriales');
    const colBiblio = db.collection('biblioteca');

    const destino = oid(destinoId) && await colEd.findOne({ _id: oid(destinoId) });
    if (!destino) return { ok: false, motivo: 'editorial destino no encontrada' };

    const absorbidosIds = [...new Set(ids.map(String))]
        .map(oid)
        .filter((x) => x && String(x) !== String(destino._id));
    if (!absorbidosIds.length) return { ok: false, motivo: 'no hay otras editoriales que fusionar' };

    const absorbidas = await colEd.find({ _id: { $in: absorbidosIds } }).toArray();
    if (!absorbidas.length) return { ok: false, motivo: 'las editoriales a fusionar no existen' };

    // Reunir grafías alternativas (nombre de cada A + sus alternativos + los que ya tuviera B), sin el nombre de B.
    const alt = new Set(destino.nombres_alternativos || []);
    for (const e of absorbidas) {
        if (e.nombre) alt.add(e.nombre);
        (e.nombres_alternativos || []).forEach((x) => alt.add(x));
    }
    alt.delete(destino.nombre);
    alt.delete('');

    const set = { fecha_actualizacion: new Date() };
    if (alt.size) set.nombres_alternativos = [...alt].sort();
    await colEd.updateOne({ _id: destino._id }, { $set: set });

    // Reasignar en biblioteca: editorial (campo único) A → B.
    const r = await colBiblio.updateMany(
        { editorial: { $in: absorbidosIds } },
        { $set: { editorial: destino._id, fecha_actualizacion: new Date() } },
    );

    // Borrar las A (ya sin referencias).
    await colEd.deleteMany({ _id: { $in: absorbidosIds } });

    return {
        ok: true,
        destino: { _id: String(destino._id), nombre: destino.nombre },
        fusionadas: absorbidas.length,
        reasignados: r.modifiedCount,
        alternativos: set.nombres_alternativos || destino.nombres_alternativos || [],
    };
}

/**
 * BORRA una editorial SOLO si no tiene libros (nunca se borra una editorial con obras). Para depurar
 * editoriales-fantasma (ePubLibre/Lectulandia u otras que quedaron sin uso tras una fusión/corrección).
 * Devuelve { ok, borrada, libros } — si tiene libros, ok:false con el conteo.
 */
export async function borrarEditorial(db, id) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const libros = await db.collection('biblioteca').countDocuments({ editorial: _id });
    if (libros > 0) return { ok: false, motivo: `tiene ${libros} libro(s); reasígnalos o fusiónala antes`, libros };
    const r = await db.collection('editoriales').deleteOne({ _id });
    return { ok: true, borrada: r.deletedCount === 1, libros: 0 };
}
