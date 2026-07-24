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
import { decodificarImagen } from './imagen-base64.js';
import { ROLES_VALIDOS } from './contribuciones.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Escapa una cadena para incrustarla literal en una RegExp (búsqueda por nombre, tolerante a mayúsculas).
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Proyección pública de un autor (sin campos internos) para las listas y la ficha.
const PROY_AUTOR = {
    nombre: 1, nombres_alternativos: 1, nacimiento: 1, fallecimiento: 1, biografia: 1, foto: 1, fotos: 1,
};

// Recuento id→nº de libros. Con un rol de CONTRIBUCIÓN (traductor/…) cuenta libros EN ESE ROL; con 'autor'
// cuenta solo como autor principal; SIN rol cuenta la IMPLICACIÓN TOTAL (autor O contribuidor), contando cada
// DOCUMENTO una sola vez por persona (aunque sea autor Y traductor del mismo). Antes el total contaba solo
// «como autor», por lo que la lista/ficha decía «20» para alguien con 20 como autor + 19 como prologuista.
async function recuentoPorAutor(db, rol) {
    const rolContrib = rol && rol !== 'autor' && ROLES_VALIDOS.includes(rol);
    const soloAutor = rol === 'autor';
    const pipeline = rolContrib
        ? [{ $match: { 'contribuciones.rol': rol } }, { $unwind: '$contribuciones' },
            { $match: { 'contribuciones.rol': rol } }, { $group: { _id: '$contribuciones.persona', n: { $sum: 1 } } }]
        : soloAutor
        ? [{ $unwind: '$autores' }, { $group: { _id: '$autores', n: { $sum: 1 } } }]
        : [
            // TOTAL: por documento, la UNIÓN de sus autores y las personas de sus contribuciones (así un doc
            // cuenta una sola vez por persona), luego se agrupa por persona.
            { $project: { personas: { $setUnion: [
                { $ifNull: ['$autores', []] },
                { $map: { input: { $ifNull: ['$contribuciones', []] }, as: 'c', in: '$$c.persona' } },
            ] } } },
            { $unwind: '$personas' },
            { $group: { _id: '$personas', n: { $sum: 1 } } },
        ];
    const conteo = new Map();
    for (const f of await db.collection('biblioteca').aggregate(pipeline).toArray()) conteo.set(String(f._id), f.n);
    return conteo;
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
 *   · rol    — '' | 'autor' | 'traductor' | 'ilustrador' | 'prologuista' | 'anotador' | 'editor' |
 *              'compilador'. Con un rol de CONTRIBUCIÓN, lista a quienes intervienen en ese rol (n = nº de
 *              libros en ese rol). Con '' o 'autor', lista autores (n = nº de libros como autor).
 *   · orden  — 'libros' (por nº, desc; por defecto) | 'nombre' (alfabético).
 * SIN búsqueda ni rol muestra los autores QUE TIENEN LIBROS (los miles del volcado sin libros son ruido;
 * aparecen al buscarlos por nombre). foto/bio se aplican siempre.
 */
export async function listarAutores(db, { q = '', limite = 60, foto = '', bio = '', orden = 'libros', rol = '', minLibros = 0, sinLibros = false, pagina = 1 } = {}) {
    const porPagina = Math.min(200, Math.max(1, Number(limite) || 60)); // autores por página
    const pag = Math.max(1, Number(pagina) || 1);
    const MAX_ESCANEO = 5000; // tope de autores a puntuar (para el recuento y la paginación)
    const min = Math.max(0, Number(minLibros) || 0); // ≥ N obras (en el rol filtrado). 0 = no filtra.
    const consulta = String(q || '').trim();
    const rolContrib = rol && rol !== 'autor' && ROLES_VALIDOS.includes(rol);
    const and = [condicionCampo('foto', foto), condicionCampo('biografia', bio)].filter(Boolean);
    const rx = consulta ? new RegExp(escapeRegex(consulta), 'i') : null;
    const vacio = { autores: [], total: 0, pagina: pag, porPagina, capado: false };

    // Recuento base (como autor, o en el rol pedido). Es también el conjunto de candidatos por defecto.
    const conteo = await recuentoPorAutor(db, rol);

    // Conjunto de autores a devolver:
    //  · con ROL de contribución → los que intervienen en ese rol (+ q/foto/bio);
    //  · con q y sin rol → búsqueda por nombre en TODA la colección (aunque tengan 0 libros) (+ foto/bio);
    //  · sin q y sin rol → los que tienen libros como autor (+ foto/bio).
    const filtro = {};
    // Restringir a autores CON libros solo cuando NO se piden los «sin libros» y (rol de contribución o sin q).
    if (!sinLibros && (rolContrib || !consulta)) {
        const ids = [...conteo.keys()].map(oid).filter(Boolean);
        if (!ids.length) return vacio;
        filtro._id = { $in: ids };
    }
    if (rx) filtro.$or = [{ nombre: rx }, { nombres_alternativos: rx }];
    if (and.length) filtro.$and = and;

    // Se escanea hasta MAX_ESCANEO (los «sin libros»/búsqueda global pueden ser miles del volcado): se puntúa
    // n_libros, se filtra y se ORDENA todo el conjunto, y luego se pagina en memoria devolviendo el TOTAL.
    const docs = await db.collection('autores').find(filtro, { projection: PROY_AUTOR }).limit(MAX_ESCANEO).toArray();

    let autores = docs.map((a) => ({ ...a, _id: String(a._id), n_libros: conteo.get(String(a._id)) || 0 }));
    if (sinLibros) autores = autores.filter((a) => a.n_libros === 0);       // SOLO los que no tienen libros
    else if (min > 0) autores = autores.filter((a) => a.n_libros >= min);   // filtro «≥ N obras»
    if (orden === 'nombre') {
        autores.sort((x, y) => String(x.nombre || '').localeCompare(String(y.nombre || '')));
    } else {
        autores.sort((x, y) => y.n_libros - x.n_libros || String(x.nombre || '').localeCompare(String(y.nombre || '')));
    }
    const total = autores.length;
    const inicio = (pag - 1) * porPagina;
    return {
        autores: autores.slice(inicio, inicio + porPagina),
        total, pagina: pag, porPagina,
        capado: docs.length >= MAX_ESCANEO, // el recuento puede quedarse corto (se escaneó el tope)
    };
}

/**
 * Borra autores POR ID, pero SOLO los que no figuran en NINGÚN documento (ni como autor ni como
 * contribuyente) — salvaguarda anti-pérdida: los que sigan referenciados se CONSERVAN. Devuelve el
 * recuento de borrados/conservados. (No recicla la foto: es un fichero pequeño; se limpia en Integridad.)
 */
// ¿Hemos INVERTIDO algo en este autor que no queramos perder aunque se quede sin libros? Datos biográficos
// (biografía, fechas de nacimiento/fallecimiento) o una FOTO. Si no hay nada de eso, es ruido del volcado o una
// mención mal parseada, y se puede borrar (se recreará solo si entra un libro que lo cite). Grafías alternativas
// NO cuentan como inversión: son un residuo de fusiones, no información obtenida sobre la persona.
export function autorTieneInversion(a) {
    return !!(
        (a?.biografia && String(a.biografia).trim()) ||
        (a?.foto && String(a.foto).trim()) ||
        (Array.isArray(a?.fotos) && a.fotos.length) ||
        a?.nacimiento || a?.fallecimiento
    );
}

/**
 * Borra los autores indicados que estén HUÉRFANOS (no figuran en ningún documento), SALVO los que tengan
 * inversión (bio/foto/fechas → autorTieneInversion), que se conservan. Devuelve el desglose por categoría.
 */
export async function eliminarAutoresVacios(db, ids = []) {
    const objs = (Array.isArray(ids) ? ids : []).map(oid).filter(Boolean);
    if (!objs.length) return { ok: false, motivo: 'sin autores' };
    let borrados = 0, conObras = 0, conInversion = 0;
    for (const _id of objs) {
        const usadoAutor = await db.collection('biblioteca').countDocuments({ autores: _id }, { limit: 1 });
        const usadoContrib = usadoAutor ? 1 : await db.collection('biblioteca').countDocuments({ 'contribuciones.persona': _id }, { limit: 1 });
        if (usadoAutor || usadoContrib) { conObras++; continue; }             // tiene libros → se conserva
        const autor = await db.collection('autores').findOne({ _id }, { projection: { biografia: 1, foto: 1, fotos: 1, nacimiento: 1, fallecimiento: 1 } });
        if (autorTieneInversion(autor)) { conInversion++; continue; }          // sin libros pero con datos → se conserva
        await db.collection('autores').deleteOne({ _id });
        borrados++;
    }
    // `conservados` = total conservados (retrocompatible con la UI); se detallan las dos causas.
    return { ok: true, borrados, conservados: conObras + conInversion, conObras, conInversion };
}

/**
 * Todas las imágenes (portada + carrusel) de las OBRAS en las que interviene este autor (como autor o
 * contribuyente) — para elegir una como foto del autor (p. ej. una foto suya del interior del libro).
 */
export async function imagenesDeObras(db, id) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const docs = await db.collection('biblioteca')
        .find({ $or: [{ autores: _id }, { 'contribuciones.persona': _id }] }, { projection: { titulo: 1, portada: 1, imagenes: 1 } })
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
 * Ficha de un autor: sus datos + los libros en los que interviene (como AUTOR y como CONTRIBUYENTE, con el
 * rol correspondiente) + la lista de roles que desempeña. Cada libro lleva `rol` ('autor' | traductor | …);
 * si aparece como autor Y como contribuyente del mismo libro, gana 'autor'. Devuelve null si no existe.
 */
export async function fichaAutor(db, id) {
    const _id = oid(id);
    if (!_id) return null;
    const autor = await db.collection('autores').findOne({ _id }, { projection: PROY_AUTOR });
    if (!autor) return null;
    // `formatos` → distinguir papel de electrónico; `nfc.fecha_vinculacion` → badge; `naturaleza` → cómic.
    const PROY = { titulo: 1, portada: 1, 'año_edicion': 1, cdu: 1, tipo_recurso: 1, naturaleza: 1, nsfw: 1, formatos: 1, 'nfc.fecha_vinculacion': 1, contribuciones: 1 };

    // Convierte un doc de biblioteca en el item mínimo de la ficha (con el rol de esta persona en él).
    //   · papel = tiene el formato 'papel' (libro físico escaneado); si no, es electrónico (epub/pdf/…).
    //   · comic = es cómic/novela gráfica (naturaleza).   · nfc = ya tiene una etiqueta NFC grabada.
    const aItem = (l, rol) => ({
        _id: String(l._id), titulo: l.titulo, portada: l.portada, 'año_edicion': l['año_edicion'],
        cdu: l.cdu, tipo_recurso: l.tipo_recurso, nsfw: l.nsfw,
        formatos: l.formatos || [], papel: (l.formatos || []).includes('papel'),
        comic: ['comic', 'novela-grafica', 'tebeo', 'historieta', 'manga'].includes(String(l.naturaleza || '').toLowerCase()),
        nfc: !!(l.nfc && l.nfc.fecha_vinculacion), rol,
    });

    // Libros como AUTOR + libros donde figura en CONTRIBUCIONES (traductor/ilustrador/…).
    const [comoAutor, comoContrib] = await Promise.all([
        db.collection('biblioteca').find({ autores: _id }, { projection: PROY }).sort({ 'año_edicion': 1, titulo: 1 }).toArray(),
        db.collection('biblioteca').find({ 'contribuciones.persona': _id }, { projection: PROY }).sort({ 'año_edicion': 1, titulo: 1 }).toArray(),
    ]);

    const porId = new Map();
    for (const l of comoAutor) porId.set(String(l._id), aItem(l, 'autor'));
    for (const l of comoContrib) {
        const k = String(l._id);
        if (porId.has(k)) continue; // ya está como autor (gana 'autor')
        const rol = (l.contribuciones || []).find((c) => String(c.persona) === String(_id))?.rol || 'contribuyente';
        porId.set(k, aItem(l, rol));
    }
    const libros = [...porId.values()];
    const roles = [...new Set(libros.map((l) => l.rol))]; // roles que desempeña esta persona

    return {
        autor: { ...autor, _id: String(autor._id) },
        libros,
        roles,
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

/**
 * QUITA un autor de documentos: lo saca del array `autores[]` y de `contribuciones[]` (si era colaborador)
 * de los documentos indicados (`ids`), o de TODOS los suyos si no se pasan. Un documento puede quedar SIN
 * autor (válido: revistas, anónimos…). Si el autor deja de estar en NINGÚN documento, se BORRA (nunca se
 * borra un autor con obras). Devuelve { quitados, restantes, autorBorrado }.
 */
export async function quitarAutorDeDocs(db, autorId, ids = null) {
    const aid = oid(autorId);
    if (!aid) return { ok: false, motivo: 'id de autor inválido' };
    const bib = db.collection('biblioteca');
    const refDelAutor = { $or: [{ autores: aid }, { 'contribuciones.persona': aid }] };
    const match = (Array.isArray(ids) && ids.length)
        ? { $and: [{ _id: { $in: ids.map(oid).filter(Boolean) } }, refDelAutor] }
        : refDelAutor;
    const r = await bib.updateMany(match, {
        $pull: { autores: aid, contribuciones: { persona: aid } },
        $set: { fecha_actualizacion: new Date() },
    });
    // ¿Sigue referenciado por algún documento? Si no, se borra (nunca con obras).
    const restantes = await bib.countDocuments(refDelAutor);
    let autorBorrado = false;
    if (restantes === 0) { await db.collection('autores').deleteOne({ _id: aid }); autorBorrado = true; }
    return { ok: true, quitados: r.modifiedCount, restantes, autorBorrado };
}

/**
 * CAMBIA EL ROL de una persona en unos documentos: p. ej. de «autor» a «prologuista». El modelo tiene el
 * autor principal en `autores[]` (solo ObjectId) y los roles secundarios en `contribuciones[{persona,rol}]`,
 * así que cambiar el rol NO es un simple $set: es MOVER la persona de un sitio a otro.
 *   · destino 'autor'  → se añade a `autores[]` y se quita de `contribuciones[]`.
 *   · destino <rol>    → se quita de `autores[]` (si estaba) y entra en `contribuciones[]` con ese rol.
 * Solo se tocan los documentos donde la persona interviene HOY (como autor o en cualquier rol). No duplica
 * (autores[] con $addToSet; contribuciones se reconstruye sin la persona y se le añade la entrada nueva).
 * @param rolDestino  uno de ROLES_VALIDOS.
 * @param ids         documentos concretos; null/[] = TODOS los del autor (como quitarAutorDeDocs).
 */
export async function cambiarRolEnDocs(db, personaId, rolDestino, ids = null) {
    const pid = oid(personaId);
    if (!pid) return { ok: false, motivo: 'id de persona inválido' };
    if (!ROLES_VALIDOS.includes(rolDestino)) return { ok: false, motivo: `rol no válido: ${rolDestino}` };
    const bib = db.collection('biblioteca');
    const refPersona = { $or: [{ autores: pid }, { 'contribuciones.persona': pid }] };
    const filtroIds = (Array.isArray(ids) && ids.length) ? { _id: { $in: ids.map(oid).filter(Boolean) } } : null;
    const match = filtroIds ? { $and: [filtroIds, refPersona] } : refPersona;

    // Se procesa documento a documento porque contribuciones[] hay que RECONSTRUIRLA (quitar la persona de
    // cualquier rol y volver a añadirla en el nuevo) — no se puede con un solo updateMany atómico.
    const docs = await bib.find(match, { projection: { autores: 1, contribuciones: 1 } }).toArray();
    let cambiados = 0;
    for (const d of docs) {
        const enAutores = (d.autores || []).some((a) => String(a) === String(pid));
        // contribuciones SIN esta persona (se re-crea su entrada abajo con el rol destino).
        const contribs = (d.contribuciones || []).filter((c) => String(c.persona) !== String(pid));
        const yaCorrecto = rolDestino === 'autor'
            ? (enAutores && (d.contribuciones || []).every((c) => String(c.persona) !== String(pid)))
            : (!enAutores && (d.contribuciones || []).some((c) => String(c.persona) === String(pid) && c.rol === rolDestino));
        if (yaCorrecto) continue;

        const upd = { $set: { fecha_actualizacion: new Date() } };
        if (rolDestino === 'autor') {
            upd.$addToSet = { autores: pid };
            upd.$set.contribuciones = contribs;                       // la quita de contribuciones
        } else {
            upd.$set.contribuciones = [...contribs, { persona: pid, rol: rolDestino }];
            if (enAutores) upd.$pull = { autores: pid };              // deja de ser autor principal
        }
        await bib.updateOne({ _id: d._id }, upd);
        cambiados++;
    }
    return { ok: true, cambiados, total: docs.length, rol: rolDestino };
}

/**
 * REASIGNA la autoría de unos DOCUMENTOS de un autor a OTRO (para «enviar los seleccionados a otro autor»):
 * en cada doc de `docIds` reemplaza `viejoId` por `nuevoId` en `autores[]` y en `contribuciones[]` (mismo
 * rol, sin duplicar). El autor viejo se CONSERVA si le quedan otros libros; si se queda sin ninguno, se
 * BORRA. Devuelve { reasignados, restantes, autorBorrado }.
 */
export async function reasignarDocsAAutor(db, docIds, viejoId, nuevoId) {
    const viejo = oid(viejoId), nuevo = oid(nuevoId);
    if (!viejo || !nuevo) return { ok: false, motivo: 'ids inválidos' };
    if (String(viejo) === String(nuevo)) return { ok: false, motivo: 'el autor de destino es el mismo' };
    const bib = db.collection('biblioteca');
    const ids = (Array.isArray(docIds) ? docIds : []).map(oid).filter(Boolean);
    if (!ids.length) return { ok: false, motivo: 'no se indicaron documentos' };
    let n = 0;
    for (const did of ids) {
        const doc = await bib.findOne({ _id: did }, { projection: { autores: 1, contribuciones: 1 } });
        if (!doc) continue;
        const set = {};
        // autores[]: viejo → nuevo, dedup.
        if ((doc.autores || []).some(a => String(a) === String(viejo))) {
            const vistos = new Set(), nuevos = [];
            for (const a of doc.autores || []) { const rep = String(a) === String(viejo) ? nuevo : a; if (!vistos.has(String(rep))) { vistos.add(String(rep)); nuevos.push(rep); } }
            set.autores = nuevos;
        }
        // contribuciones[]: persona viejo → nuevo (mismo rol), dedup por (persona,rol).
        if ((doc.contribuciones || []).some(c => c && String(c.persona) === String(viejo))) {
            const vistos = new Set(), nuevas = [];
            for (const c of doc.contribuciones || []) {
                const rep = String(c.persona) === String(viejo) ? nuevo : c.persona;
                const k = String(rep) + '|' + c.rol;
                if (!vistos.has(k)) { vistos.add(k); nuevas.push({ persona: rep, rol: c.rol }); }
            }
            set.contribuciones = nuevas;
        }
        if (Object.keys(set).length) { set.fecha_actualizacion = new Date(); await bib.updateOne({ _id: did }, { $set: set }); n++; }
    }
    const restantes = await bib.countDocuments({ $or: [{ autores: viejo }, { 'contribuciones.persona': viejo }] });
    let autorBorrado = false;
    if (restantes === 0) { await db.collection('autores').deleteOne({ _id: viejo }); autorBorrado = true; }
    return { ok: true, reasignados: n, restantes, autorBorrado };
}

// decodificarImagen se movió a utils/imagen-base64.js (la comparten la foto de autor y el logo de editorial).

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
