/**
 * Lector de CHM (Microsoft Compiled HTML Help) — un empaquetado de HTML+imágenes muy común para MANUALES y
 * LIBROS técnicos. Extrae el contenido con `extract_chmLib` (paquete libchm-bin: C nativo, libre, apto para
 * el Atom) a un directorio temporal y deduce los metadatos SIN IA:
 *   · título  → del proyecto .hhp (línea `Title=`) → la 1.ª entrada del ÍNDICE (.hhc) → el <title> de la página
 *               inicial → (si nada, lo pone el nombre). Nunca un título genérico de tema («A», «Index», «Copyright»);
 *   · ISBN    → del texto de las páginas EN ORDEN DE LECTURA (índice .hhc primero: portada, créditos…), con las
 *               etiquetas quitadas y las entidades decodificadas (pista/pivote barato para el enriquecimiento);
 *   · ISBN PROPIO, autores, editorial, año y páginas → de la CABECERA de los CHM de Safari Books Online («By … ·
 *               Publisher: … · Pub Date: … · Print ISBN-13: … · Pages: …»), y del nombre de su carpeta/índice
 *               cuando es un ISBN (`0131927566/`, `0131927566.hhc`);
 *   · ISSN    → del texto (por si es un manual serializado);
 *   · portada → la entrada «Cover» del índice, una imagen «cover/portada/front», la que lleva el ISBN en el nombre
 *               o la primera imagen (vertical) de la página inicial. Nunca «la más grande»: en un libro técnico es
 *               una figura.
 *
 * Por qué (medido el 5-nov con «Nanotechnology: Science, Innovation and Opportunity», un CHM de Safari): se leían los
 * 40 primeros HTML en el orden del disco —A.html, B.html… (el índice alfabético) y los capítulos—, la página de
 * créditos quedaba fuera; además el ISBN viene como «ISBN-13:&nbsp;978-0-13-…» y la expresión no casaba con las
 * entidades sin decodificar. El título salió «A» (el <title> de A.html) y la portada, una figura de 1000×741.
 *
 * DEGRADA CON ELEGANCIA: si falta `extract_chmLib` (libchm-bin no instalado) o el CHM está corrupto, LANZA;
 * el orquestador lo captura y cataloga el documento por su nombre (como cualquier «otro-formato»). Nunca
 * rompe la ingesta.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import * as cheerio from 'cheerio';
import { validarISBN, extraerISSNs, variantesISBN } from './identificadores.js';
import { extraerISBNs } from './lector-pdf.js';
import { medirImagen } from './medir-imagen.js';

const execFileP = promisify(execFile);

const MAX_HTML_ESCANEO = 40;    // nº máximo de HTML a inspeccionar (un CHM puede tener cientos de temas)
const MAX_BYTES_HTML = 400000;  // no leer enteros los HTML gigantes (basta el principio para título/ISBN)

// Decodifica un buffer de texto (HTML/HHC) a string DETECTANDO su codificación. Muchos CHM usan
// codificaciones LEGACY (windows-1252 occidental —comillas curvas, °, ©—, windows-1251 cirílico, gbk/big5
// CJK, shift_jis…): leerlos como UTF-8 produce «caracteres raros» (mojibake). Node trae ICU completo, así
// que TextDecoder soporta esas etiquetas. Orden: charset declarado en un <meta> → UTF-8 (si el buffer es
// UTF-8 válido) → windows-1252 (reserva occidental, superset de latin-1 que nunca falla).
function decodificarTexto(buf) {
    const cabecera = buf.subarray(0, 4096).toString('latin1');
    const m = cabecera.match(/charset\s*=\s*["']?\s*([\w-]+)/i);
    const etiqueta = m ? m[1].toLowerCase() : null;
    if (etiqueta && etiqueta !== 'utf-8' && etiqueta !== 'utf8') {
        try { return new TextDecoder(etiqueta).decode(buf); } catch { /* etiqueta desconocida → seguir */ }
    }
    // UTF-8 ESTRICTO: si el buffer NO es UTF-8 válido, TextDecoder(fatal) lanza → caemos a windows-1252.
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { /* no era UTF-8 */ }
    try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('utf-8'); }
}

