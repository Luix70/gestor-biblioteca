/**
 * LIBRO DESGLOSADO — una carpeta que contiene UN libro principal MÁS su desglose (capítulos sueltos, front/back
 * matter, apéndices, material adicional). Es un patrón muy común en material académico: el editor publica el
 * libro entero Y, al lado, cada capítulo por separado.
 *
 * QUÉ QUEREMOS: catalogar el LIBRO de forma ORDINARIA (pipeline normal: ISBN, CDU, metadatos) y que TODO lo
 * demás viaje con él como MATERIAL ADJUNTO, agrupado en UNA carpeta. Sin perder nada.
 *
 * CÓMO SE DISTINGUE DE UNA COLECCIÓN DE LIBROS (que es lo que parece a primera vista): exigimos DOS señales
 * fuertes A LA VEZ, más una tercera de apoyo:
 *   1) NOMBRE: hay un documento cuyo título se PARECE al nombre de la carpeta (contención de palabras ≥ 0,6).
 *      En una colección («Novelas de Asimov» con «Fundación.pdf», «Yo, robot.pdf») ningún fichero se parece
 *      al nombre de la carpeta.
 *   2) TAMAÑO: ese documento DOMINA (≥ 2,5× el mayor de los demás). El libro entero pesa mucho más que
 *      cualquiera de sus capítulos. En una colección los tamaños son comparables.
 *   3) APOYO: la mayoría de los demás documentos tienen nombre de PARTE (Chapter07, 01_title, 05-CH, App2,
 *      _ch10, TOC/index/preface…), que es justo lo que no ocurre en una colección de obras independientes.
 *
 * Si NO hay principal claro (p. ej. una carpeta que SOLO trae los capítulos, sin el libro entero) se devuelve
 * null a propósito: no adivinamos cuál de los capítulos «es el libro». Ese caso va al Inspector para que lo
 * decida el humano (guía `libro-material` / `intacta` / `obra`).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paginasPdf } from './qpdf.js';
const ejecutarCmd = promisify(execFile); // pdftotext (poppler) para la comprobación de capa de texto

// Extensiones que cuentan como DOCUMENTO (el principal y sus partes; las partes pueden ser .doc/.docx).
const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.djv', '.chm', '.doc', '.docx', '.rtf']);
const esDoc = (n) => EXT_DOC.has(path.extname(n).toLowerCase());
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || n === '_guia.json';

// Palabras vacías que no aportan al parecido (inflan la intersección sin significar nada).
const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'a', 'en', 'and', 'of', 'the', 'for', 'to', 'in', 'con', 'un', 'una']);

/** Normaliza a palabras comparables: minúsculas, sin acentos ni puntuación, sin palabras vacías. */
function palabras(texto) {
    return String(texto || '')
        .normalize('NFD').replace(new RegExp('[\u0300-\u036f]', 'g'), '')   // fuera acentos (rango combinante)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((p) => p.length >= 2 && !VACIAS.has(p));
}

/** Parecido por CONTENCIÓN: cuántas palabras del conjunto MENOR aparecen en el otro (0..1). */
function parecido(aTexto, bTexto) {
    const a = new Set(palabras(aTexto)), b = new Set(palabras(bTexto));
    if (!a.size || !b.size) return 0;
    let comunes = 0;
    for (const p of a) if (b.has(p)) comunes++;
    return comunes / Math.min(a.size, b.size);
}

// ¿El nombre parece una PARTE de un libro (capítulo, apéndice, portadilla, índice…)?
const RE_PARTE = [
    /^\d{1,3}([_\-. ]|$)/i,                                    // 01_title · 05-CH · 12.pdf · «07 algo»
    /(chapter|cap[ií]tulo|\bcap\b|unit|unidad|secci[oó]n|section|part[e]?|app(endix)?|anexo)[ _\-]*\d+/i,
    /[_\-](ch|cap|sec|app|unit)[ _\-]*\d+/i,                   // ste30670_ch10 · x-app2
    /(^|[_\-])(fm|bm|toc|index|indice|preface|prefacio|title|titulo|copyri|adboard|glossar|glosario|biblio|apendice|appendix|cover|portada|contents)/i,
    // ⚠ AQUÍ HABÍA UN /\d{1,3}$/ («acaba en dígitos») y fue la causa de un incidente REAL: casi todo libro
    // acaba en dígitos (año, edición, identificador), así que una carpeta de 433 libros independientes daba
    // ratio de «partes» = 1.00 y se tragó entera como desglose de uno solo. Una regla que casa con casi todo
    // no aporta información: fuera.
];

