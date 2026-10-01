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
import { libroCrossrefLocal, librosDeSerieCrossrefLocal, crossrefLocalDisponible } from './crossref-local.js';

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
    // Primero el índice LOCAL (el volcado anual, sin conexión ni límites: scripts/etl-crossref.js). La API queda para
    // lo que no esté: lo registrado después del volcado.
    const local = libroCrossrefLocal(formas);
    if (local) return local;
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
    // Con el índice local, la serie entera sale de ahí (sin paginar contra la API).
    if (crossrefLocalDisponible()) {
        const locales = librosDeSerieCrossrefLocal(issn, { max });
        if (locales.length) return locales;
    }
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

// ─── ARTÍCULOS: el DOI como pivote (equivalente al ISBN → Fichero de los libros) ─────────────────────────────
// Resuelve un DOI a su metadata (título, autores, revista de origen + ISSN, año, volumen/número/páginas, tipo).
// Lo usan la ingesta (motor-enriquecimiento), la edición manual y el panel. Degrada en silencio (null) ante red
// caída, 404 o JSON inesperado: nunca rompe la ingesta.
// (Estas dos funciones se perdieron al reescribir el fichero el 30-sep —commit d491882— y la aplicación dejó de
// arrancar: «does not provide an export named 'buscarPorDOI'». Restauradas tal cual.)
const CROSSREF_URL = 'https://api.crossref.org/works/';
const TIMEOUT_DOI = Number(process.env.CROSSREF_TIMEOUT_MS) || 12000;
// Cortesía Crossref: un mailto identifica al cliente y da acceso al «polite pool» (más estable).
const MAILTO = process.env.CROSSREF_MAILTO || 'biblioteca@localhost';

// Normaliza un DOI (quita el prefijo URL «https://doi.org/», «doi:», espacios; minúsculas). Devuelve '' si no
// parece un DOI (10.<registrante>/<sufijo>).
export function normalizarDOI(doi) {
    let d = String(doi || '').trim().toLowerCase();
    d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '').trim();
    return /^10\.\d{4,9}\/\S+$/.test(d) ? d : '';
}

// Nombre legible «Apellido, Nombre» / «Nombre Apellido» a partir de un autor Crossref {given, family, name}.
function nombreAutor(a) {
    if (!a) return null;
    if (a.name) return String(a.name).trim();               // instituciones / autores sin desglosar
    const dado = (a.given || '').trim(), fam = (a.family || '').trim();
    return [dado, fam].filter(Boolean).join(' ').trim() || null;
}

/**
 * Resuelve un DOI vía Crossref. Devuelve metadata normalizada del artículo (o null si no se pudo).
 * @returns {null | { doi, titulo, subtitulo, autores:string[], editorial, revista, issn:string[], issn_electronico,
 *                    año, volumen, numero, paginas, tipo, sinopsis, palabras_clave:string[] }}
 */
export async function buscarPorDOI(doiCrudo) {
    const doi = normalizarDOI(doiCrudo);
    if (!doi) return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_DOI);
    try {
        const url = CROSSREF_URL + encodeURIComponent(doi) + '?mailto=' + encodeURIComponent(MAILTO);
        const resp = await fetch(url, {
            signal: ctrl.signal,
            headers: { 'User-Agent': `GestorBiblioteca/1.0 (mailto:${MAILTO})`, Accept: 'application/json' },
        });
        if (!resp.ok) return null;                          // 404 (DOI desconocido) u otro → sin dato
        const json = await resp.json();
        const m = json && json.message;
        if (!m) return null;

        const primero = (arr) => (Array.isArray(arr) && arr.length ? String(arr[0]).trim() : null);
        const anio = m.published?.['date-parts']?.[0]?.[0]
            ?? m['published-print']?.['date-parts']?.[0]?.[0]
            ?? m['published-online']?.['date-parts']?.[0]?.[0] ?? null;
        // El abstract de Crossref viene en JATS/XML → se quita el marcado para una sinopsis limpia.
        const sinopsis = m.abstract ? String(m.abstract).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;

        return {
            doi,
            titulo:     primero(m.title),
            subtitulo:  primero(m.subtitle),
            autores:    (Array.isArray(m.author) ? m.author.map(nombreAutor).filter(Boolean) : []),
            editorial:  m.publisher ? String(m.publisher).trim() : null,
            revista:    primero(m['container-title']),      // la REVISTA/obra de origen (para agrupar la cabecera)
            issn:       (Array.isArray(m.ISSN) ? m.ISSN.map((s) => String(s).trim()) : []),
            año:        anio,
            volumen:    m.volume ? String(m.volume).trim() : null,
            numero:     m.issue ? String(m.issue).trim() : null,
            paginas:    m.page ? String(m.page).trim() : null,
            tipo:       m.type || null,                     // 'journal-article' | 'book-chapter' | 'proceedings-article'…
            sinopsis,
            palabras_clave: Array.isArray(m.subject) ? m.subject.map((s) => String(s).trim()).filter(Boolean) : [],
        };
    } catch (_) {
        return null;                                        // red caída / abort / JSON inválido → degrada
    } finally {
        clearTimeout(t);
    }
}
