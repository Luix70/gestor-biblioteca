/**
 * AUDIOLIBRO PURO — una carpeta cuyo contenido es esencialmente AUDIO (sin PDFs de lectura estructurados) se
 * cataloga como UN documento `naturaleza:'audiolibro'` (no una colección): todas las pistas van como PLAYLIST
 * y TODAS las imágenes que la acompañan (portada, contraportada, escaneos del libreto) al CARRUSEL — nada se
 * pierde. Es el «caso particular de transmedia sin PDF de lectura».
 *
 * Identificación 100% barata y SIN IA, por orden:
 *   1) TAGS de audio (music-metadata): `album`→título, `artist`/`albumartist`→autor, `year`→año,
 *      `comment`→narrador. Es la fuente principal (ver utils/lector-audio.js).
 *   2) NOMBRE de carpeta (limpiando basura de ripeo: «[Livre audio]», «[MP3]», «[192kbps]», «(CD MP3)»,
 *      «.partN») → corrobora/rellena autor·título·año.
 *   3) (Siguiente fase) código de barras de la CONTRAPORTADA → EAN/ISBN → Fichero/APIs para la edición.
 *
 * Principio rector, como en transmedia: AÑADIR siempre, BORRAR nunca, VERIFICAR la copia íntegra ANTES de
 * reciclar el origen. La estructura de disco se conserva VERBATIM (ruta_fija) — CDs y libreto intactos.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { DIR_CDU, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { arbolCDU } from './cdu-arbol.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { decodificarCodigoBarras } from './codigo-barras.js';
import { indexarDoc } from './indice-busqueda.js';
import { agregarMetadatos, esAudio, leerMetadatosAudio } from './lector-audio.js';
import { leerBarrasLocal } from './lector-barras-local.js';
import { reciclarCarpeta } from './papelera.js';
import { resolverPersona } from './resolver-persona.js';
import { copiarVerificado, huella } from './transmedia.js';

const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff'];
const esImagen = (n) => EXT_IMG.includes(path.extname(n).toLowerCase());
const esPdf = (n) => path.extname(n).toLowerCase() === '.pdf';
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || /^thumbs\.db$/i.test(n);

const webDe = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');

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

// ── Nombre de carpeta → autor / título / año (fuente de respaldo del ID3) ────────────────────────────────

/** Quita la basura de ripeo del nombre de carpeta: «[Livre audio] Alain FOURNIER - Le Grand Meaulnes [MP3]
 *  [192kbps].part1» → «Alain FOURNIER - Le Grand Meaulnes». */
export function limpiarNombreCarpeta(nombre) {
    return String(nombre || '')
        .replace(/\.(part\d+|rar|zip|7z)$/i, '')          // sufijo de archivo/multiparte
        .replace(/\[[^\]]*\]/g, ' ')                       // [Livre audio] [MP3] [192kbps]…
        .replace(/\((?:cd|mp3|audio|audiolibro|flac|m4b|wma|ogg|kbps)[^)]*\)/gi, ' ') // (CD MP3), (audio)…
        .replace(/\b(cd\s*mp3|mp3|flac|\d+\s*kbps|vbr|cbr)\b/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/^[\s\-–—_]+|[\s\-–—_]+$/g, '')
        .trim();
}

/** Extrae {autor, titulo, anio} de un nombre de carpeta ya limpio. Formatos: «Autor - Título»,
 *  «Año - Título», «Autor Año - Título». El año es cualquier 19xx/20xx. */