/**
 * ¿Los nombres de las partes son SISTEMÁTICOS (una serie generada por el editor) y no títulos heterogéneos?
 * ESTA es la señal fiable para distinguir un desglose de una COLECCIÓN, porque el «parecido con el nombre de
 * la carpeta» NO sirve: una colección suele llamarse como su tema («Historia de España») y siempre habrá
 * dentro un libro que comparta esas palabras. Un desglose, en cambio, viene numerado por el editor:
 *   · Chapter01…Chapter15  → mismo ESQUELETO al quitar los dígitos, o
 *   · 01_title…74_replycard / 00-FM…15-CH → EMPIEZAN por número.
 * Una colección de obras independientes no cumple ninguna de las dos.
 */
function nombresSistematicos(nombres) {
    if (!nombres.length) return false;
    const bases = nombres.map((n) => path.basename(n, path.extname(n)));
    // ESQUELETO = el nombre sin dígitos ni separadores. «Chapter07»→"chapter", «ste30670_ch10»→"stech",
    // «01»→"" (numeración pura). Una FAMILIA es un esqueleto con ≥3 miembros: eso es una serie generada por
    // el editor, no una coincidencia. Un desglose puede tener VARIAS familias a la vez (p. ej. los capítulos
    // numerados «01…40» conviviendo con «ste30670_chNN» y «AppN»), y todas cuentan.
    const esqueleto = (b) => b.replace(/\d+/g, '').replace(/[\s_\-.]+/g, '').toLowerCase();
    const cuenta = new Map();
    for (const b of bases) { const e = esqueleto(b); cuenta.set(e, (cuenta.get(e) || 0) + 1); }
    // «Empieza por número» ha de ser una NUMERACIÓN CORTA del editor (01_, 05-, 12.), no un identificador
    // largo: los ficheros del incidente empezaban por el ISBN («0521880092.Cambridge…») y con un simple
    // /^\d/ habrían pasado por sistemáticos. Se exige 1-3 dígitos NO seguidos de más dígitos.
    const numeracionCorta = (b) => /^\d{1,3}(?!\d)/.test(b);
    const enFamilia = bases.filter((b) => numeracionCorta(b) || (cuenta.get(esqueleto(b)) || 0) >= 3).length;
    // Una COLECCIÓN de obras independientes tiene títulos ÚNICOS: ningún esqueleto se repite y casi ninguno
    // empieza por número → el ratio se desploma y no pasa.
    return enFamilia / bases.length >= 0.7;
}
const pareceParte = (n) => { const base = path.basename(n, path.extname(n)); return RE_PARTE.some((re) => re.test(base)); };

// Umbrales (conservadores: ante la duda, NO es un desglose y lo decide el humano).
const MIN_PARTES = 4;        // un libro desglosado trae varias partes, no una o dos
const MIN_PARECIDO = 0.6;    // parecido nombre-fichero ↔ nombre-carpeta
const MIN_DOMINIO = 2.5;     // el libro entero pesa al menos 2,5× la mayor de sus partes
const MIN_RATIO_PARTES = 0.6; // ≥60% de los demás documentos tienen pinta de parte
const MAX_PARTES = 120;      // por encima no es un libro despiezado, es un fondo de libros (acota el daño)

/**
 * ¿`dir` es un LIBRO DESGLOSADO? Devuelve { principal, partes, dominio, parecido } o null.
 * Solo mira la RAÍZ de la carpeta (las subcarpetas, si las hay, viajan como material igualmente).
 */
