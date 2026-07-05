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
import axios from 'axios';
import { validarISSN } from './identificadores.js';

const API = 'https://www.wikidata.org/w/api.php';
const TIMEOUT = Number(process.env.WIKIDATA_TIMEOUT_MS) || 12000;
const UA = 'GestorBiblioteca/1.0 (biblioteca personal; https://github.com/Luix70/gestor-biblioteca)';

export async function buscarISSNporTitulo(titulo, { idioma = null } = {}) {
    const t = String(titulo || '').trim();
    if (t.length < 3) return null;
    const lang = (idioma && /^[a-z]{2}$/i.test(idioma)) ? idioma.toLowerCase() : 'en';
    try {
        const { data: s } = await axios.get(API, {
            params: { action: 'wbsearchentities', search: t, language: lang, uselang: lang, type: 'item', limit: 6, format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        const ids = (s?.search || []).map(x => x.id).filter(Boolean).slice(0, 6);
        if (!ids.length) return null;

        const { data: e } = await axios.get(API, {
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

// ISSN → NOMBRE de la publicación/serie (Wikidata, inverso de lo anterior). Para dar nombre AUTORITATIVO a
// la colección/serie de un libro que trae un ISSN de serie (p. ej. Springer «Studies in Big Data», ISSN
// 2197-6503) en vez de caer al nombre críptico del fichero. Wikidata indexa el ISSN (P236): se busca el
// ítem con ese P236 (`haswbstatement`) y se devuelve su etiqueta (preferido el idioma dado, luego inglés,
// luego cualquiera). Libre, sin clave, sin IA. Devuelve { nombre, fuente } o null.
export async function buscarNombrePorISSN(issn, { idioma = null } = {}) {
    const s = validarISSN(issn);
    if (!s) return null;
    const langs = [...new Set([(idioma && /^[a-z]{2}$/i.test(idioma)) ? idioma.toLowerCase() : null, 'en', 'es'].filter(Boolean))];
    try {
        const { data: q } = await axios.get(API, {
            params: { action: 'query', list: 'search', srsearch: `haswbstatement:P236=${s}`, format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        const id = q?.query?.search?.[0]?.title;
        if (!id) return null;
        const { data: e } = await axios.get(API, {
            params: { action: 'wbgetentities', ids: id, props: 'labels', languages: langs.join('|'), format: 'json' },
            headers: { 'User-Agent': UA }, timeout: TIMEOUT,
        });
        const labels = e?.entities?.[id]?.labels || {};
        const etiqueta = (langs.map((l) => labels[l]).find(Boolean) || Object.values(labels)[0])?.value || null;
        return etiqueta ? { nombre: String(etiqueta).trim(), fuente: `wikidata:${id}` } : null;
    } catch { /* red/timeout: degradar (colección sin nombre autoritativo) */ }
    return null;
}
