import { rasterizarSignificativas } from './rasterizar-pdf.js';
import { analizarImagenesRecurso } from '../agente.js';

// En un PDF escaneado, título/autor/ISBN viven en las primeras páginas (portadilla, créditos)
// y a veces en la contraportada (código de barras). Rasterizamos las primeras PAGINAS_FRENTE
// y la última, dejamos que la visión las lea, y CONSERVAMOS los renders para guardarlos como
// sidecars. Ancho alto: un ISBN en letra pequeña necesita resolución para ser legible.
const PAGINAS_FRENTE = Number(process.env.PDF_OCR_PAGINAS || 5);
const ANCHO_OCR = Number(process.env.PDF_OCR_ANCHO || 1600);

/**
 * Rasteriza las primeras PAGINAS_FRENTE páginas SIGNIFICATIVAS + la última de un PDF (a alta resolución).
 * Son los sidecars de TODO PDF (preview + OCR de datos/código de barras). Las páginas EN BLANCO (o «This page
 * is intentionally left blank») se SALTAN: se sondea una ventana un poco mayor y se cogen las que llevan tinta
 * hasta completar el 5+1 (`rasterizarSignificativas`). Devuelve [{ buffer, pagina, etiqueta }] (la 1ª =
 * 'portada') o [] si no hay poppler / PDF ilegible.
 */
export async function rasterizarFrontalesPdf(ruta, numPaginas = PAGINAS_FRENTE) {
    return rasterizarSignificativas(ruta, {
        frente: PAGINAS_FRENTE,
        incluirUltima: true,
        ancho: ANCHO_OCR,
        numPaginas: numPaginas || PAGINAS_FRENTE,
    });
}

/**
 * Identifica por visión a partir de páginas YA rasterizadas (sin volver a rasterizar). Para PDF
 * escaneado sin capa de texto, cuyo nombre de archivo suele ser basura. Devuelve la ficha o null.
 */
export async function ocrDesdeRenders(renders) {
    if (!renders || !renders.length) return null;
    console.log(`[PDF escaneado] ${renders.length} página(s) → IA/visión para identificar (sin capa de texto; NO es OCR de texto).`);
    const imagenes = renders.map(r => ({ data: r.buffer, mimeType: 'image/jpeg' }));
    try {
        return await analizarImagenesRecurso(imagenes);
    } catch {
        return null; // visión caída: el llamante seguirá con el nombre de archivo + APIs
    }
}