// decodeURIComponent tolerante: los href del .hhc suelen venir URL-encodeados (%20=espacio, subcarpetas);
// hay que decodificarlos para resolver el fichero real. Si la cadena tiene un % suelto (no escape), no rompe.
function decodeURITolerante(s) {
    try { return decodeURIComponent(String(s)); } catch { return String(s); }
}

// Decodifica las entidades HTML más comunes de un título (sin cargar un parser entero para una línea).
// También las numéricas (&#160;, &#x2013;…), que los CHM usan para espacios duros y guiones.
function decodificarEntidades(s) {
    return String(s)
        .replace(/&#x([0-9a-f]{1,6});/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#([0-9]{1,7});/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// Texto legible de una página HTML: sin scripts/estilos ni etiquetas, con las entidades decodificadas. Sobre el HTML
// crudo, «ISBN-13:&nbsp;978-0-13-192756-8» no casa con la expresión del ISBN.
function textoDeHtml(raw) {
    return decodificarEntidades(String(raw)
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' '));
}

// Títulos de TEMA que no son el título del libro: las páginas del índice alfabético («A», «B», «SYMBOL»), la tabla
// de contenidos, los créditos, las páginas de la plataforma de la que se volcó el libro («Contact us», «Print»)…
const RE_TITULO_GENERICO = /^(index|[ií]ndice|contents|table of contents|toc|copyright( information)?|cover|title page|front( matter)?|preface|foreword|introduction|dedication|acknowledge?ments?|about the authors?|editors|contributors|appendix|appendices|ap[eé]ndices?|glossary|glosario|bibliography|bibliograf[ií]a|references|answers|symbol|main|home|start|begin|untitled|online help|contact us|print|search|help|.)$/i;
// Un CAPÍTULO no es el libro («Chapter 1 Biostatistics and Clinical Practice», 1.ª entrada del índice de un Ovid).
const RE_TITULO_CAPITULO = /^(chapter|cap[ií]tulo|part|parte|section|secci[oó]n|unit|unidad|lesson|lecci[oó]n)\s+([0-9]+|[ivxlc]+)\b/i;
// Las plataformas médicas y técnicas (Ovid, AccessMedicine, Student Consult…) ponen su nombre delante del título
// de cada página («Ovid: Principles of Ambulatory Medicine», «STUDENT CONSULT: Illustrated Textbook of Paediatrics
// (ver. 2.3)») o en lugar de él («AccessMedicine - TOC»). Se quita; si no queda nada, no hay título.
const RE_PLATAFORMA = /^(ovid|student consult|accessmedicine|access medicine|md consult|stat!?ref|safari( books online)?|r2 library|books@ovid)\s*(?:[:|–—-]\s*|$)/i;

/** Título de un tema sin el nombre de la plataforma ni su versión; '' si no queda nada. */
function limpiarTituloTema(t) {
    return decodificarEntidades(String(t || ''))
        .replace(RE_PLATAFORMA, '')
        .replace(/\s*\(ver\.?\s*[\d.]+\)\s*$/i, '')
        .trim();
}

/** ¿Sirve como título del libro (ya limpio)? Al menos dos letras seguidas, ni genérico ni un capítulo. */
function tituloValido(t) {
    const s = String(t || '').trim();
    return /\p{L}{2}/u.test(s) && !RE_TITULO_GENERICO.test(s) && !RE_TITULO_CAPITULO.test(s);
}

/** El título limpio si sirve, o null. */
function tituloDeTema(t) {
    const s = limpiarTituloTema(t);
    return tituloValido(s) ? s : null;
}

/** Índice (.hhc) del CHM: [{ titulo, href }] en orden de lectura, con el href relativo a la raíz del CHM. */
async function leerToc(ficheros) {
    const toc = [];
    const hhc = ficheros.find(f => f.toLowerCase().endsWith('.hhc'));
    if (!hhc) return toc;
    const txt = await fs.readFile(hhc).then(decodificarTexto).catch(() => '');
    for (const m of txt.matchAll(/<object[^>]*>([\s\S]*?)<\/object>/gi)) {
        const bloque = m[1];
        const name = (bloque.match(/name="Name"\s+value="([^"]*)"/i) || [])[1];
        const local = (bloque.match(/name="Local"\s+value="([^"]*)"/i) || [])[1];
        if (name && local) toc.push({ titulo: decodificarEntidades(name), href: decodificarEntidades(local).replace(/\\/g, '/') });
    }
    return toc;
}

/** Página inicial declarada en el .hhp («Default topic=»), relativa a la raíz del CHM, o null. */
async function temaInicial(ficheros) {
    const hhp = ficheros.find(f => f.toLowerCase().endsWith('.hhp'));
    if (!hhp) return null;
    const txt = await fs.readFile(hhp).then(decodificarTexto).catch(() => '');
    const m = txt.match(/^\s*Default topic\s*=\s*(.+?)\s*$/im);
    return m ? m[1].trim().replace(/\\/g, '/') : null;
}

// Páginas que suelen llevar los datos del libro (portada, portadilla, créditos): se leen antes que los capítulos.
const RE_PAGINA_DATOS = /cover|title|copyright|main|front|legal|imprint|isbn|colophon|credits|portad|cr[eé]ditos/i;

/**
 * Las páginas HTML en ORDEN DE LECTURA: la inicial del .hhp, las del índice en su orden, las que por su nombre suelen
 * traer los datos del libro y, al final, el resto por nombre. El orden del disco ponía el índice alfabético y los
 * capítulos delante de los créditos.
 */
function ordenDeLectura(dir, htmls, toc, inicial) {
    const porRel = new Map(htmls.map(h => [path.relative(dir, h).replace(/\\/g, '/').toLowerCase(), h]));
    const deHref = (href) => porRel.get(decodeURITolerante(String(href || '')).split(/[?#]/)[0].replace(/^[/\\]+/, '').toLowerCase());
    const orden = [];
    const poner = (h) => { if (h && !orden.includes(h)) orden.push(h); };
    poner(deHref(inicial));
    for (const t of toc) poner(deHref(t.href));
    const resto = [...htmls].sort((a, b) => a.localeCompare(b));
    for (const h of resto) if (RE_PAGINA_DATOS.test(path.basename(h))) poner(h);
    for (const h of resto) poner(h);
    return orden;
}

/**
 * CABECERA de los CHM de Safari Books Online (página inicial): «By Lynn E. Foster ……… Publisher: Prentice Hall
 * Pub Date: December 21, 2005 Print ISBN-10: 0-13-192756-6 Print ISBN-13: 978-0-13-192756-8 Pages: 336». Es la ficha
 * del propio libro: su ISBN es PROPIO, no una pista. Devuelve null si la página no la tiene.
 */
export function cabeceraSafari(texto) {
    const t = String(texto || '');
    if (!/\bPublisher\s*:/i.test(t) || !/\bPub(?:lication)?\.?\s*Date\s*:/i.test(t)) return null;
    const isbns = [...t.matchAll(/ISBN(?:-1[03])?\s*:\s*([0-9Xx][0-9Xx\s-]{8,16}[0-9Xx])/g)]
        .map(m => validarISBN(m[1])).filter(Boolean);
    const por = t.match(/\bBy\s+(.+?)\s*(?:\.{3,}|\bPublisher\s*:)/i);
    const autores = por
        ? por[1].split(/\s*(?:,|;|&|\band\b)\s*/i).map(s => s.trim()).filter(s => /\p{L}{2}/u.test(s) && s.length <= 60)
        : [];
    const editorial = (t.match(/\bPublisher\s*:\s*(.+?)\s+Pub(?:lication)?\.?\s*Date\s*:/i) || [])[1]?.trim() || null;
    const fecha = (t.match(/\bPub(?:lication)?\.?\s*Date\s*:\s*(.{4,40}?)\s+(?:Print\s+|eText\s+)?(?:ISBN|Pages)/i) || [])[1] || '';
    const anio = (fecha.match(/\b(1[89]\d\d|20\d\d)\b/) || [])[1] || null;
    const paginas = Number((t.match(/\bPages\s*:\s*(\d{1,5})\b/i) || [])[1]) || null;
    return {
        isbn: isbns.find(x => x.length === 13) || isbns[0] || null,
        autores, editorial, anio, paginas,
    };
}

/**
 * ISBN que IDENTIFICA el contenido por su nombre: la carpeta o el índice del CHM llamados como el ISBN (Safari:
 * `0131927566/`, `0131927566.hhc`), o un parámetro `isbn=` en los enlaces del índice o en los nombres de las páginas
 * volcadas de una web (Student Consult: `default.cfm@isbn=9780723433972&id=…`).
 */
function isbnDeNombres(dir, ficheros, toc = []) {
    const nombres = new Set();
    for (const f of ficheros) {
        const rel = path.relative(dir, f).split(path.sep);
        if (rel.length > 1) nombres.add(rel[0]);                                  // carpeta de primer nivel
        if (/\.(hhc|hhp|hhk)$/i.test(f)) nombres.add(path.basename(f).replace(/\.[^.]+$/, ''));
    }
    for (const n of nombres) {
        // Solo un nombre que ES un ISBN (10 o 13 cifras, con guiones como mucho): no cifras sueltas dentro de otro texto.
        if (/^(97[89]-?)?[0-9][0-9-]{8,15}[0-9Xx]$/.test(n)) { const v = validarISBN(n); if (v) return v; }
    }
    const enlaces = [...toc.map(t => t.href), ...ficheros.slice(0, 2000).map(f => path.basename(f))];
    for (const e of enlaces) {
        const m = String(e || '').match(/[?&@]isbn=([0-9Xx-]{10,17})(?![0-9])/i);
        const v = m ? validarISBN(m[1]) : null;
        if (v) return v;
    }
    return null;
}

// Imágenes que NUNCA son la portada: figuras y tablas del libro, iconos de navegación, separadores, logotipos.
const RE_NO_PORTADA = /\d+fig\d+|_alt\.|(^|[^a-z])(fig|figure|tab|table|eq|equation|icon|logo|pixel|spacer|blank|next|prev|previous|arrow|bullet|btn|button|note|tip|warning|caution|hed)([^a-z]|$)/i;

/** Extrae TODO el contenido del CHM a `destino` con libchm-bin. Lanza si la herramienta no está o falla. */
async function extraerChm(ruta, destino) {
    await execFileP('extract_chmLib', [ruta, destino], { timeout: 120000 });
}

/** Lista recursiva de ficheros (rutas absolutas) bajo `dir`. */
async function listarFicheros(dir) {
    const out = [];
    async function rec(d) {
        let entradas;
        try { entradas = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await rec(p);
            else out.push(p);
        }
    }
    await rec(dir);
    return out;
}

const MIME_IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp' };

/**
 * Lee un CHM → { titulo, isbn, isbn_propio, isbn_candidatos, issn, autores, editorial, anio, paginas,
 *                portada:{buf,mime}|null, portada_origen }.
 * `isbn_propio` es el ISBN de la ficha del propio libro (cabecera de Safari o nombre de su carpeta): se confía. Los
 * demás ISBN del texto son pistas (`isbn_candidatos`): podrían ser de libros citados.
 * Lanza solo si la extracción entera falla.
 */
export async function leerChm(ruta) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chm-'));
    try {
        await extraerChm(ruta, dir);                       // ← lanza si falta libchm-bin / CHM corrupto
        return await leerChmExtraido(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Metadatos de un CHM ya extraído en `dir` (separado de `leerChm` para poder probarlo con una extracción hecha por
 * otra herramienta, p. ej. `hh.exe -decompile` en Windows).
 */
export async function leerChmExtraido(dir) {
    const ficheros = await listarFicheros(dir);
    const toc = await leerToc(ficheros);
    const inicial = await temaInicial(ficheros);

    // 1) Título: del .hhp (Title=) — lo fija el autor del CHM —; si no, la 1.ª entrada del índice (en Safari, el
    //    título del libro). El <title> de la primera página leída viene después, en el recorrido.
    let titulo = null;
    const hhp = ficheros.find(f => f.toLowerCase().endsWith('.hhp'));
    if (hhp) {
        const txt = await fs.readFile(hhp).then(decodificarTexto).catch(() => '');
        const m = txt.match(/^\s*Title\s*=\s*(.+?)\s*$/im);
        if (m) titulo = tituloDeTema(m[1]);
    }
    if (!titulo && toc[0]) titulo = tituloDeTema(toc[0].titulo);

    // 2) Páginas EN ORDEN DE LECTURA: título (si aún falta), cabecera de Safari, ISBN/ISSN del texto.
    const htmls = ordenDeLectura(dir, ficheros.filter(f => /\.html?$/i.test(f)), toc, inicial);
    const isbnCandidatos = new Set();
    let issn = null, cabecera = null, primeraPagina = null, escaneados = 0;
    for (const h of htmls) {
        if (escaneados >= MAX_HTML_ESCANEO) break;
        let raw;
        try { raw = decodificarTexto(await fs.readFile(h)); } catch { continue; }
        if (raw.length > MAX_BYTES_HTML) raw = raw.slice(0, MAX_BYTES_HTML);
        escaneados++;
        if (!primeraPagina) primeraPagina = { ruta: h, raw };
        if (!titulo) {
            const mt = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
            if (mt) titulo = tituloDeTema(mt[1]);
        }
        const texto = textoDeHtml(raw);
        if (!cabecera && escaneados <= 5) cabecera = cabeceraSafari(texto);
        // Mismo criterio que el cuerpo de un PDF: diez cifras sueltas sin «ISBN» cerca no son un ISBN (las tablas de
        // un libro de bioestadística daban nueve «ISBN» que pasaban el dígito de control).
        for (const v of extraerISBNs(texto, { enTexto: true })) isbnCandidatos.add(v);
        if (!issn) { const is = extraerISSNs(texto); if (is.length) issn = is[0]; }
    }

    // ISBN PROPIO: el de la cabecera del libro o el que da nombre a su carpeta, su índice o sus enlaces.
    const isbnPropio = cabecera?.isbn || isbnDeNombres(dir, ficheros, toc);
    if (isbnPropio) isbnCandidatos.add(isbnPropio);

    // 3) Portada.
    const { portada, origen: portadaOrigen } = await elegirPortada(dir, ficheros, toc, primeraPagina, isbnPropio);

    const candidatos = [...isbnCandidatos];
    const isbn = isbnPropio || candidatos.find(c => c.length === 13) || candidatos[0] || null;
    return {
        titulo, isbn, isbn_propio: isbnPropio || null, isbn_candidatos: candidatos, issn,
        autores: cabecera?.autores || [], editorial: cabecera?.editorial || null,
        anio: cabecera?.anio || null, paginas: cabecera?.paginas || null,
        portada, portada_origen: portadaOrigen,
    };
}

/**
 * Portada del CHM, por este orden: la entrada «Cover/Portada» del índice (Ovid enlaza ahí la imagen de la cubierta);
 * una imagen llamada «cover/portada/front…»; la que lleva el ISBN del libro en el nombre (Safari: `0131927566_xs.jpg`,
 * pequeña pero ES la cubierta); y la primera imagen de la página inicial, si es vertical. Si nada de eso, ninguna.
 * `origen` dice cuál fue: «indice» | «nombre» | «isbn» | «pagina».
 */
async function elegirPortada(dir, ficheros, toc, primeraPagina, isbnPropio) {
    const imgs = ficheros.filter(f => /\.(jpe?g|png)$/i.test(f));  // JPG/PNG (medibles por resolverPortada); GIF/BMP se omiten
    const enDir = (href) => resolverDentro(dir, decodeURITolerante(String(href || '')).split(/[?#]/)[0]);
    // Primera imagen (que no sea un icono) de una página HTML.
    const primeraImagen = async (pagina, raw = null) => {
        if (!raw) { try { raw = decodificarTexto(await fs.readFile(pagina)); } catch { return null; } }
        const base = path.dirname(pagina);
        for (const m of raw.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
            if (/^(data:|https?:|\/\/)/i.test(m[1])) continue;
            const f = resolverDentro(base, decodeURITolerante(m[1]));
            if (f && imgs.includes(f) && !RE_NO_PORTADA.test(path.basename(f))) return f;
        }
        return null;
    };

    let elegida = null, origen = 'indice';
    const entradaCubierta = toc.find(t => /^(cover|front cover|portada|cubierta|car[aá]tula)$/i.test(t.titulo.trim()));
    if (entradaCubierta) {
        const destino = enDir(entradaCubierta.href);
        if (destino && imgs.includes(destino)) elegida = destino;
        else if (destino && /\.html?$/i.test(destino)) elegida = await primeraImagen(destino);
    }
    if (!elegida) {
        elegida = imgs.find(f => /cover|portada|front|caratula|cubierta/i.test(path.basename(f)));
        origen = 'nombre';
    }
    if (!elegida && isbnPropio) {
        const cifras = variantesISBN(isbnPropio).map(v => String(v).replace(/[^0-9X]/gi, ''));
        elegida = imgs.find(f => cifras.some(c => path.basename(f).replace(/[^0-9X]/gi, '').includes(c)));
        origen = 'isbn';
    }
    // La primera imagen de la página inicial es una suposición: solo vale si es VERTICAL (una cubierta lo es; un
    // logotipo o una cabecera de página, casi nunca).
    if (!elegida && primeraPagina) {
        const f = await primeraImagen(primeraPagina.ruta, primeraPagina.raw);
        const m = f ? medirImagen(await fs.readFile(f).catch(() => Buffer.alloc(0))) : null;
        if (m && m.height > m.width * 1.1) elegida = f;
        origen = 'pagina';
    }
    // Ya NO se toma «la imagen más grande»: medido el 5-nov, en los tres CHM técnicos donde decidió era una FIGURA
    // (un ganglio linfático, una gráfica de potencia estadística, un diagrama de nanotecnología). Sin cubierta, la
    // ingesta y el cotejo buscan una por ISBN, y la ficha ofrece las candidatas.
    if (!elegida) return { portada: null, origen: null };
    const buf = await fs.readFile(elegida).catch(() => null);
    if (!buf || !buf.length) return { portada: null, origen: null };
    return { portada: { buf, mime: MIME_IMG[path.extname(elegida).toLowerCase()] || 'image/jpeg' }, origen };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PREVISUALIZACIÓN en el panel: se extrae el CHM UNA vez a un temporal (cacheado por ruta + TTL, como los
// cómics) y se sirve cada tema (HTML) como un documento AUTOCONTENIDO —imágenes y CSS INCRUSTADOS como
// data-URI—. Así el cliente lo pinta en un iframe `srcdoc` SANDBOX (sin scripts, sin peticiones extra que
// tendrían que llevar el token): mismo patrón seguro que el visor de MOBI.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
const MIME_PREVIEW = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const CHM_TTL = Number(process.env.CHM_CACHE_TTL_MS || 20 * 60 * 1000);
const cacheChm = new Map();   // ruta → { dir, ts }

async function podarChm() {
    const ahora = Date.now();
    for (const [k, v] of cacheChm) {
        if (ahora - v.ts <= CHM_TTL) continue;
        cacheChm.delete(k);
        await fs.rm(v.dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Extrae (y cachea) el CHM a un temporal; devuelve el directorio. Lanza si falta libchm-bin / CHM corrupto. */
async function prepararChm(ruta) {
    await podarChm();
    const ya = cacheChm.get(ruta);
    if (ya) { ya.ts = Date.now(); return ya.dir; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chm-prev-'));
    try { await extraerChm(ruta, dir); }
    catch (e) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); throw e; }
    cacheChm.set(ruta, { dir, ts: Date.now() });
    return dir;
}

/** Resuelve `partes` DENTRO de `dir` (bloquea el path-traversal: nunca sale del árbol extraído). null si escapa. */
function resolverDentro(dir, ...partes) {
    const limpio = partes.map(s => String(s || '').split(/[?#]/)[0].replace(/^[/\\]+/, ''));
    const abs = path.resolve(dir, ...limpio);
    const raiz = path.resolve(dir);
    return (abs === raiz || abs.startsWith(raiz + path.sep)) ? abs : null;
}

/**
 * ÍNDICE del CHM para el visor: { toc: [{titulo, href}], entrada: <href de la página inicial> }.
 * El TOC sale del `.hhc` (objetos con param Name/Local); la entrada, del `.hhp` (Default topic) o el 1er tema.
 * Los href son relativos a la raíz del CHM (= `dir`).
 */
export async function indiceChm(ruta) {
    const dir = await prepararChm(ruta);
    const ficheros = await listarFicheros(dir);
    const rel = (f) => path.relative(dir, f).replace(/\\/g, '/');

    const toc = await leerToc(ficheros);
    let entrada = await temaInicial(ficheros);
    if (!entrada) entrada = toc[0]?.href || (ficheros.filter(f => /\.html?$/i.test(f)).map(rel).sort()[0] || null);
    return { toc, entrada };
}

/**
 * Página (tema) del CHM como HTML AUTOCONTENIDO: se leen sus <img> y <link rel=stylesheet> del árbol
 * extraído y se INCRUSTAN como data-URI / <style>, se quitan los <script> y se neutralizan los enlaces
 * internos (la navegación es por el índice lateral). Devuelve la cadena HTML o null si no existe el tema.
 */
export async function paginaChmInline(ruta, href) {
    const dir = await prepararChm(ruta);
    // El href del .hhc/enlaces viene URL-encodeado (%20=espacio, subcarpetas) → decodificar para hallar el fichero.
    const archivo = resolverDentro(dir, decodeURITolerante(href));
    if (!archivo) return null;
    let bytes;
    try { bytes = await fs.readFile(archivo); } catch { return null; }        // buffer (para detectar codificación)
    // Si el «tema» es una IMAGEN (algunas portadas son un .jpg/.png DIRECTO, no un HTML), se envuelve en una
    // página que la MUESTRA — si no, se renderizaban sus bytes crudos como texto (ÿØÿà…JFIF…).
    const extArch = path.extname(archivo).toLowerCase();
    if (MIME_PREVIEW[extArch]) {
        return `<div style="margin:0;text-align:center"><img src="data:${MIME_PREVIEW[extArch]};base64,${bytes.toString('base64')}" style="max-width:100%;height:auto"></div>`;
    }
    const baseDir = path.dirname(archivo);
    const $ = cheerio.load(decodificarTexto(bytes));
    $('script').remove();                               // defensa en profundidad (el iframe ya es sandbox)
    // El charset del CONTENIDO ya no aplica: servimos texto YA decodificado y el iframe declara UTF-8. Dejar
    // un <meta charset=windows-1252> haría que el navegador reinterpretara el texto → mojibake de nuevo.
    $('meta').each((_, el) => {
        const $el = $(el);
        if ($el.attr('charset') != null || /content-type/i.test($el.attr('http-equiv') || '')) $el.remove();
    });

    // <img src> → data-URI (imágenes locales; se dejan las remotas/data tal cual). La ruta va URL-decodificada.
    for (const img of $('img').toArray()) {
        const src = $(img).attr('src');
        if (!src || /^(data:|https?:|\/\/)/i.test(src)) continue;
        const f = resolverDentro(baseDir, decodeURITolerante(src));
        if (!f) continue;
        try {
            const buf = await fs.readFile(f);
            $(img).attr('src', `data:${MIME_PREVIEW[path.extname(f).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`);
        } catch { /* imagen ausente: se deja el src roto, no rompe la página */ }
    }
    // <link rel=stylesheet href> → <style> incrustado (decodificando su codificación también)
    for (const link of $('link[rel=stylesheet], link[type="text/css"]').toArray()) {
        const h = $(link).attr('href');
        if (!h || /^(https?:|\/\/)/i.test(h)) continue;
        const f = resolverDentro(baseDir, decodeURITolerante(h));
        if (!f) continue;
        try { $(link).replaceWith(`<style>${decodificarTexto(await fs.readFile(f))}</style>`); } catch { /* css ausente */ }
    }
    return $.html();
}
