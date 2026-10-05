/**
 * RESOLVER UNA EDITORIAL POR SU NOMBRE (nombre → ObjectId, creándola si no existe) — la ÚNICA puerta por la que
 * entran editoriales nuevas en la base. Antes había ~15 copias de «findOne({nombre}) o insertOne» con el nombre
 * EXACTO: «Cátedra», «Catedra Ediciones», «CÁTEDRA», «Ediciones Cátedra, S.A.» eran cuatro editoriales (medido el
 * 5-oct: 911 grupos de grafías, 6.738 libros; scripts/fusionar-grafias-editoriales.js las fundió).
 *
 * MISMA EDITORIAL = misma `claveEditorial`: el nombre sin mayúsculas, acentos, puntuación, forma societaria
 * («S.A.», «Inc.», «Ltd», «GmbH»), palabras genéricas («Editorial», «Ediciones», «Publishing», «Verlag», «Grupo»…)
 * ni un año al final. Conservadora: «Press» y «Books» SÍ cuentan («Penguin Press» ≠ «Penguin Books») y una palabra
 * de más separa («Emecé Editores España» ≠ «Emecé»). La misma clave la usa el script de fusión, así que lo que él
 * funde es justo lo que aquí se reconoce después.
 *
 * Cada editorial guarda `claves` (la de su nombre y las de sus nombres alternativos), indexado: la búsqueda es una
 * consulta, no un recorrido. Las editoriales antiguas sin `claves` se completan solas la primera vez que se resuelve
 * algo en el proceso (`asegurarClaves`). Al reconocer una grafía nueva, se añade a `nombres_alternativos` (se ve en
 * la ficha de la editorial y queda como prueba de por qué ese libro fue a parar ahí).
 */
import { limpiarNombreEditorial, esEditorialFalsa } from './editoriales-falsas.js';

// Forma societaria y palabras genéricas que no distinguen una editorial de otra.
const RE_SOCIETARIA = /\b(s\.?\s?a\.?\s?u?|s\.?\s?l\.?\s?u?|s\.?\s?a\.?\s?de\s?c\.?\s?v\.?|s\.?\s?r\.?\s?l\.?|s\.?\s?p\.?\s?a\.?|inc|incorporated|ltd|ltda|limited|llc|l\.?\s?l\.?\s?c|gmbh|ag|kg|bv|nv|plc|pty|sarl|co|corp|corporation|company|& co|y cia|cia)\b\.?/gi;
const RE_GENERICAS = /\b(editorial|editoriales|ediciones|edicions|edicion|editores|editora|editrice|edizioni|editions|edition|publishing|publishers|publisher|pub|verlag|grupo|group)\b/gi;
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

