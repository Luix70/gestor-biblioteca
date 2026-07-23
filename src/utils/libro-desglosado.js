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
    /\d{1,3}$/,                                                 // ENGLI001 · algo_12
];
const pareceParte = (n) => { const base = path.basename(n, path.extname(n)); return RE_PARTE.some((re) => re.test(base)); };

// Umbrales (conservadores: ante la duda, NO es un desglose y lo decide el humano).
const MIN_PARTES = 4;        // un libro desglosado trae varias partes, no una o dos
const MIN_PARECIDO = 0.6;    // parecido nombre-fichero ↔ nombre-carpeta
const MIN_DOMINIO = 2.5;     // el libro entero pesa al menos 2,5× la mayor de sus partes
const MIN_RATIO_PARTES = 0.6; // ≥60% de los demás documentos tienen pinta de parte

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
const RE_FRONT = /(front[ _-]?matter|^fm$|^fm[ _-]|portadilla|^cover|^portada|^title|^titulo|copyri|^toc$|contents|preface|prefacio|pr[oó]logo)/i;
const FIN = [
    [/(appendix|ap[eé]ndice|anexo)/i, 1],
    [/(glossar|glosario)/i, 2],
    [/(^|[ _-])(index|[ií]ndice)([ _-]|$)/i, 3],
    [/(biblio|referenc)/i, 4],
    [/(answer|solucion|respuesta)/i, 5],
    [/(back[ _-]?matter|^bm$|^bm[ _-])/i, 6],
];
/** Primer número que aparece en el nombre (Chapter07 → 7, 05-CH → 5). null si no hay. */
const numDe = (base) => { const m = base.match(/\d{1,4}/); return m ? Number(m[0]) : null; };

/**
 * Ordena las partes de un libro como se leería: preliminares → partes numeradas → material final
 * (apéndices → glosarios → índice → bibliografía → soluciones). Determinista y estable.
 */
export function ordenarPartesLibro(nombres) {
    const clasificar = (n) => {
        const base = path.basename(n, path.extname(n));
        if (/^\d/.test(base)) return { bloque: 1, orden: numDe(base) ?? 0, base };   // «01_title», «05-CH»: manda el número
        if (RE_FRONT.test(base)) return { bloque: 0, orden: 0, base };
        for (const [re, sub] of FIN) if (re.test(base)) return { bloque: 3, orden: sub * 1000 + (numDe(base) ?? 0), base };
        const num = numDe(base);
        if (num != null) return { bloque: 1, orden: num, base };                      // «Chapter07»
        return { bloque: 2, orden: 0, base };                                          // sin pistas: entre medias
    };
    return nombres
        .map((n) => ({ n, c: clasificar(n) }))
        .sort((a, b) => a.c.bloque - b.c.bloque || a.c.orden - b.c.orden
            || a.c.base.localeCompare(b.c.base, 'es', { numeric: true, sensitivity: 'base' }))
        .map((x) => x.n);
}

/**
 * ¿Las partes tienen CAPA DE TEXTO? Es la señal que distingue de verdad un LIBRO despiezado (capítulos con
 * texto) de una carpeta de LÁMINAS o páginas escaneadas (imagen pura), que debe seguir su propio camino
 * («empaquetar» → cbz, como los Grabados de la Encyclopédie). Se muestrean como mucho 2 partes, solo su 1ª
 * página, para no penalizar el escaneo del Inbox. Si poppler no está o falla, se DA POR BUENO (no bloquear
 * por una herramienta ausente; las otras dos barreras —guía y evidencia estructural— siguen en pie).
 */
async function tienenCapaDeTexto(dir, partes) {
    const muestra = [partes[0], partes[Math.floor(partes.length / 2)]].filter(Boolean);
    let conTexto = 0, evaluadas = 0;
    for (const p of muestra) {
        try {
            const { stdout } = await ejecutarCmd('pdftotext', ['-f', '1', '-l', '1', path.join(dir, p), '-'], { timeout: 20000, maxBuffer: 1 << 20 });
            evaluadas++;
            if ((stdout || '').replace(/\s/g, '').length >= 200) conTexto++;   // 200 caracteres = página de texto real
        } catch { /* poppler ausente o PDF raro: no cuenta */ }
    }
    if (!evaluadas) return true;          // no se pudo comprobar → no bloquear
    return conTexto > 0;                   // basta con que UNA muestra sea texto de verdad
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
    // Y una señal de CONTENIDO, no de nombres: los capítulos de un libro tienen CAPA DE TEXTO; una carpeta de
    // LÁMINAS/escaneos (que va por «empaquetar» → cbz, como los Grabados) no. Esto separa los dos caminos
    // aunque los nombres despistaran. Se muestrean 2 partes (1ª página) para no penalizar el escaneo del Inbox.
    if (!(await tienenCapaDeTexto(dir, ordenarPartesLibro(pdfs)))) return null;

    return { partes: ordenarPartesLibro(pdfs), titulo: path.basename(dir), ratioPartes: Number((nPartes / pdfs.length).toFixed(2)) };
}
