/**
 * INGESTA TRANSMEDIA — una estructura de carpetas (p. ej. «Oxford Bookworms Library»: PDFs de lectura +
 * tests/ejercicios/soluciones + audios + portadas) se cataloga como UNA colección cuya estructura de disco
 * se conserva VERBATIM, colgando de una sola rama CDU. NO se reorganiza nada.
 *
 * Principio rector: AÑADIR siempre, BORRAR nunca, VERIFICAR la copia íntegra ANTES de borrar el origen.
 * Cada PDF es un documento PLANO miembro de la colección, con `ruta_fija:true` (Integridad/Conformador no
 * lo mueven ni podan) y etiquetas `nivel` (Stage) · `unidad` (el libro) · `rol_material` (lectura / test /
 * ejercicios / solucionario / glosario / guia). Los audios de cada unidad se enlazan (`audios[]`) para
 * reproducirlos. Una unidad con audio y SIN PDF de lectura = audiolibro (`naturaleza:'audiolibro'`).
 *
 * Identificación 100% ESTRUCTURAL, SIN IA (una colección puede tener cientos de PDFs): autor/título del
 * nombre de la carpeta de unidad, nivel de la carpeta «Stage N», rol del nombre/subcarpeta.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { DIR_CDU, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { arbolCDU } from './cdu-arbol.js';
import { resolverCabecera } from './colecciones.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { indexarDoc } from './indice-busqueda.js';
import { reciclarCarpeta } from './papelera.js';
import { rasterizarPaginas } from './rasterizar-pdf.js';
import { resolverPersona } from './resolver-persona.js';
import { esAudio } from './lector-audio.js'; // FUENTE ÚNICA de extensiones de audio (ampliada: Audible .aax/.aa, etc.)
import { esDocumentoLeible, esImagenArchivo, esMaterialNotable, esVideo, formatoDocumento } from './criba-material.js';
import { leerGuia } from './guia-ingesta.js'; // pistas del reproceso (principal fijado + soloAdmin de adjuntos)

// Subcarpeta OCULTA con las portadas DERIVADAS (1ª página rasterizada). El prefijo «.» hace que `ignorar`
// (y por tanto `huella`/`listarFicheros`) la salten → no cuenta en la verificación de la copia ni «altera»
// la estructura visible; queda dentro del subárbol `ruta_fija`, así que Integridad tampoco la poda.
const DIR_PORTADAS = '.portadas';
const ext = (n) => path.extname(n).toLowerCase();
const esPdf = (n) => ext(n) === '.pdf';
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#');

/**
 * Renderiza la 1ª página de un PDF como portada JPEG en `<colección>/.portadas/<id>.jpg` y devuelve su ruta
 * web (`/recursos/…`) o null. BEST-EFFORT: si no hay pdftoppm o el PDF es ilegible, devuelve null sin romper
 * la ingesta (el doc se queda con el icono genérico, recuperable luego). Da portada PROPIA a materiales/guías
 * (evita heredar —repetida— la `cover.jpg` del lector) y a los que no tienen `cover.jpg`.
 */
export async function renderizarPortadaMiembro(absPdf, carpetaColeccion, webColeccion, id) {
    try {
        const [primera] = await rasterizarPaginas(absPdf, { numPaginas: 1 });
        if (!primera?.buffer) return null;
        const dir = path.join(carpetaColeccion, DIR_PORTADAS);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, `${id}.jpg`), primera.buffer);
        return `${webColeccion}/${DIR_PORTADAS}/${id}.jpg`;
    } catch {
        return null;
    }
}

// Segmentos web (/recursos/...) de una ruta absoluta dentro del árbol CDU.
const webDe = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');

/** Recorre un árbol y devuelve TODOS los ficheros con su ruta relativa a `raiz` (POSIX). Nunca lanza. */
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

// Contenido INTERACTIVO (CD-ROM: ejecutable, Flash, bundle .app…): se preserva verbatim como transmedia
// (no se cataloga, pero NO se pierde ni se altera —romper la estructura lo inutilizaría—). autorun.inf es la
// firma clásica de un CD autoejecutable.
const EXT_INTERACTIVO = ['.exe', '.swf', '.dll', '.bat', '.cmd', '.msi', '.dmg', '.jar'];
const esInteractivo = (f) => EXT_INTERACTIVO.includes(ext(f.nombre)) || /^autorun\.inf$/i.test(f.nombre) || /(^|\/)[^/]+\.app\//i.test(f.rel);
// Segmento de carpeta «Stage N» o fichero con prefijo «Sx » (estructura de lecturas graduadas).
const RE_ESTRUCTURA = new RegExp('(^|/)(stage\\s*\\d+|s\\d+[\\s.\\-])', 'i');

// Nº MÁXIMO de documentos legibles para que un fichero INTERACTIVO (.exe/.dll/.swf/.jar/autorun…) declare la
// carpeta «transmedia». Por encima, NO es un CD-ROM interactivo: es una BIBLIOTECA con un accesorio colado (un
// .dll, un instalador, un .jar de muestra…) → hay que catalogar cada libro por su cuenta y que el interactivo
// viaje como material, no fundir cientos de libros en UNA transmedia.
//   ⚠ INCIDENTE que lo motivó (2026-07-24): una carpeta de ~600 libros de matemáticas se catalogó como UNA
//     sola colección transmedia porque contenía UN fichero interactivo. La señal «hay un .exe» ganaba a la
//     evidencia abrumadora de «hay 594 documentos independientes».
//   · Los transmedia legítimos con MUCHOS documentos (Oxford Bookworms, 887) NO dependen de esta señal: los
//     detecta la ESTRUCTURA «Stage N», que es específica y no se toca.
//   · Los interactivos legítimos (un CD-ROM) tienen POCOS o CERO documentos legibles (54.Contenido Interactivo
//     = 0), así que siguen detectándose.
const MAX_DOCS_PARA_INTERACTIVO = 12;
/** ¿El contenido INTERACTIVO es la ESENCIA de la carpeta y no un accesorio colado entre muchos documentos? */
function interactivoEsEsencia(ficheros) {
    if (!ficheros.some(esInteractivo)) return false;
    const nDocs = ficheros.filter((f) => esDocumentoLeible(f.nombre)).length;
    return nDocs <= MAX_DOCS_PARA_INTERACTIVO;
}

/**
 * ¿Una carpeta es un TRANSMEDIA (colección de estructura preservada, no un audiolibro suelto)? Es transmedia si:
 *   · trae un marcador `.transmedia`, o
 *   · contiene CONTENIDO INTERACTIVO (.exe/.swf/.app/autorun…), que hay que preservar íntegro, o
 *   · tiene AUDIO **con estructura** de colección (≥2 PDFs de lectura, o carpetas «Stage N»).
 * El audio SUELTO (0-1 PDF, sin estructura) NO es transmedia: es un audiolibro → lo enruta `esCarpetaAudiolibro`.
 */
