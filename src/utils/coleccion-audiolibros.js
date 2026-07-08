/**
 * COLECCIÓN DE AUDIOLIBROS — una carpeta con VARIOS audiolibros (una serie de audio; p. ej. «Joseph Campbell»
 * con muchos títulos) se cataloga como UNA colección cuyos miembros son documentos:
 *   · un AUDIOLIBRO por LIBRO (subcarpeta con audio), con su playlist agrupada por apartado/disco (`grupo`);
 *   · un documento por PDF (guías/notas), también miembro de la colección (no se pierden ni se «esconden»).
 * La estructura de disco se conserva VERBATIM (ruta_fija): Colección → Libro → apartado/disco → pistas.
 *
 * A diferencia del audiolibro suelto (audiolibro.js), aquí CADA subcarpeta de primer nivel es UN libro (un
 * audiolibro), y sus sub-subcarpetas son APARTADOS/DISCOS de ese libro (no libros distintos). El vídeo y demás
 * material no catalogable se preserva verbatim. Identificación barata: ID3 + ISBN del NOMBRE de carpeta
 * (…-9781565117358) → Fichero (OL+BNE); nunca inventa autor.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { DIR_CDU, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { cduDeGenero, deducirIdioma, etiquetaDisco, leerISBNdeImagenes } from './audiolibro.js';
import { arbolCDU } from './cdu-arbol.js';
import { resolverCabecera } from './colecciones.js';
import { indexarDoc } from './indice-busqueda.js';
import { agregarMetadatos, esAudio, leerMetadatosAudio } from './lector-audio.js';
import { reciclarCarpeta } from './papelera.js';
import { resolverPersona } from './resolver-persona.js';
import { copiarVerificado, huella, renderizarPortadaMiembro } from './transmedia.js';

const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'];
const EXT_VIDEO = ['.avi', '.mp4', '.mkv', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.ogv'];
const esImagen = (n) => EXT_IMG.includes(path.extname(n).toLowerCase());
const esPdf = (n) => path.extname(n).toLowerCase() === '.pdf';
const esVideo = (n) => EXT_VIDEO.includes(path.extname(n).toLowerCase());
// Basura de sistema/descargas parciales que NO se cataloga NI se lista en el manifiesto (ruido, no contenido).
const esRuido = (n) => /^thumbs\.db$/i.test(n) || /\.(!ut|part|crdownload|tmp|ds_store|nfo|sfv|url|m3u|m3u8)$/i.test(n);
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || /^thumbs\.db$/i.test(n);
const porRelNat = (a, b) => a.rel.localeCompare(b.rel, 'es', { numeric: true });

/** Lista TODOS los ficheros de un árbol con su ruta relativa (POSIX). Nunca lanza. */
async function listarFicheros(raiz) {
    const salida = [];
    const pila = [raiz];
    while (pila.length) {
        const dir = pila.pop();
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { pila.push(abs); continue; }
            salida.push({ abs, rel: path.relative(raiz, abs).split(path.sep).join('/'), nombre: e.name });
        }
    }
    return salida;
}

/** ISBN-13 (978/979…) embebido en un nombre de carpeta/fichero. Solo el 13 (fiable); el 10 en nombres da
 *  falsos positivos con años/códigos, así que se omite. */
function isbnDeNombre(nombre) {
    const m = String(nombre || '').replace(/[^0-9]/g, ' ').match(/(97[89]\d{10})/);
    return m ? m[1] : null;
}

/** Etiqueta CORTA del apartado/disco de un libro: «[Disc 1] - …» → «Disc 1»; «1_Origins_of_…» → «1 · Origins
 *  of …»; si no, el nombre con los guiones bajos como espacios. */
function etiquetaGrupo(nombre) {
    const n = String(nombre || '');
    const corta = etiquetaDisco(n);                 // «… CD1» / «… Disco 2» al final
    if (corta !== n) return corta;
    const disc = n.match(/\[?\s*(cd|disco?|disc|vol(?:umen)?)\s*\.?\s*(\d+)\s*\]?/i); // [Disc 1], Disc 2… en medio
    if (disc) return `${/cd/i.test(disc[1]) ? 'CD' : /vol/i.test(disc[1]) ? 'Vol' : 'Disc'} ${disc[2]}`;
    const sec = n.match(/^\s*(\d+)[\s._-]+(.+)$/);   // «1_Origins…» → sección numerada
    if (sec) return `${sec[1]} · ${sec[2].replace(/_/g, ' ').trim()}`;
    return n.replace(/_/g, ' ').trim();
}

