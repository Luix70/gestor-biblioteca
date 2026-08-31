/**
 * EMPAREJAR PORTADAS + .opf CON UNA SELECCIÓN (acción retroactiva del panel).
 *
 * Rescata las cubiertas (y catalogación) que quedaron SUELTAS al ingerir una colección exportada de Calibre:
 * el escaneador puso la portada real en un `.jpg` aparte (a veces con un `.opf` que la referencia), pero la
 * ingesta la ignoró y sacó la portada de la página 1 → cientos de libros sin su cubierta. Aquí, sobre una
 * SELECCIÓN GUARDADA de esos documentos ya catalogados, se emparejan las portadas/`.opf` de una carpeta y se
 * les pone la cubierta real (+ metadatos que falten). NUNCA borra la portada previa: la entrante pasa a ser la
 * 1.ª del carrusel y las anteriores bajan (imagenes-doc·anadirImagen {comoPortada}).
 *
 * Emparejado por prioridad, del más fiable al más laxo: (1) ISBN del `.opf`; (2) nombre de fichero (el `.jpg`/
 * `.opf` se llama igual que el documento); (3) título (del `.opf` o del propio nombre). Los AMBIGUOS (varios
 * candidatos) no se tocan: se listan. Trabajo en 2º plano con progreso (patrón de integridad.js).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../database.js';
import { docsDeSeleccion } from './selecciones.js';
import { leerOPF, opfEsSignificativo } from './lector-opf.js';
import { anadirImagen } from './imagenes-doc.js';
import { editarDocumento } from './editar-doc.js';
import { resolverColeccion } from './colecciones.js';
import { variantesISBN, validarISBN } from './identificadores.js';

const EXT_IMG = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const NOMBRE_GENERICO = /^(cover|portada|cubierta|frontcover|front[-_ ]?cover)$/i;
const existe = (p) => fs.access(p).then(() => true).catch(() => false);

// Normaliza un texto para comparar nombres/títulos: sin acentos, sin puntuación, minúsculas, espacios
// colapsados, y unifica «&»→«and» (una subcarpeta «… and White Fang» casa con el título «… & White Fang»). Así
// «Aesop's Fables - Aesop» y «aesops fables  aesop» casan. (Rango de diacríticos combinantes U+0300–U+036F, el
// mismo strip NFD que usa titulo-original.js.)
function norm(s) {
    return String(s || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}
// Sin ARTÍCULO inicial: el nombre de una subcarpeta suele llevar «The»/«A» que el título catalogado no («The
// Canterbury Tales» ↔ «Canterbury Tales»). Se prueba también esta variante al emparejar por título.
const sinArticulo = (k) => String(k || '').replace(/^(the|a|an|el|la|los|las|un|una|le|les|il|lo)\s+/, '');
// Quita el sufijo « - Autor» de un nombre de fichero para quedarnos con el título (heurística suave).
const soloTitulo = (base) => norm(String(base || '').split(/\s+-\s+/)[0]);

/**
 * Escanea una carpeta (recursiva 1 nivel en subcarpetas) y devuelve los ÍTEMS a emparejar. Un ítem =
 * { cover?: ruta, opf?: ruta, meta?: {…}, base: nombreSinExt, isbn?, titulo? }. Fuentes:
 *   - `.opf` de primer nivel → su cover (guide href o `.jpg` hermano) + metadatos.
 *   - `.jpg` de primer nivel SIN `.opf` hermano → cubierta a secas (por nombre).
 *   - subcarpeta con `cover.jpg`/`portada.jpg` (o una única imagen) → cubierta cuya clave es el nombre de la subcarpeta.
 */
