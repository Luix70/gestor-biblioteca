/**
 * ¿EL NOMBRE DEL FICHERO DICE QUE ES UN NÚMERO DE REVISTA? Fecha («2021 07 01 Crochet Now», «…USA 2015-05»,
 * «UltraRunningMay2014», «WatercolorArtistFall2023»), número («Crochet Now Issue 3», «Linux Format Magazine 5»,
 * «Marketing No.184 - Avril 2015») o ambas. Con las guardas aprendidas al corregir los libros catalogados como
 * revista (5-oct): un ISBN en el nombre, un escaneo, una serie o editorial de libros, los nombres de lote con la fecha
 * de la edición («…Scruton,_Roger.Mar.2009») y el «#» de las series de libros («Men at Arms #121») NO cuentan.
 *
 * Nació dentro de scripts/revistas-como-libro.js (que arreglaba lo ya catalogado); vive aquí para que la INGESTA
 * aplique el mismo criterio desde el principio (orquestador → clasificarTipo, como un nombre fechado).
 */
import { validarISBN } from './identificadores.js';
import { parsearNombre } from './parsear-nombre.js';
import { pareceSerieLibros, esEditorialDeLibros } from './revistas.js';
import { MESES_FICHERO, NOMBRES_MES, RE_FECHA_DELANTE, sinExtension, sinEntidades, cabeceraDeNombreDeFichero } from './cabecera-de-fichero.js';
const MESES = MESES_FICHERO;

// Fecha AL FINAL (antes de la extensión), con un sufijo corto opcional («US», «UK») o un «(1)» de copia.
const RE_FECHA_FINAL = /(?<!\d)((?:19|20)\d{2})[-_ .]?(0[1-9]|1[0-2])(?:[-_ .]?\d{2})?(?:\s*[A-Z]{2,3})?\s*(?:\(\d\))?\.[a-z0-9]+$/;
// Mes (o estación) y año PEGADOS al nombre: «UltraRunningMay2014», «AsimovsScienceFictionMarch2015»,
// «WatercolorArtistFall2023». Separados no valen: los nombres de lote de libros acaban en «…Scruton,_Roger.Mar.2009»
// (la fecha de la edición; medido el 5-oct: los VSI de Oxford salían todos como revistas).
const RE_MES_ANIO = new RegExp(`[a-z](${NOMBRES_MES})((?:19|20)\\d{2})(?!\\d)`, 'i');
// Mes (por su nombre) y año SEPARADOS: «Avril 2015», «December 2014». Solo como apoyo: con un «No.» delante, o en
// un documento que ya está dentro de la cabecera de una revista (los libros también llevan la fecha de su edición).
const RE_MES_ANIO_SEPARADOS = new RegExp(`(?<![a-z])(${NOMBRES_MES})\\.?[ ,]+((?:19|20)\\d{2})(?!\\d)`, 'i');
// Año-mes en cualquier parte del nombre («Harvard Business Review USA 2015-05.bak.pdf»): también solo como apoyo.
const RE_ANIO_MES_SUELTO = /(?<!\d)((?:19|20)\d{2})[-_ .](0[1-9]|1[0-2])(?!\d)/;
// Número de la revista: «Issue 3», «Vol 7 Issue 3», «No.179», «nº 13», «Magazine 5», «#12».
// «Issue 3», «Magazine 5»: número de revista sin más. «No.179», «nº 13»: solo si además hay una fecha en el nombre
// («Marketing No.184 - Avril 2015»), porque también los usan los libros («L'Ecluse n°1» de Maigret, «No.10 Commando»).
// Sin «#»: lo usan las series de libros («Osprey, Men at Arms #121», «Fortress #2»).
const RE_NUMERO_ISSUE = /\b(?:issue|magazine)\s*0*(\d{1,4})\b/i;
const RE_NUMERO_NO = /\b(?:no\.?|n[º°])\s*0*(\d{1,4})\b/i;
const RE_ANIO = /(?<!\d)(?:19|20)\d{2}(?!\d)/;
const esAnio = (n) => n >= 1800 && n <= 2100;
const RE_VOL_ISSUE = /\bvol(?:ume)?\.?\s*\d+\s*(?:issue|no\.?|n[º°])\s*\d+/i;

export const empiezaPorIsbn = (nombre) => !!validarISBN(String(nombre).split(/[ ._-]/)[0]);