export async function detectarLibroDesglosado(dir) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return null; }

    // Documentos de la RAÍZ con su tamaño.
    const docs = [];
    for (const e of entradas) {
        if (!e.isFile() || ignorar(e.name) || !esDoc(e.name)) continue;
        let size = 0;
        try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* sin stat */ }
        docs.push({ nombre: e.name, size });
    }
    if (docs.length < MIN_PARTES + 1) return null;   // hace falta el libro + varias partes
    // TOPE de partes: un libro se desglosa en decenas de piezas (el máximo real observado son 74), no en
    // cientos. Por encima, lo más probable es que sea un FONDO de libros y no un desglose — y el coste de
    // equivocarse ahí es enorme (el incidente adjuntó 433 libros a uno solo). Acota el daño por diseño.
    if (docs.length - 1 > MAX_PARTES) return null;

    // 1) PRINCIPAL: el documento MAYOR de entre los que se parecen al nombre de la carpeta.
    const nombreCarpeta = path.basename(dir);
    const candidatos = docs
        .map((d) => ({ ...d, sim: parecido(path.basename(d.nombre, path.extname(d.nombre)), nombreCarpeta) }))
        .filter((d) => d.sim >= MIN_PARECIDO)
        .sort((a, b) => b.size - a.size);
    if (!candidatos.length) return null;
    const principal = candidatos[0];

    // 2) DOMINIO de tamaño sobre el resto (el libro entero vs. su mayor capítulo).
    const resto = docs.filter((d) => d.nombre !== principal.nombre);
    const mayorResto = Math.max(...resto.map((d) => d.size), 1);
    const dominio = principal.size / mayorResto;
    if (dominio < MIN_DOMINIO) return null;

    // 3) APOYO: la mayoría del resto tiene nombre de PARTE (esto es lo que no cumple una colección de obras).
    const nPartes = resto.filter((d) => pareceParte(d.nombre)).length;
    if (nPartes / resto.length < MIN_RATIO_PARTES) return null;

    // 4) DECISIVO: las partes han de venir NUMERADAS/SISTEMÁTICAS por el editor. Sin esto, una colección de
    //    libros independientes cuya carpeta se llama como su tema colaba entera (incidente real: 433 libros
    //    adjuntados a uno solo). El parecido del nombre y el dominio de tamaño NO bastan: en una colección
    //    siempre hay un volumen grande que comparte palabras con la carpeta.
    if (!nombresSistematicos(resto.map((d) => d.nombre))) return null;

    return {
        principal: principal.nombre,
        partes: resto.map((d) => d.nombre),
        dominio: Number(dominio.toFixed(1)),
        parecido: Number(principal.sim.toFixed(2)),
        ratioPartes: Number((nPartes / resto.length).toFixed(2)),
    };
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// DESGLOSE PURO: la carpeta trae SOLO las partes, sin el libro entero (p. ej. FrontMatter + Chapter01..31 +
// Appendix + Glossary + Index). Aquí no hay un «principal» que elegir, y usar el FrontMatter como documento
// principal sería separar la obra de forma arbitraria: el visor abriría 20 páginas haciéndolas pasar por un
// libro de 700. La salida es COSER las partes en un solo PDF (qpdf, sin re-renderizar) y tratarlo como el caso
// anterior — con el añadido feliz de que las primeras páginas del resultado SON el front matter, justo donde
// el pipeline busca ISBN/CIP: identificación autoritativa y GRATIS (sin IA). Los originales viajan intactos.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