export async function escanearCarpetaPortadas(dir) {
    const items = [];
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return items; }

    const imgs = ents.filter((e) => e.isFile() && EXT_IMG.has(path.extname(e.name).toLowerCase()));
    const opfs = ents.filter((e) => e.isFile() && /\.opf$/i.test(e.name));
    const usadasComoCover = new Set();

    // 1) .opf de primer nivel → metadatos + su cover.
    for (const e of opfs) {
        const opfPath = path.join(dir, e.name);
        const meta = await leerOPF(opfPath);
        if (!opfEsSignificativo(meta)) continue;
        const base = e.name.replace(/\.opf$/i, '');
        let cover = meta.cover_path && await existe(meta.cover_path) ? meta.cover_path : null;
        if (!cover) {                                            // href ausente/roto → probar «<base>.<img>»
            for (const ext of EXT_IMG) { const p = path.join(dir, base + ext); if (await existe(p)) { cover = p; break; } }
        }
        if (cover) usadasComoCover.add(path.resolve(cover));
        items.push({ opf: opfPath, meta, cover, base, isbn: meta.isbn || null, titulo: meta.titulo || null });
    }

    // 2) imágenes de primer nivel sin .opf que las reclame → cubierta por nombre.
    for (const e of imgs) {
        const abs = path.join(dir, e.name);
        if (usadasComoCover.has(path.resolve(abs))) continue;
        if (NOMBRE_GENERICO.test(path.basename(e.name, path.extname(e.name)))) continue; // genérica en la raíz: ambigua, se ignora
        items.push({ cover: abs, base: e.name.replace(/\.[^.]+$/, ''), isbn: null, titulo: null });
    }

    // 3) subcarpetas con una cubierta (cover.jpg / única imagen): la clave es el NOMBRE de la subcarpeta.
    for (const e of ents.filter((x) => x.isDirectory())) {
        const sub = path.join(dir, e.name);
        let subEnts; try { subEnts = await fs.readdir(sub, { withFileTypes: true }); } catch { continue; }
        const subImgs = subEnts.filter((x) => x.isFile() && EXT_IMG.has(path.extname(x.name).toLowerCase()));
        if (!subImgs.length) continue;
        const gen = subImgs.find((x) => NOMBRE_GENERICO.test(path.basename(x.name, path.extname(x.name))));
        const elegida = gen || (subImgs.length === 1 ? subImgs[0] : null);   // cover.jpg, o la única imagen
        if (elegida) items.push({ cover: path.join(sub, elegida.name), base: e.name, isbn: null, titulo: null });
    }
    return items;
}

/** Índices de la selección para emparejar rápido: por ISBN (variantes), por nombre de archivo y por título. */
function indexarDocs(docs) {
    const byIsbn = new Map(), byArchivo = new Map(), byTitulo = new Map();
    const add = (map, k, doc) => {
        if (!k) return;
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(doc);
    };
    for (const d of docs) {
        if (d.isbn) for (const v of variantesISBN(d.isbn)) add(byIsbn, v, d);
        const arch = d.nombre_archivo ? norm(d.nombre_archivo.replace(/\.[^.]+$/, '')) : null;
        add(byArchivo, arch, d);
        const t = norm(d.titulo);
        add(byTitulo, t, d);
        const ta = sinArticulo(t);
        if (ta && ta !== t) add(byTitulo, ta, d);   // «Canterbury Tales» además de «The Canterbury Tales»
    }
    return { byIsbn, byArchivo, byTitulo };
}

// Devuelve { doc } si hay UN candidato claro, { ambiguo:true } si varios, o null si ninguno. Prioridad:
// ISBN → nombre de archivo → título (del .opf o del propio nombre del fichero de cubierta).
function emparejar(item, idx) {
    const unico = (arr) => (!arr || !arr.length ? null : (arr.length === 1 ? { doc: arr[0] } : { ambiguo: true, n: arr.length }));

    if (item.isbn) { const v = validarISBN(item.isbn); if (v) for (const x of variantesISBN(v)) { const r = unico(idx.byIsbn.get(x)); if (r) return { ...r, via: 'isbn' }; } }

    const archivo = norm(item.base);
    let r = unico(idx.byArchivo.get(archivo)); if (r) return { ...r, via: 'nombre de archivo' };

    // Título: el del .opf, el nombre completo, o el nombre sin el sufijo « - Autor» — y cada uno también SIN su
    // artículo inicial (la subcarpeta «The Canterbury Tales» casa con el título «Canterbury Tales»). Dedup.
    const claves = new Set();
    for (const base of [norm(item.titulo), archivo, soloTitulo(item.base)]) {
        if (!base) continue;
        claves.add(base);
        const sa = sinArticulo(base); if (sa && sa !== base) claves.add(sa);
    }
    for (const clave of claves) { r = unico(idx.byTitulo.get(clave)); if (r) return { ...r, via: 'título' }; }
    return null;
}