// Título aseado (nombre de carpeta/fichero → sin ISBN, extensión, guiones bajos, basura de ripeo).
function limpiarTitulo(nombre) {
    return String(nombre || '')
        .replace(/\.(mp3|m4a|m4b|flac|wav|ogg|opus|aac|wma)$/i, '') // carpeta llamada «…Grail_Legends.mp3»
        .replace(/97[89][\d-]{10,}/g, ' ')          // ISBN pegado
        .replace(/\[[^\]]*\]/g, ' ')                 // [MP3] [192kbps]…
        .replace(/_/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—_]+|[\s\-–—_]+$/g, '')
        .trim();
}
function tituloPista(nombre) {
    return path.basename(nombre, path.extname(nombre)).replace(/^\d+[\s.\-_]+/, '').replace(/_/g, ' ').trim();
}
// Mejor título de una pista SIN perder la info del nombre de fichero: se usa el título ID3 solo si es un
// TÍTULO DE VERDAD; si es genérico («Disc 01 of 10», «Track 05», «Pista 3») o está vacío, se usa el NOMBRE
// DE FICHERO (sin extensión, sin el prefijo de autor «X -- », guiones bajos → espacios) — que sí distingue.
function mejorTituloPista(meta, nombre) {
    const id3 = ((meta && meta.tituloPista) || '').trim();
    const generico = !id3 || /^(dis[ck]o?|track|pista|cd|part|parte|cara|side|vol(?:umen)?)\.?\s*\d/i.test(id3);
    if (!generico) return id3;
    let n = path.basename(nombre, path.extname(nombre)).replace(/_/g, ' ').trim();
    const partes = n.split(/\s+--\s+/);
    if (partes.length >= 3) n = partes.slice(1).join(' — '); // «Autor -- Obra -- Disco» → «Obra — Disco»
    return n.replace(/\s{2,}/g, ' ').trim() || tituloPista(nombre);
}
// Grupo (obra) a partir del NOMBRE de fichero cuando el libro es una carpeta PLANA con las obras codificadas
// en el nombre («Autor -- Obra -- Disc 01 of 10.mp3» → «Obra»). Así el selector de la playlist separa las
// obras aunque no haya subcarpetas (caso Feynman). null si no sigue ese patrón.
function grupoDeNombre(nombre) {
    const partes = path.basename(nombre, path.extname(nombre)).split(/\s+--\s+/);
    return partes.length >= 3 ? partes[1].replace(/\s{2,}/g, ' ').trim() : null;
}

/**
 * Analiza UN libro (subcarpeta de primer nivel de la colección): devuelve su AUDIOLIBRO (si tiene audio) con
 * la playlist agrupada por apartado/disco + ISBN/Fichero, y sus PDFs (miembros aparte). `files` son los
 * ficheros del libro con `rel` RELATIVO al propio libro.
 */
