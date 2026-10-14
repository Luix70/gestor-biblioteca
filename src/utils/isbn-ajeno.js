/**
 * LO QUE TRAJO UN ISBN EQUIVOCADO (14-oct).
 *
 * Un libro que tuvo OTRO ISBN —el que da nombre a su carpeta, o el anterior a una corrección— pudo heredar datos
 * del registro de ESE otro libro: «La conjura de los necios» conservaba la CDU 929 y las materias «Marx, Groucho –
 * Correspondencia» de «Las cartas de Groucho» (ISBN 8447360946) aunque se le diera el ISBN bueno a mano, porque con
 * el bueno ninguna autoridad da CDU y la mezcla conservadora no pisa lo que hay.
 *
 * `datosDeIsbnAjeno` compara el libro con la autoridad (Fichero) de cada ISBN anterior: si es de OTRO título, su
 * CDU —si coincide con la de ese otro libro— queda para reclasificar DESDE CERO (campaña «Refinar CDU»), y las
 * materias que solo vienen de él se retiran. Un ISBN anterior del MISMO título (otra edición) no cuenta.
 *
 * Lo usan reidentificar-doc («Extraer ISBN», también la ingesta de colecciones) y scripts/retirar-datos-isbn-ajeno.js.
 */
import { variantesISBN, validarISBN } from './identificadores.js';
import { buscarAutoridadPorISBN } from './autoridad-isbn.js';
import { mismoTituloLibro } from './titulo-libro.js';

export const FIRMA_RECLASIFICAR = 'pendiente-cdu-contaminada';

/** El ISBN que da nombre a la carpeta del libro («…/libros/8447360946-63e696» → 8447360946), o null. */
export function isbnDeCarpeta(rutaBase) {
  const seg = String(rutaBase || '').split('/').pop().replace(/-[0-9a-f]{6}$/, '');
  return /^[0-9]{9}[0-9X]$|^97[89][0-9]{10}$/.test(seg) && validarISBN(seg) ? seg : null;
}

const raiz = (c) => String(c || '').trim().match(/^\d+(?:\.\d+)*/)?.[0] || '';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/**
 * @param doc         el libro (titulo, subtitulo, cdu, cdu_manual, palabras_clave, isbn, ruta_base)
 * @param isbnActual  el ISBN bueno (el que tiene o el que se le va a dar)
 * @param opts.titulo el título con el que se va a quedar (si cambia en la misma operación)
 * @returns {Promise<null | { anterior, otroTitulo, cduAjena: boolean, materias: string[]|null, quitadas: string[] }>}
 *          null si no hay ISBN anterior de otro título; `materias` = la lista que queda (null si no cambia).
 */
export async function datosDeIsbnAjeno(doc, isbnActual, { titulo = null } = {}) {
  if (!isbnActual) return null;
  const buenos = variantesISBN(isbnActual);
  const anteriores = [...new Set([doc.isbn, isbnDeCarpeta(doc.ruta_base)]
    .filter((x) => x && validarISBN(x) && !buenos.includes(x) && !variantesISBN(x).includes(isbnActual)))];
  const tituloNuestro = titulo || doc.titulo;
  for (const anterior of anteriores) {
    const otro = await buscarAutoridadPorISBN(variantesISBN(anterior), { enLinea: false }).catch(() => null);
    if (!otro?.titulo || mismoTituloLibro(otro.titulo, tituloNuestro)) continue;

    const cduAjena = !!(doc.cdu && !doc.cdu_manual && otro.cdu && raiz(doc.cdu) && raiz(doc.cdu) === raiz(otro.cdu));
    // Materias de ese otro libro (su título, autores y materias) que el nuestro no comparte.
    const delOtro = norm([otro.titulo, otro.subtitulo, ...(otro.autores || []), ...(otro.categorias || [])].join(' '));
    const delNuestro = norm([tituloNuestro, doc.subtitulo].join(' '));
    const ajena = (m) => {
      const palabras = norm(m).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
      return palabras.length > 0 && palabras.every((w) => delOtro.includes(w)) && !palabras.some((w) => delNuestro.includes(w));
    };
    const actuales = Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [];
    const quitadas = actuales.filter(ajena);
    if (!cduAjena && !quitadas.length) continue;
    return {
      anterior, otroTitulo: otro.titulo, otraCdu: otro.cdu || null, cduAjena,
      materias: quitadas.length ? actuales.filter((m) => !ajena(m)) : null, quitadas,
    };
  }
  return null;
}
