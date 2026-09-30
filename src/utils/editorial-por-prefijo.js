/**
 * EDITORIAL POR EL PREFIJO DEL ISBN. El ISBN lleva dentro el código de la editorial (978-84-7702-… = Valdemar), así
 * que la propia biblioteca «sabe» de quién es un prefijo cuando ya tiene varios libros con él y casi todos son de la
 * misma editorial.
 *
 * Motivo (medido el 30-sep): una API dio «Rama Publishing Company» a «Los episodios de Vathek», ISBN 84-7702-036-3,
 * cuando la biblioteca tiene decenas de libros 84-7702 y todos son de Valdemar. Con esto, la editorial que diga una
 * fuente externa para una edición se contrasta con lo que la biblioteca ya sabe de ese prefijo:
 *   · si la contradice, gana la del prefijo;
 *   · si falta, se rellena con la del prefijo.
 *
 * Aproximación: el registrante tiene longitud variable, así que se usan los 9 primeros dígitos del ISBN-13 (o los 6
 * del ISBN-10). En editoriales con registrante largo ese prefijo lo comparten varias pequeñas: por eso se exige una
 * mayoría clara (≥ 60 %, al menos 3 libros y el triple que la segunda); si no, no se opina.
 * Se cuenta por NOMBRE normalizado, no por registro de editorial: medido en 84-7702, Valdemar tiene 105 libros
 * repartidos entre «Valdemar», «VALDEMAR» y «Valdemar,», más ruido («SE», «ge», «ePubLibre»…) que no cuenta.
 */
import { esEditorialFalsa, limpiarNombreEditorial } from './editoriales-falsas.js';

const MIN_LIBROS = 3;
const MAYORIA = 0.6;
const VENTAJA_SOBRE_SEGUNDA = 3;

// Clave de agrupación: sin acentos, mayúsculas, puntuación ni la palabra «editorial/ediciones…».
const RE_DIACRITICOS = new RegExp('[\u0300-\u036f]', 'g');
const RE_PALABRAS_EDITORIAL = new RegExp(String.raw`\b(editorial|editora|ediciones|edicions|editores|ed|s ?a|s ?l|inc|ltd)\b`, 'g');
export const claveEditorial = (nombre) => limpiarNombreEditorial(nombre).toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(RE_PALABRAS_EDITORIAL, ' ')
    .replace(/\s+/g, ' ').trim();
// Ruido: nombres de 1-2 letras («SE», «ge», «9e») o sin letras no son una editorial.
// Se mira el NOMBRE entero, no la clave: «Ediciones B» tiene clave «b», pero es una editorial.
// Excepción: editoriales reales de dos letras (Dorling Kindersley, Ediciones SM).
const SIGLAS_REALES = new Set(['dk', 'sm']);
export const esNombreRuido = (nombre) => {
    const letras = limpiarNombreEditorial(nombre).replace(/[^\p{L}]/gu, '');
    return letras.length < 3 && !SIGLAS_REALES.has(letras.toLowerCase());
};

const soloDigitos = (isbn) => String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();

function aIsbn13(isbn) {
    const d = soloDigitos(isbn);
    if (d.length === 13) return d;
    if (d.length !== 10) return null;
    const base = '978' + d.slice(0, 9);
    let suma = 0;
    for (let i = 0; i < 12; i++) suma += Number(base[i]) * (i % 2 ? 3 : 1);
    return base + ((10 - (suma % 10)) % 10);
}

// Caché por proceso: en una pasada larga, muchos libros comparten prefijo.
const cache = new Map();

/** Prefijo de 9 dígitos del ISBN-13 con el que se agrupa (null si no es un ISBN). */
export function prefijoEditorialISBN(isbn) {
    const i13 = aIsbn13(isbn);
    return i13 && /^97[89]/.test(i13) ? i13.slice(0, 9) : null;
}

/**
 * Parte PURA: de los nombres de editorial de los libros de un prefijo, la dominante (o null si no hay mayoría
 * clara). La usan la consulta de abajo y el script de saneado (que agrupa todo el catálogo en memoria).
 * @returns {{nombre, clave, libros, total, grupos: Object<clave, nº>}|null}
 */
