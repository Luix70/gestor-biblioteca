import { medirImagen } from './medir-imagen.js';
import { variantesISBN } from './identificadores.js';
import { googleBooksConCuota, marcarGoogleBooksSinCuota } from './buscador-google-books.js';
import { mismoTituloLibro } from './titulo-libro.js';

/** Minúsculas, sin acentos ni signos: para comparar nombres de persona. */
const normalizarNombre = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Descarga una imagen remota → { buf, ancho, alto, formato } o null (no carga, no es imagen, placeholder 1x1).
 * Mismos umbrales que `medirPortadaRemota`. Tope de 12 MB.
 */
export async function descargarImagen(url) {
    try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 12000);
        const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        clearTimeout(to);
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 800 || buf.length > 12 * 1024 * 1024) return null;
        const dim = medirImagen(buf);
        if (!dim || !dim.width || dim.width < 20 || dim.height < 20) return null;
        return { buf, ancho: dim.width, alto: dim.height, formato: dim.formato };
    } catch { return null; }
}

// Descarga una imagen remota y devuelve sus dimensiones (sin sharp: se leen de la cabecera JPEG/PNG).
// Descarta placeholders diminutos («sin imagen») por tamaño de buffer. null si no carga o no es imagen.
export async function medirPortadaRemota(url, fuente) {
    try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 9000);
        const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
        clearTimeout(to);
        if (!resp.ok) return null;
        const buf = Buffer.from(await resp.arrayBuffer());
        if (buf.length < 800) return null;                  // cuerpo vacío / respuesta de error
        const dim = medirImagen(buf);
        // Se rechaza SOLO el placeholder 1x1 («no image» de Amazon, etc.), NO las portadas pequeñas reales:
        // el usuario prefiere una cubierta chica a un documento sin portada.
        if (!dim || !dim.width || dim.width < 20 || dim.height < 20) return null;
        return { url, fuente, ancho: dim.width, alto: dim.height, bytes: buf.length };
    } catch { return null; }
}

