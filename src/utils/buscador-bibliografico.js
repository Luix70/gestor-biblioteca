import axios from 'axios';

const BASE = 'https://openlibrary.org';

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

    return {
        isbn: isbnFinal,
        titulo: data.title || null,
        editorial: editorial,
        año_edicion: data.first_publish_year || parseInt(data.publish_date) || null,
        workKey: workKey
    };
}

/**
 * Recupera la sinopsis del registro 'work'. OpenLibrary devuelve 'description'
 * como string o como objeto { type, value }. Devuelve null si no existe.
 */
async function obtenerSinopsis(workKey) {
    if (!workKey) return null;
    try {
        const res = await axios.get(`${BASE}${workKey}.json`);
        const desc = res.data && res.data.description;
        if (!desc) return null;
        return typeof desc === 'string' ? desc : (desc.value || null);
    } catch (e) {
        return null;
    }
}

/**
 * Ejecuta una búsqueda por texto en /search.json y devuelve el primer resultado normalizado.
 */
async function buscarPorTexto(titulo, autor) {
    const params = new URLSearchParams({
        title: titulo,
        limit: '1',
        fields: 'key,title,isbn,publisher,first_publish_year'
    });
    if (autor) params.set('author', autor);

    const res = await axios.get(`${BASE}/search.json?${params.toString()}`);
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
    const { workKey, ...resto } = norm;
    resto.sinopsis = incluirSinopsis ? await obtenerSinopsis(workKey) : null;
    return resto;
}

export async function buscarPorCriterios(criterios) {
    const incluirSinopsis = criterios.incluirSinopsis !== false; // por defecto, sí

    // 1. Intento preferente: lookup directo por ISBN
    if (criterios.isbn) {
        try {
            const isbnLimpio = criterios.isbn.replace(/-/g, '');
            const res = await axios.get(`${BASE}/isbn/${isbnLimpio}.json`);
            const norm = normalizar(res.data);
            if (norm) return await finalizar(norm, incluirSinopsis);
        } catch (e) {
            // 404 (ISBN inexistente o mal leído por la IA) -> caemos al buscador por texto
        }
    }

    // 2 y 3. Fallback por texto
    if (criterios.titulo) {
        try {
            const conAutor = await buscarPorTexto(criterios.titulo, criterios.autor);
            if (conAutor) return await finalizar(conAutor, incluirSinopsis);

            // Si el autor no devolvió nada, reintentamos solo con el título
            if (criterios.autor) {
                return await finalizar(await buscarPorTexto(criterios.titulo, null), incluirSinopsis);
            }
        } catch (e) {
            return null;
        }
    }

    return null;
}