export function editorialDominante(nombres) {
    const grupos = new Map();   // clave → { libros, nombres: Map(nombre → nº) }
    let validos = 0;
    for (const nombre of nombres) {
        if (!nombre || esEditorialFalsa(nombre)) continue;
        const k = claveEditorial(nombre);
        if (!k || esNombreRuido(nombre)) continue;
        validos++;
        const g = grupos.get(k) || { libros: 0, nombres: new Map() };
        g.libros++;
        g.nombres.set(nombre, (g.nombres.get(nombre) || 0) + 1);
        grupos.set(k, g);
    }
    const [primera, segunda] = [...grupos.values()].sort((a, b) => b.libros - a.libros);
    const clara = primera && primera.libros >= MIN_LIBROS && primera.libros / validos >= MAYORIA
        && primera.libros >= VENTAJA_SOBRE_SEGUNDA * (segunda?.libros || 0);
    if (!clara) return null;
    // El nombre: la forma más usada del grupo, ya limpia («Valdemar», no «Valdemar,»).
    const nombre = limpiarNombreEditorial([...primera.nombres.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    return {
        nombre,
        clave: claveEditorial(nombre),
        libros: primera.libros,
        total: validos,
        // Libros de cada editorial del prefijo: una con 3+ es plausible (coedición, sello); una con 1-2, una rareza.
        grupos: Object.fromEntries([...grupos.entries()].map(([c, g]) => [c, g.libros])),
    };
}

/**
 * La editorial DOMINANTE de los libros de la biblioteca con el mismo prefijo de ISBN, o null si no hay mayoría
 * clara. @returns {Promise<{nombre, id, libros, total}|null>}
 */
export async function editorialPorPrefijoISBN(db, isbn, { excluirId = null } = {}) {
    const prefijo13 = prefijoEditorialISBN(isbn);
    if (!prefijo13) return null;
    const clave = `${prefijo13}|${excluirId || ''}`;
    if (cache.has(clave)) return cache.get(clave);

    // Los ISBN se guardan normalmente en 13 dígitos; los antiguos pueden estar en 10 (sin el 978).
    const filtroIsbn = [{ isbn: { $regex: `^${prefijo13}` } }];
    if (prefijo13.startsWith('978')) filtroIsbn.push({ isbn: { $regex: `^${prefijo13.slice(3)}` } });
    const filtro = { $or: filtroIsbn, editorial: { $exists: true, $ne: null } };
    if (excluirId) filtro._id = { $ne: excluirId };

    const docs = await db.collection('biblioteca')
        .find(filtro, { projection: { editorial: 1 } })
        .limit(300)
        .toArray()
        .catch(() => []);

    // Nombres de las editoriales de esos libros, agrupados por clave normalizada (sin ruido ni maquetadores).
    const eds = await db.collection('editoriales')
        .find({ _id: { $in: docs.map((d) => d.editorial) } }, { projection: { nombre: 1 } })
        .toArray()
        .catch(() => []);
    const nombrePorId = new Map(eds.map((e) => [String(e._id), e.nombre]));
    const resultado = editorialDominante(docs.map((d) => nombrePorId.get(String(d.editorial))));
    cache.set(clave, resultado);
    return resultado;
}

/** Grupo de registro (país/lengua) del ISBN-13, aproximado: 978-0…7 son de 1 dígito, 978-8x de 2, 978-9xx de 3. */
export function grupoRegistroISBN(prefijo13) {
    const d = prefijo13[3];
    return prefijo13.slice(0, d <= '7' ? 4 : d === '8' ? 5 : 6);
}

/** ¿Tiene la biblioteca 3+ libros de esa editorial con ISBN del mismo país? (una editorial real y conocida allí) */
async function conocidaEnElPais(db, nombre, prefijo13) {
    const ids = await db.collection('editoriales')
        .find({ nombre: limpiarNombreEditorial(nombre) }, { projection: { _id: 1 } })
        .toArray()
        .catch(() => []);
    if (!ids.length) return false;
    const grupo = grupoRegistroISBN(prefijo13);
    // Los ISBN antiguos pueden estar guardados en 10 dígitos (84…, sin el 978).
    const deGrupo = [{ isbn: { $regex: `^${grupo}` } }];
    if (grupo.startsWith('978')) {
        const g10 = grupo.slice(3);
        deGrupo.push({ isbn: { $regex: `^${g10}[0-9Xx]{${10 - g10.length}}$` } });
    }
    const n = await db.collection('biblioteca')
        .countDocuments({ editorial: { $in: ids.map((e) => e._id) }, $or: deGrupo }, { limit: MIN_LIBROS })
        .catch(() => 0);
    return n >= MIN_LIBROS;
}

/** ¿Comparten una palabra propia? «Springer International Publishing» ~ «Springer» (variante del mismo nombre). */
function varianteDeNombre(a, b) {
    const genericas = new Set(['press', 'publishing', 'publishers', 'books', 'group', 'university', 'libros']);
    const propias = (n) => new Set(claveEditorial(n).split(' ').filter((w) => w.length >= 4 && !genericas.has(w)));
    const B = propias(b);
    return [...propias(a)].some((w) => B.has(w));
}

/**
 * La editorial que conviene poner a una edición con ese ISBN, a partir de la `propuesta` de una fuente externa:
 *   · sin propuesta (o un maquetador / basura) → la del prefijo;
 *   · la misma, una variante del nombre o un sello con 3+ libros en ese prefijo → la propuesta;
 *   · una editorial REAL que la biblioteca ya conoce en ese país (3+ libros) → la propuesta: puede ser un sello del
 *     grupo (Routledge en un ISBN de Taylor & Francis, Clarendon en uno de Oxford) y no se pierde;
 *   · una desconocida que contradice una mayoría clara → la del prefijo («Rama Publishing Company» en 84-7702).
 * @param mismaEditorial (a, b) → bool, comparación tolerante (la de identificar-edicion)
 * @returns {Promise<{nombre: string|null, corregida: boolean, prefijo: object|null}>}
 */
export async function editorialCoherenteConISBN(db, isbn, propuesta, mismaEditorial, opts = {}) {
    const prefijo = await editorialPorPrefijoISBN(db, isbn, opts);
    if (!prefijo) return { nombre: propuesta || null, corregida: false, prefijo: null };
    const valida = propuesta && !esEditorialFalsa(propuesta) && !esNombreRuido(propuesta);
    if (!valida) return { nombre: prefijo.nombre, corregida: !!propuesta, prefijo };
    const queda = { nombre: propuesta, corregida: false, prefijo };
    if (mismaEditorial(propuesta, prefijo.nombre) || varianteDeNombre(propuesta, prefijo.nombre)) return queda;
    if ((prefijo.grupos[claveEditorial(propuesta)] || 0) >= MIN_LIBROS) return queda;
    if (await conocidaEnElPais(db, propuesta, prefijoEditorialISBN(isbn))) return queda;
    return { nombre: prefijo.nombre, corregida: true, prefijo };
}