// Portada/preliminares (van primero) y material final (va al final, en este orden).
// Incluye la serie de Wiley y otros editores: ffirs, ftoc, fpref… delante; bapp01, bgloss, bindex… detrás.
const RE_FRONT = /(front[ _-]?matter|^fm\d*$|^fm[ _-]|[_-]\d*fm\d*$|^bkfm|inside[ _-]?cover|portadilla|^cover|^portada|^title|^titulo|copyri|^toc$|contents|preface|prefacio|^prefix|pr[oó]logo|^intro|^ack|^author'?s?\b|^foreword|^dedicat|^f(firs|last|toc|pref|betw|fore|intro|ack|ded)\b)/i;
const FIN = [
    [/(appendi|ap[eé]ndice|anexo|^bapp|(^|[_-])app[ _-]*[a-z\d]$)/i, 1],
    [/glos/i, 2],
    [/((^|[ _-])(index(es)?|[ií]ndice)([ _-]|$)|^[a-z]?index\b|idx|indx)/i, 3],   // «nindex.qxd» y «sindex.qxd»: de nombres y de materias
    [/(biblio|referenc|^bib$|^b?refs?\b|[_-]refs?$)/i, 4],
    [/(answer|solucion|respuesta)/i, 5],
    [/(back[ _-]?matter|^bm$|^bm[ _-]|[_-]bm\d*$|^bkrm)/i, 6],
    [/(credits?|cr[eé]ditos)/i, 7],
];
/**
 * Número de la parte. Primero el que sigue a «chapter», «ch», «unit»…: en «FAA-H-8083-15A - Chapter 04» o
 * «ste30670_ch10» el primer número del nombre es el del documento, igual en todas las partes. Si no, el primero
 * que aparezca (05-CH → 5). null si no hay.
 */
const numDe = (base) => {
    const marcado = base.match(/(?:chapter|cap[ií]tulo|cap|chap|ch|unit|unidad|lesson|lecci[oó]n|section|secci[oó]n)[ _.-]*(\d{1,4})/i);
    if (marcado) return Number(marcado[1]);
    const m = base.match(/\d{1,4}/);
    return m ? Number(m[0]) : null;
};
// «p01», «part 2»: la portadilla de una parte va ANTES del capítulo con el mismo número.
const RE_PORTADILLA_PARTE = /^p(art)?[ _-]*\d/i;

/**
 * Prefijo que comparten TODOS los nombres (sin distinguir mayúsculas), sin cifras al final («Chapter0» de
 * «Chapter01…Chapter09» se queda en «Chapter»: el número es de la parte). Solo con 3+ partes y 3+ caracteres:
 * con dos nombres «Preface»/«Prelude» se comerían su propia palabra. Nunca deja un nombre vacío.
 */
function prefijoComun(bases) {
    if (bases.length < 3) return '';
    let p = bases[0];
    for (const b of bases) {
        let i = 0;
        while (i < p.length && i < b.length && p[i].toLowerCase() === b[i].toLowerCase()) i++;
        p = p.slice(0, i);
    }
    p = p.replace(/\d+$/, '');
    if (p.length < 3 || bases.some((b) => b.length <= p.length)) return '';
    return p;
}

/**
 * Ordena las partes de un libro como se leería: preliminares → partes numeradas → material final
 * (apéndices → glosarios → índice → bibliografía → soluciones). Determinista y estable.
 */
export function ordenarPartesLibro(nombres) {
    // El número inicial manda solo si es una numeración GLOBAL (01_title … 74_replycard). Si se repite, cada familia
    // lleva la suya («01 appendix», «01 chapter», «01 title page», o un ISBN delante): decide la palabra.
    const inicial = (base) => base.match(/^\d{1,3}(?!\d)/)?.[0] ?? null;
    const usos = new Map();
    for (const n of nombres) {
        const i = inicial(path.basename(n, path.extname(n)));
        if (i != null) usos.set(Number(i), (usos.get(Number(i)) || 0) + 1);
    }
    // Prefijo común a todas las partes («KENNch01», «KENNack», «KENNbkfm»; «CliffordFM»; «mad86161 fm»): es la marca
    // del libro, no de la parte. Sin quitarlo, «^ack» o «^fm» no casan y el front matter acababa entre los capítulos
    // (College Books, 3-nov: el de «Literature» en la página 3.082, lejos de donde se busca el ISBN).
    const prefijo = prefijoComun(nombres.map((n) => path.basename(n, path.extname(n))));
    const clasificar = (n) => {
        const base = path.basename(n, path.extname(n));
        const i = inicial(base);
        if (i != null && usos.get(Number(i)) === 1) return { bloque: 1, orden: Number(i), base };   // «01_title», «05-CH»
        const palabra = base.slice(prefijo.length).replace(/^\d{1,3}[ _.-]+(?=\D)/, '');
        if (RE_FRONT.test(palabra)) return { bloque: 0, orden: 0, base };
        for (const [re, sub] of FIN) if (re.test(palabra)) return { bloque: 3, orden: sub * 1000 + (numDe(palabra) ?? 0), base };
        const num = numDe(base.slice(prefijo.length));   // «mad86161 01»: el 86161 es del libro
        if (num != null) return { bloque: 1, orden: RE_PORTADILLA_PARTE.test(base) ? num - 0.5 : num, base };   // «Chapter07»
        return { bloque: 2, orden: 0, base };                                          // sin pistas: entre medias
    };
    return nombres
        .map((n) => ({ n, c: clasificar(n) }))
        .sort((a, b) => a.c.bloque - b.c.bloque || a.c.orden - b.c.orden
            || a.c.base.localeCompare(b.c.base, 'es', { numeric: true, sensitivity: 'base' }))
        .map((x) => x.n);
}

/**
 * Con qué ficheros se cose un libro. `docs` son las partes presentes y `ordenGuia` el orden de la guía; lo que la
 * guía no nombre va al final en el orden determinista (coserlo sin una parte sería perder contenido en silencio).
 * Una parte que no es PDF se cose con su gemelo «.pdf» si lo tiene (scripts/convertir-partes-word.ps1 los deja al
 * lado del original). Devuelve { aCoser, sinPdf, titulos }; `sinPdf` no vacío = aún no se puede coser.
 */
export function planCosido(docs, ordenGuia = [], titulos = {}) {
    const enGuia = [...new Set(ordenGuia)].filter((n) => docs.includes(n));
    const orden = [...enGuia, ...ordenarPartesLibro(docs.filter((n) => !enGuia.includes(n)))];
    const presentes = new Map(docs.map((n) => [n.toLowerCase(), n]));
    const aCoser = [], sinPdf = [], titulosPdf = {};
    for (const n of orden) {
        const ext = path.extname(n).toLowerCase();
        const pdf = ext === '.pdf' ? n : presentes.get((n.slice(0, -ext.length) + '.pdf').toLowerCase());
        if (!pdf) { sinPdf.push(n); continue; }
        if (!aCoser.includes(pdf)) aCoser.push(pdf);
        if (titulos[n] && !titulosPdf[pdf]) titulosPdf[pdf] = titulos[n];
    }
    return { aCoser, sinPdf, titulos: titulosPdf };
}

/**
 * Si el libro viene entero en PDF y además en .doc por capítulos, los .doc son una COPIA: cosidos o convertidos, el
 * libro saldría duplicado («A Short Guide to Writing about History»: 01…08.pdf y MARIcp01…08.doc). Se reconoce porque
 * los capítulos numerados de los .doc ya están en los PDF. Devuelve las partes que hay que coser.
 */
export function sinCopiasParalelas(docs) {
    const esPdf = (n) => path.extname(n).toLowerCase() === '.pdf';
    const numero = (n) => numDe(path.basename(n, path.extname(n)));
    const pdfs = docs.filter(esPdf);
    const numerados = docs.filter((n) => !esPdf(n)).map(numero).filter((x) => x != null);
    if (pdfs.length < 5 || !numerados.length) return docs;
    const enPdf = new Set(pdfs.map(numero));
    return numerados.filter((x) => enPdf.has(x)).length / numerados.length >= 0.8 ? pdfs : docs;
}

// Formatos en los que puede venir el libro entero (un .doc es siempre un capítulo o un manuscrito).
const EXT_LIBRO_ENTERO = new Set(['.pdf']);
const PAGS_MIN_ENTERO = 100;         // por debajo no es un libro de texto entero
const RATIO_PAGS_ENTERO = 0.7;       // el entero tiene al menos el 70 % de las páginas de las demás partes juntas
const DOMINIO_PAGS_ENTERO = 2;       // y al menos el doble que la mayor de ellas
const RATIO_COPIA_ENTERO = 0.8;      // lo que tenga el 80 % de sus páginas es otra copia o edición del entero
const PAGS_ESTIMADAS_DOC = 5;        // un .doc no se puede medir aquí: cuenta como un capítulo mínimo

/**
 * ¿Entre las partes de una carpeta que YA se sabe que es un libro desglosado está el libro ENTERO, aunque su nombre
 * no se parezca al de la carpeta («12e.pdf», «Introduction to Literature 14e.pdf»)? Devuelve su ruta relativa o null.
 *
 * Se mide en PÁGINAS, no en bytes. En bytes engaña: el capítulo 7 del Instrument Flying Handbook pesa 23 MB de 48 y
 * cuatro veces lo que el siguiente, y es solo una parte de sus 387 páginas. Sin este paso, varios libros cosieron el
 * entero con sus propios capítulos. Una parte cuyas páginas no se puedan medir cuenta 0.
 */
export async function libroEnteroEntrePartes(dir, partes, { rutaDe = (n) => path.join(dir, ...n.split('/')) } = {}) {
    const candidatos = [];
    for (const nombre of partes) {
        if (!EXT_LIBRO_ENTERO.has(path.extname(nombre).toLowerCase())) continue;
        candidatos.push({ nombre, paginas: await paginasPdf(rutaDe(nombre)) || 0 });
    }
    if (!candidatos.length) return null;
    candidatos.sort((a, b) => b.paginas - a.paginas);
    const mayor = candidatos[0];
    if (mayor.paginas < PAGS_MIN_ENTERO) return null;
    // Copias del entero: no son partes, y entre ellas se prefiere la que no se llame como una parte. Medido:
    // en «Understanding Movies», «Chapter 6.pdf» es el libro entero repetido (624 págs. las dos).
    const copias = candidatos.filter((c) => c.paginas >= RATIO_COPIA_ENTERO * mayor.paginas);
    const resto = candidatos.filter((c) => !copias.includes(c));
    const sinMedir = partes.length - candidatos.length;
    // Sin sumar: si hay capítulos en PDF, los .doc suelen ser esos mismos capítulos.
    const sumaResto = Math.max(resto.reduce((s, c) => s + c.paginas, 0), sinMedir * PAGS_ESTIMADAS_DOC);
    const segunda = Math.max(resto[0]?.paginas || 0, sinMedir ? PAGS_ESTIMADAS_DOC : 0);
    if (!sumaResto) return null;
    if (mayor.paginas < RATIO_PAGS_ENTERO * sumaResto || mayor.paginas < DOMINIO_PAGS_ENTERO * segunda) return null;
    return (copias.find((c) => !pareceParte(c.nombre)) || mayor).nombre;
}

// Subcarpetas que, dentro de un libro desglosado, guardan sus PARTES: «Chapters/», «Capítulos/», «PDF/»…
export const RE_CARPETA_PARTES = /^(chapters?|cap[ií]tulos?|caps|parts?|partes?|sections?|secciones?|split|pdfs?|unidades|units?|lessons?|lecciones|temas)$/i;

/**
 * PARTES de un libro desglosado: los documentos sueltos de la carpeta MÁS los de sus subcarpetas de partes (por
 * nombre, o las que se indiquen — p. ej. las que el agente marcó como «parte»). Devuelve rutas RELATIVAS a `dir`
 * («Chapters/ch01.pdf»). Antes solo se miraba la raíz, y un libro con sus capítulos en «Chapters/» no se cosía.
 */
export async function partesDeDesglose(dir, subcarpetas = []) {
    const out = [];
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    const indicadas = new Set(subcarpetas);
    for (const e of ents) {
        if (ignorar(e.name)) continue;
        if (e.isFile() && esDoc(e.name)) { out.push(e.name); continue; }
        if (!e.isDirectory() || !(indicadas.has(e.name) || RE_CARPETA_PARTES.test(e.name))) continue;
        let sub;
        try { sub = await fs.readdir(path.join(dir, e.name), { withFileTypes: true }); } catch { continue; }
        for (const s of sub) if (s.isFile() && !ignorar(s.name) && esDoc(s.name)) out.push(`${e.name}/${s.name}`);
    }
    return out;
}

/**
 * ¿El NOMBRE dice por sí solo dónde va la parte en el libro? Un número (Chapter07, 05-CH), un preliminar
 * (Preface, Contents) o material final (Index, Appendix). Si casi todas lo dicen, ordenarPartesLibro acierta sin
 * ayuda; si no (capítulos nombrados por su TÍTULO: «The Fall of Rome.pdf»), el orden alfabético es el equivocado y
 * hace falta leer el sumario (afinar-guias · detallarDesglose, con IA).
 */
export function tienePistaDeOrden(nombre) {
    const base = path.basename(nombre, path.extname(nombre));
    return numDe(base) != null || RE_FRONT.test(base) || FIN.some(([re]) => re.test(base));
}

const MIN_PAGS_PARTE = 3;   // un capítulo tiene páginas; una lámina/página suelta, una

/**
 * ¿Las partes PARECEN CAPÍTULOS de un libro (y no láminas/páginas sueltas escaneadas, que deben ir por
 * «empaquetar» → cbz, como los Grabados)? Se miran DOS cosas sobre una muestra de 3 partes:
 *
 *   1) PÁGINAS POR FICHERO (la señal fuerte, e INMUNE AL OCR): un capítulo trae muchas páginas
 *      (aquí 10–25); una lámina o una página escaneada trae UNA. Medido: Grabados = 1 pág./fichero en los
 *      seis; Automotive Engines = 20/25/10. Basar la barrera solo en la «capa de texto» era un colador: un
 *      escaneo PASADO POR OCR sí tiene texto y habría colado.
 *   2) CAPA DE TEXTO real en alguna muestra (señal de apoyo).
 *
 * FALLA EN CERRADO a propósito: si no se puede medir (poppler ausente/PDF ilegible) se devuelve false y NO se
 * cose. Coser fabrica un fichero derivado; ante la duda, que lo decida el humano en el Inspector.
 */
async function parecenCapitulosDeLibro(dir, partes) {
    const indices = [...new Set([0, Math.floor(partes.length / 2), partes.length - 1])];
    const muestra = indices.map((i) => partes[i]).filter(Boolean);
    const paginas = [], textos = [];
    for (const p of muestra) {
        const ruta = path.join(dir, p);
        try {
            const { stdout } = await ejecutarCmd('pdfinfo', [ruta], { timeout: 20000, maxBuffer: 1 << 20 });
            const m = stdout.match(/^Pages:\s+(\d+)/m);
            if (m) paginas.push(Number(m[1]));
        } catch { /* ilegible: no cuenta */ }
        try {
            const { stdout } = await ejecutarCmd('pdftotext', ['-f', '1', '-l', '1', ruta, '-'], { timeout: 20000, maxBuffer: 1 << 20 });
            textos.push((stdout || '').replace(/\s/g, '').length);
        } catch { /* sin texto extraíble */ }
    }
    if (!paginas.length) return false;                       // no medible → NO se cose (fallo en cerrado)
    paginas.sort((a, b) => a - b);
    const mediana = paginas[Math.floor(paginas.length / 2)];
    if (mediana < MIN_PAGS_PARTE) return false;              // ~1 página por fichero = láminas, no capítulos
    return textos.some((n) => n >= 200);                     // y alguna muestra con texto de verdad
}

const MIN_PARTES_PURO = 6;      // coser tiene sentido con un libro de verdad, no con 3 ficheros
const MIN_RATIO_PARTES_PURO = 0.8; // aquí somos MÁS exigentes: no hay «principal» que confirme el patrón

// Palabra EXPLÍCITA de capítulo/unidad (no vale «acaba en números»: «I03133» es un identificador de lámina).
const RE_CAPITULO = /(chapter|cap[ií]tulo|\bcap\b|unit|unidad|secci[oó]n|section|lecci[oó]n|tema)[ _-]*\d+/i;
/**
 * ¿Hay EVIDENCIA ESTRUCTURAL de que esto es un LIBRO despiezado y no una serie de piezas independientes?
 * Sin un «principal» que confirme el patrón, exigir solo «ficheros numerados» es demasiado laxo: una carpeta de
 * LÁMINAS sueltas (I03133.pdf … I03138.pdf, todas del mismo tamaño) también lo cumple, y coserlas sería inventar
 * un libro que no existe. Se pide ver el ESQUELETO de un libro: preliminares, material final, o capítulos
 * nombrados como tales.
 */
function evidenciaLibro(nombres) {
    const bases = nombres.map((n) => path.basename(n, path.extname(n)));
    const hayFront = bases.some((b) => RE_FRONT.test(b));
    const hayFin = bases.some((b) => FIN.some(([re]) => re.test(b)));
    const nCap = bases.filter((b) => RE_CAPITULO.test(b)).length;
    return hayFront || hayFin || nCap >= 3;
}

// Series de capítulos que pareceParte no reconoce: «KENNch12», «MARIcp01», «c01», «p01».
const RE_CAPITULO_SUELTO = /^(?:[a-z]{2,8}c[hp]|[cp] ?)\d{1,3}$/i;

/**
 * ¿Es EVIDENTE que esta carpeta sin guía es UN libro por capítulos con partes que no son PDF? detectarDesglosePuro
 * solo admite PDF, y sin esta red cada capítulo .doc acababa de documento suelto. Basta con esperar en el Inbox si la
 * detección se pasa, así que no hace falta medir páginas: nombres de parte en casi todos y el esqueleto de un libro.
 */
export async function esLibroPorCapitulos(dir) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return false; }
    const docs = entradas.filter((e) => e.isFile() && !ignorar(e.name) && esDoc(e.name)).map((e) => e.name);
    if (docs.length < MIN_PARTES_PURO) return false;
    if (docs.every((n) => path.extname(n).toLowerCase() === '.pdf')) return false;   // ese caso es de detectarDesglosePuro
    const sueltos = docs.filter((n) => RE_CAPITULO_SUELTO.test(path.basename(n, path.extname(n)))).length;
    const conNombre = docs.filter((n) => pareceParte(n) || RE_CAPITULO_SUELTO.test(path.basename(n, path.extname(n)))).length;
    if (conNombre / docs.length < MIN_RATIO_PARTES_PURO) return false;
    return evidenciaLibro(docs) || sueltos >= 3;
}

