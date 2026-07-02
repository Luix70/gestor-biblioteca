import { medirImagen } from './medir-imagen.js';

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
    for (const x of [isbn13, isbn10]) {
        if (!x) continue;
        try {
            const key = process.env.GOOGLE_BOOKS_API_KEY ? `&key=${process.env.GOOGLE_BOOKS_API_KEY}` : '';
            const resp = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${x}${key}`);
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
