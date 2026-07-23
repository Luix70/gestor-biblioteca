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
