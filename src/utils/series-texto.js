/**
 * SERIE EDITORIAL EN TEXTO → { nombre, subserie, numero, orden } y su CLAVE de agrupación.
 *
 * Las fichas escriben la serie de mil maneras (medido en el Fichero, OpenLibrary + BNE, 30-sep):
 *   «Ediciones de Bolsillo -- 284»            «Research paper RM -- 291»          «Chikuma shinsho -- 584»
 *   «Antrazyt -- Paz y conflictos -- 233»     «Studi superiori NIS -- 20 -- Scienze sociali»
 *   «UCRL ; 52431»   «Special paper ;»        «World landmark books,»             «Göttinger Orientforschungen -- Bd. 29»
 *   «La rueda del tiempo v. 4»   «Kezkak bilduma 6»   «Historische Studien -- Heft 187»   «Early American imprints -- no. 6357.»
 *   «Histoire générale des civilisations -- t. 3.»      «University of Kansas paleontological contributions. Paper 60»
 * Todo esto da el mismo resultado: el NOMBRE de la serie (y la subserie, si la hay) y el NÚMERO del libro en ella.
 * `orden` es el número como entero, para ordenar y buscar huecos (el nº «12a» o «1/80» ordena por su 12 / 1).
 */
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

// Número con su designador opcional: «284», «no. 6357», «v. 4», «t. 3.», «Bd. 29», «Heft 187», «nº 12», «Paper 60».
const DESIGNADOR = String.raw`(?:n[º°o]\.?|no\.?|núm\.?|num\.?|number|vol\.?|v\.|t\.|tomo|bd\.?|band|heft|paper|nr\.?|#)`;
const NUMERO = String.raw`(\d{1,6}[a-z]?(?:[\/.\-]\d{1,4})?)`;
const RE_SOLO_NUMERO = new RegExp(String.raw`^\s*${DESIGNADOR}?\s*${NUMERO}\s*\.?\s*$`, 'i');
const RE_NUMERO_FINAL = new RegExp(String.raw`^(.*?)[\s,;:.\-]+${DESIGNADOR}?\s*${NUMERO}\s*\.?\s*$`, 'i');

