import axios from 'axios';
import { ErrorInfraestructura, esErrorDeRed } from '../errores.js';

const BASE = 'https://openlibrary.org';

// OpenLibrary es significativamente más lento que otras APIs (30–40 s en búsquedas de texto).
// Se le da su propio timeout en vez de depender del global HTTP_TIMEOUT_MS (20 s).
const olAxios = axios.create({ timeout: Number(process.env.OL_TIMEOUT_MS || 45000) });

/**
 * Normaliza la respuesta de OpenLibrary a nuestro esquema interno.
 * Funciona tanto para la respuesta de /isbn/*.json como para los docs de /search.json,
 * que usan nombres de campo ligeramente distintos.
 */
function normalizar(data) {
    if (!data) return null;

    const isbnFinal = (data.isbn_13 && data.isbn_13[0])
        || (Array.isArray(data.isbn) ? data.isbn[0] : data.isbn)
        || null;

    const editorial = Array.isArray(data.publishers) ? data.publishers[0]
        : Array.isArray(data.publisher) ? data.publisher[0]
        : (data.publishers || data.publisher || null);

    // La clave del 'work' llega como doc.key en /search o como works[0].key en /isbn
    const workKey = data.key && data.key.startsWith('/works/') ? data.key
        : (Array.isArray(data.works) && data.works[0] ? data.works[0].key : null);

    // Códigos de clasificación para derivar/aprender la CDU (Dewey y Library of Congress).
    const dewey = (Array.isArray(data.dewey_decimal_class) && data.dewey_decimal_class[0])
        || (Array.isArray(data.ddc) && data.ddc[0]) || null;
    const lcc = (Array.isArray(data.lc_classifications) && data.lc_classifications[0])
        || (Array.isArray(data.lcc) && data.lcc[0]) || null;

    // Autores: /search.json los da ya resueltos en author_name; /isbn solo da claves
    // (/authors/OLxxxA) que hay que resolver con una llamada extra (lo hace finalizar()).
    const autoresNombres = Array.isArray(data.author_name) ? data.author_name : null;
    const autoresClaves = Array.isArray(data.authors)
        ? data.authors.map(a => (a && a.key) || null).filter(Boolean)
        : null;

    return {
        isbn: isbnFinal,
        titulo: data.title || null,
        editorial: editorial,
        año_edicion: data.first_publish_year || parseInt(data.publish_date) || null,
        dewey: dewey,
        lcc: lcc,
        workKey: workKey,
        autoresNombres: autoresNombres,
        autoresClaves: autoresClaves
    };
}

/**
 * Resuelve claves /authors/OLxxxA a nombres legibles (una llamada por autor, acotado a 5).
 * Best-effort: un fallo deja ese autor fuera (nunca rompe la ingesta).
 */
async function resolverAutores(claves) {
    if (!Array.isArray(claves) || claves.length === 0) return [];
    const nombres = [];
    for (const k of claves.slice(0, 5)) {
        try {
            const res = await olAxios.get(`${BASE}${k}.json`);
            const n = res.data && (res.data.name || res.data.personal_name);
            if (n) nombres.push(String(n).trim());
        } catch { /* autor irrecuperable: se omite */ }
    }
    return nombres;
}

/**
 * Recupera la sinopsis del registro 'work'. OpenLibrary devuelve 'description'
 * como string o como objeto { type, value }. Devuelve null si no existe.
 */
async function obtenerSinopsis(workKey) {
    if (!workKey) return null;
    try {
        const res = await olAxios.get(`${BASE}${workKey}.json`);
        const desc = res.data && res.data.description;
        if (!desc) return null;
        return typeof desc === 'string' ? desc : (desc.value || null);
    } catch (e) {
        return null;
    }
}

// ISO 639-1 → código MARC de 3 letras para el filtro de idioma de OpenLibrary.
const ISO_MARC = {
    es: 'spa', en: 'eng', fr: 'fre', de: 'ger', it: 'ita',
    pt: 'por', ru: 'rus', ca: 'cat', gl: 'glg', eu: 'baq',
    zh: 'chi', ja: 'jpn', ar: 'ara', nl: 'dut', pl: 'pol',
};

