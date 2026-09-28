import { http } from './http.js';
import { ErrorInfraestructura, esErrorDeRed } from '../errores.js';

const BASE = 'https://www.googleapis.com/books/v1/volumes';

/**
 * Normaliza un volumeInfo de Google Books a nuestro esquema interno.
 * Devuelve un superconjunto del shape de OpenLibrary: añade idioma, categorías
 * (semilla para la CDU) y portada_url.
 */
function normalizar(volumen) {
    if (!volumen) return null;
    const info = volumen.volumeInfo || {};

    // ISBN: preferimos el 13; si no, el 10.
    let isbn = null;
    const ids = Array.isArray(info.industryIdentifiers) ? info.industryIdentifiers : [];
    const isbn13 = ids.find(i => i.type === 'ISBN_13');
    const isbn10 = ids.find(i => i.type === 'ISBN_10');
    if (isbn13) isbn = isbn13.identifier;
    else if (isbn10) isbn = isbn10.identifier;

    const imageLinks = info.imageLinks || {};
    const portada_url = imageLinks.thumbnail || imageLinks.smallThumbnail || null;

    return {
        isbn: isbn,
        titulo: info.title || null,
        subtitulo: info.subtitle || null,
        autores: Array.isArray(info.authors) ? info.authors : [],
        editorial: info.publisher || null,
        año_edicion: info.publishedDate ? (parseInt(info.publishedDate.substring(0, 4)) || null) : null,
        sinopsis: info.description || null,
        idioma: info.language || null,           // ISO 639-1
        categorias: Array.isArray(info.categories) ? info.categories : [],
        portada_url: portada_url
    };
}

function clave() {
    return process.env.GOOGLE_BOOKS_API_KEY
        ? `&key=${process.env.GOOGLE_BOOKS_API_KEY.trim()}`
        : '';
}

// CUOTA DIARIA AGOTADA. Medido (sep. 2026): Google Books respondía 429 «Quota exceeded … Queries per day» en el
// 55-87 % de los libros de cada semana, y el pipeline lo registraba como «inalcanzable» y REINTENTABA (cuatro
// intentos con esperas) en cada libro. No es un baneo ni una caída: la cuota gratuita del proyecto se agota a
// primera hora con las ingestas masivas y no vuelve hasta que Google la reinicia (medianoche, hora del
// Pacífico). Así que, en cuanto se detecta, se deja de llamar hasta entonces: ahorra tiempo y no empeora nada.
let sinCuotaHasta = 0;
/** Próxima medianoche del Pacífico, con margen (08:05 UTC cubre el horario de invierno y el de verano). */
function reinicioCuota() {
    const ahora = new Date();
    const t = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate(), 8, 5));
    if (t <= ahora) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime();
}
const esCuotaDiaria = (e) => e?.response?.status === 429 && /per day|quota/i.test(JSON.stringify(e.response?.data || ''));

/** ¿Se puede llamar a Google Books ahora? (false mientras dure la cuota agotada) */
export const googleBooksConCuota = () => Date.now() >= sinCuotaHasta;

/**
 * Ejecuta una consulta y devuelve el primer volumen normalizado (o null).
 * Si se proporciona idioma (ISO 639-1), se añade langRestrict para filtrar por lengua.
 */
async function consultar(query, idioma = null) {
    if (!googleBooksConCuota()) {
        const hora = new Date(sinCuotaHasta).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
        throw new ErrorInfraestructura(`Google Books sin cuota diaria (vuelve a las ${hora})`, null);
    }
    try {
        const lang = idioma ? `&langRestrict=${idioma}` : '';
        const url = `${BASE}?q=${encodeURIComponent(query)}&maxResults=1&country=ES${lang}${clave()}`;
        const res = await http.get(url);
        const item = res.data && Array.isArray(res.data.items) ? res.data.items[0] : null;
        return normalizar(item);
    } catch (e) {
        if (esCuotaDiaria(e)) {
            sinCuotaHasta = reinicioCuota();
            const hora = new Date(sinCuotaHasta).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
            console.warn(`⚠️  Google Books: cuota diaria agotada → sin llamadas hasta las ${hora}.`);
            throw new ErrorInfraestructura(`Google Books sin cuota diaria (vuelve a las ${hora})`, e);
        }
        if (esErrorDeRed(e)) throw new ErrorInfraestructura('Google Books inalcanzable', e);
        return null;
    }
}

/**
 * Busca metadatos en Google Books con la misma estrategia tolerante a fallos
 * que el buscador de OpenLibrary:
 *   1. Por ISBN (preferente).
 *   2. Por título + colección (edición exacta) con filtro de idioma.
 *   3. Por título + autor con filtro de idioma; fallback sin filtro.
 *   4. Por título solo.
 */
export async function buscarEnGoogleBooks(criterios) {
    const idioma  = criterios.idioma  || null;
    const coleccion = criterios.coleccion || null;

    // 1. Por ISBN (se prueban todos los candidatos: variantes 10/13 / ediciones).
    const isbns = (criterios.isbns && criterios.isbns.length)
        ? criterios.isbns
        : (criterios.isbn ? [criterios.isbn] : []);
    for (const isbn of isbns) {
        const porIsbn = await consultar(`isbn:${String(isbn).replace(/-/g, '')}`);
        if (porIsbn) return porIsbn;
    }

    if (!criterios.titulo) return null;

    // 2. Edición exacta vía colección (nombre de serie) + idioma.
    // La IA extrae la colección de la portada (ej. "Clásica Maior") → búsqueda muy específica.
    if (coleccion && idioma) {
        const qCol = `intitle:${criterios.titulo} "${coleccion}"`;
        const conColeccion = await consultar(qCol, idioma);
        if (conColeccion) return conColeccion;
    }

    // 3. Por texto con filtro de idioma (intentar primero con idioma para dar con la edición
    //    en la lengua del archivo; si no hay resultados, caer sin filtro).
    const qAutor = criterios.autor
        ? `intitle:${criterios.titulo}+inauthor:${criterios.autor}`
        : `intitle:${criterios.titulo}`;

    if (idioma) {
        const conIdioma = await consultar(qAutor, idioma);
        if (conIdioma) return conIdioma;
    }

    const sinFiltro = await consultar(qAutor);
    if (sinFiltro) return sinFiltro;

    // 4. Solo título (sin autor) como último recurso.
    if (criterios.autor) {
        return await consultar(`intitle:${criterios.titulo}`, idioma || null);
    }

    return null;
}
