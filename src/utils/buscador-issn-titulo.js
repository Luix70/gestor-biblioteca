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
