/**
 * UNIR CAPÍTULOS — varios documentos del catálogo que son CAPÍTULOS de un mismo libro (se colaron uno a uno en la
 * ingesta) pasan a ser UN documento: un solo PDF cosido en orden de lectura, con índice de capítulos, y los
 * capítulos originales como adjunto («Capítulos/»). Dos casos medidos el 4-nov:
 *   · «Theory of Machines»: Ch-0 Index … chp-26 catalogados como OBRA de 27 «tomos» (una guía «obra» del agente).
 *   · «Elements of Photonics»: V1CH1, V1CH2, V1CH8, V2CH9… sueltos en una carpeta de materia, cada uno como un
 *     LIBRO con el ISBN de su tomo (la página de créditos de Wiley viaja en cada capítulo).
 *
 * Dos piezas:
 *   · `coCapitulosDe(db, doc)`: los documentos que PARECEN co-capítulos de `doc`, con sus razones (misma obra,
 *     mismo ISBN, mismo título, misma familia de nombres —«V1CH1»/«V1CH8», «Ch-05»/«ch.24»—, ingeridos a la vez) y
 *     siempre PEQUEÑOS (un capítulo tiene decenas de páginas, no cientos). Solo propone: decides tú.
 *   · `unirCapitulos(db, ids)`: cose los elegidos. El PRINCIPAL (el más completo) se queda con el PDF entero y los
 *     datos de todos (huecos rellenados, autores y palabras clave unidos, la mejor CDU por prioridad); los demás se
 *     retiran como en «Fusionar versiones»: su ficha entera queda en `documentos_fusionados`, sus selecciones y
 *     fichas de lectura pasan al principal y su id redirige a él. Los hashes de los capítulos quedan en
 *     `hashes_anteriores`, así que un capítulo que vuelva a entrar por el Inbox se reconoce y no se cataloga.
 *
 * ANTI-PÉRDIDA: nada se borra. Los capítulos se MUEVEN a «Capítulos/» del principal (copia verificada entre
 * volúmenes) y las carpetas vaciadas van a la Papelera. Si el cosido falla, no se toca nada.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal, recolocarSegunCdu, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { unirPdfs, paginasPdf } from './qpdf.js';
import { ordenarPartesLibro } from './libro-desglosado.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { reciclarCarpeta } from './papelera.js';
import { indexarDoc, desindexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';
import { validarISBN, isbn10a13 } from './identificadores.js';
import { mejorCdu, fuenteCduDoc, aplicarCduConPrioridad } from './prioridad-cdu.js';
import { otroDocEnCarpeta } from './carpeta-en-uso.js';
import { reconstruirInventarioObra } from './obras.js';

// ── Señales ────────────────────────────────────────────────────────────────────────────────────────────

const isbnComparable = (v) => { const x = v ? validarISBN(v) : null; return x ? (isbn10a13(x) || x) : null; };
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Un capítulo tiene decenas de páginas; un libro, cientos. Sin páginas, el tamaño del fichero (≈ 3 MB).
const MAX_PAGS_CAPITULO = 150;
const MAX_BYTES_CAPITULO = 6 * 1048576;
// Ingeridos «a la vez»: la misma pasada del Vigilante sobre la misma carpeta.
const VENTANA_INGESTA_MS = 3 * 3600 * 1000;

function esPequeno(d) {
    if (d.paginas) return d.paginas <= MAX_PAGS_CAPITULO;
    if (d.hash_tamano) return d.hash_tamano <= MAX_BYTES_CAPITULO;
    return false;
}

/** El título del LIBRO que lleva un capítulo: sin el «— Vol. 27: chp-26» que le puso la obra. */
function tituloDelLibro(d) {
    return String(d.obra_titulo || d.titulo || '').replace(/\s+—\s+Vol\.\s*\d+.*$/i, '').trim();
}

/**
 * FAMILIA del nombre de un capítulo: lo que queda de su marca numerada al quitar los dígitos. «V1CH1-Fourier
 * Optics…» → «vch»; «Ch-05 simple mechanisms» y «ch.24» → «ch»; «chp-26» → «chp» (se acepta como «ch»). Un nombre
 * sin marca numerada al principio no tiene familia: un título cualquiera no hace a nadie co-capítulo.
 */
export function familiaDeNombre(nombre) {
    const base = path.basename(String(nombre || ''), path.extname(String(nombre || ''))).toLowerCase();
    const m = base.match(/^([a-z]{0,6}\d{0,3}[a-z]{0,6})[ _.-]*\d{1,3}(?!\d)/);
    if (!m) return null;
    const familia = m[1].replace(/\d+/g, '').replace(/^(chp|chap|chapter|cap|capitulo)$/, 'ch');
    return familia || null;
}

