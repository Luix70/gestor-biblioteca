/**
 * RECLASIFICADOR del campo `editorial` de una SELECCIÓN de libros. Para arreglar en lote editoriales mal
 * puestas o ausentes (p. ej. libros cuya «editorial» es ePubLibre —un grupo de maquetación, no una casa—, o
 * libros sin editorial). Por cada libro busca la editorial correcta en CASCADA, minimizando IA/coste
 * ([[minimize-ai-ingestion]]): la IA (visión) es el ÚLTIMO recurso y va OPT-IN.
 *
 *   1) Fichero local (fichero.db)  ── por ISBN, offline, sin coste
 *   2) OpenLibrary                 ── por ISBN y luego texto (título/autor)
 *   3) Google Books               ── ídem
 *   4) IA (visión sobre la portada / imágenes) ── SOLO si usarIA=true y los anteriores no resolvieron
 *
 * DECISIÓN por libro (conservadora, anti-pérdida):
 *   · La cascada halla una editorial P distinta de la actual → se PROPONE el cambio (actual → P).
 *   · P coincide (normalizada) con la actual → sin cambio.
 *   · La cascada NO halla nada:
 *       – si la editorial actual es FALSA (ePubLibre/Lectulandia…) → se propone QUITARLA (queda sin editorial);
 *       – si la actual es una editorial real (o no tiene) → se DEJA como está (no se pierde nada) y se lista aparte.
 *
 * INFORME agregado por TRANSICIÓN (no un log por libro):
 *   { transiciones:[{de,a,n,fuentes[]}], eliminados:[{de,n}], sinCambio, noResueltos:[{_id,titulo,editorial}], … }
 *
 * DRY-RUN por defecto (aplicar=false): calcula y devuelve el informe SIN tocar la BD. Con aplicar=true resuelve
 * cada editorial destino a su ObjectId (reutiliza la existente por nombre/variante o crea una nueva) y aplica.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { DIR_CDU } from '../mantenimiento/util-mantenimiento.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEnGoogleBooks } from './buscador-google-books.js';
import { analizarImagenesRecurso } from '../agente.js';
import { validarISBN, variantesISBN } from './identificadores.js';
// «Editoriales» que en realidad son grupos de maquetación/difusión o re-editores de dominio público (no
// casas editoriales): si un libro tiene una de estas y no hallamos una real, se propone quitarla. Lista
// compartida — ver `utils/editoriales-falsas.js`.
import { esEditorialFalsa } from './editoriales-falsas.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

// Normaliza un nombre de editorial para COMPARAR (no para mostrar): minúsculas, sin acentos ni puntuación,
// espacios colapsados, y se quitan sufijos societarios comunes (S.A., Ltd, Inc, GmbH, & Sons…) que hacen que
// «John Wiley & Sons» y «Wiley» parezcan distintas.
const RE_DIACR = new RegExp('[\\u0300-\\u036f]', 'g');
function normEd(nombre) {
    let s = String(nombre || '').toLowerCase().normalize('NFD').replace(RE_DIACR, '');
    s = s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/\b(s a|s l|s a u|sa|sl|ltd|limited|inc|llc|gmbh|co|company|and sons|sons|editores|editorial|ediciones|publishers|publishing|press|verlag|group)\b/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

// Quita puntuación de los BORDES de un nombre de editorial (no interna: «John Wiley & Sons», «W. W. Norton»
// se conservan). Los volcados arrastran restos como «Planeta]», «Acantilado,», «[Destino», «Anagrama;».
function limpiarNombreEditorial(nombre) {
    return String(nombre || '')
        .replace(/^[\s.,;:·\-«»"'()\[\]]+/, '')
        .replace(/[\s.,;:·\-«»"'()\[\]]+$/, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// De la respuesta de un proveedor, saca un nombre de editorial LIMPIO (o null). Limpia los bordes, descarta
// las falsas (para que el proveedor no reintroduzca ePubLibre) y las cadenas vacías/absurdas.
function editorialDeProveedor(res) {
    if (!res) return null;
    const e = limpiarNombreEditorial(res.editorial);
    if (!e || e.length < 2 || esEditorialFalsa(e)) return null;
    return e;
}

// Lee del disco hasta `max` imágenes del documento (portada + carrusel) para la visión. Las rutas son web
// (/recursos/…) servidas desde DIR_CDU; se traducen a ruta de fichero. Devuelve [{data,mimeType}] (puede ir vacío).
async function imagenesDelDoc(doc, max = 3) {
    const rutasWeb = [];
    if (doc.portada) rutasWeb.push(doc.portada);
    for (const im of doc.imagenes || []) if (im?.ruta && !rutasWeb.includes(im.ruta)) rutasWeb.push(im.ruta);
    const out = [];
    for (const web of rutasWeb.slice(0, max)) {
        try {
            const rel = decodeURIComponent(String(web)).replace(/^\/recursos\//, '');
            const abs = path.join(DIR_CDU, rel);
            const data = await fs.readFile(abs);
            const ext = path.extname(abs).toLowerCase();
            const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
            out.push({ data, mimeType });
        } catch { /* imagen ausente/ilegible: se omite */ }
    }
    return out;
}

