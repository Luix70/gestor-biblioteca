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
 * PREFIJO DE REGISTRANTE de un ISBN (978 + 5 cifras, en forma ISBN-13), o null. Dos libros con el mismo prefijo
 * los registró casi siempre el mismo editor: «Montena» 84-397-1500… y «Montena División Infantil de Mondadori»
 * 84-397-1500… → 97884397. Los ISBN están guardados unos con 10 cifras y otros con 13.
 */
export function prefijoIsbn(isbn) {
  const d = String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  let p = null;
  if (d.length === 13 && /^97[89]/.test(d)) p = d.slice(0, 8);
  else if (d.length === 10) p = '978' + d.slice(0, 5);
  if (!p || /^97[89]0000/.test(p)) return null;   // «0000000000000»: relleno, no un ISBN
  return p;
}

/** Filtro de Mongo: libros de esa editorial cuyo ISBN (de 10 o de 13 cifras) empieza por ese prefijo. */
function filtroPrefijo(editorialId, prefijo) {
  const formas = [{ isbn: { $regex: '^' + prefijo } }];
  if (prefijo.startsWith('978')) formas.push({ isbn: { $regex: '^' + prefijo.slice(3) + '[0-9]{4}[0-9X]$' } });
  return { editorial: editorialId, $or: formas };
}

/**
 * Las claves más cortas contenidas al principio de esta: «montena division infantil mondadori espana» →
 * «montena», «montena division», … (de menos a más palabras; cada una de 3+ letras).
 */
export function clavesPrefijo(k) {
  const palabras = String(k || '').split(' ').filter(Boolean);
  const out = [];
  for (let i = 1; i < palabras.length; i++) {
    const pref = palabras.slice(0, i).join(' ');
    if (pref.replace(/ /g, '').length >= 3) out.push(pref);
  }
  return out;
}

/**
 * Busca la editorial de ese nombre, SIN crearla:
 *   1. nombre exacto (antes que un alternativo: un alternativo mal puesto no debe ganar a la editorial de verdad);
 *   2. nombre alternativo exacto;
 *   3. misma clave (otra grafía: «Catedra Ediciones» → «Cátedra»);
 *   4. con `isbn`: una editorial cuyo nombre es el PRINCIPIO de este y que ya tiene libros con el mismo prefijo de
 *      ISBN («Montena/Mondiberica», «Montena División Infantil de Mondadori» → «Montena»). El nombre solo no basta
 *      («Alianza Emecé» no es «Alianza» por llamarse así); el ISBN dice que es el mismo editor.
 * Con varias candidatas, la que tiene trabajo a mano (logo, descripción, web) y, si no, la más antigua.
 * Devuelve el documento ({_id, nombre, …}) o null.
 */
export async function buscarEditorial(db, nombre, { isbn = null } = {}) {
  const t = limpiarNombreEditorial(String(nombre || ''));
  if (!t) return null;
  const col = db.collection('editoriales');
  const proyeccion = { nombre: 1, nombres_alternativos: 1, logo: 1, descripcion: 1, web: 1 };

  const exacta = await col.findOne({ nombre: t }, { projection: proyeccion })
    || await col.findOne({ nombres_alternativos: t }, { projection: proyeccion });
  if (exacta) return exacta;

  const k = claveUtil(t);
  if (!k) return null;
  await asegurarClaves(db).catch(() => {});   // sin índice/claves, solo se pierde el reconocimiento por grafía
  const elegir = (lista) => lista.find((e) => e.logo || e.descripcion || e.web) || lista[0] || null;
  const candidatas = await col.find({ claves: k }, { projection: proyeccion }).sort({ _id: 1 }).limit(10).toArray();
  if (candidatas.length) return elegir(candidatas);

  const prefijo = prefijoIsbn(isbn);
  if (!prefijo) return null;
  const bib = db.collection('biblioteca');
  for (const pref of clavesPrefijo(k)) {   // de la más corta (la editorial madre) a la más larga
    const conEsePrincipio = await col.find({ claves: pref }, { projection: proyeccion }).sort({ _id: 1 }).limit(10).toArray();
    const avaladas = [];
    for (const e of conEsePrincipio) if (await bib.findOne(filtroPrefijo(e._id, prefijo), { projection: { _id: 1 } })) avaladas.push(e);
    if (avaladas.length) return elegir(avaladas);
  }
  return null;
}

/**
 * Nombre de editorial → ObjectId: la existente (por nombre o grafía) o una NUEVA. Una grafía nueva reconocida
 * se apunta en `nombres_alternativos` de la existente. Devuelve null si el nombre queda vacío tras limpiarlo.
 * `{ alCrear(nombre) }` avisa cuando se crea una (la ingesta lo anota en las alertas del libro); `{ isbn }` (el del
 * libro) permite reconocer una variante con palabras de más («Montena/Mondiberica» → «Montena»), ver buscarEditorial.
 */
export async function resolverEditorial(db, nombre, { alCrear, isbn = null } = {}) {
  const t = limpiarNombreEditorial(String(nombre || ''));
  if (!t) return null;
  const col = db.collection('editoriales');

  const existente = await buscarEditorial(db, t, { isbn });
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