/** Nº de capítulo del nombre («V2CH16-…» → 16, «ch.24» → 24, «Ch-0 Index» → 0); null si no lo lleva. */
function numeroDeNombre(nombre) {
    const base = path.basename(String(nombre || ''), path.extname(String(nombre || '')));
    const m = base.match(/^[a-z]{0,6}\d{0,3}[a-z]{0,6}[ _.-]*(\d{1,3})(?!\d)/i);
    return m ? Number(m[1]) : null;
}

const PROY = {
    titulo: 1, obra_titulo: 1, obra: 1, volumen_numero: 1, isbn: 1, nombre_archivo: 1, paginas: 1, hash_tamano: 1,
    fecha_ingreso: 1, tipo_recurso: 1, formatos: 1, portada: 1, ruta_base: 1,
};

/**
 * Los documentos que parecen CO-CAPÍTULOS de `doc` (sin incluirlo). Cada uno con su puntuación y sus razones.
 * Hace falta que el propio `doc` sea pequeño y PDF (lo que se puede coser) y, en cada candidato, al menos una
 * señal fuerte (obra, ISBN, título) o la familia de nombres ingerida a la vez.
 * @returns {Promise<{ok, doc?, candidatos?, motivo?}>}
 */
export async function coCapitulosDe(db, docOId) {
    const col = db.collection('biblioteca');
    const doc = typeof docOId === 'object' && docOId?.titulo !== undefined
        ? docOId : await col.findOne({ _id: new ObjectId(String(docOId)) }, { projection: PROY });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if (!(doc.formatos || []).includes('pdf')) return { ok: false, motivo: 'solo se pueden unir capítulos en PDF' };
    // Los números de una revista se parecen a capítulos (misma cabecera, «DarwinLife-01-02-2014»…) y no lo son.
    if (doc.tipo_recurso === 'revista') return { ok: false, motivo: 'es un número de revista, no un capítulo' };

    const isbn = isbnComparable(doc.isbn);
    const titulo = norm(tituloDelLibro(doc));
    const familia = familiaDeNombre(doc.nombre_archivo);
    const fecha = doc.fecha_ingreso ? new Date(doc.fecha_ingreso).getTime() : null;

    // Un solo barrido acotado: los de la misma obra, ISBN o título, y los ingeridos a la vez (para la familia).
    const o = [];
    if (doc.obra) o.push({ obra: doc.obra });
    if (isbn) o.push({ isbn: { $in: [isbn, doc.isbn].filter(Boolean) } });
    if (doc.titulo) o.push({ titulo: doc.titulo });
    if (doc.obra_titulo) o.push({ obra_titulo: doc.obra_titulo });
    if (fecha && familia) o.push({ fecha_ingreso: { $gte: new Date(fecha - VENTANA_INGESTA_MS), $lte: new Date(fecha + VENTANA_INGESTA_MS) } });
    if (!o.length) return { ok: true, doc, candidatos: [] };
    const vecinos = await col.find({ _id: { $ne: doc._id }, formatos: 'pdf', tipo_recurso: { $ne: 'revista' }, $or: o }, { projection: PROY }).limit(800).toArray();

    const candidatos = [];
    for (const v of vecinos) {
        if (!esPequeno(v)) continue;
        const razones = [];
        let puntos = 0;
        const fuerte = (cond, txt, p) => { if (cond) { razones.push(txt); puntos += p; } };
        fuerte(doc.obra && v.obra && String(doc.obra) === String(v.obra), 'misma obra', 3);
        fuerte(isbn && isbnComparable(v.isbn) === isbn, 'mismo ISBN', 3);
        fuerte(titulo && norm(tituloDelLibro(v)) === titulo, 'mismo título', 2);
        const cerca = fecha && v.fecha_ingreso && Math.abs(new Date(v.fecha_ingreso).getTime() - fecha) <= VENTANA_INGESTA_MS;
        fuerte(familia && cerca && familiaDeNombre(v.nombre_archivo) === familia, `nombres de la misma serie («${familia}…»)`, 2);
        if (!puntos) continue;
        if (cerca) { razones.push('ingeridos a la vez'); puntos += 1; }
        // Solo la familia de nombres no basta: hace falta otra señal (aunque sea la de ingerirse a la vez, que ya
        // está en la familia) o un tamaño claramente de capítulo.
        if (puntos < 3) continue;
        // SEGURO = comparte obra, ISBN o título. Solo la serie de nombres es una pista: «Ch05-…» de otro libro
        // ingerido la misma noche también es «ch…» (medido: los capítulos de Marks' Biochemistry salían junto a los
        // de Theory of Machines). Se ofrecen, pero sin marcar.
        const seguro = razones.some((x) => x === 'misma obra' || x === 'mismo ISBN' || x === 'mismo título');
        candidatos.push({
            _id: String(v._id), titulo: v.titulo, nombre_archivo: v.nombre_archivo, paginas: v.paginas || null,
            isbn: v.isbn || null, portada: v.portada || null, numero: numeroDeNombre(v.nombre_archivo), puntos, razones, seguro,
        });
    }
    // Sin ninguno seguro, la serie de nombres es todo lo que hay: entonces sí se proponen (se marcan en la ficha).
    if (!candidatos.some((c) => c.seguro)) for (const c of candidatos) c.propuesto = true;
    else for (const c of candidatos) c.propuesto = c.seguro;
    candidatos.sort((a, b) => Number(b.propuesto) - Number(a.propuesto) || (a.numero ?? 1e9) - (b.numero ?? 1e9) || b.puntos - a.puntos);
    return {
        ok: true,
        doc: { _id: String(doc._id), titulo: doc.titulo, nombre_archivo: doc.nombre_archivo, paginas: doc.paginas || null, numero: numeroDeNombre(doc.nombre_archivo), pequeno: esPequeno(doc) },
        candidatos,
    };
}