export function parseCarpeta(nombre) {
    const limpio = limpiarNombreCarpeta(nombre);
    const anio = (limpio.match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;
    let autor = null, titulo = limpio;
    const i = limpio.indexOf(' - ');
    if (i > 0) {
        const izq = limpio.slice(0, i).trim();
        const der = limpio.slice(i + 3).trim();
        titulo = der || izq;
        // La izquierda es el autor SALVO que sea solo el año (p. ej. «2009 - From Shakespeare With Love»).
        const izqSinAnio = izq.replace(/\b(?:19|20)\d{2}\b/g, '').replace(/[\s\-–—]+$/g, '').trim();
        if (izqSinAnio) autor = izqSinAnio;
    }
    // Quita el año del título si quedó pegado.
    if (anio) titulo = titulo.replace(new RegExp('\\b' + anio + '\\b', 'g'), '').replace(/\s{2,}/g, ' ').trim();
    return { autor, titulo: titulo || limpio, anio: anio ? Number(anio) : null };
}

// CDU deducida (editable) a partir del género del ID3. Por defecto 82 (Literatura).
function cduDeGenero(genero) {
    const g = String(genero || '').toLowerCase();
    if (/poetry|poes[íi]a|vers/.test(g)) return '82-1';
    if (/biograph|biograf[íi]a/.test(g)) return '929';
    if (/drama|teatro|play/.test(g)) return '82-2';
    return '82';
}

// Idioma DEDUCIDO (editable): heurística ligera por acentos/palabras. No es autoritativo.
function deducirIdioma(texto) {
    const t = ' ' + String(texto || '').toLowerCase() + ' ';
    if (/[ñ¿¡]|\b(por|del|los|las|mismo|él|según|niño)\b/.test(t)) return 'es';
    if (/[çœ]|\b(le|la|les|grand|livre|français|é\w+)\b/.test(t)) return 'fr';
    return 'en';
}

// Título limpio de una pista a partir del nombre de fichero, si el ID3 no trae título.
function tituloPistaDeArchivo(nombre) {
    return path.basename(nombre, path.extname(nombre))
        .replace(/^\d+[\s.\-]+/, '')      // «01 - », «1-01 »
        .replace(/\s*\[\d+\]\s*$/, '')
        .trim();
}

// Clasifica una imagen por su nombre: portada frontal / contraportada / libreto.
function claseImagen(nombre) {
    const n = nombre.toLowerCase();
    if (/back|trasera|contra|reverso/.test(n)) return 'contraportada';
    if (/front|frontal|cover|portada|car[áa]tula|caratula/.test(n)) return 'portada';
    return 'libreto';
}

/**
 * Lee un ISBN del CÓDIGO DE BARRAS de las imágenes (zxing local, sin IA). Prioriza contraportada → portada →
 * última del libreto (donde suele ir el EAN). Máx 3 intentos. Best-effort: null si no hay barras / no disponible.
 * @param {Array<{abs:string,rel:string,clase:string}>} imagenes
 */
async function leerISBNdeImagenes(imagenes) {
    const orden = [
        ...imagenes.filter((i) => i.clase === 'contraportada'),
        ...imagenes.filter((i) => i.clase === 'portada'),
        ...imagenes.filter((i) => i.clase === 'libreto').slice(-1),
    ].slice(0, 3);
    for (const im of orden) {
        try {
            const buf = await fs.readFile(im.abs);
            const r = await leerBarrasLocal([buf]);
            const dec = r ? decodificarCodigoBarras(r.codigo_barras) : null;
            if (dec?.isbn) return { isbn: dec.isbn, imagen: im.rel };
        } catch { /* siguiente imagen */ }
    }
    return null;
}

// ── ANÁLISIS (sin efectos: no copia, no toca la BD) ──────────────────────────────────────────────────────

/**
 * Detecta las UNIDADES-audiolibro dentro de una carpeta soltada:
 *   · si hay audio DIRECTAMENTE en la carpeta → ella misma es UN audiolibro (con sus CDs/imágenes debajo);
 *   · si el audio solo está en subcarpetas → cada subcarpeta inmediata con audio es un audiolibro (contenedor,
 *     p. ej. «53.Audiolibros» con cuatro dentro).
 */
async function detectarUnidades(dir) {
    const files = await listarFicheros(dir);
    const audios = files.filter((f) => esAudio(f.nombre));
    if (!audios.length) return [];
    const directos = audios.some((a) => !a.rel.includes('/'));
    if (directos) return [{ carpeta: dir, nombre: path.basename(dir), files }];
    const hijos = [...new Set(audios.map((a) => a.rel.split('/')[0]))];
    return hijos.map((h) => ({
        carpeta: path.join(dir, h),
        nombre: h,
        files: files.filter((f) => f.rel === h || f.rel.startsWith(h + '/')).map((f) => ({
            ...f, rel: f.rel.slice(h.length + 1) || f.nombre,
        })),
    }));
}

/** Plan de UN audiolibro a partir de sus ficheros (audios ordenados, imágenes, metadatos agregados). */
async function planUnidad(unidad) {
    const audiosF = unidad.files.filter((f) => esAudio(f.nombre))
        .sort((a, b) => a.rel.localeCompare(b.rel, 'es', { numeric: true })); // orden natural: CD1/01, CD1/02, CD2/01…
    const imagenesF = unidad.files.filter((f) => esImagen(f.nombre))
        .sort((a, b) => a.rel.localeCompare(b.rel, 'es', { numeric: true }));
    const pdfsF = unidad.files.filter((f) => esPdf(f.nombre));

    // Metadatos: se leen TODAS las pistas (para dar título propio a cada una en la playlist) y se agregan.
    const metas = [];
    for (const a of audiosF) metas.push(await leerMetadatosAudio(a.abs));
    const agg = agregarMetadatos(metas);

    // Título/autor/año: ID3 primero, nombre de carpeta como respaldo.
    const deCarpeta = parseCarpeta(unidad.nombre);
    let titulo = agg.titulo || deCarpeta.titulo || limpiarNombreCarpeta(unidad.nombre);
    let autor = agg.autor || deCarpeta.autor || null;
    let anio = agg.anio || deCarpeta.anio || null;
    let cdu = cduDeGenero(agg.genero);
    let idioma = deducirIdioma([titulo, autor, unidad.nombre].filter(Boolean).join(' '));

    // Imágenes clasificadas (con ruta absoluta, para leer el código de barras).
    const imagenes = imagenesF.map((f) => ({ abs: f.abs, rel: f.rel, clase: claseImagen(f.nombre) }));

    // ISBN por CÓDIGO DE BARRAS de la contra/portada (zxing local, sin IA) → PIVOTE al Fichero (OL+BNE):
    // rescata edición/autor/editorial/CDU/idioma/sinopsis, sobre todo cuando el ID3 no da autor (audiolibros
    // «corales» como los sonetos). CONSERVADOR: los datos del ID3/carpeta MANDAN; el Fichero solo RELLENA
    // huecos, salvo la CDU y el idioma, donde el dato AUTORITATIVO del Fichero gana a la deducción
    // (por género / por acentos) que es solo una estimación.
    const isbnInfo = await leerISBNdeImagenes(imagenes);
    let editorial = null, sinopsis = null, dewey = null, lcc = null, ficheroHit = false;
    if (isbnInfo) {
        const f = await buscarEnFicheroLocal({ isbns: [isbnInfo.isbn] }).catch(() => null);
        if (f && f.titulo) {
            ficheroHit = true;
            if (!autor && f.autores?.length) autor = f.autores[0];
            if (!anio && f.año_edicion) anio = Number(f.año_edicion) || anio;
            if (f.cdu) cdu = f.cdu;                 // CDU autoritativa > deducción por género
            if (f.idioma) idioma = f.idioma;         // idioma autoritativo > heurística
            editorial = f.editorial || null;
            sinopsis = f.sinopsis || null;
            dewey = f.dewey || null;
            lcc = f.lcc || null;
        }
    }

    // Portada: la imagen marcada «frontal/cover»; si no, la primera; si tampoco hay imágenes, la embebida.
    const portadaImg = imagenes.find((i) => i.clase === 'portada') || imagenes[0] || null;

    // Playlist: título de pista del ID3 (`common.title`) si lo hay; si no, el nombre de fichero aseado.
    const audios = audiosF.map((f, i) => ({
        rel: f.rel,
        titulo: (metas[i] && metas[i].tituloPista) || tituloPistaDeArchivo(f.nombre),
    }));

    return {
        carpeta: unidad.carpeta,
        nombreCarpeta: unidad.nombre,
        titulo, autor, anio, cdu, idioma,
        isbn: isbnInfo?.isbn || null, editorial, sinopsis, dewey, lcc, ficheroHit,
        narrador: agg.narrador, genero: agg.genero, coral: agg.coral, autorFuente: agg.autorFuente,
        duracionTotal: agg.duracionTotal,
        tienePortadaEmbebida: !!agg.portadaEmbebida,
        portadaEmbebida: agg.portadaEmbebida,   // {buffer,mime} o null (solo en ingesta)
        audios,
        imagenes: imagenes.map((i) => ({ rel: i.rel, clase: i.clase })),
        portadaRel: portadaImg ? portadaImg.rel : null,
        pdfs: pdfsF.map((f) => f.rel),
    };
}

/** Analiza una carpeta soltada y devuelve el PLAN (una o varias unidades-audiolibro). Sin efectos. */
export async function analizarAudiolibro(dir) {
    const unidades = await detectarUnidades(dir);
    const planes = [];
    for (const u of unidades) planes.push(await planUnidad(u));
    return { dir, unidades: planes };
}

/** ¿La carpeta es (o contiene) un audiolibro? Heurística: hay audio y NO hay PDFs de lectura estructurados
 *  (una obra suelta puede traer 1 PDF de texto; muchos PDFs = otra cosa —libro/transmedia—). */
export async function esCarpetaAudiolibro(dir) {
    const files = await listarFicheros(dir);
    const audios = files.filter((f) => esAudio(f.nombre));
    const pdfs = files.filter((f) => esPdf(f.nombre));
    return audios.length > 0 && pdfs.length <= 1;
}

// ── INGESTA (copia verbatim + 1 documento por audiolibro) ────────────────────────────────────────────────

const DIR_PORTADAS = '.portadas';

/**
 * Ingesta REAL: por cada audiolibro detectado copia su carpeta VERBATIM a `<cdu>/audiolibros/<carpeta>/`,
 * crea UN documento `naturaleza:'audiolibro'` (playlist + carrusel con TODAS las imágenes) y, tras VERIFICAR
 * la copia, recicla el origen. No borra ni fusiona: un re-drop del mismo título se omite (anti-duplicados).
 */
export async function ingestarAudiolibro(dir, { db: dbArg, reciclarOrigen = true } = {}) {
    const db = dbArg || await conectarDB();
    const { unidades } = await analizarAudiolibro(dir);
    if (!unidades.length) return { ok: false, motivo: 'no se encontró audio que catalogar' };

    const bib = db.collection('biblioteca');
    const resultados = [];
    let algunoConservado = false;

    for (const u of unidades) {
        // Anti-duplicados: si ya hay un audiolibro con ese título, no se re-cataloga (evita duplicar la copia).
        const previo = await bib.findOne(
            { naturaleza: 'audiolibro', titulo: u.titulo },
            { collation: { locale: 'es', strength: 1 }, projection: { _id: 1 } });
        if (previo) { resultados.push({ titulo: u.titulo, ok: false, motivo: 'ya catalogado' }); continue; }

        // Destino: <árbol CDU>/audiolibros/<nombre-carpeta>/ (estructura interna verbatim).
        const segsCdu = arbolCDU(u.cdu).segmentos;
        const carpetaDest = path.join(DIR_CDU, ...segsCdu, 'audiolibros', u.nombreCarpeta);
        const webDest = webDe(carpetaDest);

        const { integra, huella: copiado } = await copiarVerificado(u.carpeta, carpetaDest);
        if (!integra) { resultados.push({ titulo: u.titulo, ok: false, motivo: 'copia no íntegra (origen aún cambiaba): se conserva el origen' }); algunoConservado = true; continue; }
        await fs.writeFile(path.join(carpetaDest, MARCA_RUTA_FIJA), `audiolibro: ${u.titulo}\n`).catch(() => {});

        const _id = new ObjectId();
        const webRel = (rel) => `${webDest}/${rel}`;

        // Imágenes del carrusel = TODAS las que acompañan (portada primero, contraportada al final).
        const orden = { portada: 0, libreto: 1, contraportada: 2 };
        const imgs = [...u.imagenes].sort((a, b) => (orden[a.clase] - orden[b.clase]));
        const imagenes = imgs.map((im) => ({ ruta: webRel(im.rel), tipo: im.clase === 'portada' ? 'portada' : 'otra' }));
        let portada = u.portadaRel ? webRel(u.portadaRel) : null;

        // Si NO había imágenes sueltas pero SÍ carátula embebida en el audio, se extrae a `.portadas/`.
        if (!portada && u.portadaEmbebida) {
            const dirP = path.join(carpetaDest, DIR_PORTADAS);
            await fs.mkdir(dirP, { recursive: true }).catch(() => {});
            const nom = `${_id}.${(u.portadaEmbebida.mime || 'image/jpeg').includes('png') ? 'png' : 'jpg'}`;
            await fs.writeFile(path.join(dirP, nom), u.portadaEmbebida.buffer).catch(() => {});
            portada = `${webDest}/${DIR_PORTADAS}/${nom}`;
            imagenes.unshift({ ruta: portada, tipo: 'portada' });
        }

        const audios = u.audios.map((a, i) => ({ ruta: webRel(a.rel), titulo: a.titulo, orden: i + 1 }));
        // Se resuelve el autor SIEMPRE que lo haya (incluido el que aportó el Fichero por ISBN a un audiolibro
        // coral): u.autor ya viene vacío si no había fuente fiable → nunca se inventa.
        const autores = u.autor ? await resolverAutor(db, u.autor) : [];
        const editorial = u.editorial ? await resolverEditorialRef(db, u.editorial) : null;
        const tienePdf = u.pdfs.length > 0;

        const doc = limpiarUndefined({
            _id,
            tipo_recurso: 'libro', naturaleza: 'audiolibro',
            titulo: u.titulo, cdu: u.cdu, idioma: u.idioma,
            formatos: tienePdf ? ['audio', 'pdf'] : ['audio'],
            ubicacion: { ambito: 'Sin asignar', estanteria: 'Sin asignar' },
            autores: autores.length ? autores : undefined,
            editorial: editorial || undefined,
            isbn: u.isbn || undefined,           // del código de barras de la contraportada
            'año_edicion': u.anio || undefined,
            dewey: u.dewey || undefined, lcc: u.lcc || undefined,
            sinopsis: u.sinopsis || undefined,
            narrador: u.narrador || undefined,
            ruta_base: webDest,
            // Si trae PDF del texto, se abre en el visor; se apunta el 1er PDF como archivo principal.
            nombre_archivo: tienePdf ? path.basename(u.pdfs[0]) : undefined,
            portada: portada || undefined,
            imagenes: imagenes.length ? imagenes : undefined,
            audios,
            ruta_fija: true, estado_verificacion: 'completado',
            fecha_ingreso: new Date(), fecha_creacion: new Date(),
        });
        await bib.insertOne(doc);
        await indexarDoc(db, _id).catch(() => {});

        // Reciclar el origen SOLO si no cambió desde la copia (por si aún se estaba escribiendo).
        let origenReciclado = false;
        if (reciclarOrigen) {
            const ahora = await huella(u.carpeta);
            if (ahora.n === copiado.n && ahora.bytes === copiado.bytes) {
                // Si la carpeta soltada ERA la unidad, se recicla ella; si era un contenedor, solo esta subcarpeta.
                await reciclarCarpeta(u.carpeta, 'audiolibro-ingerido').catch(() => {});
                origenReciclado = true;
            }
        }
        resultados.push({ titulo: u.titulo, ok: true, autores: autores.length, audios: audios.length, imagenes: imagenes.length, web: webDest, origenReciclado });
    }

    const ok = resultados.some((r) => r.ok);
    return { ok, resultados, algunoConservado };
}

/** Resuelve un nombre de autor → [ObjectId] (check-then-create). Best-effort. */
async function resolverAutor(db, nombre) {
    const r = await resolverPersona(db, nombre).catch(() => null);
    return r?._id ? [r._id] : [];
}

/** Resuelve un nombre de editorial → ObjectId (check-then-create). El $jsonSchema exige ObjectId, no string. */
async function resolverEditorialRef(db, nombre) {
    const t = String(nombre || '').trim();
    if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t }, { projection: { _id: 1 } });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}

function limpiarUndefined(obj) {
    const salida = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) salida[k] = v;
    return salida;
}
