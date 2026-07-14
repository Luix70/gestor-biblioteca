import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { timeoutPoppler } from './timeout-poppler.js';

const execFileP = promisify(execFile);

// Ancho objetivo del rasterizado. pdftoppm (poppler) es un rasterizador CPU portátil que
// detecta las instrucciones del procesador en tiempo de ejecución (pixman cae a SSE2/SSSE3),
// así que funciona en el Atom D525 — al contrario que sharp/libvips (SIMD AVX en un .node).
const ANCHO = Number(process.env.PDF_RASTER_ANCHO || 1024);

// Errores de poppler que indican que el PDF ENTERO es ilegible (xref dañado, sin árbol de
// páginas…), no que falle una página suelta: ante esto no tiene sentido probar más páginas.
const PDF_ILEGIBLE = /pages object is wrong type|xref\b.*not found|after the last page \(0\)|May not be a PDF|Couldn't read xref|Document stream is empty/i;

// Páginas clave: las 2 primeras (portada/portadilla) y la última (contraportada).
function paginasObjetivo(numPaginas) {
    const set = new Set([1]);
    if (numPaginas >= 2) set.add(2);
    if (numPaginas >= 1) set.add(numPaginas);
    return [...set].sort((a, b) => a - b);
}

// Agrupa una lista de páginas en TRAMOS contiguos [desde, hasta]. Rasterizar cada tramo en UNA sola llamada
// a pdftoppm ahorra RELECTURAS del PDF: en un PDF grande NO-linealizado (Acrobat sin «fast web view»),
// poppler relee el fichero ENTERO en CADA invocación, así que rasterizar 6 páginas por separado = 6 lecturas
// de 177 MB (~50 s cada una en el Atom → timeouts). Por tramos: frontales [1..5] en 1 lectura + contraportada.
function tramosContiguos(paginas) {
    const orden = [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b);
    const tramos = [];
    for (const p of orden) {
        const ultimo = tramos[tramos.length - 1];
        if (ultimo && p === ultimo[1] + 1) ultimo[1] = p;
        else tramos.push([p, p]);
    }
    return tramos;
}

// Rasteriza el tramo [desde, hasta] a JPEG en `dir` con UNA llamada a pdftoppm. pdftoppm nombra la salida
// `<prefijo>-NNNN.jpg` (NNNN = nº de página relleno con ceros al ancho del TOTAL de páginas del documento,
// que no conocemos aquí) → se GLOBEA el directorio y se mapea por el número del nombre. Devuelve
// [{ pagina, buffer }] ordenado. Lanza (para que el caller distinga ENOENT/ilegible/timeout).
async function rasterizarTramo(ruta, desde, hasta, dir, ancho, timeout, idx) {
    const prefijo = path.join(dir, `t${idx}`);
    await execFileP('pdftoppm', [
        '-jpeg', '-f', String(desde), '-l', String(hasta),
        '-scale-to-x', String(ancho), '-scale-to-y', '-1',
        ruta, prefijo,
    ], { timeout: timeout || 60000 });
    const nombres = (await fs.readdir(dir)).filter(n => n.startsWith(`t${idx}-`) && n.endsWith('.jpg'));
    const paginas = [];
    for (const n of nombres) {
        const m = n.match(/-(\d+)\.jpg$/);
        if (m) paginas.push({ pagina: parseInt(m[1], 10), buffer: await fs.readFile(path.join(dir, n)) });
    }
    return paginas.sort((a, b) => a.pagina - b.pagina);
}

/**
 * Rasteriza páginas de un PDF a JPEG con poppler/pdftoppm.
 *   - { numPaginas }      → páginas clave para portada (1, 2 y la última).
 *   - { paginas: [..] }   → lista explícita (p. ej. la portadilla/créditos para OCR).
 *   - { ancho }           → ancho objetivo en px (1024 portada; más alto para OCR legible).
 * Devuelve [{ buffer, pagina, etiqueta }] (la 1ª = 'portada'). Rasteriza por TRAMOS contiguos (menos
 * relecturas del PDF). Si pdftoppm no está instalado (ENOENT) o el PDF está dañado, devuelve lo que pudo
 * (posiblemente []) → degradación elegante.
 */
