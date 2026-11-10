/**
 * Buscador en ARXIV (API pública, gratis y sin clave): la ficha de un preprint por su identificador.
 *
 *   https://export.arxiv.org/api/query?id_list=hep-th/9912205,0806.1234&max_results=N     (Atom XML)
 *
 * Devuelve lo que el autor declaró al subirlo: título, autores (con filiación), resumen, categorías (la principal
 * primero), fecha de la primera versión y de la última, comentario («885 pages, 73 figures») y, si se publicó en una
 * revista, la referencia (journal_ref) y el DOI de la revista.
 *
 * Peculiaridades medidas (10-nov):
 *   · Sin versión en el identificador, devuelve la ÚLTIMA versión (hep-th/9912205 → v3).
 *   · La forma antigua con subclase («math.QA/0202059») no siempre resuelve: se pregunta por la canónica
 *     («math/0202059»), que es la que da normalizarArxiv.
 *   · Un identificador que no existe vuelve como una entrada «Error» con id …/api/errors#…: se descarta.
 *   · Las condiciones de uso piden no más de una consulta cada 3 s: se espacian aquí (además del ritmo global de
 *     http.js) y se agrupan hasta 50 identificadores por consulta.
 *
 * Degradación elegante, como el resto de buscadores: red caída → null (y pausa un rato); no hallado → ausente.
 */
import * as cheerio from 'cheerio';
import { http } from './http.js';
import { esErrorDeRed } from '../errores.js';
import { normalizarArxiv, paginasDeComentario } from './arxiv-id.js';

const API = 'https://export.arxiv.org/api/query';
const TIMEOUT = Number(process.env.ARXIV_TIMEOUT_MS) || 30000;
const PAUSA_MS = Number(process.env.ARXIV_PAUSA_MS) || 15 * 60 * 1000;
const RITMO_MS = 3000;          // condiciones de uso de arXiv: una consulta cada 3 s
const LOTE = 50;

let pausadaHasta = 0;
let proxima = 0;
export const arxivDisponible = () => Date.now() >= pausadaHasta;

/** Espera el turno de la siguiente consulta (una cada RITMO_MS, compartido por todo el proceso). */
async function turno() {
    const ahora = Date.now();
    const inicio = Math.max(ahora, proxima);
    proxima = inicio + RITMO_MS;
    if (inicio > ahora) await new Promise((r) => setTimeout(r, inicio - ahora));
}

const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim() || null;

/** Una <entry> del Atom → ficha. */
function fichaDeEntrada($, e) {
    const el = $(e);
    const ref = normalizarArxiv(el.children('id').text());
    if (!ref) return null;
    const categorias = [];
    const principal = el.find('arxiv\\:primary_category').attr('term');
    if (principal) categorias.push(principal);
    el.children('category').each((_, c) => {
        const t = $(c).attr('term');
        if (t && !categorias.includes(t)) categorias.push(t);
    });
    const comentario = limpio(el.find('arxiv\\:comment').text());
    const publicado = limpio(el.children('published').text());
    return {
        id: ref.id,
        version: ref.version,                                  // la última (la que devuelve la API)
        titulo: limpio(el.children('title').text()),
        // Algunos nombres llegan con la coma del «, Jr.» partido («W. A. Rodrigues,»): fuera la puntuación colgante.
        autores: el.children('author').map((_, a) => limpio($(a).children('name').text())?.replace(/[\s,;]+$/, '')).get().filter(Boolean),
        sinopsis: limpio(el.children('summary').text()),
        categorias,
        comentario,
        paginas: paginasDeComentario(comentario),
        journal_ref: limpio(el.find('arxiv\\:journal_ref').text()),
        doi: limpio(el.find('arxiv\\:doi').text())?.toLowerCase() || null,
        fecha: publicado,                                      // primera versión (ISO)
        actualizado: limpio(el.children('updated').text()),    // última versión (ISO)
        año: publicado ? Number(publicado.slice(0, 4)) : null,
        url: `https://arxiv.org/abs/${ref.id}`,
        fuente: 'arxiv',
    };
}

/** Una consulta (hasta LOTE identificadores) → Map id → ficha; null si arXiv no responde. */
async function consultarLote(ids) {
    if (!arxivDisponible()) return null;
    await turno();
    try {
        const r = await http.get(API, {
            params: { id_list: ids.join(','), max_results: ids.length },
            timeout: TIMEOUT,
            responseType: 'text',
        });
        const $ = cheerio.load(String(r.data || ''), { xml: true });
        const out = new Map();
        $('entry').each((_, e) => {
            const f = fichaDeEntrada($, e);
            if (f?.titulo) out.set(f.id, f);
        });
        return out;
    } catch (e) {
        if (esErrorDeRed(e) || e.response?.status >= 500 || e.response?.status === 429) {
            pausadaHasta = Date.now() + PAUSA_MS;
            console.warn(`[arXiv] no responde (${e.message}): se omite ${Math.round(PAUSA_MS / 60000)} min.`);
            return null;
        }
        return new Map();   // 400 (identificador mal formado…): nada que dar, sin pausar
    }
}

/**
 * Las fichas de varios preprints. Acepta identificadores en cualquier forma (se normalizan).
 * @returns {Promise<Map<string, object>|null>} id canónico → ficha (los no hallados no están); null si arXiv no
 *          respondió en ninguna consulta.
 */
export async function buscarEnArxiv(identificadores = []) {
    const ids = [...new Set(identificadores.map((x) => normalizarArxiv(x)?.id).filter(Boolean))];
    const out = new Map();
    let alguna = false;
    for (let i = 0; i < ids.length; i += LOTE) {
        const m = await consultarLote(ids.slice(i, i + LOTE));
        if (m === null) continue;
        alguna = true;
        for (const [k, v] of m) out.set(k, v);
    }
    return alguna || !ids.length ? out : null;
}

/** La ficha de un preprint; {} si arXiv no lo tiene; null si no responde. */
export async function fichaArxiv(identificador) {
    const id = normalizarArxiv(identificador)?.id;
    if (!id) return {};
    const m = await buscarEnArxiv([id]);
    if (m === null) return null;
    return m.get(id) || {};
}