/** Clave de una editorial: el nombre sin lo que no distingue una editorial de otra. */
export function claveEditorial(nombre) {
  return String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(RE_DIACRITICOS, '')
    .replace(/&amp;/g, '&')
    .replace(/[,\s]+(1[5-9]|20)\d{2}\s*$/, '')            // «…, 1997»
    .replace(/&/g, ' and ')
    .replace(RE_SOCIETARIA, ' ')
    .replace(RE_GENERICAS, ' ')
    .replace(/\band\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * ¿La clave sirve para reconocer grafías? Muy corta («B», «SM») agruparía cosas distintas, y un placeholder
 * («Unknown», «Publisher Unknown») no es una editorial: en esos casos solo vale el nombre exacto.
 */
export function claveUtil(nombre) {
  const k = claveEditorial(nombre);
  if (k.replace(/\s/g, '').length < 3) return null;
  if (esEditorialFalsa(nombre)) return null;
  return k;
}

/** Las claves de una editorial: la de su nombre y las de sus nombres alternativos (sin repetir). */
export function clavesDeEditorial(editorial) {
  const nombres = [editorial?.nombre, ...(editorial?.nombres_alternativos || [])];
  return [...new Set(nombres.map(claveUtil).filter(Boolean))];
}

/** Recalcula y guarda las `claves` de una editorial (tras renombrarla, editar sus alternativos o fundirla). */
export async function actualizarClaves(db, editorialId) {
  const e = await db.collection('editoriales').findOne({ _id: editorialId }, { projection: { nombre: 1, nombres_alternativos: 1 } });
  if (!e) return;
  await db.collection('editoriales').updateOne({ _id: e._id }, { $set: { claves: clavesDeEditorial(e) } });
}

// Una vez por proceso: índice sobre `claves` y claves para las editoriales que aún no las tienen.
let clavesAseguradas = null;
export function asegurarClaves(db) {
  if (!clavesAseguradas) {
    clavesAseguradas = (async () => {
      const col = db.collection('editoriales');
      await col.createIndex({ claves: 1 }).catch(() => {});
      const sinClaves = await col.find({ claves: { $exists: false } }, { projection: { nombre: 1, nombres_alternativos: 1 } }).toArray();
      for (let i = 0; i < sinClaves.length; i += 500) {
        const lote = sinClaves.slice(i, i + 500).map((e) => ({
          updateOne: { filter: { _id: e._id }, update: { $set: { claves: clavesDeEditorial(e) } } },
        }));
        await col.bulkWrite(lote, { ordered: false });
      }
    })().catch((err) => {
      clavesAseguradas = null;   // se reintenta en la próxima resolución
      throw err;
    });
  }
  return clavesAseguradas;
}

/**
 * Busca la editorial de ese nombre, SIN crearla: nombre exacto → nombre alternativo exacto → misma clave.
 * Con varias de la misma clave (grafías aún sin fundir) se queda con la que tiene trabajo a mano (logo,
 * descripción, web) y, si no, con la más antigua. Devuelve el documento ({_id, nombre, …}) o null.
 */
export async function buscarEditorial(db, nombre) {
  const t = limpiarNombreEditorial(String(nombre || ''));
  if (!t) return null;
  const col = db.collection('editoriales');
  const proyeccion = { nombre: 1, nombres_alternativos: 1, logo: 1, descripcion: 1, web: 1 };

  const exacta = await col.findOne({ $or: [{ nombre: t }, { nombres_alternativos: t }] }, { projection: proyeccion });
  if (exacta) return exacta;

  const k = claveUtil(t);
  if (!k) return null;
  await asegurarClaves(db).catch(() => {});   // sin índice/claves, solo se pierde el reconocimiento por grafía
  const candidatas = await col.find({ claves: k }, { projection: proyeccion }).sort({ _id: 1 }).limit(10).toArray();
  return candidatas.find((e) => e.logo || e.descripcion || e.web) || candidatas[0] || null;
}

/**
 * Nombre de editorial → ObjectId: la existente (por nombre o grafía) o una NUEVA. Una grafía nueva reconocida
 * se apunta en `nombres_alternativos` de la existente. Devuelve null si el nombre queda vacío tras limpiarlo.
 * `{ alCrear(nombre) }` avisa cuando se crea una (la ingesta lo anota en las alertas del libro).
 */
export async function resolverEditorial(db, nombre, { alCrear } = {}) {
  const t = limpiarNombreEditorial(String(nombre || ''));
  if (!t) return null;
  const col = db.collection('editoriales');

  const existente = await buscarEditorial(db, t);
  if (existente) {
    const yaConocida = existente.nombre === t || (existente.nombres_alternativos || []).includes(t);
    if (!yaConocida) {
      await col.updateOne({ _id: existente._id }, { $addToSet: { nombres_alternativos: t } });
    }
    return existente._id;
  }

  const k = claveUtil(t);
  const nueva = { nombre: t, fecha_creacion: new Date() };
  if (k) nueva.claves = [k];
  const { insertedId } = await col.insertOne(nueva);
  if (alCrear) alCrear(t);
  return insertedId;
}