/**
 * Cascada de búsqueda de la editorial de un libro. Devuelve { editorial, fuente } o { editorial:null }.
 * `criterios` = { isbns, titulo, autor, idioma }. `usarIA` habilita el 4.º nivel (visión).
 */
async function buscarEditorialEnCascada(doc, criterios, usarIA) {
    // 1) Fichero local (offline, por ISBN).
    if (criterios.isbns.length) {
        try {
            const loc = await buscarEnFicheroLocal({ isbns: criterios.isbns });
            const e = editorialDeProveedor(loc);
            if (e) return { editorial: e, fuente: 'fichero' };
        } catch { /* fichero no disponible: se sigue */ }
    }
    // 2) OpenLibrary (ISBN → texto).
    try {
        const ol = await buscarPorCriterios({ ...criterios, incluirSinopsis: false });
        const e = editorialDeProveedor(ol);
        if (e) return { editorial: e, fuente: 'openlibrary' };
    } catch { /* red/OL: se sigue con el siguiente proveedor */ }
    // 3) Google Books (ISBN → texto).
    try {
        const gb = await buscarEnGoogleBooks(criterios);
        const e = editorialDeProveedor(gb);
        if (e) return { editorial: e, fuente: 'google' };
    } catch { /* red/GB: se sigue */ }
    // 4) IA (visión) — ÚLTIMO recurso, opt-in, con coste. Solo si lo anterior no resolvió.
    if (usarIA) {
        try {
            const imgs = await imagenesDelDoc(doc);
            if (imgs.length) {
                const visto = await analizarImagenesRecurso(imgs);
                const e = editorialDeProveedor(visto);
                if (e) return { editorial: e, fuente: 'ia' };
            }
        } catch { /* visión falló: se deja sin resolver */ }
    }
    return { editorial: null, fuente: null };
}

/**
 * CALCULA (dry-run) la reclasificación de `docIds`: hace la cascada por cada libro y agrega el informe por
 * transición. NO toca la BD. Devuelve el informe + un `plan` interno (para aplicarlo luego sin re-buscar, de
 * forma que «lo previsualizado == lo aplicado»). @param opciones { usarIA=false, alPaso?(hechos,total) }.
 */