export async function esCarpetaTransmedia(dir) {
    try { if (await fs.access(path.join(dir, '.transmedia')).then(() => true, () => false)) return true; } catch { /* */ }
    const ficheros = await listarFicheros(dir);
    if (interactivoEsEsencia(ficheros)) return true;   // interactivo ESENCIAL (no un accesorio entre 600 libros)
    const audios = ficheros.filter((f) => esAudio(f.nombre));
    const pdfs = ficheros.filter((f) => esPdf(f.nombre));
    const hayEstructura = ficheros.some((f) => RE_ESTRUCTURA.test(f.rel));
    return audios.length > 0 && (pdfs.length >= 2 || hayEstructura);
}

/**
 * Señales FUERTES de transmedia que DEBEN ganar a «colección de audiolibros» en el enrutado del vigilante:
 * marcador `.transmedia`, contenido INTERACTIVO (CD-ROM) o ESTRUCTURA de lecturas graduadas («Stage N»). El
 * caso débil (audio + ≥2 PDFs SIN estructura) se deja para `esCarpetaTransmedia`, DESPUÉS de descartar que
 * sea una colección de audiolibros (donde el audio es el protagonista y el PDF una guía).
 */
export async function esTransmediaFuerte(dir) {
    try { if (await fs.access(path.join(dir, '.transmedia')).then(() => true, () => false)) return true; } catch { /* */ }
    const ficheros = await listarFicheros(dir);
    return interactivoEsEsencia(ficheros) || ficheros.some((f) => RE_ESTRUCTURA.test(f.rel));
}

// ── Deducción de metadatos ESTRUCTURALES (sin IA) ──────────────────────────────────────────────────────

/** Nivel de dificultad: un segmento «Stage N» o un prefijo «SN » en la carpeta de unidad → «Stage N». */
function nivelDe(segmentos) {
    for (const s of segmentos) {
        const m = s.match(/stage\s*(\d+)/i) || s.match(/^S(\d+)\b/i);
        if (m) return `Stage ${m[1]}`;
    }
    return null;
}