const limpiarBordes = (s) => String(s || '').replace(/\s+/g, ' ').replace(/^[\s,;:.\-–—/"'«»]+|[\s,;:\-–—/"'«»]+$/g, '').trim();
const ordenDe = (numero) => {
    const m = String(numero || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
};

/**
 * Las SERIES de un campo que puede traer varias: el volcado de la BNE junta los valores repetidos de un campo con
 * « /**\/ » («Punto de lectura /**\/  Biblioteca de bolsillo» = dos menciones de serie; «Bestseller 185/4 /**\/» =
 * una, con el separador colgando). Medido 30-sep: 25 colecciones creadas con el separador en el nombre.
 * @returns {string[]} las menciones, sin vacías
 */
export function seriesDelCampo(texto) {
    const partes = String(texto || '').split(/\s*\/\*\*\/\s*/).map((s) => s.trim()).filter(Boolean);
    // Un trozo que es SOLO un número es el número de la serie anterior, no otra serie («Nova /**\/  269»).
    const out = [];
    for (const p of partes) {
        if (out.length && /^[\d\s/.\-]+$/.test(p)) out[out.length - 1] += ` ${p}`;
        else out.push(p);
    }
    // Una mención entera entre corchetes («[Narrativas históricas Edhasa 18]»): sin los corchetes.
    return out.map((p) => p.replace(/^\[\s*([^\[\]]+?)\s*\]$/, '$1'));
}

/** La PRIMERA serie del campo (la principal), o null. */
export const primeraSerie = (texto) => seriesDelCampo(texto)[0] || null;

/**
 * @returns {{ nombre: string|null, subserie: string|null, numero: string|null, orden: number|null, issn: string|null }}
 */
export function separarSerie(texto) {
    texto = primeraSerie(texto) || '';
    // El ISSN de la serie a veces va pegado al nombre («Graduate Texts in Mathematics, 0072-5285»): se separa (es el
    // eslabón con Crossref y con las colecciones por ISSN) y el nombre queda limpio. También un «Volume» colgando.
    const RE_ISSN = /[\s,;(]*\b(?:ISSN:?\s*)?(\d{4}-\d{3}[\dXx])\b\)?/;
    const mIssn = String(texto || '').match(RE_ISSN);
    const issn = mIssn ? mIssn[1].toUpperCase() : null;
    const sinIssn = mIssn ? String(texto).replace(RE_ISSN, ' ') : texto;
    const r = separarSerieSinIssn(String(sinIssn || '').replace(/[\s,;]+(volume|vol\.?|band|tome)\s*$/i, ''));
    return { ...r, issn };
}

function separarSerieSinIssn(texto) {
    let t = limpiarBordes(texto);
    if (!t) return { nombre: null, subserie: null, numero: null, orden: null };

    // 1) Partes con « -- » (MARC 490 aplanado): nombre -- [subserie] -- número (en cualquier orden tras el nombre).
    if (t.includes(' -- ')) {
        const partes = t.split(' -- ').map(limpiarBordes).filter(Boolean);
        const nombre = partes.shift();
        let numero = null;
        const resto = [];
        for (const p of partes) {
            const m = p.match(RE_SOLO_NUMERO);
            if (m && !numero) numero = m[1];
            else resto.push(p);
        }
        // El número puede venir pegado al final de la subserie: «… -- Paz y conflictos 233».
        if (!numero && resto.length) {
            const m = resto[resto.length - 1].match(RE_NUMERO_FINAL);
            if (m && limpiarBordes(m[1]).length >= 3) { numero = m[2]; resto[resto.length - 1] = limpiarBordes(m[1]); }
        }
        return { nombre, subserie: resto.join(' -- ') || null, numero, orden: ordenDe(numero) };
    }

    // 2) « ; número» (ISBD): «UCRL ; 52431», «Special paper ;».
    if (t.includes(';')) {
        const [antes, ...despues] = t.split(';');
        const m = despues.join(';').match(RE_SOLO_NUMERO);
        if (limpiarBordes(antes).length >= 2) {
            const numero = m ? m[1] : null;
            return { nombre: limpiarBordes(antes), subserie: null, numero, orden: ordenDe(numero) };
        }
    }

    // 3) Número en MEDIO y subserie detrás: «Ediciones de bolsillo, 235. Literatura».
    const medio = t.match(/^(.*?),\s*(?:n[º°o]\.?\s*)?(\d{1,6})\.\s+(\D.*)$/i);
    if (medio && limpiarBordes(medio[1]).replace(/[^\p{L}]/gu, '').length >= 3) {
        return { nombre: limpiarBordes(medio[1]), subserie: limpiarBordes(medio[3]) || null, numero: medio[2], orden: ordenDe(medio[2]) };
    }

    // 3 bis) Número entre corchetes al final: «Le magasin théâtral [t. 11, 18]» → nº 11.
    const corchete = t.match(/^(.*?)\s*\[([^\]]*\d[^\]]*)\]\s*$/);
    if (corchete && limpiarBordes(corchete[1]).length >= 3) {
        const n = (corchete[2].match(/\d{1,6}[a-z]?/i) || [null])[0];
        return { nombre: limpiarBordes(corchete[1]), subserie: null, numero: n, orden: ordenDe(n) };
    }

    // 4) Número al final: «La rueda del tiempo v. 4», «Kezkak bilduma 6», «… contributions. Paper 60».
    //    Solo si queda un nombre con cuerpo (≥ 3 letras): «1984» o «2001» no son «serie + número».
    const m = t.match(RE_NUMERO_FINAL);
    if (m && limpiarBordes(m[1]).replace(/[^\p{L}]/gu, '').length >= 3) {
        return { nombre: limpiarBordes(m[1]), subserie: null, numero: m[2], orden: ordenDe(m[2]) };
    }
    return { nombre: t, subserie: null, numero: null, orden: null };
}

// Palabras genéricas al PRINCIPIO que no distinguen («Colección Áncora y Delfín» = «Áncora y Delfín»). «Biblioteca»
// no se quita: «Biblioteca Oro» y «Oro» no son lo mismo.
const RE_GENERICA_INICIAL = /^(coleccion|collection|coll|col|serie|series|collana|reihe|coleccio)\s+/;

/** Clave de agrupación de una serie: sin acentos, mayúsculas, puntuación ni «Colección…» delante. */
export function claveSerie(nombre) {
    let k = String(nombre || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(RE_DIACRITICOS, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
    k = k.replace(RE_GENERICA_INICIAL, '').trim();
    return k;
}
