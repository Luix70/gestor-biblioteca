/**
 * AUTORIDAD POR ISBN para los pivotes rápidos de la ingesta (miembros de colecciones transmedia, audiolibros,
 * colecciones de audiolibros): el Fichero local primero (offline, 0,1 ms) y la BNE en línea solo donde el
 * Fichero se queda corto. Devuelve la MISMA forma que `buscarEnFicheroLocal` (titulo, autores, editorial,
 * año_edicion, idioma, cdu, dewey…), así que el llamador no cambia nada más.
 *
 * Por qué no basta el Fichero: su volcado BNE tiene huecos medidos (2016-2018 sobre todo, y 2024), y muchas
 * filas vienen solo de OpenLibrary, sin CDU. La BNE en línea se consulta:
 *   · si el Fichero NO tiene el ISBN (cualquier ISBN: la BNE tiene también libros extranjeros);
 *   · si lo tiene pero SIN CDU y el ISBN es de España (978-84 / 979-13): ahí la BNE casi siempre la tiene.
 * Nunca pisa lo que trae el Fichero: la BNE solo rellena lo que falta.
 */
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarEnBNE } from './buscador-bne-sru.js';

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
// Palabras de un título SIN lo que va entre paréntesis o corchetes: «(Ilustrado por Quentin Blake)», «(Colección
// Alfaguara Clásicos)», «[Tapa dura]» son coletillas de la edición, no del título, y bajaban la coincidencia.
const palabras = (s) => String(s || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2);

/**
 * ¿Es fiable aplicar la CDU de este registro de autoridad a ESTE documento? Dos comprobaciones, las dos por casos
 * medidos al estimar el cambio en todo el catálogo:
 *   · La CDU tiene CLASE PRINCIPAL (empieza por dígito). El volcado trae a veces solo auxiliares —«(054)(460.27
 *     M.)», forma y lugar—, que no son una clasificación.
 *   · El TÍTULO del registro casa con el del documento. Si no, lo más probable es que el ISBN del documento sea de
 *     OTRO libro (como los Osprey con un ISBN compartido): «Los caminos de la seda» (historia) se habría ido a
 *     159.942.5 (psicología de las emociones). Mejor no tocar que clasificar por un ISBN equivocado.
 */
export function cduDeAutoridadFiable(doc, reg) {
    const cdu = String(reg?.cdu || '').trim();
    if (!/^\d/.test(cdu)) return false;
    const A = new Set(palabras(doc?.titulo)), B = new Set(palabras([reg?.titulo, reg?.subtitulo].filter(Boolean).join(' ')));
    if (!A.size || !B.size) return false;
    const [chico, grande] = A.size <= B.size ? [A, B] : [B, A];
    let comunes = 0;
    for (const w of chico) if (grande.has(w)) comunes++;
    return comunes / chico.size >= 0.6;
}

const esIsbnEspañol = (isbns) => (isbns || []).some((i) => /^(97884|97913|84)/.test(String(i || '').replace(/[^0-9Xx]/g, '')));
const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);

/**
 * @param isbns       variantes del ISBN (10/13)
 * @param opts.enLinea false = solo el Fichero (como antes)
 * @returns {Promise<object|null>} registro con la forma del Fichero, o null
 */
export async function buscarAutoridadPorISBN(isbns, { enLinea = true } = {}) {
    const f = await buscarEnFicheroLocal({ isbns }).catch(() => null);
    const conFichero = !!(f && f.titulo);
    if (!enLinea) return conFichero ? f : null;
    if (conFichero && (f.cdu || !esIsbnEspañol(isbns))) return f;

    const b = await buscarEnBNE({ isbns }).catch(() => null);
    if (!b || !b.titulo) return conFichero ? f : null;
    if (!conFichero) return { ...b, fuentes: ['bne-en-linea'] };

    // Fichero + BNE: el Fichero manda; la BNE rellena sus huecos (CDU, páginas, medidas, colección…).
    const junto = { ...f };
    for (const [k, v] of Object.entries(b)) if (vacio(junto[k]) && !vacio(v)) junto[k] = v;
    junto.fuentes = [...(f.fuentes || []), 'bne-en-linea'];
    return junto;
}