/** Rol del material a partir de la ruta+nombre (Activities/Tests → test; Exercise Answers → solucionario…). */
function rolMaterial(rutaLower) {
    if (/exercise answers|answer key/.test(rutaLower)) return 'solucionario';
    if (/\btests?\b/.test(rutaLower)) return 'test';
    if (/activity worksheet|worksheets?\b/.test(rutaLower)) return 'ejercicios';
    if (/glossary|glosario/.test(rutaLower)) return 'glosario';
    if (/teaching tool kit|syllabus|introducing|welcome to|using the|resources for|chart|readers \[/.test(rutaLower)) return 'guia';
    return 'lectura';
}

/** Autor y título de la carpeta de unidad: «S0 Christine Lindop - Red Roses» → {autor, titulo}. */
function parseUnidad(nombreCarpeta) {
    const limpio = String(nombreCarpeta || '').replace(/^S\d+\s+/i, '').trim(); // quita el prefijo de stage
    const i = limpio.indexOf(' - ');
    if (i > 0) return { autor: limpio.slice(0, i).trim(), titulo: limpio.slice(i + 3).trim(), unidad: limpio };
    return { autor: null, titulo: limpio, unidad: limpio };
}

/** Título de PDF de lectura sin adornos: «Red Roses [1].pdf» → «Red Roses». */
function tituloDeArchivo(nombre) {
    return path.basename(nombre, path.extname(nombre)).replace(/\s*\[\d+\]\s*$/, '').trim();
}

/** CDU deducida (editable después). Heurística ligera por palabras clave; por defecto 82 (literatura). */
function deducirCdu(nombreColeccion, muestraNombres) {
    const t = (nombreColeccion + ' ' + muestraNombres.join(' ')).toLowerCase();
    if (/english|inglés|graded reader|bookworms|readers?\b/.test(t)) return '811.111'; // inglés (lengua)
    if (/français|french/.test(t)) return '811.133.1';
    if (/deutsch|german/.test(t)) return '811.112.2';
    return '82'; // literatura / narrativa, por defecto
}

/**
 * ANALIZA (sin efectos secundarios: no copia, no toca la BD) una carpeta transmedia y devuelve el PLAN:
 * nombre de colección, CDU deducida, idioma, y la lista de miembros (un PDF = un miembro) con sus etiquetas,
 * más las unidades audio-only (audiolibros). Ideal para un dry-run.
 */
export async function analizarTransmedia(dirOrigen, { idioma = 'en' } = {}) {
    // La colección es la carpeta soltada; si envuelve una ÚNICA subcarpeta (y solo metadatos sueltos), se
    // desciende a ella (caso «52.Archivos transmedia/Oxford Bookworms Library»).
    let raiz = dirOrigen;
    const enRaiz = (await fs.readdir(raiz, { withFileTypes: true }).catch(() => []))
        .filter((e) => !ignorar(e.name));
    const subdirs = enRaiz.filter((e) => e.isDirectory());
    const ficherosRaiz = enRaiz.filter((e) => e.isFile() && (esPdf(e.name) || esAudio(e.name)));
    if (subdirs.length === 1 && ficherosRaiz.length === 0) raiz = path.join(raiz, subdirs[0].name);

    const nombreColeccion = path.basename(raiz);
    const ficheros = await listarFicheros(raiz);
    // MIEMBROS = todos los documentos con lector propio (pdf, epub, mobi, azw3, djvu, cbz, chm, docx…), no solo
    // PDF: un EPUB dentro de una colección caía en «material»/manifiesto → invisible, con el origen ya
    // reciclado. Cada uno se cataloga con SU formato.
    const pdfs = ficheros.filter((f) => esDocumentoLeible(f.nombre));
    const audios = ficheros.filter((f) => esAudio(f.nombre));
    const covers = ficheros.filter((f) => /^cover\.(jpe?g|png|webp)$/i.test(f.nombre)); // solo la portada, no páginas

    // Índice del segmento que es la CARPETA DE UNIDAD del libro. El marcador MÁS fiable es que EMPIECE por
    // «Sx » (S0..S6 «Autor - Título»): funciona tanto bajo «Stage N/» como bajo «Without Book/» (audiolibros).
    // Si no lo hay, se usa la hija de «Stage N»; y si tampoco, la carpeta de primer nivel.
    const idxUnidad = (segs) => {
        const i = segs.findIndex((s) => /^S\d+[\s.\-]/i.test(s));
        if (i >= 0) return i;
        const st = segs.findIndex((s) => /stage\s*\d+/i.test(s));
        if (st >= 0 && segs.length > st + 1) return st + 1;
        return segs.length >= 2 ? 0 : -1;
    };
    const unidadDe = (rel) => { const segs = rel.split('/'); const i = idxUnidad(segs); return i >= 0 ? segs[i] : null; };
    const carpetaUnidadDe = (rel) => { const segs = rel.split('/'); const i = idxUnidad(segs); return i >= 0 ? segs.slice(0, i + 1).join('/') : null; };

    // Índice de covers y audios por carpeta de unidad (para enlazarlos al doc de lectura/audiolibro).
    const coverPorUnidad = new Map();
    for (const c of covers) {
        const u = carpetaUnidadDe(c.rel);
        if (u && !coverPorUnidad.has(u)) coverPorUnidad.set(u, c.rel);
    }
    const audiosPorUnidad = new Map();
    const audiosSueltos = []; // audio MONOLÍTICO en la RAÍZ (no cuelga de una carpeta-unidad): cada uno = 1 audiolibro
    for (const a of audios.sort((x, y) => x.rel.localeCompare(y.rel, 'es', { numeric: true }))) {
        const u = carpetaUnidadDe(a.rel);
        if (!u) { audiosSueltos.push(a); continue; } // suelto en la raíz → audiolibro monolítico (más abajo)
        if (!audiosPorUnidad.has(u)) audiosPorUnidad.set(u, []);
        audiosPorUnidad.get(u).push(a.rel);
    }

    // Un miembro por PDF.
    const miembros = pdfs.map((f) => {
        const segs = f.rel.split('/');
        const nivel = nivelDe(segs);
        const carpetaUnidad = carpetaUnidadDe(f.rel);
        const nombreUnidad = unidadDe(f.rel);
        const { autor, titulo: tituloUnidad } = parseUnidad(nombreUnidad || '');
        const rol = rolMaterial(f.rel.toLowerCase());
        const esLectura = rol === 'lectura';
        const titulo = esLectura
            ? (tituloUnidad || tituloDeArchivo(f.nombre))
            : `${tituloUnidad || tituloDeArchivo(f.nombre)} — ${rol}`;
        return {
            rel: f.rel,
            nombre_archivo: f.nombre,
            nivel,
            unidad: nombreUnidad || null,
            rol_material: rol,
            titulo,
            formato: formatoDocumento(f.nombre) || 'pdf',   // pdf/epub/mobi/djvu/cbz/chm… cada uno el suyo
            autores: esLectura && autor ? [autor] : [],
            // La lectura de una unidad lleva su portada y sus audios; los materiales, solo la portada.
            portada_rel: carpetaUnidad ? (coverPorUnidad.get(carpetaUnidad) || null) : null,
            audios_rel: esLectura && carpetaUnidad ? (audiosPorUnidad.get(carpetaUnidad) || []) : [],
        };
    });

    // Audiolibros: unidades con AUDIO pero SIN ningún PDF de lectura → un documento audio-only por unidad.
    const unidadesConLectura = new Set(
        miembros.filter((m) => m.rol_material === 'lectura' && m.unidad).map((m) => carpetaUnidadDe(m.rel)),
    );
    const audiolibros = [];
    for (const [carpetaUnidad, lista] of audiosPorUnidad) {
        if (unidadesConLectura.has(carpetaUnidad)) continue; // ya lo lleva su lectura
        const nombreUnidad = carpetaUnidad.split('/').pop();
        const { autor, titulo } = parseUnidad(nombreUnidad);
        audiolibros.push({
            unidad: nombreUnidad,
            carpeta_rel: carpetaUnidad,
            nivel: nivelDe(carpetaUnidad.split('/')),
            titulo,
            autores: autor ? [autor] : [],
            portada_rel: coverPorUnidad.get(carpetaUnidad) || null,
            audios_rel: lista,
        });
    }

    // AUDIO MONOLÍTICO suelto en la RAÍZ de la carpeta transmedia (un fichero = un audiolibro entero). ANTES se
    // PERDÍA para el catálogo: se copiaba verbatim pero NO se catalogaba (al no colgar de una carpeta-unidad, su
    // carpetaUnidad era null y el bucle lo saltaba). Ahora cada uno se cataloga como su PROPIO audiolibro
    // (naturaleza:'audiolibro', título del nombre de fichero) → queda BUSCABLE, no solo preservado en disco.
    for (const a of audiosSueltos) {
        const base = tituloDeArchivo(a.nombre);
        const { autor, titulo } = parseUnidad(base);
        audiolibros.push({
            unidad: null,
            carpeta_rel: '',                        // raíz de la colección → ruta_base = webColeccion (en la ingesta)
            nivel: 0,
            titulo: titulo || base,
            autores: autor ? [autor] : [],
            portada_rel: null,
            audios_rel: [a.rel],
        });
    }

    // VÍDEOS y MATERIAL NOTABLE. Hasta ahora transmedia SOLO catalogaba PDFs y audiolibros: los vídeos y los
    // documentos que ningún visor abre (.docx/.lit/.nrg/.iso…) se copiaban verbatim pero quedaban INVISIBLES —
    // justo lo que el invariante prohíbe (lo que entra y no es duplicado exacto debe tener un registro que
    // apunte a él). Los vídeos se catalogan SIEMPRE (como ya hacía colección-de-audiolibros); del resto decide
    // la CRIBA: lo notable recibe ficha y la basura (código fuente, node_modules, READMEs) va al manifiesto.
    const videos = [], material = [], sinCatalogar = [];
    for (const f of ficheros) {
        if (esDocumentoLeible(f.nombre) || esAudio(f.nombre) || esImagenArchivo(f.nombre)) continue; // ya tratados arriba
        if (esVideo(f.nombre)) { videos.push({ rel: f.rel, titulo: tituloDeArchivo(f.nombre) }); continue; }
        let bytes = null;
        try { bytes = (await fs.stat(f.abs)).size; } catch { /* sin stat: la criba decide por formato y nombre */ }
        if (esMaterialNotable(f.rel, bytes)) material.push({ rel: f.rel, titulo: tituloDeArchivo(f.nombre) });
        else sinCatalogar.push(f.rel);
    }

    const cdu = deducirCdu(nombreColeccion, pdfs.slice(0, 30).map((f) => f.nombre));
    return {
        raiz, nombreColeccion, cdu, idioma,
        totales: {
            pdfs: pdfs.length, audios: audios.length, covers: covers.length, audiolibros: audiolibros.length,
            videos: videos.length, material: material.length, sinCatalogar: sinCatalogar.length, ficheros: ficheros.length,
        },
        miembros, audiolibros, videos, material, sinCatalogar,
    };
}

// ── Ejecución: copiar VERBATIM + crear colección + insertar miembros + reciclar origen ──────────────────

/**
 * Copia un árbol origen→destino y VERIFICA que el nº de ficheros y los bytes coinciden (el origen no cambió
 * durante la copia). LIMPIA una copia parcial de un intento previo antes de empezar y, si la verificación
 * falla, la retira (evita que un reintento con ficheros truncados se atasque). Nunca toca el ORIGEN.
 * @returns {Promise<{integra:boolean, huella:{n:number,bytes:number}}>}
 */
// Copia recursiva RESILIENTE: usa los nombres EXACTOS del readdir (evita el ENOENT de fs.cp por desajuste de
// normalización Unicode NFC/NFD —típico en Synology/SMB con acentos, «Religión»— o por una entrada que
// desaparece a mitad, p. ej. una guía que movió una subcarpeta). Salta lo que dé ENOENT; propaga otros errores.
async function copiarArbolResiliente(origen, destino) {
    let ents;
    try { ents = await fs.readdir(origen, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    await fs.mkdir(destino, { recursive: true });
    for (const e of ents) {
        if (ignorar(e.name)) continue;
        const src = path.join(origen, e.name), dst = path.join(destino, e.name);
        try {
            if (e.isDirectory()) await copiarArbolResiliente(src, dst);
            else await fs.copyFile(src, dst);
        } catch (err) { if (err.code !== 'ENOENT') throw err; /* entrada desaparecida/normalización → se salta */ }
    }
}

/**
 * Copia `origen` → `destino` y VERIFICA la copia (misma huella: nº de ficheros + bytes). Solo con `integra`
 * el llamante debe reciclar el origen.
 * @param limpiarDestino  true (por defecto) = borra el destino antes (parcial de un intento anterior). FALSE al
 *   COMPLETAR una colección ya catalogada: se FUSIONA sobre lo que hay, para no borrar las portadas derivadas
 *   (.portadas/) ni los ficheros de los documentos que ya existen. `huella` ignora lo oculto, así que la
 *   verificación sigue cuadrando.
 */
export async function copiarVerificado(origen, destino, { limpiarDestino = true } = {}) {
    if (limpiarDestino) await fs.rm(destino, { recursive: true, force: true }).catch(() => {}); // parcial de un intento anterior
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await copiarArbolResiliente(origen, destino);
    const [orig, dest] = await Promise.all([huella(origen), huella(destino)]);
    // ORIGEN VACÍO O DESAPARECIDO ⇒ NUNCA íntegra. Sin esta guarda, `0 === 0` daba `integra:true`: una copia de
    // NADA se daba por buena y el llamante catalogaba documentos apuntando a una carpeta VACÍA (y reciclaba un
    // origen que ya no estaba). Caso real: colecciones ANIDADAS —la padre recicla su carpeta entera y, al tocarle
    // a la hija, su origen ya no existe—; `copiarArbolResiliente` se traga el ENOENT en silencio (por diseño:
    // resiste a que una entrada desaparezca a mitad) y la verificación no lo veía. De ahí los mp3 inalcanzables.
    if (orig.n === 0) {
        await fs.rm(destino, { recursive: true, force: true }).catch(() => {});
        return { integra: false, huella: dest, vacio: true };
    }
    const integra = orig.n === dest.n && orig.bytes === dest.bytes;
    if (!integra) await fs.rm(destino, { recursive: true, force: true }).catch(() => {}); // no dejar la parcial
    return { integra, huella: dest };
}
export async function huella(dir) {
    let n = 0, bytes = 0;
    const pila = [dir];
    while (pila.length) {
        const d = pila.pop();
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (ignorar(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) pila.push(p);
            else { try { const s = await fs.stat(p); n++; bytes += s.size; } catch { /* */ } }
        }
    }
    return { n, bytes };
}

/**
 * Ingesta REAL de una carpeta transmedia. Copia el árbol verbatim a `<cdu>/transmedia/<colección>/`, crea la
 * colección `tipo:'transmedia'` y un documento por PDF (+ audiolibros), y solo tras VERIFICAR la copia recicla
 * el origen del Inbox. Dedup por hash: PDFs de igual hash → un solo documento (ambos ficheros permanecen).
 * @returns {Promise<{ok:boolean, coleccion?:string, insertados?:number, motivo?:string}>}
 */
export async function ingestarTransmedia(dirOrigen, { db: dbArg, reciclarOrigen = true } = {}) {
    const db = dbArg || await conectarDB();
    const plan = await analizarTransmedia(dirOrigen);
    // Se cataloga si hay miembros (PDF/audio) O si hay CONTENIDO que preservar (p. ej. un CD interactivo sin
    // PDF/audio: se copia verbatim y se crea la colección aunque tenga 0 miembros — nada se pierde).
    const hayContenido = (plan.totales?.ficheros || 0) > 0;
    if (!plan.miembros.length && !plan.audiolibros.length && !hayContenido) return { ok: false, motivo: 'carpeta vacía: nada que catalogar' };

    // Anti-duplicados MIEMBRO A MIEMBRO. Un re-drop no debe duplicar los cientos de documentos de una colección
    // ya catalogada... pero TAMPOCO debe impedir COMPLETAR una colección INCOMPLETA. El guardián «todo o nada»
    // anterior rechazaba el drop ENTERO si la colección existía con aunque fuera 1 documento → a una colección a
    // la que le faltaban miembros (caso real: se catalogó el audiolibro y sus 3 PDFs se quedaron fuera) NO se le
    // podían añadir NUNCA: cada re-drop se rechazaba y los que faltaban no entraban jamás. Ahora se compara el
    // plan con lo YA catalogado y se inserta SOLO LO QUE FALTA (y si ya está todo, se omite sin copiar 19 GB en
    // balde). Claves: los PDFs por `nombre_archivo`; los audiolibros por `titulo` (no tienen fichero único).
    const colPrevia = await db.collection('colecciones').findOne(
        { nombre: plan.nombreColeccion }, { collation: { locale: 'es', strength: 1 }, projection: { _id: 1 } });
    let miembros = plan.miembros, audiolibros = plan.audiolibros, videos = plan.videos, material = plan.material;
    if (colPrevia) {
        const previos = await db.collection('biblioteca')
            .find({ coleccion: colPrevia._id }, { projection: { nombre_archivo: 1, titulo: 1, rol_material: 1 } }).toArray();
        const yaFichero = new Set(previos.map((d) => d.nombre_archivo).filter(Boolean));
        const yaAudio = new Set(previos.filter((d) => d.rol_material === 'audiolibro').map((d) => d.titulo).filter(Boolean));
        miembros = plan.miembros.filter((m) => !yaFichero.has(m.nombre_archivo));
        audiolibros = plan.audiolibros.filter((a) => !yaAudio.has(a.titulo));
        videos = plan.videos.filter((v) => !yaFichero.has(path.basename(v.rel)));
        material = plan.material.filter((x) => !yaFichero.has(path.basename(x.rel)));
        if (!miembros.length && !audiolibros.length && !videos.length && !material.length)
            return { ok: false, permanente: true, motivo: `ya existe la colección «${plan.nombreColeccion}» COMPLETA (${previos.length} documento/s): no se re-cataloga (evita duplicados)` };
        console.log(`  ↻ «${plan.nombreColeccion}» ya existe con ${previos.length} documento/s: se COMPLETA con lo que falta (${miembros.length} PDF · ${audiolibros.length} audiolibro/s · ${videos.length} vídeo/s · ${material.length} material).`);
    }

    // Destino: <árbol CDU>/transmedia/<nombre-colección>/… (una sola rama; la estructura interna se preserva).
    const segsCdu = arbolCDU(plan.cdu).segmentos;
    const carpetaColeccion = path.join(DIR_CDU, ...segsCdu, 'transmedia', plan.nombreColeccion);
    const webColeccion = webDe(carpetaColeccion);

    // 1) COPIA VERBATIM + verificación (nunca se borra el origen si la copia no quedó íntegra; si el origen
    //    seguía copiándose, orig≠dest → falla, se limpia la parcial y se reintenta en el próximo escaneo).
    // Al COMPLETAR una colección existente NO se limpia el destino: se fusiona, para no borrar las portadas
    // derivadas (.portadas/) ni los ficheros de los documentos ya catalogados.
    const { integra, huella: copiado } = await copiarVerificado(plan.raiz, carpetaColeccion, { limpiarDestino: !colPrevia });
    if (!integra) return { ok: false, motivo: 'la copia al árbol CDU no cuadró (el origen aún cambiaba): se CONSERVA el origen y se limpió la copia parcial' };
    // Marcador que protege TODO el subárbol de Integridad/Conformador (no podar/mover/reciclar).
    await fs.writeFile(path.join(carpetaColeccion, MARCA_RUTA_FIJA), `transmedia: ${plan.nombreColeccion}\n`).catch(() => {});

    // 2) Colección tipo:'transmedia' (CDU deducida, editable después).
    const { _id: coleccionId } = await resolverCabecera(db, {
        nombre: plan.nombreColeccion, tipo: 'transmedia', cdu: plan.cdu,
        descripcion: `Colección transmedia · ${plan.totales.pdfs} PDF · ${plan.totales.audios} audios.`,
    });
    await db.collection('colecciones').updateOne({ _id: coleccionId }, { $set: { raiz_web: webColeccion, ruta_fija: true } });

    const bib = db.collection('biblioteca');
    const webDeRel = (rel) => rel ? `${webColeccion}/${rel}` : null;                       // fichero
    const carpetaWebDeRel = (rel) => rel ? `${webColeccion}/${rel.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') : webColeccion; // su carpeta

    // Resuelve nombres de autor → ObjectId (check-then-create, insensible a grafía). autores es array de
    // ObjectId en el $jsonSchema; se cachean para no re-resolver el mismo nombre en cientos de docs.
    const cacheAutores = new Map();
    const resolverAutores = async (nombres) => {
        const ids = [];
        for (const nom of nombres || []) {
            if (!cacheAutores.has(nom)) { const r = await resolverPersona(db, nom).catch(() => null); cacheAutores.set(nom, r?._id || null); }
            const id = cacheAutores.get(nom);
            if (id) ids.push(id);
        }
        return ids;
    };

    // 3) Documentos por PDF (dedup por hash) + audiolibros. Se calcula el hash sobre el fichero YA copiado.
    const hashesVistos = new Set();
    let insertados = 0, deduplicados = 0;

    const baseDoc = (extra) => ({
        cdu: plan.cdu, idioma: plan.idioma, ubicacion: { ambito: 'Sin asignar', estanteria: 'Sin asignar' },
        coleccion: coleccionId, coleccion_nombre: plan.nombreColeccion, ruta_fija: true,
        // `fecha_ingreso` es el campo por el que el Catálogo ordena («reciente»/«antiguo») y filtra por día;
        // sin él, los documentos caen al final (nulos al final) y NO se ven al navegar → hay que ponerlo.
        estado_verificacion: 'completado', fecha_ingreso: new Date(), fecha_creacion: new Date(), ...extra,
    });

    for (const m of miembros) {   // `miembros` = los que FALTAN (todos, si la colección es nueva)
        const abs = path.join(carpetaColeccion, ...m.rel.split('/'));
        const hash = await calcularHashArchivo(abs).catch(() => null);
        if (hash && hashesVistos.has(hash)) { deduplicados++; continue; } // igual hash → un solo doc (fichero intacto)
        if (hash) hashesVistos.add(hash);
        const autores = await resolverAutores(m.autores);
        const audios = (m.audios_rel || []).map((r, i) => ({ ruta: webDeRel(r), titulo: tituloDeArchivo(path.basename(r)), orden: i + 1 }));
        // El _id se pre-genera para nombrar su portada derivada (`.portadas/<id>.jpg`). Portada: la LECTURA
        // usa la `cover.jpg` de su unidad; los materiales/guías (o una lectura sin cover) reciben su PROPIA
        // 1ª página rasterizada → ni portadas repetidas ni docs con icono genérico.
        const _id = new ObjectId();
        const esLectura = m.rol_material === 'lectura';
        let portada = esLectura ? webDeRel(m.portada_rel) : null;
        if (!portada) portada = await renderizarPortadaMiembro(abs, carpetaColeccion, webColeccion, _id);
        const doc = baseDoc({
            _id,
            // Una lectura CON audio se etiqueta pdf + audio (así el thumbnail avisa de que trae audiolibro).
            titulo: m.titulo, tipo_recurso: 'libro',
            // Cada miembro con SU formato (no todo es pdf). Una lectura CON audio se etiqueta además 'audio'.
            formatos: audios.length ? [m.formato || 'pdf', 'audio'] : [m.formato || 'pdf'],
            autores: autores.length ? autores : undefined,
            nombre_archivo: m.nombre_archivo, ruta_base: carpetaWebDeRel(m.rel),
            nivel: m.nivel || undefined, unidad: m.unidad || undefined, rol_material: m.rol_material,
            portada: portada || undefined,
            audios: audios.length ? audios : undefined,   // una lectura con audio se deja como libro (+ audios)
            hash_contenido: hash || undefined,
        });
        await bib.insertOne(limpiarUndefined(doc));
        await indexarDoc(db, _id).catch(() => {});   // índice FTS: para que salga en la Búsqueda de texto
        insertados++;
    }

    for (const a of audiolibros) {   // `audiolibros` = los que FALTAN (todos, si la colección es nueva)
        const autores = await resolverAutores(a.autores);
        const _id = new ObjectId();
        const doc = baseDoc({
            _id,
            titulo: a.titulo, tipo_recurso: 'libro', naturaleza: 'audiolibro', formatos: ['audio'],
            autores: autores.length ? autores : undefined,
            ruta_base: webDeRel(a.carpeta_rel) || webColeccion, rol_material: 'audiolibro', // '' (monolítico) → la raíz de la colección
            nivel: a.nivel || undefined, unidad: a.unidad || undefined,
            portada: webDeRel(a.portada_rel) || undefined,   // audio-only: su cover.jpg si la hay (no hay PDF que rasterizar)
            audios: a.audios_rel.map((r, i) => ({ ruta: webDeRel(r), titulo: tituloDeArchivo(path.basename(r)), orden: i + 1 })),
        });
        await bib.insertOne(limpiarUndefined(doc));
        await indexarDoc(db, _id).catch(() => {});
        insertados++;
    }

    // 3c) VÍDEOS → documento propio (naturaleza:'video'): sin visor para los códecs que el navegador no
    //     decodifica, pero VISIBLE y descargable. Antes NO se catalogaban en transmedia (solo en colAudio).
    for (const v of videos) {
        const _id = new ObjectId();
        await bib.insertOne(limpiarUndefined(baseDoc({
            _id, titulo: v.titulo, tipo_recurso: 'libro', naturaleza: 'video', formatos: ['video'],
            nombre_archivo: path.basename(v.rel), ruta_base: carpetaWebDeRel(v.rel),
        })));
        await indexarDoc(db, _id).catch(() => {});
        insertados++;
    }

    // 3d) MATERIAL NOTABLE (.docx/.lit/.nrg/.iso…) que pasó la CRIBA → ficha propia (sin visor, pero buscable y
    //     descargable). Lo que NO pasó (código fuente, node_modules, READMEs) va al manifiesto de abajo.
    for (const x of material) {
        const _id = new ObjectId();
        await bib.insertOne(limpiarUndefined(baseDoc({
            _id, titulo: x.titulo, tipo_recurso: 'libro', naturaleza: 'material', formatos: ['material'],
            nombre_archivo: path.basename(x.rel), ruta_base: carpetaWebDeRel(x.rel),
        })));
        await indexarDoc(db, _id).catch(() => {});
        insertados++;
    }

    // 3d-bis) RED DE SEGURIDAD DEL INVARIANTE. Si tras TODO lo anterior no se catalogó NI UN documento pero la
    // carpeta SÍ tiene contenido, ese contenido quedaría preservado en disco y COMPLETAMENTE INVISIBLE: la
    // colección existiría con 0 miembros, y el catálogo lista `biblioteca`, no `colecciones`. Es justo lo que
    // el invariante prohíbe (lo que entra y no es duplicado exacto debe acabar con un registro que apunte a
    // él), y además pasaba BAJO EL RADAR: se devolvía ok:true con un «✔ contenido preservado verbatim (0
    // documentos catalogables)» y se reciclaba el origen — nada fallaba, simplemente no se catalogaba nada.
    // Caso real: 142 páginas escaneadas marcadas «intacta» → analizarTransmedia no cuenta las IMÁGENES (las
    // trata como portadas) → 0 miembros → carpeta entera invisible.
    // Ahora ese contenido recibe UN documento propio (como un paquete de software): buscable, con ficha y con
    // su explorador de archivos. Mejor un registro imperfecto que una carpeta fantasma.
    if (insertados === 0 && hayContenido) {
        const _id = new ObjectId();
        await bib.insertOne(limpiarUndefined(baseDoc({
            _id, tipo_recurso: 'libro', naturaleza: 'material', titulo: plan.nombreColeccion,
            formatos: ['material'], ruta_base: webColeccion,
            portada: (await primeraImagenDe(carpetaColeccion)) || undefined,
        })));
        await indexarDoc(db, _id).catch(() => {});
        insertados++;
        console.warn(`  ⚠️  «${plan.nombreColeccion}»: 0 documentos catalogables (${plan.totales.ficheros} ficheros: ni PDF, ni audio, ni vídeo, ni material notable) → se cataloga como UN registro del contenido preservado, para que NO quede invisible.`);
    }

    // 3e) MANIFIESTO de lo PRESERVADO pero NO catalogado (lo que la criba dejó fuera): deja constancia de que
    //     está ahí y de que se revisó. En la raíz de la colección (ruta_fija → no se poda).
    const manif = [
        `Colección transmedia: ${plan.nombreColeccion}`,
        `Catalogado: ${plan.miembros.length} PDF · ${plan.audiolibros.length} audiolibro(s) · ${plan.videos.length} vídeo(s) · ${plan.material.length} material notable.`,
        '',
        plan.sinCatalogar.length
            ? `Ficheros PRESERVADOS pero NO catalogados (${plan.sinCatalogar.length}) — están aquí, en esta carpeta:`
            : 'No hay ficheros sin catalogar.',
        ...plan.sinCatalogar.map((x) => `  · ${x}`),
    ].join('\n');
    await fs.writeFile(path.join(carpetaColeccion, '_contenido.txt'), manif + '\n').catch(() => {});

    // 4) Reciclar el origen del Inbox — pero SOLO si NO ha cambiado desde que se copió (por si la copia había
    //    pausado durante la verificación y luego resumió: no mover una carpeta que aún se está escribiendo).
    let origenReciclado = false;
    if (reciclarOrigen) {
        const ahora = await huella(plan.raiz);
        if (ahora.n === copiado.n && ahora.bytes === copiado.bytes) {
            await reciclarCarpeta(dirOrigen, 'transmedia-ingerido').catch(() => {});
            origenReciclado = true;
        }
        // Si cambió, se CONSERVA el origen (el usuario lo retira a mano cuando termine); el catálogo ya está.
    }

    return {
        ok: true, coleccion: plan.nombreColeccion, cdu: plan.cdu, insertados, deduplicados, web: webColeccion,
        origenReciclado,
    };
}

// Primera imagen del árbol (recursivo, ficheros del nivel antes que subcarpetas) → portada web, o null.
async function primeraImagenDe(raizAbs) {
    async function rec(dir) {
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
        const ord = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
        for (const e of entradas.filter((x) => x.isFile()).sort(ord)) {
            if (/\.(jpe?g|png|webp|gif|bmp)$/i.test(e.name)) return path.join(dir, e.name);
        }
        for (const e of entradas.filter((x) => x.isDirectory() && !x.name.startsWith('.') && !x.name.startsWith('@')).sort(ord)) {
            const r = await rec(path.join(dir, e.name));
            if (r) return r;
        }
        return null;
    }
    const abs = await rec(raizAbs);
    return abs ? webDe(abs) : null;
}

/**
 * BLOQUE VERBATIM: copia una carpeta ÍNTEGRA al árbol CDU (protegida con ruta_fija) y la cataloga como UN
 * ÚNICO documento — NO uno por fichero. Es la forma de decir «esto es UNA COSA: consérvala tal cual y déjame
 * un registro que apunte a ella». Comparte los atributos de un documento (CDU, portada, valoración,
 * ubicación) y su previsualización es un explorador de ficheros de SOLO LECTURA. Dos sabores:
 *   · SOFTWARE  (`accion:'software'`)  → naturaleza:'software', CDU 004, rama `software/`
 *   · INTACTA   (`accion:'intacta'`)   → naturaleza:'material',  CDU deducida del nombre, rama `intacta/`
 * `intacta` NO es transmedia: transmedia es una colección de ficheros de VARIOS tipos que se catalogan por
 * separado (un doc por PDF, por audiolibro…). Enrutarla por ahí era el error que dejaba una carpeta de solo
 * imágenes con CERO documentos (test 67): su análisis no cuenta las imágenes y salían 0 miembros.
 */
async function ingestarBloqueVerbatim(dirOrigen, { db: dbArg, reciclarOrigen = true, naturaleza, cdu, rama, nombreDefecto } = {}) {
    const db = dbArg || await conectarDB();
    const nombre = path.basename(dirOrigen).trim() || nombreDefecto;
    const carpetaDestino = path.join(DIR_CDU, ...arbolCDU(cdu).segmentos, rama, nombre);
    const webBase = webDe(carpetaDestino);

    // Anti-duplicado: si ya hay un documento con esta ruta_base, no re-catalogar (evita duplicar un re-drop).
    const previa = await db.collection('biblioteca').findOne({ naturaleza, ruta_base: webBase }, { projection: { _id: 1 } });
    if (previa) return { ok: false, permanente: true, motivo: `ya catalogado «${nombre}»` };

    const totales = await huella(dirOrigen);
    if (!totales.n) return { ok: false, motivo: 'carpeta vacía: nada que catalogar' };

    // 1) Copia verbatim + verificación (nunca se borra el origen si no quedó íntegra).
    const { integra, huella: copiado } = await copiarVerificado(dirOrigen, carpetaDestino);
    if (!integra) return { ok: false, motivo: 'la copia al árbol CDU no cuadró (el origen aún cambiaba): se conserva el origen' };
    await fs.writeFile(path.join(carpetaDestino, MARCA_RUTA_FIJA), `${naturaleza}: ${nombre}\n`).catch(() => {});

    // 2) UN documento (+ portada = 1ª imagen del bloque, si hay). El software es su propio tipo_recurso; el
    //    resto va como 'libro' + naturaleza:'material' (no es un libro, pero es LA cosa que se conserva: con
    //    ficha, buscable y con su explorador de ficheros).
    const esSw = naturaleza === 'software';
    const _id = new ObjectId();
    const doc = limpiarUndefined({
        _id, tipo_recurso: esSw ? 'software' : 'libro', naturaleza, titulo: nombre, cdu, idioma: 'es',
        formatos: [esSw ? 'software' : 'material'], ubicacion: { ambito: 'Sin asignar', estanteria: 'Sin asignar' },
        ruta_base: webBase, ruta_fija: true, portada: (await primeraImagenDe(carpetaDestino)) || undefined,
        software: esSw ? { ficheros: totales.n, bytes: totales.bytes } : undefined,
        bloque: esSw ? undefined : { ficheros: totales.n, bytes: totales.bytes },
        estado_verificacion: 'completado', fecha_ingreso: new Date(), fecha_creacion: new Date(),
    });
    await db.collection('biblioteca').insertOne(doc);
    await indexarDoc(db, _id).catch(() => {});

    // 3) Reciclar el origen si no ha cambiado desde la copia.
    let origenReciclado = false;
    if (reciclarOrigen) {
        const ahora = await huella(dirOrigen);
        if (ahora.n === copiado.n && ahora.bytes === copiado.bytes) { await reciclarCarpeta(dirOrigen, `${naturaleza}-ingerido`).catch(() => {}); origenReciclado = true; }
    }
    return { ok: true, _id: String(_id), titulo: nombre, cdu, web: webBase, ficheros: totales.n, origenReciclado };
}

/** SOFTWARE (`accion:'software'`): bloque verbatim en `004/software/<nombre>/`, 1 registro naturaleza:'software'. */
export const ingestarSoftware = (dirOrigen, opts = {}) =>
    ingestarBloqueVerbatim(dirOrigen, { ...opts, naturaleza: 'software', cdu: '004', rama: 'software', nombreDefecto: 'Software' });

/**
 * INTACTA (`accion:'intacta'`): la carpeta es UNA COSA — se conserva ÍNTEGRA y deja UN registro que apunta a
 * ella. NO es transmedia (eso es una colección de ficheros de varios tipos, catalogados por separado) y no
 * pretende decidir qué es: por eso `naturaleza:'material'`, con su explorador de ficheros. La CDU se deduce
 * del nombre (editable en la ficha; el Conformador puede afinarla después).
 */
export const ingestarIntacta = (dirOrigen, opts = {}) =>
    ingestarBloqueVerbatim(dirOrigen, {
        ...opts, naturaleza: 'material', rama: 'intacta', nombreDefecto: 'Carpeta',
        cdu: deducirCdu(path.basename(dirOrigen), []),
    });

/** Quita las claves con valor undefined (para no persistir campos vacíos y no violar el $jsonSchema). */
function limpiarUndefined(obj) {
    const salida = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) salida[k] = v;
    return salida;
}

// Extensiones de DOCUMENTO PRINCIPAL (el "libro" de un drop «libro + material»). El resto = material auxiliar.
const EXT_DOC_PRINCIPAL = new Set(['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.djv', '.cbz', '.cbr', '.cb7', '.chm']);

/**
 * LIBRO + MATERIAL AUXILIAR (un solo drop; accion:'libro-material' en el Inspector): una carpeta con UN
 * documento principal (el libro) + material de apoyo (código de ejemplo, datasets, multimedia…). El LIBRO se
 * cataloga por el PIPELINE NORMAL (ISBN, enriquecimiento, CDU real → un `tipo_recurso:'libro'` de pleno
 * derecho: NO transmedia, NO colección, NO «audiolibro+pdf»), y el material se conserva VERBATIM junto a él en
 * su carpeta CDU, protegido por `ruta_fija` (Integridad no lo poda) y visible en el explorador «🗂️ Archivos»
 * de la ficha. El documento principal = el fichero bibliográfico MAYOR de la raíz (un libro pesa más que un
 * capítulo de muestra); todo lo demás (subcarpetas + otros ficheros) es material.
 */
export async function ingestarLibroConMaterial(dirOrigen, { reciclarOrigen = true } = {}) {
    // Accesorios que NO son ni el libro ni material: la guía, los marcadores del árbol y CUALQUIER «*.meta.json»
    // (override de identidad que el pipeline lee aparte → no se copia ni cuenta como material).
    const esAccesorio = (n) => ignorar(n) || n === '_guia.json' || /\.meta\.json$/i.test(n) || /^\.(ruta_fija|transmedia|noborrar|override)/.test(n);
    let entradas;
    try { entradas = await fs.readdir(dirOrigen, { withFileTypes: true }); }
    catch (e) { return { ok: false, motivo: `no se puede leer la carpeta: ${e.message}` }; }

    // Pistas de la guía (las escribe el REPROCESO): principal FIJADO + metadatos de adjuntos (soloAdmin).
    const lm = (await leerGuia(dirOrigen))?.libro_material || null;

    // 1) DOCUMENTO PRINCIPAL: el que FIJA la guía (reproceso) o, en su defecto, el fichero bibliográfico MAYOR
    //    de la RAÍZ (un libro pesa más que un capítulo de muestra). Fijarlo evita que una crítica/anexo grande
    //    usurpe el papel de libro al reprocesar.
    const docsRaiz = [];
    for (const e of entradas) {
        if (!e.isFile() || esAccesorio(e.name)) continue;
        if (!EXT_DOC_PRINCIPAL.has(path.extname(e.name).toLowerCase())) continue;
        let size = 0; try { size = (await fs.stat(path.join(dirOrigen, e.name))).size; } catch { /* sin stat */ }
        docsRaiz.push({ name: e.name, abs: path.join(dirOrigen, e.name), size });
    }
    if (!docsRaiz.length) return { ok: false, motivo: 'no hay documento principal (pdf/epub/…) en la raíz: ¿marcaste bien la carpeta?' };
    docsRaiz.sort((a, b) => b.size - a.size);
    const principal = (lm?.principal && docsRaiz.find((d) => d.name === lm.principal)) || docsRaiz[0];

    // 2) Catalogar el LIBRO por el pipeline normal (import dinámico → evita cualquier ciclo de carga).
    const { ingestarRecurso } = await import('../servicio-ingesta.js');
    let res;
    try { res = await ingestarRecurso({ rutas: [principal.abs], contexto: {} }); }
    catch (e) { return { ok: false, motivo: `no se pudo catalogar el libro «${principal.name}»: ${e.message}` }; }

    // Carpeta CDU del libro: la que devuelve el pipeline (inserción) o, si fue duplicado (carpeta null), la
    // derivada de su ruta_base ya existente. Sin carpeta no se puede adjuntar → se conserva el origen.
    const destino = res.carpeta
        || (res.rutaWeb ? path.join(DIR_CDU, String(res.rutaWeb).replace(/^\/?recursos\//, '').split('/').join(path.sep)) : null);
    if (!destino) return { ok: false, motivo: 'el pipeline no devolvió carpeta destino para el libro (no se adjunta material)' };

    // 3) Copiar el MATERIAL AUXILIAR verbatim JUNTO al libro (subcarpetas y otros ficheros de la raíz). El
    //    documento principal ya lo copió el pipeline; el resto (código, datasets, un README…) es material. Se
    //    anota cada elemento de PRIMER NIVEL para reconstruir el registro estructurado `adjuntos[]`.
    const topMaterial = [];
    for (const e of entradas) {
        if (esAccesorio(e.name)) continue;
        const src = path.join(dirOrigen, e.name);
        if (src === principal.abs) continue;
        const dst = path.join(destino, e.name);
        try {
            if (e.isDirectory()) { await copiarArbolResiliente(src, dst); }
            else { await fs.copyFile(src, dst); }
            topMaterial.push(e.name);
        } catch (err) { if (err.code !== 'ENOENT') console.warn(`  ⚠️  material «${e.name}» no copiado: ${err.message}`); }
    }
    const material = topMaterial.length;

    // 4) Proteger el árbol (marcador .ruta_fija + ruta_fija:true → Integridad NO poda el material) y REGISTRAR
    //    el material como `adjuntos[]` ESTRUCTURADO — una entrada por elemento de primer nivel, con el flag
    //    «solo admin» que la guía preserve (reproceso). Antes solo se guardaba un CONTADOR (`material_adjunto`),
    //    así que al reprocesar se perdía la lista y las marcas «solo admin»; ahora viajan. El doc SIGUE siendo
    //    tipo_recurso:'libro'. (Esto mejora también un drop libro-material nuevo: su ficha ya lista los adjuntos.)
    if (material > 0 && res._id) {
        await fs.writeFile(path.join(destino, MARCA_RUTA_FIJA), `libro-con-material: ${res.documento?.titulo || principal.name}\n`).catch(() => {});
        const soloAdminDe = new Map((lm?.adjuntos || []).map((a) => [a.nombre, !!a.soloAdmin]));
        const adjuntos = [];
        for (const nombre of topMaterial) {
            let tipo = 'fichero', bytes = 0;
            try { const st = await fs.stat(path.join(destino, nombre)); tipo = st.isDirectory() ? 'carpeta' : 'fichero'; bytes = st.isDirectory() ? 0 : st.size; } catch { /* recién copiado */ }
            adjuntos.push({ nombre, tipo, soloAdmin: soloAdminDe.get(nombre) || false, bytes, fecha: new Date() });
        }
        try {
            const db = await conectarDB();
            await db.collection('biblioteca').updateOne({ _id: new ObjectId(String(res._id)) }, { $set: { ruta_fija: true, material_adjunto: adjuntos.length, adjuntos } });
        } catch (e) { console.warn(`  ⚠️  no se pudo marcar ruta_fija/adjuntos del libro: ${e.message}`); }
    }

    // 5) Reciclar el origen (Papelera) si la copia del libro fue íntegra, o si era un duplicado (su PDF ya lo
    //    retiró el pipeline). Si la copia falló, se conserva el origen para no perder nada.
    const esDup = res.operacion === 'duplicado_exacto' || res.duplicado || res.ya_existia;
    let origenReciclado = false;
    if (reciclarOrigen && (res.copiaIntegra === true || esDup)) {
        try { await reciclarCarpeta(dirOrigen, 'libro-material-ingerido'); origenReciclado = true; } catch { /* se conserva */ }
    }

    return {
        ok: true, _id: String(res._id), titulo: res.documento?.titulo || principal.name,
        cdu: res.documento?.cdu || null, web: res.rutaWeb || null, material, duplicado: !!esDup, origenReciclado,
    };
}
