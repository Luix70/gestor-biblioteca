/**
 * LO QUE TRAJO UN ISBN EQUIVOCADO (14-oct).
 *
 * Un libro con un ISBN de OTRO libro hereda los datos del registro de ese otro libro: «La conjura de los necios»
 * tenía la CDU 929 y las materias «Marx, Groucho – Correspondencia» de «Las cartas de Groucho» (8447360946). Pasa
 * de dos formas, y las dos se miran aquí:
 *   · el ISBN equivocado es el ANTERIOR (ya corregido, pero lo que trajo sigue ahí): el que da nombre a la carpeta,
 *     o el que tenía antes de una corrección;
 *   · el ISBN equivocado es el ACTUAL: lo traen los metadatos del propio fichero (un EPUB maquetado con el ISBN de
 *     otro libro) y la ingesta lo daba por bueno sin mirar el título.
 * «Otro libro» = título CLARAMENTE distinto (sin una sola palabra con cuerpo en común: titulo-libro.js), para no
 * tomar por ajeno el mismo libro con el título abreviado («Amarte» / «Amarte. Pensar el amor…»).
 *
 * Qué se hace (quien llama lo aplica): su CDU —si es la de ese otro libro— va a reclasificarse DESDE CERO (campaña
 * «Refinar CDU»); se retiran las materias que solo vienen de él; y si es el ISBN ACTUAL, se descarta (pasa a
 * `isbns_descartados`, que no se vuelve a adoptar; nada se pierde).
 *
 * Lo usan reidentificar-doc («Extraer ISBN») y scripts/retirar-datos-isbn-ajeno.js; la ingesta (orquestador) usa
 * `isbnDeOtroLibro` para no adoptar el ISBN de un EPUB que es de otro título.
 */
import { variantesISBN, validarISBN } from './identificadores.js';
import { buscarAutoridadPorISBN } from './autoridad-isbn.js';
import { tituloClaramenteDistinto } from './titulo-libro.js';

export const FIRMA_RECLASIFICAR = 'pendiente-cdu-contaminada';

/** El ISBN que da nombre a la carpeta del libro («…/libros/8447360946-63e696» → 8447360946), o null. */
export function isbnDeCarpeta(rutaBase) {
  const seg = String(rutaBase || '').split('/').pop().replace(/-[0-9a-f]{6}$/, '');
  return /^[0-9]{9}[0-9X]$|^97[89][0-9]{10}$/.test(seg) && validarISBN(seg) ? seg : null;
}

/** Apellidos y nombres (palabras de 3+ letras, sin tildes) de una lista de autores. */
const palabrasDeAutores = (autores) => new Set((autores || []).flatMap((a) => String(a || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z]+/).filter((w) => w.length >= 3)));

/**
 * ¿Es este ISBN de OTRO libro? Devuelve el registro de autoridad (Fichero) de ese ISBN si su título es claramente
 * distinto de `titulo` Y sus autores no comparten ni un nombre con `autores`; null si no, si no hay registro o si
 * falta con qué comparar. El autor es imprescindible: con el título solo, una TRADUCCIÓN («Hija de la fortuna» /
 * «Daughter of Fortune») o un tomo con otro nombre («Their Finest Hour» / «The Second World War, Volume 2») salían
 * como otro libro (seco del 14-oct: 1.543 «ISBN de otro libro», muchos de ellos así).
 */
export async function isbnDeOtroLibro(isbn, titulo, autores = [], idioma = null) {
  if (!isbn || !titulo) return null;
  // Con un título de UNA palabra («Hume», «Kolb», «Graphic1», «Opener») no se puede afirmar nada: lo más probable es
  // que el malo sea el título, no el ISBN («Hume» con el ISBN del «Treatise of Human Nature»). Seco del 14-oct.
  const conCuerpo = String(titulo).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z]+/).filter((w) => w.length >= 4);
  if (conCuerpo.length < 2) return null;
  const nuestros = palabrasDeAutores(autores);
  if (!nuestros.size) return null;   // sin autor no se puede afirmar que sea otro libro
  const reg = await buscarAutoridadPorISBN(variantesISBN(isbn), { enLinea: false }).catch(() => null);
  if (!reg?.titulo || !tituloClaramenteDistinto(reg.titulo, titulo)) return null;
  // En OTRO idioma es otra EDICIÓN (una traducción), no otro libro: su registro pone como «autor» al traductor («Yellow
  // Dog» → Linda Asher, para «Le chien jaune» de Simenon) y la comparación de autores no los emparejaba.
  const idiomaReg = String(reg.idioma || '').slice(0, 2).toLowerCase();
  if (idioma && idiomaReg && idiomaReg !== String(idioma).slice(0, 2).toLowerCase()) return null;
  const suyos = palabrasDeAutores([...(reg.autores || []), ...(reg.contribuciones_nombres || []).map((c) => c?.nombre || c)]);
  if (!suyos.size) return null;
  for (const w of suyos) if (nuestros.has(w)) return null;   // comparten autor: otra edición del mismo libro
  return reg;
}

/** Nombres de los autores de un documento (refs ObjectId → nombre; o ya nombres). */
export async function nombresDeAutores(db, autores) {
  if (!Array.isArray(autores) || !autores.length) return [];
  if (typeof autores[0] === 'string') return autores;
  const filas = await db.collection('autores').find({ _id: { $in: autores } }, { projection: { nombre: 1 } }).toArray();
  return filas.map((a) => a.nombre).filter(Boolean);
}

