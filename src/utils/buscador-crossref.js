/**
 * Buscador CROSSREF por DOI — el PIVOTE del ARTÍCULO (equivalente al ISBN→Fichero de los libros).
 *
 * Crossref (api.crossref.org) es la agencia de registro de DOI de la literatura académica: resuelve un DOI a
 * su metadata autoritativa (título, autores, revista de origen + ISSN, año, volumen/número/páginas, tipo).
 * Es GRATUITO y SIN CLAVE (cortesía: se envía un `mailto`). Degrada EN SILENCIO (devuelve null) ante red caída,
 * 404 o JSON inesperado — nunca rompe la ingesta. Cumple [[minimize-ai-ingestion]]: fuente libre antes que IA.
 */

const CROSSREF_URL = 'https://api.crossref.org/works/';
const TIMEOUT = Number(process.env.CROSSREF_TIMEOUT_MS) || 12000;
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
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
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