async function analizarLibro(nombreLibro, files) {
    const audios = files.filter((f) => esAudio(f.nombre)).sort(porRelNat);
    const pdfs = files.filter((f) => esPdf(f.nombre)).sort(porRelNat);
    const imgs = files.filter((f) => esImagen(f.nombre)).sort(porRelNat);

    let audiolibro = null;
    if (audios.length) {
        const metas = [];
        for (const a of audios) metas.push(await leerMetadatosAudio(a.abs));
        const agg = agregarMetadatos(metas);

        // Título del LIBRO: en una colección organizada por carpetas, el NOMBRE DE CARPETA es el título
        // fiable (cada carpeta = un libro). El álbum del ID3 es un respaldo poco fiable aquí (viene con el
        // disco/sección —«[Disc 1]…»— o directamente mal etiquetado: p. ej. «Buddhism» con álbum «The
        // Eastern Way»). Se usa solo si la carpeta no da nada.
        const albums = [...new Set(metas.filter(Boolean).map((m) => m.album).filter(Boolean))];
        let titulo = limpiarTitulo(nombreLibro) || (albums.length === 1 ? albums[0] : null) || 'Audiolibro';
        let autor = agg.autor || null;
        let anio = agg.anio || null;
        let cdu = cduDeGenero(agg.genero);
        let idioma = deducirIdioma([titulo, autor, nombreLibro].filter(Boolean).join(' '));
        let editorial = null, sinopsis = null, dewey = null, lcc = null, ficheroHit = false;

        // ISBN: del NOMBRE de carpeta (…-9781565117358) primero; si no, del código de barras de una imagen.
        let isbn = isbnDeNombre(nombreLibro);
        if (!isbn) { const bi = await leerISBNdeImagenes(imgs.map((f) => ({ abs: f.abs, rel: f.rel, clase: 'portada' }))); isbn = bi?.isbn || null; }
        if (isbn) {
            const f = await buscarEnFicheroLocal({ isbns: [isbn] }).catch(() => null);
            if (f && f.titulo) {
                ficheroHit = true;
                if (!autor && f.autores?.length) autor = f.autores[0];
                if (!anio && f.año_edicion) anio = Number(f.año_edicion) || anio;
                if (f.cdu) cdu = f.cdu;
                if (f.idioma) idioma = f.idioma;
                editorial = f.editorial || null; sinopsis = f.sinopsis || null; dewey = f.dewey || null; lcc = f.lcc || null;
            }
        }

        const pistas = audios.map((f, i) => ({
            rel: f.rel,
            titulo: mejorTituloPista(metas[i], f.nombre), // nunca pierde el nombre de fichero si el ID3 es genérico
            // Grupo = apartado/disco (subcarpeta) o, en carpetas planas, la obra codificada en el nombre.
            grupo: f.rel.includes('/') ? etiquetaGrupo(f.rel.split('/')[0]) : grupoDeNombre(f.nombre),
            duracion: (metas[i] && metas[i].duracion) || null,
        }));
        const portadaImg = imgs.find((f) => /(^|\/)(cover|folder|portada|front)/i.test(f.rel)) || imgs[0] || null;

        audiolibro = {
            titulo, autor, anio, cdu, idioma, isbn, editorial, sinopsis, dewey, lcc, ficheroHit,
            narrador: agg.narrador, genero: agg.genero, coral: agg.coral, duracionTotal: agg.duracionTotal,
            audios: pistas,
            imagenes: imgs.map((f) => ({ rel: f.rel })),
            portadaRel: portadaImg ? portadaImg.rel : null,
        };
    }

    const pdfsOut = pdfs.map((f) => ({ rel: f.rel, titulo: limpiarTitulo(path.basename(f.nombre, path.extname(f.nombre))) }));
    // VÍDEOS: se catalogan como documentos miembro (descargables) → nada de contenido queda invisible.
    const videosOut = files.filter((f) => esVideo(f.nombre)).sort(porRelNat)
        .map((f) => ({ rel: f.rel, titulo: limpiarTitulo(path.basename(f.nombre, path.extname(f.nombre))), ext: path.extname(f.nombre).slice(1).toLowerCase() }));
    // «otros» = ficheros que NO se catalogan pero tampoco son ruido → van al MANIFIESTO (para que se SEPA
    // que están ahí, aunque no tengan visor).
    const otros = files.filter((f) => !esAudio(f.nombre) && !esPdf(f.nombre) && !esVideo(f.nombre) && !esImagen(f.nombre) && !esRuido(f.nombre))
        .map((f) => f.rel);
    return { nombre: nombreLibro, audiolibro, pdfs: pdfsOut, videos: videosOut, otros };
}

/** ¿Es una PARTE (disco/sección) de un libro, y no un libro/colección por sí misma? Discos «[Disc 1]»,
 *  «CD2», «Vol 3», o secciones numeradas «1_Origins…», «1996-Inward_Journey_1». */
