import { rasterizarPaginas } from './rasterizar-pdf.js';
import { analizarImagenesRecurso } from '../agente.js';

// En un PDF escaneado, título/autor/ISBN viven en las primeras páginas (portadilla, créditos)
// y a veces en la contraportada (código de barras). Rasterizamos las primeras PAGINAS_FRENTE
// y la última, dejamos que la visión las lea, y CONSERVAMOS los renders para guardarlos como
// sidecars. Ancho alto: un ISBN en letra pequeña necesita resolución para ser legible.
const PAGINAS_FRENTE = Number(process.env.PDF_OCR_PAGINAS || 5);
const ANCHO_OCR = Number(process.env.PDF_OCR_ANCHO || 1600);

/**
 * Identifica un PDF escaneado por OCR de visión sobre sus primeras 5 páginas + la última.
 * Es la única fuente fiable cuando no hay capa de texto y el nombre del archivo es basura.
 *
 * @returns { datos, renders } — 'datos' = ficha de la visión (o null si no concluyó) y
 *          'renders' = [{ buffer, pagina, etiqueta }] de las páginas rasterizadas (para
 *          guardarlas como sidecars). Devuelve null solo si no se pudo rasterizar nada
 *          (sin poppler o PDF ilegible) → el llamante seguirá con el nombre de archivo.
 */
export async function ocrPdfEscaneado(ruta, numPaginas = PAGINAS_FRENTE) {
    const n = Math.min(PAGINAS_FRENTE, numPaginas || PAGINAS_FRENTE);
    const paginas = Array.from({ length: n }, (_, i) => i + 1);
    if (numPaginas > PAGINAS_FRENTE) paginas.push(numPaginas); // + contraportada (código de barras)

    const renders = await rasterizarPaginas(ruta, { paginas, ancho: ANCHO_OCR });
    if (!renders.length) return null; // sin poppler o PDF ilegible

    console.log(`[OCR-PDF] ${renders.length} página(s) rasterizada(s) → visión para identificar el escaneado.`);
    const imagenes = renders.map(r => ({ data: r.buffer, mimeType: 'image/jpeg' }));
    let datos = null;
    try {
        datos = await analizarImagenesRecurso(imagenes);
    } catch {
        datos = null; // visión caída: aún devolvemos los renders para conservarlos como sidecars
    }
    return { datos, renders };
}