const raiz = (c) => String(c || '').trim().match(/^\d+(?:\.\d+)*/)?.[0] || '';
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Qué hay que retirar de `doc` por el registro `otro` (de otro libro). */
function retirarDe(doc, otro, tituloNuestro) {
  const cduAjena = !!(doc.cdu && !doc.cdu_manual && otro.cdu && raiz(doc.cdu) && raiz(doc.cdu) === raiz(otro.cdu));
  const delOtro = norm([otro.titulo, otro.subtitulo, ...(otro.autores || []), ...(otro.categorias || [])].join(' '));
  const delNuestro = norm([tituloNuestro, doc.subtitulo].join(' '));
  const ajena = (m) => {
    const palabras = norm(m).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
    return palabras.length > 0 && palabras.every((w) => delOtro.includes(w)) && !palabras.some((w) => delNuestro.includes(w));
  };
  const actuales = Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [];
  const quitadas = actuales.filter(ajena);
  return { cduAjena, materias: quitadas.length ? actuales.filter((m) => !ajena(m)) : null, quitadas };
}

/**
 * @param doc         el libro (titulo, subtitulo, cdu, cdu_manual, palabras_clave, isbn, ruta_base)
 * @param isbnActual  el ISBN con el que se va a quedar (el que tiene, o el que se le va a dar)
 * @param opts.titulo el título con el que se va a quedar (si cambia en la misma operación)
 * @param opts.autores los NOMBRES de sus autores (imprescindibles: sin ellos no se afirma que sea otro libro)
 * @returns {Promise<null | { anterior, otroTitulo, otraCdu, isbnActualAjeno: boolean, cduAjena, materias, quitadas }>}
 *          null si nada viene de otro libro. `isbnActualAjeno`: el ISBN ACTUAL es de otro libro → descartarlo.
 *          `materias` = la lista que queda (null si no cambia).
 */
export async function datosDeIsbnAjeno(doc, isbnActual, { titulo = null, autores = [], idioma = null } = {}) {
  const idiomaNuestro = idioma || doc.idioma || null;
  const tituloNuestro = titulo || doc.titulo;
  // El ACTUAL, primero: si es de otro libro, todo lo que trajo es ajeno y el ISBN se descarta.
  if (isbnActual) {
    const otro = await isbnDeOtroLibro(isbnActual, tituloNuestro, autores, idiomaNuestro);
    if (otro) return { anterior: isbnActual, otroTitulo: otro.titulo, otraCdu: otro.cdu || null, isbnActualAjeno: true, ...retirarDe(doc, otro, tituloNuestro) };
  }
  const buenos = isbnActual ? variantesISBN(isbnActual) : [];
  const anteriores = [...new Set([doc.isbn, isbnDeCarpeta(doc.ruta_base)]
    .filter((x) => x && validarISBN(x) && !buenos.includes(x) && !(isbnActual && variantesISBN(x).includes(isbnActual))))];
  for (const anterior of anteriores) {
    const otro = await isbnDeOtroLibro(anterior, tituloNuestro, autores, idiomaNuestro);
    if (!otro) continue;
    const r = retirarDe(doc, otro, tituloNuestro);
    if (!r.cduAjena && !r.quitadas.length) continue;
    return { anterior, otroTitulo: otro.titulo, otraCdu: otro.cdu || null, isbnActualAjeno: false, ...r };
  }
  return null;
}

/**
 * Aplica lo que devolvió `datosDeIsbnAjeno` a un libro ya catalogado: CDU a reclasificar desde cero, materias
 * ajenas fuera y, si el ISBN ACTUAL es de otro libro, ese ISBN a `isbns_descartados` (no se vuelve a adoptar).
 * Deja la alerta y el diario `deshacer` con lo que había. No mueve ficheros. Devuelve el documento como queda.
 */
export async function aplicarRetirada(db, doc, ajeno, { origen = 'isbn-ajeno' } = {}) {
  const set = {};
  const unset = {};
  const antes = {};
  if (ajeno.cduAjena) { set.mantenimiento_firma = FIRMA_RECLASIFICAR; antes.mantenimiento_firma = doc.mantenimiento_firma ?? null; }
  if (ajeno.materias) {
    antes.palabras_clave = doc.palabras_clave ?? null;
    if (ajeno.materias.length) set.palabras_clave = ajeno.materias; else unset.palabras_clave = '';
  }
  const descartarIsbn = ajeno.isbnActualAjeno && doc.isbn && variantesISBN(doc.isbn).includes(ajeno.anterior);
  if (descartarIsbn) { unset.isbn = ''; antes.isbn = doc.isbn; }
  const alerta = `ISBN ${ajeno.anterior} = «${ajeno.otroTitulo}», OTRO libro (${origen}):`
    + `${descartarIsbn ? ' ISBN descartado (queda en isbns_descartados);' : ''}`
    + `${ajeno.cduAjena ? ` la CDU ${doc.cdu} era la suya: a reclasificar desde cero;` : ''}`
    + `${ajeno.quitadas.length ? ` materias quitadas: ${ajeno.quitadas.join(' | ')}.` : ''}`;
  await db.collection('biblioteca').updateOne({ _id: doc._id }, {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
    ...(ajeno.isbnActualAjeno ? { $addToSet: { isbns_descartados: ajeno.anterior } } : {}),
    $push: { alertas_agente: alerta, deshacer: { fecha: new Date(), origen, antes } },
  });
  const nuevo = { ...doc, ...set };
  for (const k of Object.keys(unset)) delete nuevo[k];
  if (ajeno.isbnActualAjeno) nuevo.isbns_descartados = [...new Set([...(doc.isbns_descartados || []), ajeno.anterior])];
  return nuevo;
}