function esParte(nombre) {
    return /(^|[\s[(_-])(cd|dis[ck]o?|disque|vol(?:umen)?)\s*\.?\s*\d+/i.test(nombre) || /^\s*\d+[\s._-]/.test(nombre);
}

/**
 * Clasifica una carpeta por su contenido:
 *   'libro' → audiolibro (audio DIRECTO, o subcarpetas con audio que son TODAS partes disco/sección);
 *   'grupo' → colección/autor (sus subcarpetas con audio son LIBROS, no partes);
 *   'pdf'   → sin audio pero con PDFs (p. ej. «Transformations…»: un libro solo-PDF, miembro de la colección);
 *   'vacio' → nada catalogable.
 */
async function clasificar(dir) {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return 'vacio'; }
    ents = ents.filter((e) => !ignorar(e.name));
    if (ents.some((e) => e.isFile() && esAudio(e.name))) return 'libro'; // audio directo
    const subdirs = ents.filter((e) => e.isDirectory());
    const conAudio = [];
    for (const s of subdirs) {
        const fs2 = await listarFicheros(path.join(dir, s.name));
        if (fs2.some((f) => esAudio(f.nombre))) conAudio.push(s.name);
    }
    if (conAudio.length) return conAudio.every(esParte) ? 'libro' : 'grupo';
    return ents.some((e) => e.isFile() && esPdf(e.name)) || (await listarFicheros(dir)).some((f) => esPdf(f.nombre)) ? 'pdf' : 'vacio';
}

/**
 * Recolecta las COLECCIONES de un árbol: una carpeta 'grupo' cuyos hijos incluyen 'libro'/'pdf' ES una
 * colección (nombre = su nombre); un 'grupo' con solo hijos 'grupo' (contenedor de colecciones, p. ej. la
 * carpeta soltada con varios autores) se RECURRE. Así funciona tanto si sueltas un autor como varios.
 */
async function recolectarColecciones(dir, salida) {
    if ((await clasificar(dir)) !== 'grupo') return;
    let ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    ents = ents.filter((e) => e.isDirectory() && !ignorar(e.name));
    const hijos = [];
    for (const e of ents) { const abs = path.join(dir, e.name); hijos.push({ name: e.name, abs, clase: await clasificar(abs) }); }
    const libros = hijos.filter((h) => h.clase === 'libro' || h.clase === 'pdf');
    if (libros.length) salida.push({ nombre: limpiarTitulo(path.basename(dir)), dir, libros });
    for (const g of hijos.filter((h) => h.clase === 'grupo')) await recolectarColecciones(g.abs, salida); // colecciones más profundas
}

/**
 * Analiza una carpeta soltada como una o varias COLECCIONES de audiolibros (sin efectos). Detección
 * recursiva: cada carpeta «padre de libros» es una colección; cada libro (subcarpeta con audio directo o en
 * partes disco/sección, o solo-PDF) es un miembro.
 */
export async function analizarColeccionAudiolibros(dir) {
    const encontradas = [];
    await recolectarColecciones(dir, encontradas);
    const colecciones = [];
    for (const c of encontradas) {
        const miembros = [];
        for (const l of c.libros) {
            const files = await listarFicheros(l.abs);
            miembros.push(await analizarLibro(l.name, files));
        }
        const nAudiolibros = miembros.filter((m) => m.audiolibro).length;
        const nPdfs = miembros.reduce((s, m) => s + m.pdfs.length, 0);
        const nVideos = miembros.reduce((s, m) => s + m.videos.length, 0);
        const nOtros = miembros.reduce((s, m) => s + m.otros.length, 0);
        colecciones.push({ nombre: c.nombre, dir: c.dir, miembros, totales: { audiolibros: nAudiolibros, pdfs: nPdfs, videos: nVideos, otros: nOtros } });
    }
    return { colecciones };
}

// ── INGESTA: copia verbatim + colección + miembros (audiolibros, PDFs, vídeos) + manifiesto ──────────────

const webDe = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');
const posix = (rel) => rel.split('/');
const moda = (vals) => { const c = new Map(); for (const v of vals) if (v) c.set(v, (c.get(v) || 0) + 1); let m = null, n = 0; for (const [v, k] of c) if (k > n) { n = k; m = v; } return m; };
function limpiarUndefined(obj) { const o = {}; for (const [k, v] of Object.entries(obj)) if (v !== undefined) o[k] = v; return o; }

async function resolverEditorialRef(db, nombre) {
    const t = String(nombre || '').trim();
    if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t }, { projection: { _id: 1 } });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}

