/**
 * Buscador en CROSSREF (API REST pública, gratis y sin clave): la agencia de DOI de las editoriales académicas.
 *
 *   https://api.crossref.org/works?filter=isbn:<10>,isbn:<13>      (el libro por su ISBN)
 *   https://api.crossref.org/works?filter=issn:<ISSN>,type:book     (los libros de una SERIE, por su ISSN)
 *
 * Por qué (30-sep): para los libros académicos (Springer, Routledge/Taylor & Francis, Cambridge, Oxford, Elsevier,
 * Wiley, De Gruyter…) Crossref sabe lo que al Fichero le falta: la SERIE con su ISSN («Reading, Writing, and
 * Proving» → «Undergraduate Texts in Mathematics», 0172-6056; el Fichero tenía el libro sin serie) y lo reciente.
 * El volcado anual (U:\_DUMPEDCATALOGS) dará la base sin conexión; esta API, lo registrado después.
 *
 * Peculiaridades medidas:
 *   · Hay libros registrados con el ISBN-10 y otros con el 13: se pregunta por LAS DOS formas a la vez (OR).
 *   · Una consulta por ISBN devuelve también los CAPÍTULOS del libro (book-chapter): se queda con el libro.
 *   · La serie va en `container-title` y su ISSN en `ISSN`; el nº de volumen, en `volume` (casi nunca viene).
 *
 * Degradación elegante, como el resto: error de red → null (y pausa un rato); no hallado → {}.
 * El User-Agent con contacto (http.js, EMAIL del .env) mete las consultas en el «polite pool» de Crossref.
 */
import { http } from './http.js';
import { esErrorDeRed } from '../errores.js';
import { variantesISBN } from './identificadores.js';
import { limpiarNombreEditorial } from './editoriales-falsas.js';

const API = 'https://api.crossref.org/works';
const TIMEOUT = Number(process.env.CROSSREF_TIMEOUT_MS || 20000);
const PAUSA_MS = Number(process.env.CROSSREF_PAUSA_MS || 15 * 60 * 1000);
let pausadaHasta = 0;
export const crossrefDisponible = () => Date.now() >= pausadaHasta;

// Tipos de Crossref que son un LIBRO entero (no un capítulo, un artículo ni una entrada de enciclopedia).
const TIPOS_LIBRO = new Set(['book', 'monograph', 'edited-book', 'reference-book', 'book-set']);

async function consultar(params) {
    if (!crossrefDisponible()) return null;
    try {
        const r = await http.get(API, { params, timeout: TIMEOUT });
        return r.data?.message || {};
    } catch (e) {
        if (esErrorDeRed(e) || e.response?.status >= 500) {
            pausadaHasta = Date.now() + PAUSA_MS;
            console.warn(`[Crossref] no responde (${e.message}): se omite ${Math.round(PAUSA_MS / 60000)} min.`);
            return null;
        }
        return {};
    }
}

const anio = (w) => (w.published || w['published-print'] || w.issued)?.['date-parts']?.[0]?.[0] || null;
const nombrePersona = (p) => [p.given, p.family].filter(Boolean).join(' ').trim() || p.name || null;

/** Un item de Crossref (libro) → la forma de ficha que usa el resto del pipeline. */
export function fichaDeCrossref(w) {
    const titulo = (w.title || [])[0] || null;
    // La serie: el primer container-title que no sea el propio título (en los libros de serie, es la serie).
    const serie = (w['container-title'] || []).find((c) => c && c !== titulo) || null;
    const issnImpreso = (w['issn-type'] || []).find((x) => x.type === 'print')?.value;
    return {
        isbn: (w['isbn-type'] || []).find((x) => x.type === 'print')?.value || (w.ISBN || [])[0] || null,
        isbns: w.ISBN || [],
        titulo,
        subtitulo: (w.subtitle || [])[0] || null,
        autores: (w.author || []).map(nombrePersona).filter(Boolean),
        contribuciones_nombres: (w.editor || []).map((p) => ({ nombre: nombrePersona(p), rol: 'editor' })).filter((c) => c.nombre),
        editorial: limpiarNombreEditorial(w.publisher) || null,
        año_edicion: anio(w),
        idioma: w.language ? String(w.language).slice(0, 2) : null,
        coleccion_nombre: serie,
        coleccion_issn: serie ? (issnImpreso || (w.ISSN || [])[0] || null) : null,
        coleccion_numero: serie && w.volume ? String(w.volume) : null,
        categorias: w.subject || [],
        doi: w.DOI || null,
        edicion: w['edition-number'] || null,
        fuente: 'crossref',
    };
}

/**
 * El LIBRO con ese ISBN (sus capítulos no cuentan).
 * @returns {Promise<object|null>} ficha; {} si Crossref no lo tiene; null si no responde.
 */
export async function buscarEnCrossref({ isbns = [] } = {}) {
    const formas = [...new Set(isbns.flatMap((i) => variantesISBN(i)))].map((i) => String(i).replace(/[^0-9Xx]/g, ''));
    if (!formas.length) return {};
    const m = await consultar({ filter: formas.map((i) => `isbn:${i}`).join(','), rows: 20 });
    if (m === null) return null;
    const libro = (m.items || []).find((w) => TIPOS_LIBRO.has(w.type));
    return libro ? fichaDeCrossref(libro) : {};
}

/**
 * Los LIBROS de una serie por su ISSN (paginado con cursor; hasta `max`). Para ver los huecos de una colección.
 * @returns {Promise<object[]|null>} fichas; null si Crossref no responde.
 */
export async function librosDeSerieCrossref(issn, { max = 2000 } = {}) {
    const out = [];
    let cursor = '*';
    while (out.length < max) {
        const m = await consultar({ filter: `issn:${issn},type:book`, rows: 500, cursor });
        if (m === null) return out.length ? out : null;
        const items = m.items || [];
        out.push(...items.map(fichaDeCrossref));
        if (!items.length || !m['next-cursor'] || items.length < 500) break;
        cursor = m['next-cursor'];
    }
    return out;
}
