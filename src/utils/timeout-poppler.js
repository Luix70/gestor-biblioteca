import fs from 'node:fs/promises';

/**
 * TIMEOUT ADAPTATIVO al tamaño del fichero para las llamadas a poppler (pdfinfo/pdftotext/pdftoppm).
 *
 * Cada invocación de poppler RELEE el PDF entero desde disco. Un timeout FIJO (los 30/60 s de antes) se
 * quedaba corto con un PDF de cientos de MB en el Atom: poppler no llegaba ni a leer el fichero → agotaba
 * el timeout → un PDF PERFECTAMENTE VÁLIDO se declaraba «ilegible» y acababa en Cuarentena. Escalamos el
 * timeout con el tamaño: `base + porMB·MB`, acotado a `[base, max]`. Configurable por .env:
 *   PDF_TIMEOUT_BASE_MS (45 s) · PDF_TIMEOUT_POR_MB (700 ms/MB) · PDF_TIMEOUT_MAX_MS (240 s).
 * Ej.: 5 MB → 45 s · 177 MB → ~168 s · 500 MB → 240 s (tope). Un fichero pequeño roto sigue fallando rápido.
 */
const T_BASE = Number(process.env.PDF_TIMEOUT_BASE_MS) || 45000;
const T_POR_MB = Number(process.env.PDF_TIMEOUT_POR_MB) || 700;
const T_MAX = Number(process.env.PDF_TIMEOUT_MAX_MS) || 240000;

export async function timeoutPoppler(ruta) {
    let mb = 0;
    try { mb = (await fs.stat(ruta)).size / 1048576; } catch { /* sin stat → timeout base */ }
    return Math.min(T_MAX, Math.max(T_BASE, Math.round(T_BASE + mb * T_POR_MB)));
}
