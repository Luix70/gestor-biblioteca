import axios from 'axios';
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

/**
 * Ejecuta una consulta y devuelve el primer volumen normalizado (o null).
 */
async function consultar(query) {
    try {
        const url = `${BASE}?q=${encodeURIComponent(query)}&maxResults=1&country=ES${clave()}`;
        const res = await axios.get(url);
        const item = res.data && Array.isArray(res.data.items) ? res.data.items[0] : null;
        return normalizar(item);
    } catch (e) {
        if (esErrorDeRed(e)) throw new ErrorInfraestructura('Google Books inalcanzable', e);
        return null;
    }
}

/**
 * Busca metadatos en Google Books con la misma estrategia tolerante a fallos
 * que el buscador de OpenLibrary:
 *   1. Por ISBN (preferente).
 *   2. Fallback por título + autor.
 *   3. Fallback final por título solo.
 */
export async function buscarEnGoogleBooks(criterios) {
    // 1. Por ISBN (se prueban todos los candidatos: variantes 10/13 / ediciones).
    const isbns = (criterios.isbns && criterios.isbns.length)
        ? criterios.isbns
        : (criterios.isbn ? [criterios.isbn] : []);
    for (const isbn of isbns) {
        const porIsbn = await consultar(`isbn:${String(isbn).replace(/-/g, '')}`);
        if (porIsbn) return porIsbn;
    }

    // 2 y 3. Por texto
    if (criterios.titulo) {
        const q = criterios.autor
            ? `intitle:${criterios.titulo}+inauthor:${criterios.autor}`
            : `intitle:${criterios.titulo}`;
        const conAutor = await consultar(q);
        if (conAutor) return conAutor;

        if (criterios.autor) {
            return await consultar(`intitle:${criterios.titulo}`);
        }
    }

    return null;
}