// data: URL de una imagen de disco (para anadirImagen, que decodifica jpg/png/webp).
async function coverADataUrl(ruta) {
    const buf = await fs.readFile(ruta);
    const mime = MIME[path.extname(ruta).toLowerCase()] || 'image/jpeg';
    return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Aplica un ítem emparejado a su documento: portada (siempre) + metadatos que falten (si `aplicarMeta`). */
async function aplicarItem(db, doc, item, aplicarMeta) {
    const acciones = [];
    if (item.cover) {
        try { await anadirImagen(db, String(doc._id), await coverADataUrl(item.cover), { comoPortada: true }); acciones.push('portada'); }
        catch (e) { acciones.push(`portada-ERROR(${e.message})`); }
    }
    if (aplicarMeta && item.meta) {
        const m = item.meta, campos = {};
        if (m.titulo && !doc.titulo) campos.titulo = m.titulo;
        if (m.autores?.length && !(doc.autores || []).length) campos.autores = m.autores;         // gap-fill: casi siempre ya tienen
        if (m.contribuciones?.length && !(doc.contribuciones || []).length) campos.contribuciones = m.contribuciones;
        if (m.editorial && !doc.editorial) campos.editorial = m.editorial;
        if (m.sinopsis && !doc.sinopsis) campos.sinopsis = m.sinopsis;
        if (m.idioma && !doc.idioma) campos.idioma = m.idioma;
        if (m.isbn && !doc.isbn) campos.isbn = m.isbn;
        if (m.materias?.length && !(doc.palabras_clave || []).length) campos.palabras_clave = m.materias;
        if (Object.keys(campos).length) { await editarDocumento(db, String(doc._id), campos); acciones.push('metadatos:' + Object.keys(campos).join('/')); }
        // Serie → colección de LIBROS (solo si el doc aún no está en ninguna): resolver/crear y enlazar.
        if (m.serie_nombre && !doc.coleccion) {
            try {
                const edId = doc.editorial && typeof doc.editorial !== 'string' ? doc.editorial : null;
                const { _id } = await resolverColeccion(db, m.serie_nombre, edId);
                const setC = { coleccion: _id, fecha_actualizacion: new Date() };
                if (m.serie_indice) setC.coleccion_numero = String(m.serie_indice);
                await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: setC });
                acciones.push('colección');
            } catch (e) { acciones.push(`colección-ERROR(${e.message})`); }
        }
    }
    return acciones;
}

/**
 * Empareja los ítems de `dir` con los documentos de la selección `seleccionId`. `aplicar=false` = DRY-RUN
 * (solo informa). `aplicarMeta` = además de la portada, rellena metadatos huecos desde el `.opf`.
 * `onProgress({fase, hechos, total})`. Devuelve el informe.
 */
export async function emparejarPortadas({ dir, seleccionId, aplicar = false, aplicarMeta = true, onProgress = null } = {}) {
    const prog = (fase, extra = {}) => { try { onProgress?.({ fase, ...extra }); } catch { /* nunca rompe */ } };
    const db = await conectarDB();
    prog('escaneando');
    const items = await escanearCarpetaPortadas(dir);

    prog('cargando-seleccion');
    const ids = await docsDeSeleccion(db, seleccionId);
    if (!ids.length) return { ok: false, motivo: 'la selección está vacía o no existe', items: items.length };
    const docs = await db.collection('biblioteca')
        .find({ _id: { $in: ids } }, { projection: { titulo: 1, isbn: 1, nombre_archivo: 1, autores: 1, editorial: 1, sinopsis: 1, idioma: 1, coleccion: 1, palabras_clave: 1, contribuciones: 1, portada: 1 } })
        .toArray();
    const idx = indexarDocs(docs);

    const emparejados = [], ambiguos = [], sinMatch = [];
    const total = items.length;
    let hechos = 0;
    for (const item of items) {
        const m = emparejar(item, idx);
        if (!m) sinMatch.push({ base: item.base, tieneCover: !!item.cover, tieneOpf: !!item.meta });
        else if (m.ambiguo) ambiguos.push({ base: item.base, n: m.n });
        else {
            const fila = { base: item.base, docId: String(m.doc._id), titulo: m.doc.titulo, via: m.via, tieneCover: !!item.cover, yaTenia: !!m.doc.portada };
            if (aplicar) fila.acciones = await aplicarItem(db, m.doc, item, aplicarMeta);
            emparejados.push(fila);
        }
        prog('emparejando', { hechos: ++hechos, total });
    }
    prog('hecho', { hechos, total });
    return {
        ok: true, aplicado: !!aplicar, aplicarMeta: !!aplicarMeta, carpeta: dir,
        resumen: { items: total, emparejados: emparejados.length, ambiguos: ambiguos.length, sinMatch: sinMatch.length, docsSeleccion: docs.length },
        emparejados, ambiguos, sinMatch,
    };
}

// ── SEGUNDO PLANO (para el panel): POST arranca, GET .../estado sondea (patrón de integridad.js) ─────────────
let trabajo = { en_curso: false, fase: null, progreso: {}, ts: null, informe: null, error: null };
export function estadoEmparejado() { return { ...trabajo }; }
export function lanzarEmparejado({ dir, seleccionId, aplicar = false, aplicarMeta = true } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay un emparejado en curso' };
    trabajo = { en_curso: true, fase: 'escaneando', progreso: {}, ts: new Date().toISOString(), informe: null, error: null };
    (async () => {
        try {
            const inf = await emparejarPortadas({ dir, seleccionId, aplicar, aplicarMeta, onProgress: (p) => { trabajo.fase = p.fase; trabajo.progreso = p; } });
            trabajo.informe = inf;
        } catch (e) { trabajo.error = e.message; }
        finally { trabajo.en_curso = false; trabajo.fase = 'hecho'; }
    })();
    return { ok: true };
}