/**
 * ¿`dir` es un DESGLOSE PURO (solo las partes, sin el libro)? Devuelve { partes (YA ORDENADAS), titulo } o null.
 * Exigencias: ningún principal claro, ≥6 documentos, TODOS PDF (no se pueden coser .doc) y ≥80% con nombre de
 * parte. Si no se cumple, null: mejor que lo decida el humano en el Inspector que recomponer algo inventado.
 */
export async function detectarDesglosePuro(dir) {
    if (await detectarLibroDesglosado(dir)) return null;   // si hay libro entero, ese es el camino (no se cose)
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return null; }

    const docs = entradas.filter((e) => e.isFile() && !ignorar(e.name) && esDoc(e.name)).map((e) => e.name);
    if (docs.length < MIN_PARTES_PURO) return null;
    // TODOS los documentos han de ser PDF: qpdf no cose .doc/.epub, y mezclar dejaría partes fuera del libro.
    const pdfs = docs.filter((n) => path.extname(n).toLowerCase() === '.pdf');
    if (pdfs.length !== docs.length) return null;
    // La inmensa mayoría debe tener nombre de PARTE (sin un principal que lo confirme, subimos el listón).
    const nPartes = pdfs.filter(pareceParte).length;
    if (nPartes / pdfs.length < MIN_RATIO_PARTES_PURO) return null;
    // Y sobre todo: que se vea el ESQUELETO de un libro (preliminares / material final / capítulos nombrados).
    // Sin esto, una carpeta de láminas sueltas numeradas se «cosería» como si fuera un libro inexistente.
    if (!evidenciaLibro(pdfs)) return null;
    // Y una señal de CONTENIDO, no de nombres: los capítulos traen MUCHAS páginas (inmune al OCR), las láminas
    // una. Separa el cosido del camino «empaquetar»→cbz aunque los nombres despistaran. Falla en cerrado.
    if (!(await parecenCapitulosDeLibro(dir, ordenarPartesLibro(pdfs)))) return null;

    return { partes: ordenarPartesLibro(pdfs), titulo: path.basename(dir), ratioPartes: Number((nPartes / pdfs.length).toFixed(2)) };
}
