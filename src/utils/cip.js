import { validarISBN } from './identificadores.js';
import { modernizarCDU } from './cdu-moderna.js';

/**
 * Parser del BLOQUE DE CATALOGACIÓN EN PUBLICACIÓN (CIP) que muchos libros imprimen en la página
 * de créditos: un registro MARC casi completo, GRATIS y de alta confianza, leído del propio fichero.
 *
 * Extrae: autor (+fechas), título/subtítulo, serie, ISBN(s) con su etiqueta (encuadernación/rol),
 * materias (LCSH), clasificación LC (050), Dewey (082), LCCN (010) y año.
 *
 * Lo más valioso para NOSOTROS: Dewey y LC → CDU por el mapeo que ya tenemos (clasificador-cdu),
 * sin IA; e ISBN(s) para identificar. Devuelve null si el texto no contiene un bloque CIP.
 */

// Guiones tipográficos (U+2010–2015: ‐‑‒–—―) y el signo menos (U+2212) → '-'. En new RegExp para evitar la
// corrupción de literales regex con rangos de guion. Los CIP están tipografiados y meten estos en los ISBN.
const RE_GUIONES = new RegExp('[\\u2010-\\u2015\\u2212]', 'g');

const MARCADORES = [
    { re: /Library of Congress Cataloging[- ]?in[- ]?Publication/i, fuente: 'cip-lc' },
    { re: /British Library Cataloguing[- ]?in[- ]?Publication/i,    fuente: 'cip-bl' },
    { re: /Cataloging[- ]?in[- ]?Publication Data/i,                fuente: 'cip-lc' },
    { re: /Catalogaci[óo]n en (?:la )?publicaci[óo]n|Datos de catalogaci[óo]n/i, fuente: 'cip-es' },
];