/**
 * Ejecuta una búsqueda por texto en /search.json y devuelve el primer resultado normalizado.
 * Si se proporciona idioma (ISO 639-1), se añade el parámetro `lang` de OpenLibrary.
 */
async function buscarPorTexto(titulo, autor, idioma = null) {
    const params = new URLSearchParams({
        title: titulo,
        limit: '1',
        fields: 'key,title,isbn,publisher,first_publish_year,ddc,lcc'
    });
    if (autor) params.set('author', autor);
    const marcLang = idioma ? ISO_MARC[idioma] : null;
    if (marcLang) params.set('lang', marcLang);

    const res = await olAxios.get(`${BASE}/search.json?${params.toString()}`);
    const doc = res.data && Array.isArray(res.data.docs) ? res.data.docs[0] : null;
    return normalizar(doc);
}

/**
 * Busca metadatos en OpenLibrary con tolerancia a fallos:
 *   1. Por ISBN (preferente, pero la visión IA puede leerlo mal).
 *   2. Fallback por título + autor (resistente a ISBN erróneos o ausentes).
 *   3. Fallback final por título solo, si el autor sobre-restringe la búsqueda.
 */
/**
 * Completa el resultado con la sinopsis del 'work' y descarta la clave interna workKey.
 * Si incluirSinopsis es false, se ahorra la llamada HTTP extra al registro 'work'
 * (el llamante ya dispone de una sinopsis que no quiere sobrescribir).
 */
async function finalizar(norm, incluirSinopsis) {
    if (!norm) return null;
    const { workKey, autoresNombres, autoresClaves, ...resto } = norm;
    resto.sinopsis = incluirSinopsis ? await obtenerSinopsis(workKey) : null;
    // Autores: usa los ya resueltos (search.json) o resuelve las claves (registro /isbn).
    resto.autores = autoresNombres || await resolverAutores(autoresClaves);
    return resto;
}

export async function buscarPorCriterios(criterios) {
    const incluirSinopsis = criterios.incluirSinopsis !== false; // por defecto, sí

    // 1. Intento preferente: lookup directo por ISBN. Se admite una lista de candidatos
    //    (variantes 10/13, ediciones, lectura del archivo) y se prueba cada uno: un libro
    //    suele estar indexado por solo una de sus formas, así que el primer 404 no es el final.
    const isbns = (criterios.isbns && criterios.isbns.length)
        ? criterios.isbns
        : (criterios.isbn ? [criterios.isbn] : []);
    for (const isbn of isbns) {
        try {
            const isbnLimpio = String(isbn).replace(/-/g, '');
            const res = await olAxios.get(`${BASE}/isbn/${isbnLimpio}.json`);
            const norm = normalizar(res.data);
            if (norm) return await finalizar(norm, incluirSinopsis);
        } catch (e) {
            if (esErrorDeRed(e)) throw new ErrorInfraestructura('OpenLibrary inalcanzable', e);
            // 404 (ISBN inexistente o de otra edición) -> probar el siguiente candidato
        }
    }

    // 2 y 3. Fallback por texto
    // Estrategia: intentar primero con filtro de idioma (da con la edición en la lengua del
    // archivo); si no hay resultado, repetir sin filtro (cubre ISBNs no indexados por idioma).
    if (criterios.titulo) {
        const idioma = criterios.idioma || null;
        try {
            // 2a. Con idioma (preferente, si se conoce)
            if (idioma) {
                const conIdioma = await buscarPorTexto(criterios.titulo, criterios.autor, idioma);
                if (conIdioma) return await finalizar(conIdioma, incluirSinopsis);
            }

            // 2b. Sin filtro de idioma
            const conAutor = await buscarPorTexto(criterios.titulo, criterios.autor);
            if (conAutor) return await finalizar(conAutor, incluirSinopsis);

            if (criterios.autor) {
                return await finalizar(await buscarPorTexto(criterios.titulo, null, idioma || null), incluirSinopsis);
            }
        } catch (e) {
            if (esErrorDeRed(e)) throw new ErrorInfraestructura('OpenLibrary inalcanzable', e);
            return null;
        }
    }

    return null;
}