// ── Detección en la INGESTA y en el CATÁLOGO ─────────────────────────────────────────────────────────

export const NOMBRE_SELECCION_INGESTA = 'Capítulos por unir';

/** Mete los ids en una selección por nombre (la crea si no existe; no duplica). */
async function anotarEnSeleccion(db, nombre, descripcion, ids) {
    const { crearSeleccion, anadirDocs } = await import('./selecciones.js');
    const ya = await db.collection('selecciones').findOne({ nombre }, { projection: { _id: 1 } });
    if (ya) await anadirDocs(db, ya._id, ids.map(String));
    else await crearSeleccion(db, { nombre, descripcion, docs: ids.map(String) });
}

/**
 * Gemelo en la INGESTA: si el documento recién catalogado tiene co-capítulos SEGUROS, él y ellos van a la selección
 * «Capítulos por unir» y llevan un aviso. Devuelve cuántos co-capítulos tiene (0 = nada que hacer).
 */
export async function anotarCoCapitulosEnIngesta(db, id) {
    const r = await coCapitulosDe(db, id);
    if (!r.ok || !r.doc?.pequeno) return 0;
    const seguros = r.candidatos.filter((c) => c.seguro);
    if (!seguros.length) return 0;
    const ids = [r.doc._id, ...seguros.map((c) => c._id)];
    await anotarEnSeleccion(db, NOMBRE_SELECCION_INGESTA,
        'Documentos que parecen CAPÍTULOS de un mismo libro (se catalogaron uno a uno). Ábrelos y usa «📑 Co-capítulos» en la ficha o «📑 Unir capítulos» en la selección.',
        ids);
    await db.collection('biblioteca').updateOne({ _id: new ObjectId(String(id)) }, {
        $push: { alertas_agente: `Parece un CAPÍTULO: ${seguros.length} co-capítulo(s) ya catalogados (${seguros[0].razones.join(', ')}). Únelos con «📑 Co-capítulos».` },
    });
    return seguros.length;
}

/**
 * GRUPOS de capítulos en TODO el catálogo (para scripts/detectar-capitulos.js): PDFs pequeños que comparten
 *   · una OBRA cuyos tomos son todos pequeños y llevan nombre de capítulo («Ch-01», «Ch01-…»: no «Vol 3»), o
 *   · un ISBN (sin ser versiones del mismo fichero: páginas distintas, hashes distintos), o
 *   · el título del libro + la misma serie de nombres, ingeridos a la vez.
 * @returns {Promise<Array<{motivo, titulo, ids, nombres, paginas, seguro}>>}
 */