// Candidatas de PORTADA por ISBN. PRIMERO la del propio Fichero local (la más autoritativa: la trae nuestro
// dump), luego fuentes KEYLESS (sin scraping frágil): OpenLibrary Covers (L), Amazon (truco ISBN-10) y
// Google Books (mayor tamaño). Se miden (sin sharp) y ordenan por ancho desc para premarcar la de más resolución.
export async function portadasPorISBN(isbn13, isbn10, ficheroUrl) {
    const urls = [];
    if (ficheroUrl) urls.push([String(ficheroUrl).replace(/^http:/, 'https:'), 'Fichero']);
    // OpenLibrary Covers: probar 13 Y 10 (distinta disponibilidad por edición).
    for (const x of [isbn13, isbn10]) if (x) urls.push([`https://covers.openlibrary.org/b/isbn/${x}-L.jpg?default=false`, 'OpenLibrary']);
    // Amazon (ISBN-10 = ASIN de libro): CDN ACTUAL (m.media-amazon) + heredado, con «max res» y «grande».
    if (isbn10) {
        urls.push([`https://m.media-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_.jpg`, 'Amazon']);
        urls.push([`https://m.media-amazon.com/images/P/${isbn10}.01.L.jpg`, 'Amazon']);
        urls.push([`https://images-na.ssl-images-amazon.com/images/P/${isbn10}.01._SCLZZZZZZZ_.jpg`, 'Amazon']);
    }
    // OpenLibrary Search por el CAMPO isbn (NO por q=, que es difuso y traía portadas de otros libros que
    // "mencionan" ese número → causa de portadas equivocadas). isbn= empareja EXACTO y devuelve las ediciones
    // con ese ISBN (varias cover_i). Si OL no tiene el ISBN, no devuelve nada (mejor nada que una equivocada).
    for (const x of [isbn13, isbn10]) {
        if (!x) continue;
        try {
            const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 9000);
            const resp = await fetch(`https://openlibrary.org/search.json?isbn=${x}&limit=5&fields=cover_i`, { signal: ctrl.signal });
            clearTimeout(to);
            if (resp.ok) {
                const j = await resp.json();
                for (const d of (j.docs || [])) if (d.cover_i) urls.push([`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`, 'OpenLibrary']);
            }
        } catch { /* OL search opcional */ }
    }
    // Google Books: por 13 y 10, tomando la portada de VARIOS resultados (no solo el primero) → más variedad.
    // Con la clave del proyecto gasta la MISMA cuota diaria que los metadatos: si está agotada no se llama, y si
    // esta consulta la agota se avisa al buscador (el cotejo de portadas corre en una campaña, libro tras libro).
    for (const x of [isbn13, isbn10]) {
        if (!x || !googleBooksConCuota()) continue;
        try {
            const key = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';
            const resp = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${x}${key}`);
            if (resp.status === 429 && /per day|quota/i.test(await resp.text().catch(() => ''))) { marcarGoogleBooksSinCuota(); continue; }
            if (resp.ok) {
                const j = await resp.json();
                for (const it of (j.items || []).slice(0, 5)) {
                    const il = it.volumeInfo && it.volumeInfo.imageLinks;
                    const u = il && (il.extraLarge || il.large || il.medium || il.small || il.thumbnail);
                    if (u) urls.push([u.replace(/^http:/, 'https:').replace(/&edge=curl/, ''), 'Google Books']);
                }
            }
        } catch { /* Google Books opcional */ }
    }
    // Medir EN PARALELO (con tope) y DEDUP por URL y por (dimensiones+bytes) — evita repetir la misma imagen
    // (13 y 10, distintas CDNs, misma edición). Se aceptan portadas pequeñas: mejor una chica que ninguna.
    const urlsUnicas = [...new Map(urls.map(([u, f]) => [u, f])).entries()].slice(0, 18);
    const medidas = await Promise.all(urlsUnicas.map(([u, f]) => medirPortadaRemota(u, f)));
    const out = [], vistos = new Set();
    for (const m of medidas) {
        if (!m) continue;
        const sig = `${m.ancho}x${m.alto}:${m.bytes}`;
        if (vistos.has(sig)) continue;
        vistos.add(sig); out.push(m);
    }
    out.sort((a, b) => b.ancho - a.ancho);
    return out;
}

/**
 * Portada por ISBN lista para GUARDAR (Buffer), reuniendo TODAS las fuentes keyless que ya usa la ingesta
 * (OpenLibrary Covers + búsqueda por cover_i, Amazon por ISBN-10, Google Books en varios tamaños) vía
 * `portadasPorISBN`, que las mide (sin sharp) y ordena por ancho. Se descarga la de MAYOR resolución (con
 * reintento a la siguiente si la primera falla al bajar). `portadasPorISBN` ya descartó el 1x1 «sin portada».
 * Pensado como ÚLTIMO RECURSO de portada cuando el fichero no da cubierta (CHM de solo texto, Word, MOBI con
 * DRM, software/ISO sin fichero). Devuelve un Buffer o null (ISBN inválido o ninguna fuente la tiene).
 */
export async function bufferPortadaPorISBN(isbn) {
    const vs = variantesISBN(isbn);                       // [13, 10] normalizados (o subconjunto); [] si no es válido
    if (!vs.length) return null;
    const isbn13 = vs.find((x) => x.length === 13) || null;
    const isbn10 = vs.find((x) => x.length === 10) || null;
    const candidatas = await portadasPorISBN(isbn13, isbn10).catch(() => []); // ordenadas por ancho desc
    for (const c of candidatas) {
        const img = await descargarImagen(c.url);       // si falla al bajar, la siguiente
        if (img) return img.buf;
    }
    return null;
}

/**
 * Candidatas de portada por TÍTULO + AUTOR, sin clave ni cuota: OpenLibrary Search (varias ediciones) y Apple
 * Books/iTunes (carátula a 600 px). Pueden ser de OTRA edición del mismo libro: sirven para elegir a mano, nunca
 * para ponerlas solas. Medidas, sin repetir y ordenadas por ancho.
 */
export async function portadasPorTitulo(titulo, autor, isbn = '') {
    const cands = [];
    // Apellido del autor («Lynn E. Foster» → «foster»; «Foster, Lynn» → «foster»), para filtrar resultados difusos.
    const nombreAutor = String(autor || '').includes(',') ? String(autor).split(',')[0] : String(autor || '').split(/\s+/).pop();
    const apellido = normalizarNombre(nombreAutor);
    // 1) OpenLibrary Search (título + autor) → id de cubierta de varias ediciones.
    try {
        const p = new URLSearchParams({ limit: '8', fields: 'cover_i' });
        if (titulo) p.set('title', titulo);
        if (autor) p.set('author', autor);
        if (!titulo && isbn) { p.delete('title'); p.set('q', isbn); }
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
        const r1 = await fetch('https://openlibrary.org/search.json?' + p.toString(), { signal: ctrl.signal }); clearTimeout(to);
        if (r1.ok) { const j1 = await r1.json(); for (const d of (j1.docs || [])) if (d.cover_i) cands.push([`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`, 'OpenLibrary']); }
    } catch { /* OL opcional */ }
    // 2) Apple Books / iTunes Search (keyless) → carátula subida a 600 px.
    try {
        const term = [titulo, autor].filter(Boolean).join(' ') || isbn;
        if (term) {
            const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 10000);
            const r2 = await fetch('https://itunes.apple.com/search?media=ebook&limit=8&term=' + encodeURIComponent(term), { signal: ctrl.signal }); clearTimeout(to);
            if (r2.ok) {
                const j2 = await r2.json();
                for (const it of (j2.results || [])) {
                    // La búsqueda de Apple es difusa: para «Nanotechnology: Science, Innovation, and Opportunity» devolvía
                    // seis libros de nanotecnología de otros autores (5-nov). Solo vale el MISMO libro: título que case
                    // y, si se sabe el autor, su apellido entre los autores del resultado.
                    if (titulo && !mismoTituloLibro(titulo, it.trackName || '')) continue;
                    if (apellido && !normalizarNombre(it.artistName).includes(apellido)) continue;
                    const a = it.artworkUrl100 || it.artworkUrl60;
                    if (a) cands.push([a.replace(/\/\d+x\d+bb\.(jpg|png|jpeg)/i, '/600x600bb.$1'), 'Apple Books']);
                }
            }
        }
    } catch { /* Apple opcional */ }
    const medidas = await Promise.all([...new Map(cands).entries()].slice(0, 16).map(([u, f]) => medirPortadaRemota(u, f)));
    const out = [], vistos = new Set();
    for (const m of medidas) {
        if (!m) continue;
        const sig = `${m.ancho}x${m.alto}:${m.bytes}`;
        if (vistos.has(sig)) continue;
        vistos.add(sig); out.push(m);
    }
    out.sort((a, b) => b.ancho - a.ancho);
    return out;
}

/**
 * TODAS las candidatas de portada de un libro, de todas las fuentes: primero las de SU ISBN (Fichero, OpenLibrary,
 * Amazon, Google Books: son de esta edición), luego las de su título y autor (pueden ser de otra edición). Cada una
 * lleva `por: 'isbn' | 'titulo'`. Sin repetir la misma imagen. Hasta `max`.
 */
export async function portadasCandidatas({ isbn = null, titulo = '', autor = '', portadaUrl = null, max = 12 } = {}) {
    const vs = isbn ? variantesISBN(isbn) : [];
    const isbn13 = vs.find((x) => x.length === 13) || null;
    const isbn10 = vs.find((x) => x.length === 10) || null;
    const [porIsbn, porTitulo] = await Promise.all([
        vs.length || portadaUrl ? portadasPorISBN(isbn13, isbn10, portadaUrl).catch(() => []) : [],
        titulo ? portadasPorTitulo(titulo, autor, isbn13 || isbn10 || '').catch(() => []) : [],
    ]);
    const out = [], vistas = new Set();
    for (const [lista, por] of [[porIsbn, 'isbn'], [porTitulo, 'titulo']]) {
        for (const c of lista) {
            const sig = `${c.ancho}x${c.alto}:${c.bytes}`;
            if (vistas.has(c.url) || vistas.has(sig)) continue;
            vistas.add(c.url); vistas.add(sig);
            out.push({ url: c.url, fuente: c.fuente, ancho: c.ancho, alto: c.alto, por });
        }
    }
    return out.slice(0, max);
}
