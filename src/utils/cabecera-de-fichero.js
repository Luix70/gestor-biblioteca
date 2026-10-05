/**
 * EL NOMBRE DE LA CABECERA (la revista) que dice el NOMBRE DEL FICHERO de un número: «2021 07 01 Crochet Now.pdf» →
 * «Crochet Now», «BBCKnowledge201506.pdf» → «BBC Knowledge», «[Isaac Asimov Magazine 05] AA. VV. - …» → «Isaac Asimov
 * Magazine», «BBC Easy cook 2018 109.pdf» → «BBC Easy Cook». Quita la fecha, el número, la basura de la web de
 * descargas y separa las palabras pegadas.
 *
 * Consumidores: scripts/revistas-como-libro.js (la cabecera de un número que estaba como libro) y
 * scripts/unificar-titulos-numeros.js (el nombre real de una cabecera que nació con el de una marca de agua:
 * «downmagaz.net», «Storemags - Free Magazines for iPad»).
 */
import { parsearNombre } from './parsear-nombre.js';
import { tituloCabecera, capitalizarCabecera } from './revistas.js';

/** Meses (es/en/fr, con abreviaturas) y estaciones → nº de mes (la estación, su primer mes). */
export const MESES_FICHERO = {
    jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4,
    abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7, aug: 8, august: 8, ago: 8,
    agosto: 8, sep: 9, sept: 9, september: 9, septiembre: 9, oct: 10, october: 10, octubre: 10, nov: 11, november: 11,
    noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12,
    janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9,
    octobre: 10, novembre: 11, decembre: 12, décembre: 12,
    // Las estaciones (números trimestrales): el primer mes de cada una.
    winter: 1, invierno: 1, spring: 4, primavera: 4, summer: 7, verano: 7, autumn: 10, fall: 10, otono: 10,
};
export const NOMBRES_MES = Object.keys(MESES_FICHERO).sort((a, b) => b.length - a.length).join('|');

// Fecha DELANTE: «2021 07 01 Crochet Now», «2023-01-01 Watercolor Artist».
export const RE_FECHA_DELANTE = /^((?:19|20)\d{2})[-_ ](0[1-9]|1[0-2])[-_ ](\d{2})\b/;

export const sinExtension = (nombre) => String(nombre || '').replace(/\.[a-z0-9]{2,5}$/i, '');
// Entidades HTML en el nombre («Hacker&#39;s» no es el nº 39).
export const sinEntidades = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

/** El nombre de la cabecera según el fichero, o null si no queda nada legible. */
export function cabeceraDeNombreDeFichero(nombre) {
    nombre = sinEntidades(nombre);
    // Cabecera ePubLibre «[Isaac Asimov Magazine 05]», «[Nueva Dimension 020]»: el nombre de la colección sin el nº.
    const pn = parsearNombre(nombre);
    if (pn.coleccion_nombre && pn.coleccion_numero) return pn.coleccion_nombre.replace(/\s+extra$/i, '').trim();
    let t = sinExtension(nombre)
        .replace(RE_FECHA_DELANTE, ' ')
        .replace(/\bvol(?:ume)?\.?\s*\d+.*$/i, ' ')
        .replace(/(?<!\d)(?:19|20)\d{2}[-_ .]?(?:0[1-9]|1[0-2])(?:[-_ .]?\d{2})?.*$/, ' ')
        .replace(new RegExp(`(${NOMBRES_MES})\\.?[-_ ]?(?:19|20)\\d{2}.*$`, 'i'), ' ')
        .replace(/(?<!\d)(?:19|20)\d{2}\b.*$/, ' ')                 // un año suelto y lo que siga («Easy cook 2018 109»)
        .replace(/\b(?:issue|no\.?|n[º°]|#)\s*\d+.*$/i, ' ')
        .replace(/\bdownmagaz(?:\.com|\.net)?\b|\bstoremags?\b|\bfantamag(?:\.com)?\b/gi, ' ')
        .replace(/[_.]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')            // «CustomPC» → «Custom PC», «BBCKnowledge» → «BBC Knowledge»
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\s*\(\d\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    t = t.replace(new RegExp(`[\\s,.-]*\\b(${NOMBRES_MES})\\.?\\s*$`, 'i'), '').trim();   // un mes suelto al final («… Juin»)
    t = tituloCabecera(t) || t;
    return t.length >= 3 ? capitalizarCabecera(t) : null;
}