export async function gruposDeCapitulos(db, { alProgreso = null } = {}) {
    const col = db.collection('biblioteca');
    const PEQ = { formatos: 'pdf', tipo_recurso: { $ne: 'revista' }, $or: [{ paginas: { $lte: MAX_PAGS_CAPITULO } }, { paginas: { $exists: false }, hash_tamano: { $lte: MAX_BYTES_CAPITULO } }] };
    const docs = await col.find(PEQ, { projection: { ...PROY, hash_contenido: 1 } }).toArray();
    const usados = new Set();
    const grupos = [];
    const RE_NO_CAPITULO = /^(vol|volume|volumen|tomo|t|band|bd|libro|book|issue|no|n|part)$/;
    const conFamiliaDeCapitulo = (d) => { const f = familiaDeNombre(d.nombre_archivo); return f && !RE_NO_CAPITULO.test(f); };
    const nuevo = (motivo, ds, seguro) => {
        const orden = ordenarPartesLibro(ds.map((d) => d.nombre_archivo));
        grupos.push({
            motivo, seguro, titulo: tituloDelLibro(ds[0]),
            ids: ds.map((d) => d._id), nombres: orden, paginas: ds.reduce((s, d) => s + (d.paginas || 0), 0),
        });
        for (const d of ds) usados.add(String(d._id));
    };

    // (a) Obras de capítulos: TODOS sus tomos pequeños y con nombre de capítulo.
    const porObra = new Map();
    for (const d of docs) if (d.obra) { const k = String(d.obra); if (!porObra.has(k)) porObra.set(k, []); porObra.get(k).push(d); }
    let i = 0;
    for (const [obra, ds] of porObra) {
        alProgreso?.(++i, porObra.size, 'obras');
        if (ds.length < 2) continue;
        const total = await col.countDocuments({ obra: new ObjectId(obra) });
        if (total !== ds.length) continue;                             // algún tomo grande: es una obra de verdad
        if (ds.filter(conFamiliaDeCapitulo).length / ds.length < 0.6) continue;
        nuevo('obra de capítulos', ds, true);
    }
    // (b) Mismo ISBN, ficheros distintos, páginas distintas (no versiones).
    const porIsbn = new Map();
    for (const d of docs) {
        if (usados.has(String(d._id))) continue;
        const k = isbnComparable(d.isbn);
        if (k) { if (!porIsbn.has(k)) porIsbn.set(k, []); porIsbn.get(k).push(d); }
    }
    for (const ds of porIsbn.values()) {
        if (ds.length < 2) continue;
        if (new Set(ds.map((d) => d.hash_contenido)).size < ds.length) continue;   // copias exactas: otra cosa
        const pags = ds.map((d) => d.paginas || 0);
        if (Math.max(...pags) - Math.min(...pags) <= 2) continue;                    // versiones del mismo fichero
        if (ds.filter((d) => familiaDeNombre(d.nombre_archivo)).length < 2) continue; // sin nombres de serie: dudoso
        nuevo('mismo ISBN', ds, true);
    }
    // (c) Mismo título de libro + misma serie de nombres + ingeridos a la vez (≥3).
    const porTitulo = new Map();
    for (const d of docs) {
        if (usados.has(String(d._id)) || !conFamiliaDeCapitulo(d)) continue;
        const k = `${norm(tituloDelLibro(d))}|${familiaDeNombre(d.nombre_archivo)}`;
        if (!porTitulo.has(k)) porTitulo.set(k, []);
        porTitulo.get(k).push(d);
    }
    for (const ds of porTitulo.values()) {
        if (ds.length < 3) continue;
        const t = ds.map((d) => new Date(d.fecha_ingreso || 0).getTime()).sort((a, b) => a - b);
        if (t[t.length - 1] - t[0] > VENTANA_INGESTA_MS) continue;
        nuevo('mismo título y serie de nombres', ds, false);
    }
    return grupos;
}

/** Selección de un grupo del catálogo: «Capítulos por unir: <título> (N)». Si ya existe, se actualizan sus miembros. */
export async function seleccionDeGrupo(db, g) {
    const { crearSeleccion, reemplazarDocs } = await import('./selecciones.js');
    const prefijo = `Capítulos por unir: ${String(g.titulo || '').slice(0, 60)}`;
    const nombre = `${prefijo} (${g.ids.length})`;
    const descripcion = `${g.ids.length} documentos parecen CAPÍTULOS de un mismo libro (${g.motivo}). Revísalos y usa «📑 Unir capítulos». Orden: ${g.nombres.slice(0, 6).join(', ')}${g.nombres.length > 6 ? '…' : ''}`;
    const esc = prefijo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ya = await db.collection('selecciones').findOne({ nombre: { $regex: `^${esc} \\(` } }, { projection: { _id: 1 } });
    if (ya) {
        await reemplazarDocs(db, ya._id, g.ids.map(String));
        await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { nombre, descripcion } });
    } else await crearSeleccion(db, { nombre, descripcion, docs: g.ids.map(String) });
}

// ── Unir ───────────────────────────────────────────────────────────────────────────────────────────────

const vacio = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const CAMPOS_COMPLETITUD = ['isbn', 'sinopsis', 'autores', 'editorial', 'año_edicion', 'subtitulo', 'palabras_clave', 'dewey', 'lcc', 'coleccion'];
// Lo que NO se hereda de un capítulo: su fichero, su carpeta, su estado interno, y lo que lo hacía TOMO de una obra.
const NO_HEREDAR = new Set(['_id', 'titulo', 'ruta_base', 'nombre_archivo', 'hash_contenido', 'hash_fecha', 'hash_mtime', 'hash_tamano',
    'hashes_anteriores', 'imagenes', 'portada', 'fecha_ingreso', 'fecha_actualizacion', 'mantenimiento', 'mantenimiento_firma',
    'campanas', 'alertas_agente', 'versiones', 'sidecars_fecha', 'paginas', 'formatos', 'textos', 'audios', 'adjuntos',
    'material_adjunto', 'capitulos', 'documentos_fusionados', 'estado_verificacion', 'tipo_recurso', 'texto_util',
    'obra', 'obra_titulo', 'obra_total', 'volumen_numero', 'volumen_titulo', 'cdu', 'cdu_fuente', 'cdu_manual',
    'portadas_candidatas', 'portadas_candidatas_fecha', 'deshacer', 'ruta_fija']);
