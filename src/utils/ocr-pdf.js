import { rasterizarPaginas } from './rasterizar-pdf.js';
import { analizarImagenesRecurso } from '../agente.js';

// En un PDF escaneado, título/autor/ISBN viven en las primeras páginas (portadilla, créditos)
// y a veces en la contraportada (código de barras). Rasterizamos las primeras PAGINAS_FRENTE
// y la última, dejamos que la visión las lea, y CONSERVAMOS los renders para guardarlos como
// sidecars. Ancho alto: un ISBN en letra pequeña necesita resolución para ser legible.
const PAGINAS_FRENTE = Number(process.env.PDF_OCR_PAGINAS || 5);
const ANCHO_OCR = Number(process.env.PDF_OCR_ANCHO || 1600);

/**
 * Rasteriza las primeras PAGINAS_FRENTE páginas + la última de un PDF (a alta resolución).
 * Son los sidecars de TODO PDF (preview + OCR de datos/código de barras). Devuelve
 * [{ buffer, pagina, etiqueta }] (la 1ª = 'portada') o [] si no hay poppler / PDF ilegible.
 */
export async function rasterizarFrontalesPdf(ruta, numPaginas = PAGINAS_FRENTE) {
    const n = Math.min(PAGINAS_FRENTE, numPaginas || PAGINAS_FRENTE);
    const paginas = Array.from({ length: n }, (_, i) => i + 1);
    if (numPaginas > PAGINAS_FRENTE) paginas.push(numPaginas); // + contraportada (código de barras)
    return rasterizarPaginas(ruta, { paginas, ancho: ANCHO_OCR });
}

/**
 * Identifica por visión a partir de páginas YA rasterizadas (sin volver a rasterizar). Para PDF
 * escaneado sin capa de texto, cuyo nombre de archivo suele ser basura. Devuelve la ficha o null.
 */
export async function ocrDesdeRenders(renders) {
    if (!renders || !renders.length) return null;
    console.log(`[OCR-PDF] ${renders.length} página(s) → visión para identificar el escaneado.`);
    const imagenes = renders.map(r => ({ data: r.buffer, mimeType: 'image/jpeg' }));
    try {
        return await analizarImagenesRecurso(imagenes);
    } catch {
        return null; // visión caída: el llamante seguirá con el nombre de archivo + APIs
    }
}