export async function calcularReclasificacion(db, docIds, { usarIA = false, alPaso = null } = {}) {
    const bib = db.collection('biblioteca');
    const colEd = db.collection('editoriales');
    const colAut = db.collection('autores');

    const ids = [...new Set((Array.isArray(docIds) ? docIds : []).map(String))].map(oid).filter(Boolean);
    if (!ids.length) return { ok: false, motivo: 'no se indicaron documentos' };

    const docs = await bib.find(
        { _id: { $in: ids } },
        { projection: { titulo: 1, isbn: 1, isbn_propio: 1, isbn_candidatos: 1, idioma: 1, editorial: 1, autores: 1, portada: 1, imagenes: 1 } },
    ).toArray();

    // Cachés de nombres (id→nombre) para editoriales (mostrar la actual) y autores (mejorar la búsqueda por texto).
    const nombreEd = new Map();
    const edIds = [...new Set(docs.map((d) => d.editorial).filter(Boolean).map(String))].map(oid).filter(Boolean);
    if (edIds.length) for (const e of await colEd.find({ _id: { $in: edIds } }, { projection: { nombre: 1 } }).toArray()) nombreEd.set(String(e._id), e.nombre || '');
    const autIds = [...new Set(docs.flatMap((d) => (d.autores || []).slice(0, 1)).map(String))].map(oid).filter(Boolean);
    const nombreAut = new Map();
    if (autIds.length) for (const a of await colAut.find({ _id: { $in: autIds } }, { projection: { nombre: 1 } }).toArray()) nombreAut.set(String(a._id), a.nombre || '');

    // Acumuladores del informe.
    const transiciones = new Map(); // clave `de→a` → { de, a, n, fuentes:Set }
    const eliminados = new Map();   // clave `de`  → { de, n }
    const noResueltos = [];         // { _id, titulo, editorial }
    let sinCambio = 0;
    const plan = []; // { _id, accion:'set'|'unset', nombreDestino? } — se ejecuta después con aplicarReclasificacion

    let hechos = 0;
    for (const doc of docs) {
        const actualNombre = doc.editorial ? (nombreEd.get(String(doc.editorial)) || '') : '';
        const isbns = [...new Set([
            ...variantesISBN(validarISBN(doc.isbn_propio) || ''),
            ...variantesISBN(validarISBN(doc.isbn) || ''),
            ...(Array.isArray(doc.isbn_candidatos) ? doc.isbn_candidatos : []),
        ].filter(Boolean))];
        const autor = doc.autores && doc.autores.length ? (nombreAut.get(String(doc.autores[0])) || '') : '';
        const criterios = { isbns, titulo: doc.titulo || '', autor, idioma: doc.idioma || null };

        const { editorial: hallada, fuente } = await buscarEditorialEnCascada(doc, criterios, usarIA);

        if (hallada) {
            if (actualNombre && normEd(hallada) === normEd(actualNombre)) {
                sinCambio++;
            } else {
                const de = actualNombre || '(sin editorial)';
                const clave = de + ' → ' + hallada;
                if (!transiciones.has(clave)) transiciones.set(clave, { de, a: hallada, n: 0, fuentes: new Set() });
                const t = transiciones.get(clave);
                t.n++; t.fuentes.add(fuente);
                plan.push({ _id: doc._id, accion: 'set', nombreDestino: hallada });
            }
        } else if (actualNombre && esEditorialFalsa(actualNombre)) {
            // Editorial FALSA sin reemplazo → quitarla (el libro queda sin editorial, editable/reclasificable luego).
            if (!eliminados.has(actualNombre)) eliminados.set(actualNombre, { de: actualNombre, n: 0 });
            eliminados.get(actualNombre).n++;
            plan.push({ _id: doc._id, accion: 'unset' });
        } else {
            // Nada hallado y la actual es real (o no hay): se DEJA como está (anti-pérdida) y se lista aparte.
            noResueltos.push({ _id: String(doc._id), titulo: doc.titulo || '', editorial: actualNombre || '' });
        }
        hechos++;
        if (typeof alPaso === 'function') { try { alPaso(hechos, docs.length); } catch { /* no romper por el callback */ } }
    }

    return {
        ok: true,
        total: docs.length,
        cambios: plan.filter((p) => p.accion === 'set').length,
        eliminadosTotal: plan.filter((p) => p.accion === 'unset').length,
        sinCambio,
        transiciones: [...transiciones.values()].map((t) => ({ de: t.de, a: t.a, n: t.n, fuentes: [...t.fuentes] })).sort((a, b) => b.n - a.n),
        eliminados: [...eliminados.values()].sort((a, b) => b.n - a.n),
        noResueltos,
        usarIA: !!usarIA,
        plan, // interno: lo usa aplicarReclasificacion; el endpoint no lo devuelve al cliente
    };
}

/**
 * APLICA un `plan` calculado por calcularReclasificacion (rápido, solo BD, sin red): resuelve cada editorial
 * destino a su ObjectId (reutiliza la existente por nombre/variante, o crea una nueva) y actualiza los docs;
 * los 'unset' quitan la editorial. Devuelve { cambios, eliminadosTotal, creadas }.
 */
