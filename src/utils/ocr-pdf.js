import { rasterizarPaginas } from './rasterizar-pdf.js';
import { analizarImagenesRecurso } from '../agente.js';

// En un PDF escaneado, título/autor/ISBN viven en las primeras páginas (portadilla, créditos)
// y a veces en la contraportada (código de barras). Rasterizamos esas y dejamos que la visión
// las lea. Ancho alto: un ISBN en letra pequeña necesita resolución para ser legible.
const PAGINAS_FRENTE = Number(process.env.PDF_OCR_PAGINAS || 6);
const ANCHO_OCR = Number(process.env.PDF_OCR_ANCHO || 1600);

/**
 * Identifica un PDF escaneado por OCR de visión sobre sus páginas frontales (+ contraportada).
 * Es la única fuente fiable cuando no hay capa de texto y el nombre del archivo es basura.
 *
 * @returns metadatos de la visión { titulo, autores, isbn, editorial, ... } o null si no fue
 *          posible (sin poppler, sin visión, o sin nada legible).
 */
export async function ocrPdfEscaneado(ruta, numPaginas = PAGINAS_FRENTE) {
    const n = Math.min(PAGINAS_FRENTE, numPaginas || PAGINAS_FRENTE);
    const paginas = Array.from({ length: n }, (_, i) => i + 1);
    if (numPaginas > PAGINAS_FRENTE) paginas.push(numPaginas); // + contraportada (código de barras)

    const renders = await rasterizarPaginas(ruta, { paginas, ancho: ANCHO_OCR });
    if (!renders.length) return null; // sin poppler o PDF ilegible

    console.log(`[OCR-PDF] ${renders.length} página(s) rasterizada(s) → visión para identificar el escaneado.`);
    const imagenes = renders.map(r => ({ data: r.buffer, mimeType: 'image/jpeg' }));
    try {
        return await analizarImagenesRecurso(imagenes);
    } catch {
        return null; // visión caída: el llamante seguirá con el nombre de archivo + APIs
    }
}