const CAMPOS_TOMO = ['obra', 'obra_titulo', 'obra_total', 'volumen_numero', 'volumen_titulo'];

function puntosPrincipal(d) {
    const completo = CAMPOS_COMPLETITUD.filter((c) => !vacio(d[c])).length + (d.estado_verificacion === 'completado' ? 2 : 0)
        + (/^0+$/.test(String(d.cdu || '0')) ? 0 : 1) + (d.cdu_manual ? 3 : 0) + (d.valoracion ? 3 : 0);
    return completo;
}

async function nombreLibre(dir, nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    for (let k = 1; k < 200; k++) {
        const cand = k === 1 ? nombre : `${base} (${k})${ext}`;
        try { await fs.access(path.join(dir, cand)); } catch { return cand; }
    }
    return `${base} (${Date.now()})${ext}`;
}

/** Mueve un fichero (rename; entre volúmenes, copia verificada + borrado). */
async function mover(origen, destino) {
    try { await fs.rename(origen, destino); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
    await fs.copyFile(origen, destino);
    const [a, b] = await Promise.all([fs.stat(origen), fs.stat(destino)]);
    if (a.size !== b.size) throw new Error('copia incompleta');
    await fs.rm(origen, { force: true });
}

/** Nombre de fichero válido en Windows y Linux para el PDF cosido. */
const nombreSeguro = (t) => String(t || 'Libro').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150) || 'Libro';

/** Título de un capítulo para el índice: el suyo si no es el del libro, si no el de su nombre de fichero. */
function tituloCapitulo(d, tituloLibro) {
    // Sin la marca numerada del principio («Ch-05 simple mechanisms» → «Simple mechanisms», «V1CH1-Fourier…» →
    // «Fourier…»); sin nada detrás, «Capítulo N».
    const sinMarca = (s) => String(s || '').replace(/^[a-z]{0,6}\d{0,3}[a-z]{0,6}[ _.-]*\d{1,3}(?!\d)[ _.-]*/i, '').replace(/_/g, ' ').trim();
    const mayus = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const propio = String(d.volumen_titulo || d.titulo || '').trim();
    if (propio && norm(propio) !== norm(tituloLibro)) {
        const t = sinMarca(propio);
        if (t) return mayus(t);
    }
    const t = sinMarca(path.basename(d.nombre_archivo, path.extname(d.nombre_archivo)));
    const n = numeroDeNombre(d.nombre_archivo);
    return t ? mayus(t) : (n != null ? `Capítulo ${n}` : path.basename(d.nombre_archivo, path.extname(d.nombre_archivo)));
}

/** Huecos en la numeración de los capítulos (1, 2, 8 → faltan 3-7): el libro unido estará INCOMPLETO. */
function huecosNumeracion(docs) {
    const nums = [...new Set(docs.map((d) => numeroDeNombre(d.nombre_archivo)).filter((n) => n != null && n > 0))].sort((a, b) => a - b);
    if (nums.length < 2) return null;
    const faltan = [];
    for (let n = nums[0]; n < nums[nums.length - 1] && faltan.length < 50; n++) if (!nums.includes(n)) faltan.push(n);
    // Si no empieza en 1 (ni en 0), también faltan los primeros.
    return { presentes: nums, faltan, empiezaTarde: nums[0] > 1 };
}

/**
 * Une los documentos `ids` (capítulos de UN libro) en uno. `aplicar=false` → solo devuelve el plan (orden, principal,
 * título, ISBN, avisos). `titulo` = el del libro si quieres otro. Varios ISBN distintos se rechazan salvo `forzar`
 * (suelen ser dos tomos: «Elements of Photonics» I y II).
 * @returns {Promise<{ok, motivo?, plan?, principal?, retirados?, paginas?, capitulos?}>}
 */