export function parsearBloqueCatalogacion(texto) {
    if (!texto) return null;
    const marcador = MARCADORES.find(m => m.re.test(texto));
    if (!marcador) return null; // no hay bloque CIP reconocible

    const idx = texto.search(marcador.re);
    // Los CIP están TIPOGRAFIADOS: usan guiones largos (– —, U+2010–2015, y el signo menos U+2212) donde una
    // regex espera '-'. Sin normalizar, un ISBN «978–0–19–956938–0» (en-dash) se PIERDE y se cuela otro
    // equivocado. Se normalizan a '-' en todo el bloque (todas las regex de abajo esperan '-').
    const bloque = texto.slice(idx, idx + 1500).replace(RE_GUIONES, '-'); // el bloque CIP es corto
    const lineas = bloque.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const plano = bloque.replace(/\s+/g, ' ');

    const out = {
        fuente: marcador.fuente, autor: null, autor_fechas: null, titulo: null, subtitulo: null,
        serie: null, isbns: [], materias: [], lc: null, dewey: null, lccn: null, año: null,
    };

    // ── ISBN(s) con etiqueta (encuadernación o rol): "ISBN 0-7914-5259-X (alk. paper)" ──
    const isbnRe = /ISBN[:\s-]*((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])\s*(?:\(([^)]{1,40})\))?/gi;
    let m;
    const vistos = new Set();
    while ((m = isbnRe.exec(plano)) !== null) {
        const isbn = validarISBN(m[1]);
        if (isbn && !vistos.has(isbn)) { vistos.add(isbn); out.isbns.push({ isbn, etiqueta: (m[2] || '').trim() || null }); }
    }

    // ── Materias (LCSH): "1. Tema. 2. Tema. … N. Tema." hasta "I. Title" ──
    const matM = plano.match(/\b1\.\s+([\s\S]+?)\b[IVX]+\.\s*(?:Title|T[íi]tulo|Series)/i);
    if (matM) {
        out.materias = matM[1].split(/\s*\d+\.\s+/)
            .map(s => s.replace(/\s+/g, ' ').trim().replace(/\.$/, ''))
            .filter(s => s.length > 2);
    }

    // ── Clasificación LC (050): "CB245.R68 2002" ──
    const lcM = bloque.match(/\b([A-Z]{1,3}\d{1,4}(?:\.[A-Z]\d+)?)\s+(\d{4})\b/);
    if (lcM) { out.lc = lcM[1]; out.año = parseInt(lcM[2]); }

    // ── Dewey (082): "909'.09821—dc21" / "909.09821 dc21" (quita marcas de segmentación) ──
    const dM = bloque.match(/(\d{1,3}(?:[.'’]+\d+)+|\d{3})\s*[—–-]*\s*d?dc\d*/i);
    if (dM) out.dewey = dM[1].replace(/['’]/g, '');

    // ── LCCN (010): run de 8-10 dígitos (suele ir junto al Dewey) ──
    const lccnM = bloque.match(/\b(\d{8,10})\b/);
    if (lccnM) out.lccn = lccnM[1];

    // ── Serie (490): "— (SUNY series in religious studies)" / "(… series …)" ──
    const sM = plano.match(/[—–-]\s*\(([^)]{3,80})\)/) || plano.match(/\(([^)]*\bseries\b[^)]*)\)/i);
    if (sM) out.serie = sM[1].trim();

    // ── Título / subtítulo: "Título : subtítulo / mención de responsabilidad" ──
    for (const l of lineas) {
        if (/ISBN|cm\.|p\.\s*cm|Library of Congress|Cataloging/i.test(l)) continue;
        const t = l.match(/^(.+?)\s*:\s*(.+?)\s*\/\s*.+$/);
        if (t) { out.titulo = t[1].trim(); out.subtitulo = t[2].trim(); break; }
        const t2 = l.match(/^(.+?)\s*\/\s*.+$/);
        if (t2 && !out.titulo) { out.titulo = t2[1].trim(); }
    }

    // ── Autor (encabezamiento principal): "Apellido, Nombre, 1947–" ──
    for (const l of lineas) {
        if (/series|title|congress|cataloging|ISBN/i.test(l)) continue;
        const a = l.match(/^([A-ZÁÉÍÓÚÑ][^,]+,\s*[^,0-9]+?)(?:,\s*(\d{4}\s*[–-]\s*\d{0,4}))?\.?$/);
        if (a) { out.autor = a[1].trim(); out.autor_fechas = a[2] ? a[2].replace(/\s+/g, '') : null; break; }
    }

    return out;
}

// ─── CDU IMPRESA en la página de créditos ────────────────────────────────────────────────────────────────
//
// Algunas editoriales (sobre todo académicas, y muchas fichas catalográficas de libros hispanoamericanos)
// imprimen la CDU en los créditos: «CDU 821.134.2-31"19"», «C.D.U.: 94(460)». Es la clasificación que
// decidieron el autor y la editorial, y por eso tiene prioridad sobre la de la BNE y sobre cualquier deducción
// (ver prioridad-cdu.js). Es RARA en esta biblioteca (medido: 0 de 300 EPUB y 0 de 200 PDF en español), así que
// el lector es ESTRICTO para no inventar: los dos «aciertos» de aquella muestra eran falsos — el partido alemán
// CDU y la CDU de OTRA obra citada en una bibliografía. Por eso solo se acepta:
//   · la sigla CDU/C.D.U. (o «Clasificación Decimal Universal») seguida DIRECTAMENTE de un código con forma de CDU
//     (empieza por dígito; solo dígitos y los signos de la CDU);
//   · y cerca (±400 caracteres) de señales de PÁGINA DE CRÉDITOS de este libro: ISBN, depósito legal, «ficha
//     catalográfica», «catalogación en publicación», «impreso en»… — no en medio del texto ni de una bibliografía.
const RE_CDU_IMPRESA = new RegExp(
    String.raw`(?:\bC\.?\s?D\.?\s?U\.?|Clasificaci[oó]n\s+Decimal\s+Universal)\s*[:.]?\s*`
    + String.raw`(\d[\d.:/()\-=+"'’”“ ]{0,40}?)`
    + String.raw`(?=\s*(?:$|[\n;·|,—–]|\s{2}|ISBN|I\.S\.B\.N|D\.\s?L\.|Dep[oó]sito|NIPO|\b[A-ZÁÉÍÓÚ][a-záéíóú]{2,}))`,
    'gi',
);
const RE_CREDITOS_CERCA = /ISBN|I\.S\.B\.N|dep[oó]sito\s+legal|\bD\.\s?L\.|ficha\s+catalogr[aá]fica|catalogaci[oó]n\s+en\s+(la\s+)?publicaci[oó]n|impreso\s+en|printed\s+in|©|copyright/i;
const RE_BIBLIOGRAFIA_CERCA = /bibliograf[ií]a|referencias|obras\s+citadas|Biblioteca\s+Virtual/i;

/**
 * CDU impresa en la página de créditos de ESTE libro, o null. Ver la nota de arriba (estricta a propósito).
 * @param {string} texto  texto de las primeras páginas
 */
export function cduImpresa(texto) {
    const t = String(texto || '');
    for (const m of t.matchAll(RE_CDU_IMPRESA)) {
        const codigo = m[1].replace(/[\s.;:,]+$/, '').replace(/\s+/g, ' ').trim();
        if (!/^\d/.test(codigo) || codigo.length < 1) continue;
        const entorno = t.slice(Math.max(0, m.index - 400), m.index + m[0].length + 400);
        if (!RE_CREDITOS_CERCA.test(entorno)) continue;          // no es la página de créditos de este libro
        if (RE_BIBLIOGRAFIA_CERCA.test(entorno) && !/ISBN/i.test(entorno)) continue;
        return modernizarCDU(codigo);   // un CIP de un libro viejo puede traer 860, 820… (notación antigua)
    }
    return null;
}