/**
 * Ingesta REAL de una colección de audiolibros. Por cada colección detectada: copia su carpeta VERBATIM a
 * `<cdu>/audiolibros/<colección>/`, crea la `colección` y sus MIEMBROS (un audiolibro por libro con su
 * playlist; un doc por PDF; un doc por VÍDEO —descargable— para que NADA quede invisible), escribe un
 * MANIFIESTO de lo no catalogable, y solo tras VERIFICAR la copia recicla el origen. AÑADIR siempre, BORRAR
 * nunca: los duplicados por título se CONSERVAN (no se fusionan).
 */
export async function ingestarColeccionAudiolibros(dir, { db: dbArg, reciclarOrigen = true } = {}) {
    const db = dbArg || await conectarDB();
    const { colecciones } = await analizarColeccionAudiolibros(dir);
    if (!colecciones.length) return { ok: false, motivo: 'no se detectó ninguna colección de audiolibros' };

    const bib = db.collection('biblioteca');
    const resultados = [];

    for (const c of colecciones) {
        // Anti-duplicados: colección con ese nombre Y con miembros → no re-catalogar (evita duplicar la copia).
        const prev = await db.collection('colecciones').findOne(
            { nombre: c.nombre }, { collation: { locale: 'es', strength: 1 }, projection: { _id: 1 } });
        if (prev && (await bib.countDocuments({ coleccion: prev._id })) > 0) {
            resultados.push({ coleccion: c.nombre, ok: false, permanente: true, motivo: 'ya existe (no se re-cataloga)' });
            continue;
        }

        // CDU / idioma de la colección: los más comunes entre sus audiolibros (o por defecto).
        const cdu = moda(c.miembros.map((m) => m.audiolibro?.cdu)) || '82';
        const idiomaCol = moda(c.miembros.map((m) => m.audiolibro?.idioma)) || 'es';
        const segs = arbolCDU(cdu).segmentos;
        const carpetaCol = path.join(DIR_CDU, ...segs, 'audiolibros', c.nombre);
        const webCol = webDe(carpetaCol);

        // 1) COPIA VERBATIM + verificación (conserva el origen si el origen aún cambiaba).
        const { integra, huella: copiado } = await copiarVerificado(c.dir, carpetaCol);
        if (!integra) { resultados.push({ coleccion: c.nombre, ok: false, motivo: 'copia no íntegra (origen aún cambiaba): se conserva el origen' }); continue; }
        await fs.writeFile(path.join(carpetaCol, MARCA_RUTA_FIJA), `coleccion-audiolibros: ${c.nombre}\n`).catch(() => {});

        // 2) Colección.
        const { _id: colId } = await resolverCabecera(db, {
            nombre: c.nombre, tipo: 'audiolibros', cdu,
            descripcion: `Colección de audiolibros · ${c.totales.audiolibros} audiolibro(s) · ${c.totales.pdfs} PDF(s)${c.totales.videos ? ` · ${c.totales.videos} vídeo(s)` : ''}.`,
        });
        await db.collection('colecciones').updateOne({ _id: colId }, { $set: { raiz_web: webCol, ruta_fija: true } });

        const base = (extra) => limpiarUndefined({
            cdu, idioma: idiomaCol, ubicacion: { ambito: 'Sin asignar', estanteria: 'Sin asignar' },
            coleccion: colId, coleccion_nombre: c.nombre, ruta_fija: true, estado_verificacion: 'completado',
            fecha_ingreso: new Date(), fecha_creacion: new Date(), ...extra,
        });
        const cacheAutor = new Map();
        const resolverAutor = async (nombre) => {
            if (!nombre) return [];
            if (!cacheAutor.has(nombre)) { const r = await resolverPersona(db, nombre).catch(() => null); cacheAutor.set(nombre, r?._id || null); }
            const id = cacheAutor.get(nombre);
            return id ? [id] : [];
        };

        let insertados = 0;
        const manifiesto = [];
        for (const m of c.miembros) {
            const webLibro = `${webCol}/${m.nombre}`;
            const absLibro = path.join(carpetaCol, m.nombre);

            // 3a) AUDIOLIBRO del libro.
            if (m.audiolibro) {
                const a = m.audiolibro;
                const _id = new ObjectId();
                const autores = await resolverAutor(a.coral ? null : a.autor);
                const editorial = a.editorial ? await resolverEditorialRef(db, a.editorial) : null;
                const audios = a.audios.map((x, i) => ({ ruta: `${webLibro}/${x.rel}`, titulo: x.titulo, orden: i + 1, grupo: x.grupo || undefined, duracion: x.duracion || undefined }));
                const imagenes = a.imagenes.map((im) => ({ ruta: `${webLibro}/${im.rel}`, tipo: (a.portadaRel && im.rel === a.portadaRel) ? 'portada' : 'otra' }));
                await bib.insertOne(base({
                    _id, tipo_recurso: 'libro', naturaleza: 'audiolibro', titulo: a.titulo, cdu: a.cdu, idioma: a.idioma,
                    formatos: ['audio'], autores: autores.length ? autores : undefined, editorial: editorial || undefined,
                    isbn: a.isbn || undefined, 'año_edicion': a.anio || undefined, dewey: a.dewey || undefined, lcc: a.lcc || undefined,
                    sinopsis: a.sinopsis || undefined, narrador: a.narrador || undefined,
                    ruta_base: webLibro, portada: a.portadaRel ? `${webLibro}/${a.portadaRel}` : undefined,
                    imagenes: imagenes.length ? imagenes : undefined, audios,
                }));
                await indexarDoc(db, _id).catch(() => {});
                insertados++;
            }

            // 3b) PDFs del libro → documentos miembro (portada = 1ª página rasterizada).
            for (const p of m.pdfs) {
                const _id = new ObjectId();
                const d = path.posix.dirname(p.rel);
                const rutaBase = d === '.' ? webLibro : `${webLibro}/${d}`;
                const absPdf = path.join(absLibro, ...posix(p.rel));
                const portada = await renderizarPortadaMiembro(absPdf, carpetaCol, webCol, _id);
                await bib.insertOne(base({
                    _id, tipo_recurso: 'libro', titulo: p.titulo, formatos: ['pdf'],
                    ruta_base: rutaBase, nombre_archivo: path.basename(p.rel), portada: portada || undefined,
                }));
                await indexarDoc(db, _id).catch(() => {});
                insertados++;
            }

            // 3c) VÍDEOS del libro → documentos miembro (descargables; sin visor, pero VISIBLES → no se pierden).
            for (const v of m.videos) {
                const _id = new ObjectId();
                const d = path.posix.dirname(v.rel);
                const rutaBase = d === '.' ? webLibro : `${webLibro}/${d}`;
                await bib.insertOne(base({
                    _id, tipo_recurso: 'libro', naturaleza: 'video', titulo: v.titulo, formatos: ['video'],
                    ruta_base: rutaBase, nombre_archivo: path.basename(v.rel),
                }));
                await indexarDoc(db, _id).catch(() => {});
                insertados++;
            }

            for (const o of m.otros) manifiesto.push(`${m.nombre}/${o}`);
        }

        // 4) MANIFIESTO de lo NO catalogado (para que se sepa que está ahí). Se escribe SIEMPRE (aunque vacío,
        //    deja constancia de que se revisó). Va en la raíz de la colección (ruta_fija, no se poda).
        const manif = [
            `Colección: ${c.nombre}`,
            `Catalogado: ${c.totales.audiolibros} audiolibro(s), ${c.totales.pdfs} PDF(s), ${c.totales.videos} vídeo(s).`,
            '',
            manifiesto.length ? `Ficheros PRESERVADOS pero NO catalogados (${manifiesto.length}) — están aquí, en esta carpeta:` : 'No hay ficheros sin catalogar.',
            ...manifiesto.map((x) => `  · ${x}`),
        ].join('\n');
        await fs.writeFile(path.join(carpetaCol, '_contenido.txt'), manif + '\n').catch(() => {});

        // 5) Reciclar el origen SOLO si no cambió desde la copia.
        let reciclado = false;
        if (reciclarOrigen) {
            const ahora = await huella(c.dir);
            if (ahora.n === copiado.n && ahora.bytes === copiado.bytes) { await reciclarCarpeta(c.dir, 'coleccion-audiolibros').catch(() => {}); reciclado = true; }
        }
        resultados.push({ coleccion: c.nombre, ok: true, insertados, videos: c.totales.videos, sinCatalogar: manifiesto.length, web: webCol, reciclado });
    }

    const ok = resultados.some((r) => r.ok);
    const permanente = !ok && resultados.length > 0 && resultados.every((r) => r.permanente);
    return { ok, resultados, permanente };
}