export async function unirCapitulos(db, ids, { aplicar = true, titulo = null, forzar = false } = {}) {
    const col = db.collection('biblioteca');
    const oids = (ids || []).map((x) => (typeof x === 'string' ? new ObjectId(x) : x));
    const docs = await col.find({ _id: { $in: oids } }).toArray();
    if (docs.length < 2) return { ok: false, motivo: 'hacen falta al menos dos documentos' };

    // 1) Todos han de tener su PDF en disco: es lo que se cose.
    const fichero = new Map();
    const faltan = [];
    for (const d of docs) {
        const f = d.nombre_archivo && /\.pdf$/i.test(d.nombre_archivo) ? await archivoOriginal(carpetaDeDoc(d), d.nombre_archivo).catch(() => null) : null;
        if (f) fichero.set(String(d._id), f); else faltan.push(`«${d.titulo}» (${d._id})`);
    }
    if (faltan.length) return { ok: false, motivo: `sin PDF en disco: ${faltan.slice(0, 5).join(', ')}${faltan.length > 5 ? '…' : ''}` };

    // 2) ¿Un solo libro? Varios ISBN distintos = probablemente varios tomos.
    const isbns = [...new Set(docs.map((d) => isbnComparable(d.isbn)).filter(Boolean))];
    const avisos = [];
    if (isbns.length > 1) {
        if (!forzar) return { ok: false, motivo: `tienen ${isbns.length} ISBN distintos (${isbns.join(', ')}): parecen capítulos de libros distintos (¿dos tomos?). Únelos por separado, o fuerza la unión.`, isbns };
        avisos.push(`Unidos con ${isbns.length} ISBN distintos (${isbns.join(', ')}), forzando.`);
    }

    // 3) Orden de lectura por el nombre (preliminares delante, índice/apéndices detrás, capítulos por número).
    //    Nombres repetidos en carpetas distintas se distinguen con su id para no perder ninguno.
    const clave = new Map();
    for (const d of docs) {
        let n = d.nombre_archivo;
        if ([...clave.keys()].includes(n)) n = `${path.basename(n, '.pdf')} [${d._id}].pdf`;
        clave.set(n, d);
    }
    const orden = ordenarPartesLibro([...clave.keys()]).map((n) => clave.get(n));

    const principal = [...docs].sort((a, b) => puntosPrincipal(b) - puntosPrincipal(a)
        || new Date(a.fecha_ingreso || 0) - new Date(b.fecha_ingreso || 0))[0];
    const otros = docs.filter((d) => String(d._id) !== String(principal._id));
    // Título del libro: el que digas; si no, el de la obra o el más repetido entre los capítulos.
    const cuenta = new Map();
    for (const d of docs) { const t = tituloDelLibro(d); if (t) cuenta.set(t, (cuenta.get(t) || 0) + 1); }
    const tituloLibro = (titulo && String(titulo).trim()) || principal.obra_titulo || [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || principal.titulo;

    // ¿Están todos? Con huecos se une igual (es lo que hay), pero se dice, en el plan y en el documento.
    const huecos = huecosNumeracion(docs);
    const incompleto = !!huecos && (huecos.faltan.length > 0 || huecos.empiezaTarde);
    if (incompleto) avisos.push(`Libro INCOMPLETO: solo los capítulos ${huecos.presentes.join(', ')}${huecos.faltan.length ? ` (faltan ${huecos.faltan.join(', ')}${huecos.empiezaTarde ? ' y los anteriores' : ''})` : ' (faltan los primeros)'}.`);
    const plan = {
        titulo: tituloLibro,
        incompleto,
        principal: { id: String(principal._id), titulo: principal.titulo },
        orden: orden.map((d) => ({ id: String(d._id), nombre_archivo: d.nombre_archivo, paginas: d.paginas || null, capitulo: tituloCapitulo(d, tituloLibro) })),
        isbn: principal.isbn || docs.find((d) => d.isbn)?.isbn || null,
        paginas: docs.every((d) => d.paginas) ? docs.reduce((s, d) => s + d.paginas, 0) : null,
        avisos,
    };
    if (!aplicar) return { ok: true, plan };

    // 4) COSER en la carpeta del principal. Si falla, no se ha tocado nada.
    const carpetaP = carpetaDeDoc(principal);
    if (!carpetaP) return { ok: false, motivo: 'el principal no tiene carpeta' };
    await fs.mkdir(carpetaP, { recursive: true });
    const nombreLibro = await nombreLibre(carpetaP, `${nombreSeguro(tituloLibro)}.pdf`);
    const destino = path.join(carpetaP, nombreLibro);
    const rutas = orden.map((d) => fichero.get(String(d._id)));
    const r = await unirPdfs(rutas, destino);
    if (!r.ok || (r.paginas && r.paginas < rutas.length)) {
        await fs.rm(destino, { force: true }).catch(() => {});
        return { ok: false, motivo: `no se pudo coser: ${r.ok ? `${r.paginas} páginas para ${rutas.length} capítulos` : r.motivo}` };
    }
    // Índice de capítulos (página de inicio de cada uno). Si no cuadra con el PDF cosido, no hay índice.
    let capitulos = [];
    let pagina = 1;
    for (const d of orden) {
        const n = await paginasPdf(fichero.get(String(d._id)));
        if (!n) { capitulos = []; break; }
        capitulos.push({ titulo: tituloCapitulo(d, tituloLibro), pagina });
        pagina += n;
    }
    if (capitulos.length && r.paginas && pagina - 1 !== r.paginas) capitulos = [];

    // 5) Los capítulos originales → «Capítulos/» del principal (adjunto). Sus hashes, a hashes_anteriores.
    const dirCap = path.join(carpetaP, 'Capítulos');
    await fs.mkdir(dirCap, { recursive: true });
    const hashesAnteriores = [...(principal.hashes_anteriores || [])];
    for (const d of orden) {
        const h = d.hash_contenido || await calcularHashArchivo(fichero.get(String(d._id))).catch(() => null);
        if (h) hashesAnteriores.push({ hash: h, hasta: new Date(), capitulo: d.nombre_archivo, doc_origen: d._id });
        await mover(fichero.get(String(d._id)), path.join(dirCap, await nombreLibre(dirCap, d.nombre_archivo)));
    }

    // 6) Datos: los huecos del principal se rellenan con los de los capítulos; autores y palabras clave se UNEN.
    const set = {};
    const autores = [...(principal.autores || [])];
    const palabras = new Set(principal.palabras_clave || []);
    const isbnCand = new Set(principal.isbn_candidatos || []);
    const cdus = [principal.cdu ? { cdu: principal.cdu, fuente: fuenteCduDoc(principal) } : null];
    const fusionados = [...(principal.documentos_fusionados || [])];
    for (const o of otros) {
        for (const [k, v] of Object.entries(o)) {
            if (NO_HEREDAR.has(k) || vacio(v)) continue;
            if (k === 'autores') { for (const a of v) if (!autores.some((x) => String(x) === String(a))) autores.push(a); continue; }
            if (k === 'palabras_clave') { for (const x of v) palabras.add(x); continue; }
            if (k === 'isbn_candidatos') { for (const x of v) isbnCand.add(x); continue; }
            if (vacio(principal[k]) && vacio(set[k])) set[k] = v;
        }
        if (o.cdu) cdus.push({ cdu: o.cdu, fuente: fuenteCduDoc(o) });
        const ficha = { ...o };
        for (const k of ['imagenes', 'mantenimiento', 'campanas', 'textos', 'versiones', 'documentos_fusionados']) delete ficha[k];
        fusionados.push({ _id: o._id, fecha_fusion: new Date(), motivo: 'capítulo unido', ficha });
    }
    if (autores.length > (principal.autores || []).length) set.autores = autores;
    if (palabras.size > (principal.palabras_clave || []).length) set.palabras_clave = [...palabras];
    if (isbnCand.size > (principal.isbn_candidatos || []).length) set.isbn_candidatos = [...isbnCand];
    if (!principal.isbn && plan.isbn) set.isbn = plan.isbn;

    const st = await fs.stat(destino);
    const hash = await calcularHashArchivo(destino);
    const adjuntos = (principal.adjuntos || []).filter((a) => a.nombre !== 'Capítulos');
    adjuntos.push({ nombre: 'Capítulos', tipo: 'carpeta', soloAdmin: false, bytes: 0, fecha: new Date() });
    Object.assign(set, {
        titulo: tituloLibro,
        tipo_recurso: 'libro',
        nombre_archivo: nombreLibro,
        formatos: ['pdf'],
        paginas: r.paginas || plan.paginas || null,
        hash_contenido: hash, hash_fecha: new Date(), hash_mtime: st.mtimeMs, hash_tamano: st.size,
        hashes_anteriores: hashesAnteriores,
        adjuntos, material_adjunto: adjuntos.length, ruta_fija: true,
        documentos_fusionados: fusionados,
        fecha_actualizacion: new Date(),
    });
    if (capitulos.length) set.capitulos = capitulos;
    if (incompleto) set.capitulos_incompleto = { presentes: huecos.presentes, faltan: huecos.faltan };
    if (otros.some((o) => o.estado_verificacion === 'completado') && principal.estado_verificacion !== 'completado') set.estado_verificacion = 'completado';
    if (!set.paginas) delete set.paginas;
    // Deja de ser tomo de una obra: lo era solo por haberse colado capítulo a capítulo.
    const unset = {};
    const obraId = principal.obra || otros.find((o) => o.obra)?.obra || null;
    for (const k of CAMPOS_TOMO) if (principal[k] !== undefined) unset[k] = '';
    // Su texto principal es el PDF cosido: el selector de textos viejo apuntaba al capítulo.
    if (principal.textos) unset.textos = '';

    const update = {
        $set: set,
        $push: { alertas_agente: { $each: [`Unidos ${docs.length} capítulos en un solo PDF («${nombreLibro}», ${r.paginas || '?'} págs.${capitulos.length ? `, índice de ${capitulos.length}` : ''}). Los originales quedan en «Capítulos/»; retirados: ${otros.map((o) => o._id).join(', ')}.`, ...avisos] } },
    };
    if (Object.keys(unset).length) update.$unset = unset;
    await col.updateOne({ _id: principal._id }, update);

    // 7) Retirar los demás: referencias al principal, id redirigido, carpeta (ya sin su PDF) a la Papelera.
    for (const o of otros) {
        await db.collection('selecciones').updateMany({ docs: o._id }, { $addToSet: { docs: principal._id } });
        await db.collection('selecciones').updateMany({ docs: o._id }, { $pull: { docs: o._id } });
        await db.collection('fichas_lectura').updateMany({ ambito: 'documento', ref: o._id }, { $set: { ref: principal._id } });
        if (o.coleccion) await db.collection('colecciones').updateOne({ _id: o.coleccion }, { $pull: { numeros: { _id: o._id }, numeros_sin_fecha: o._id } });
        await db.collection('redirecciones').updateOne({ _id: o._id }, { $set: { a: principal._id, motivo: 'capítulos unidos', fecha: new Date() } }, { upsert: true });
        await db.collection('redirecciones').updateMany({ a: o._id }, { $set: { a: principal._id } });
        await col.deleteOne({ _id: o._id });
        await desindexarDoc(o._id).catch(() => {});
        const carpetaO = carpetaDeDoc(o);
        if (carpetaO && path.resolve(carpetaO) !== path.resolve(carpetaP)) {
            const otroUsa = await otroDocEnCarpeta(db, o.ruta_base, [o._id]);
            if (!otroUsa) await reciclarCarpeta(carpetaO, `capitulos-${principal._id}`, path.basename(path.dirname(carpetaO))).catch(() => null);
        }
    }
    // La OBRA que los reunía: sin tomos se borra; con tomos que no se unieron, se rehace su inventario.
    if (obraId) {
        const quedan = await col.countDocuments({ obra: obraId });
        if (!quedan) await db.collection('obras').deleteOne({ _id: obraId });
        else await reconstruirInventarioObra(db, obraId).catch(() => {});
    }
    await fs.writeFile(path.join(carpetaP, MARCA_RUTA_FIJA), `capítulos unidos: ${tituloLibro}\n`).catch(() => {});

    // 8) CDU (la de mayor prioridad entre todos) y carpeta: un tomo vivía en «obras/…»; un libro, en «libros/».
    let act = await col.findOne({ _id: principal._id });
    const ganadora = mejorCdu(cdus.filter(Boolean));
    if (ganadora && ganadora.cdu !== act.cdu) {
        await aplicarCduConPrioridad(db, act, ganadora.cdu, ganadora.fuente).catch(() => null);
        act = await col.findOne({ _id: principal._id });
    }
    const mov = await recolocarSegunCdu(act).catch(() => null);
    if (mov?.set) {
        await col.updateOne({ _id: principal._id }, { $set: mov.set, ...(mov.alertas?.length ? { $push: { alertas_agente: { $each: mov.alertas } } } : {}) });
        act = await col.findOne({ _id: principal._id });
    }
    // Portada e imágenes de catalogación, del PDF UNIDO: las del principal eran las de SU capítulo (en «Theory of
    // Machines», el del índice). Conserva las añadidas a mano.
    const { reextraerImagenesDoc } = await import('./reextraer-imagenes.js');
    await reextraerImagenesDoc(db, act).catch(() => null);
    act = await col.findOne({ _id: principal._id });
    await regenerarSidecarsDoc(db, act, carpetaDeDoc(act)).catch(() => {});
    await indexarDoc(db, principal._id).catch(() => {});

    // 9) Sin ISBN: las primeras páginas del PDF cosido son ahora el front matter → se intenta sacarlo (sin IA).
    let isbn = act.isbn || null;
    if (!isbn) {
        const { reidentificarDoc } = await import('./reidentificar-doc.js');
        const ri = await reidentificarDoc(db, act, { aplicar: true }).catch(() => null);
        if (ri?.isbn) isbn = ri.isbn;
    }
    return {
        ok: true, plan,
        principal: { id: String(principal._id), titulo: tituloLibro }, retirados: otros.map((o) => String(o._id)),
        paginas: r.paginas || null, capitulos: capitulos.length, isbn,
    };
}

// ── LOTE en 2º plano (acción «📑 Unir capítulos» sobre una selección) ───────────────────────────────────

let trabajo = { en_curso: false, fase: '', resultado: null, error: null };
export function estadoUnirCapitulos() { return { ...trabajo }; }

export function lanzarUnirCapitulos({ ids, titulo = null, forzar = false } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una unión en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(',')).map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x));
    if (lista.length < 2) return { ok: false, motivo: 'elige al menos dos documentos' };
    trabajo = { en_curso: true, fase: 'cosiendo', resultado: null, error: null };
    (async () => {
        try { trabajo.resultado = await unirCapitulos(await conectarDB(), lista, { titulo, forzar }); }
        catch (e) { trabajo.error = e.message; }
        finally { trabajo.en_curso = false; }
    })();
    return { ok: true, total: lista.length };
}