export async function rasterizarPaginas(ruta, { numPaginas = 2, paginas = null, ancho = ANCHO } = {}) {
    const objetivo = (paginas && paginas.length)
        ? [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b)
        : paginasObjetivo(numPaginas);
    const total = objetivo.length ? Math.max(...objetivo) : numPaginas;
    let dir;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raster-'));
    } catch {
        return [];
    }

    // Timeout ADAPTATIVO al tamaño (se calcula UNA vez): en el Atom, un PDF de cientos de MB no se rasteriza
    // en 60 s → antes daba renders=[] y el PDF (válido) acababa declarado ilegible.
    const to = await timeoutPoppler(ruta);
    const salida = [];
    try {
        let idx = 0;
        for (const [desde, hasta] of tramosContiguos(objetivo)) {
            try {
                for (const { pagina, buffer } of await rasterizarTramo(ruta, desde, hasta, dir, ancho, to, idx++)) {
                    const etiqueta = pagina === 1 ? 'portada' : (pagina === total ? 'contraportada' : `pagina-${pagina}`);
                    salida.push({ buffer, pagina, etiqueta });
                }
            } catch (e) {
                if (e.code === 'ENOENT') {
                    console.warn('[Raster] pdftoppm (poppler-utils) no disponible: se omite el rasterizado del PDF.');
                    break;
                }
                if (PDF_ILEGIBLE.test(e.message || '') || PDF_ILEGIBLE.test(e.stderr || '')) {
                    console.warn(`[Raster] PDF ilegible (estructura dañada, p. ej. xref): se omite el rasterizado de "${path.basename(ruta)}". Requiere una copia mejor.`);
                    break;
                }
                // Timeout (proceso matado) o error del tramo: DIAGNÓSTICO explícito (para verlo en los logs del
                // NAS) y se sigue con el resto de tramos (otro puede salir bien).
                const motivo = e.killed ? `TIMEOUT tras ${to} ms` : ((e.stderr || e.message || '').split('\n')[0] || 'error');
                console.warn(`[Raster] tramo ${desde}-${hasta} de "${path.basename(ruta)}" no rasterizado: ${motivo}.`);
            }
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return salida.sort((a, b) => a.pagina - b.pagina);
}

/**
 * ¿Es un PDF de IMÁGENES (escaneo), aunque traiga capa de texto OCR? Adobe Scan / CamScanner / Lens…
 * generan PDFs que SON fotos de páginas con una capa de texto OCR encima → `texto_legible` da true y
 * se colaban como "PDF digital". Señales (poppler, C, sin SIMD → apto para el Atom):
 *   1) Productor/creador = app de escaneo conocida.
 *   2) pdffonts: sin fuentes reales — solo la invisible "GlyphLessFont" del OCR (Tesseract/Adobe), o ninguna.
 * Devuelve true si parece escaneo. Degrada a false si no hay pdfinfo/pdffonts.
 */
const APPS_ESCANEO = /adobe scan|camscanner|office lens|microsoft lens|genius scan|scanbot|swiftscan|tiny scanner|tapscanner|clear ?scanner|fast scanner|notebloc|photomyne|simple scan|naps2|vflat/i;
export async function pdfEsImagen(ruta) {
    const to = await timeoutPoppler(ruta);   // adaptativo: un PDF grande no cabe en 15 s en el Atom
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: to });
        if (APPS_ESCANEO.test(stdout)) return true;
    } catch { /* sin pdfinfo o PDF raro */ }
    try {
        const { stdout } = await execFileP('pdffonts', [ruta], { timeout: to });
        const filas = stdout.split('\n').slice(2).filter(l => l.trim()); // saltar las 2 líneas de cabecera
        if (filas.length === 0) return true;                              // sin fuentes → página = imagen
        if (filas.every(l => /glyphlessfont/i.test(l))) return true;      // solo la fuente invisible del OCR
    } catch { /* sin pdffonts (poppler) → no se puede afinar; se queda en false */ }
    return false;
}

/**
 * Tamaño de la 1ª página en puntos (1/72") vía pdfinfo. Sirve para calcular recortes a una resolución
 * conocida. Devuelve { anchoPts, altoPts } o null (sin pdfinfo / PDF ilegible) → degradación elegante.
 */
export async function tamanoPagina(ruta) {
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: await timeoutPoppler(ruta) });
        const m = stdout.match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i);
        if (m) return { anchoPts: parseFloat(m[1]), altoPts: parseFloat(m[2]) };
    } catch { /* sin pdfinfo o PDF ilegible */ }
    return null;
}

/**
 * Rasteriza UN RECORTE de una página a JPEG con poppler (pdftoppm -r DPI -x -y -W -H, todo en C → barato
 * en CPU, sin SIMD; apto para el Atom). Coordenadas en el espacio de píxeles del DPI dado. Devuelve el
 * buffer JPEG o null. Se usa para enfocar el CÓDIGO DE BARRAS de la cubierta antes de pasarlo a la visión.
 */
export async function rasterizarRecorte(ruta, pagina, { dpi, x, y, w, h }) {
    let dir;
    try { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-')); } catch { return null; }
    const prefijo = path.join(dir, `crop-${pagina}`);
    try {
        await execFileP('pdftoppm', [
            '-jpeg', '-singlefile', '-f', String(pagina), '-l', String(pagina),
            '-r', String(Math.round(dpi)),
            '-x', String(Math.max(0, Math.round(x))), '-y', String(Math.max(0, Math.round(y))),
            '-W', String(Math.max(1, Math.round(w))), '-H', String(Math.max(1, Math.round(h))),
            ruta, prefijo,
        ], { timeout: await timeoutPoppler(ruta) });
        return await fs.readFile(`${prefijo}.jpg`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[Raster] recorte p${pagina} no generado: ${e.message}`);
        return null;
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