/** { anio, mes, numero } que se leen en el nombre del fichero (los que haya). */

export function datosDelNombre(nombre) {
    const base = sinEntidades(nombre);
    const out = { anio: null, mes: null, numero: null, señal: null };
    let m = base.match(RE_FECHA_DELANTE);
    if (m) Object.assign(out, { anio: +m[1], mes: +m[2], señal: 'fecha delante' });
    if (!out.anio && (m = base.match(RE_FECHA_FINAL))) Object.assign(out, { anio: +m[1], mes: +m[2], señal: 'fecha al final' });
    if (!out.anio && (m = sinExtension(base).match(RE_MES_ANIO))) {
        Object.assign(out, { anio: +m[2], mes: MESES[m[1].toLowerCase()] || null, señal: 'mes y año' });
    }
    const pn = parsearNombre(base);
    const ni = base.match(RE_NUMERO_ISSUE);
    const nn = base.match(RE_NUMERO_NO);
    if (ni && !esAnio(+ni[1])) { out.numero = +ni[1]; out.señal = out.señal || 'número de revista'; }
    else if (nn && !esAnio(+nn[1]) && ((out.anio && out.mes) || RE_MES_ANIO_SEPARADOS.test(base))) {
        out.numero = +nn[1];
        out.señal = out.señal || 'número y fecha';
    }
    else if (pn.coleccion_numero && /magazine|revista|dimensi[oó]n|bolet[ií]n/i.test(pn.coleccion_nombre || '')) {
        out.numero = +pn.coleccion_numero;
        out.señal = out.señal || 'número de revista';
    }
    if (RE_VOL_ISSUE.test(base)) out.señal = out.señal || 'volumen y número';
    // Apoyos (no bastan solos): mes y año separados, o año-mes en cualquier parte. Se guardan aparte.
    let a;
    if (!out.anio && (a = base.match(RE_MES_ANIO_SEPARADOS))) Object.assign(out, { anio: +a[2], mes: MESES[a[1].toLowerCase()] || null, apoyo: 'mes y año' });
    else if (!out.anio && (a = base.match(RE_ANIO_MES_SUELTO))) Object.assign(out, { anio: +a[1], mes: +a[2], apoyo: 'año-mes' });
    return out;
}

const cabeceraDelNombre = cabeceraDeNombreDeFichero;

/** 'revista' | 'revisar' | null, con el motivo y los datos leídos. */
export function clasificarPorNombre(d, c) {
    const nombre = sinEntidades(d.nombre_archivo);
    if (!nombre || empiezaPorIsbn(nombre)) return { clase: null };
    // Una imagen o un escaneo («Scan_20260628_201205.jpg»): la fecha es la del escáner.
    if (/\.(jpe?g|png|tiff?|gif|webp|heic)$/i.test(nombre) || /^scan[_ -]/i.test(nombre)) return { clase: null };
    // Un ISBN válido en cualquier parte del nombre («2011-10-24-#-0691141207.djvu»): es un libro.
    if ((nombre.match(/\d{9}[\dXx]|\d{13}/g) || []).some((x) => validarISBN(x))) return { clase: null };
    if (pareceSerieLibros(d.titulo) || pareceSerieLibros(nombre) || esEditorialDeLibros(nombre)) return { clase: null };
    const datos = datosDelNombre(nombre);
    const esComic = ['comic', 'novela-grafica', 'tebeo', 'manga'].includes(String(d.naturaleza || '').toLowerCase())
        || /\.(cbr|cbz|cb7)$/i.test(nombre);
    const enCabecera = !!(c && c.tipo === 'revista');
    if (datos.señal && !esComic) return { clase: 'revista', motivo: datos.señal, datos };
    // Dentro de la cabecera de una revista, una fecha con el mes basta («MSDN - April 2010», «Mother Earth News
    // (December 2014 - January 2015)», «03. The Woodworker & Woodturner - March 2016»).
    if (enCabecera && datos.apoyo && !esComic) return { clase: 'revista', motivo: `${datos.apoyo} y está en la cabecera`, datos };
    if (enCabecera || (datos.señal && esComic)) {
        return { clase: 'revisar', motivo: esComic ? 'es un cómic: álbum o número' : `está en la cabecera «${c.nombre}» sin fecha ni número en el nombre`, datos };
    }
    return { clase: null };
}

