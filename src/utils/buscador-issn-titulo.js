/**
 * ISSN por TÍTULO (Wikidata) — último recurso para revistas SIN código de barras legible (p. ej. copias
 * de suscriptor sin EAN, como Mother Earth News). Wikidata es libre y sin clave, y solo las publicaciones
 * SERIADAS llevan ISSN (P236) — así que un acierto con P236 es, por construcción, un periódico.
 *
 * Estrategia conservadora (evita inventar ISSN que crearían cabeceras erróneas):
 *   1) wbsearchentities(titulo) → candidatos por relevancia de etiqueta.
 *   2) wbgetentities(candidatos, claims) → el PRIMERO que tenga P236 (ISSN) gana.
 * Si ningún candidato bien emparejado tiene ISSN → null (la revista se queda sin ISSN, recuperable a mano).
 */
import { http } from './http.js';
import { validarISSN } from './identificadores.js';

const API = 'https://www.wikidata.org/w/api.php';
const TIMEOUT = Number(process.env.WIKIDATA_TIMEOUT_MS) || 12000;
const UA = 'GestorBiblioteca/1.0 (biblioteca personal; https://github.com/Luix70/gestor-biblioteca)';

export async function buscarISSNporTitulo(titulo, { idioma = null } = {}) {
    const t = String(titulo || '').trim();
    if (t.length < 3) return null;
    const lang = (idioma && /^[a-z]{2}$/i.test(idioma)) ? idioma.toLowerCase() : 'en';
    try {
        const { data: s } = await http.get(API, {
            params: { action: 'wbsearchentities', search: t, language: lang, uselang: lang, type: 'item', limit: 6, format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        const ids = (s?.search || []).map(x => x.id).filter(Boolean).slice(0, 6);
        if (!ids.length) return null;

        const { data: e } = await http.get(API, {
            params: { action: 'wbgetentities', ids: ids.join('|'), props: 'claims', format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        for (const id of ids) {                                   // respeta el orden de relevancia de la búsqueda
            const p236 = e?.entities?.[id]?.claims?.P236;
            if (!p236) continue;
            for (const c of p236) {
                const issn = validarISSN(c?.mainsnak?.datavalue?.value);
                if (issn) return { issn, fuente: `wikidata:${id}` };
            }
        }
    } catch { /* red/timeout: degradar (sin ISSN) */ }
    return null;
}

// ── ISSN → NOMBRE de la serie/cabecera (para nombrar AUTORITATIVAMENTE la colección de un libro con ISSN
//    de serie, en vez del nombre críptico del fichero). Dos fuentes libres, sin clave, sin IA:
//      1) ISSN PORTAL (registro OFICIAL del ISSN, portal.issn.org): tiene también SERIES DE LIBROS que
//         Wikidata no indexa (p. ej. «Springer Texts in Business and Economics», ISSN 2192-4333). Se lee del
//         <title> de la PÁGINA HTML (200 con cualquier User-Agent); OJO: la negociación JSON-LD del API
//         (Accept: application/ld+json) la BLOQUEA su anti-bot con 403 — por eso NO se usa.
//      2) WIKIDATA (fallback): ítem con P236=<issn> filtrado a publicaciones seriadas (P31).
//    Devuelve { nombre, fuente } o null. ──────────────────────────────────────────────────────────────

const PORTAL = 'https://portal.issn.org/resource/ISSN/';
// Decodifica las entidades HTML habituales de un título (&amp;, &#39;, &quot;…).
function _desHTML(s) {
    return String(s || '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;|&#0*39;|&#x0*27;/gi, "'")
        .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch { return ''; } });
}
async function nombrePorISSNPortal(s) {
    try {
        // Se pide el HTML (no la negociación JSON-LD, que da 403 anti-bot). El nombre va en el <title>:
        // «ISSN 2192-4333 - Springer texts in business and economics (Print)».
        const resp = await http.get(PORTAL + s, {
            headers: { 'User-Agent': UA, Accept: 'text/html' }, timeout: TIMEOUT, responseType: 'text',
        });
        const html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        const m = html.match(/<title>([^<]*)<\/title>/i);
        if (!m) return null;
        // Debe ser la página del REGISTRO de ESTE ISSN: «ISSN <s> - <nombre> (Medio)». Si el <title> no empieza
        // por ese ISSN, es una página de error/landing → null (no inventar nombre).
        const reg = new RegExp('^\\s*ISSN\\s*' + s + '\\s*[-\\u2013\\u2014]\\s*(.+)$', 'i');
        const mm = _desHTML(m[1]).replace(/\s+/g, ' ').trim().match(reg);
        if (!mm) return null;
        const nombre = mm[1]
            .replace(/\s*\((?:internet|online|print|en\s*ligne|imprim[ée]e?)\)\s*$/i, '') // sufijo del medio (Print/Online…)
            .replace(/\s*[.]\s*$/, '').trim();
        // Descarta «Título / Autor» (un registro de LIBRO colado) y nombres demasiado cortos.
        return (nombre.length >= 3 && !nombre.includes(' / ')) ? { nombre, fuente: `issn-portal:${s}` } : null;
    } catch { return null; }
}

// Clases de Wikidata (P31) de una publicación SERIADA (evita que un LIBRO que cite el ISSN de su serie
// —«AstroFAQs… / Tonkin»— se tome por el nombre de la serie): Q5633421 revista científica · Q277759
// colección de libros · Q1002697 publicación periódica · Q41298 revista · Q737498 revista académica ·
// Q1259759 magazine · Q27785883 serie de textos.
const CLASES_SERIE = new Set(['Q5633421', 'Q277759', 'Q1002697', 'Q41298', 'Q737498', 'Q1259759', 'Q27785883']);
async function nombrePorISSNWikidata(s, { idioma = null } = {}) {
    const langs = [...new Set([(idioma && /^[a-z]{2}$/i.test(idioma)) ? idioma.toLowerCase() : null, 'en', 'es'].filter(Boolean))];
    try {
        const { data: q } = await http.get(API, {
            params: { action: 'query', list: 'search', srsearch: `haswbstatement:P236=${s}`, srlimit: 6, format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        const ids = (q?.query?.search || []).map((x) => x.title).filter(Boolean).slice(0, 6);
        if (!ids.length) return null;
        const { data: e } = await http.get(API, {
            params: { action: 'wbgetentities', ids: ids.join('|'), props: 'labels|claims', languages: langs.join('|'), format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        for (const id of ids) {
            const ent = e?.entities?.[id];
            const clases = (ent?.claims?.P31 || []).map((c) => c?.mainsnak?.datavalue?.value?.id).filter(Boolean);
            if (!clases.some((c) => CLASES_SERIE.has(c))) continue;
            const labels = ent.labels || {};
            const etiqueta = (langs.map((l) => labels[l]).find(Boolean) || Object.values(labels)[0])?.value || null;
            if (etiqueta && !etiqueta.includes(' / ')) return { nombre: String(etiqueta).trim(), fuente: `wikidata:${id}` };
        }
    } catch { /* red/timeout: degradar */ }
    return null;
}

// Resuelve el nombre de la serie/cabecera de UN ISSN. Wikidata PRIMERO (da el título en grafía natural,
// «Studies in Big Data») y el ISSN Portal como COBERTURA (registro oficial, tiene lo que Wikidata no
// indexa —series de libros— aunque en «sentence case», «Astronomers' universe»).
export async function buscarNombrePorISSN(issn, { idioma = null } = {}) {
    const s = validarISSN(issn);
    if (!s) return null;
    return (await nombrePorISSNWikidata(s, { idioma })) || (await nombrePorISSNPortal(s));
}

// Prueba VARIOS ISSN (impreso + e-ISSN…) y devuelve el PRIMER nombre resuelto. Encarna el principio de
// «reunir todos los identificadores»: una serie puede tener el impreso NO indexado y el electrónico SÍ.
export async function buscarNombreDeISSNs(issns, { idioma = null } = {}) {
    const lista = [...new Set((Array.isArray(issns) ? issns : [issns]).map(validarISSN).filter(Boolean))];
    for (const s of lista) { const r = await buscarNombrePorISSN(s, { idioma }); if (r) return r; }
    return null;
}