export async function aplicarReclasificacion(db, plan) {
    const bib = db.collection('biblioteca');
    const colEd = db.collection('editoriales');
    if (!Array.isArray(plan) || !plan.length) return { ok: true, cambios: 0, eliminadosTotal: 0, creadas: 0 };

    // Caché nombre normalizado → ObjectId (no crear duplicados dentro del mismo lote).
    const resueltas = new Map();
    let creadas = 0;
    const resolverEditorial = async (nombre) => {
        const clave = normEd(nombre);
        if (resueltas.has(clave)) return resueltas.get(clave);
        // Buscar una existente por nombre exacto (tolerante a mayúsculas) y afinar por normalización en memoria.
        const rxExacto = new RegExp('^' + String(nombre).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
        const cand = await colEd.find(
            { $or: [{ nombre: rxExacto }, { nombres_alternativos: rxExacto }] },
            { projection: { nombre: 1, nombres_alternativos: 1 } },
        ).limit(20).toArray();
        const elegida = cand.find((e) => normEd(e.nombre) === clave)
            || cand.find((e) => (e.nombres_alternativos || []).some((v) => normEd(v) === clave));
        let _id;
        if (elegida) _id = elegida._id;
        else { _id = (await colEd.insertOne({ nombre, fecha_creacion: new Date() })).insertedId; creadas++; }
        resueltas.set(clave, _id);
        return _id;
    };

    let cambios = 0, eliminadosTotal = 0;
    for (const p of plan) {
        const _id = oid(p._id);
        if (!_id) continue;
        if (p.accion === 'unset') {
            await bib.updateOne({ _id }, { $unset: { editorial: '' }, $set: { fecha_actualizacion: new Date() } });
            eliminadosTotal++;
        } else {
            const edId = await resolverEditorial(p.nombreDestino);
            await bib.updateOne({ _id }, { $set: { editorial: edId, fecha_actualizacion: new Date() } });
            cambios++;
        }
    }
    return { ok: true, cambios, eliminadosTotal, creadas };
}

// ── Job en 2º plano (la cascada hace llamadas de red por libro → un proxy podría cortar una petición larga).
//    El panel lanza el DRY-RUN, sondea el progreso y, con el informe a la vista, confirma para APLICAR. ─────
let _job = { activo: false, fase: 'inactivo', hechos: 0, total: 0, informe: null, plan: null, error: null, iniciado: null };

export function estadoReclasificacion() {
    // No se expone el `plan` (interno); sí el informe agregado y el progreso.
    const { plan, informe, ...resto } = _job;
    return { ...resto, informe: informe ? (({ plan: _p, ...rest }) => rest)(informe) : null };
}

export function lanzarReclasificacion(db, docIds, { usarIA = false } = {}) {
    if (_job.activo) return { ok: false, motivo: 'ya hay una reclasificación en curso' };
    const ids = Array.isArray(docIds) ? docIds : [];
    if (!ids.length) return { ok: false, motivo: 'no se indicaron documentos' };
    _job = { activo: true, fase: 'buscando', hechos: 0, total: ids.length, informe: null, plan: null, error: null, iniciado: new Date() };
    (async () => {
        try {
            const informe = await calcularReclasificacion(db, ids, { usarIA, alPaso: (h, t) => { _job.hechos = h; _job.total = t; } });
            _job.informe = informe;
            _job.plan = informe.plan || [];
            _job.fase = 'listo'; // dry-run terminado; esperando confirmación para aplicar
        } catch (e) {
            _job.error = e.message; _job.fase = 'error';
        } finally {
            _job.activo = false;
        }
    })();
    return { ok: true, lanzado: true };
}

/**
 * APLICA el plan del ÚLTIMO dry-run (el que el usuario acaba de revisar). Síncrono (solo BD, rápido). Guarda:
 * exige que haya un dry-run 'listo'. Devuelve el resultado de la aplicación.
 */
export async function aplicarUltimaReclasificacion(db) {
    if (_job.activo) return { ok: false, motivo: 'hay una reclasificación en curso' };
    if (_job.fase !== 'listo' || !Array.isArray(_job.plan)) return { ok: false, motivo: 'no hay una previsualización lista que aplicar' };
    const r = await aplicarReclasificacion(db, _job.plan);
    _job.fase = 'aplicado';
    _job.plan = null; // consumido: no re-aplicar
    return r;
}
