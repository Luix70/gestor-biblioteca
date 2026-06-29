import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

async function rasterizarUna(ruta, pagina, dir, ancho) {
    const prefijo = path.join(dir, `pag-${pagina}`);
    await execFileP('pdftoppm', [
        '-jpeg', '-singlefile',
        '-f', String(pagina), '-l', String(pagina),
        '-scale-to-x', String(ancho), '-scale-to-y', '-1',
        ruta, prefijo,
    ], { timeout: 60000 });
    return fs.readFile(`${prefijo}.jpg`);
}

/**
 * Rasteriza páginas de un PDF a JPEG con poppler/pdftoppm.
 *   - { numPaginas }      → páginas clave para portada (1, 2 y la última).
 *   - { paginas: [..] }   → lista explícita (p. ej. la portadilla/créditos para OCR).
 *   - { ancho }           → ancho objetivo en px (1024 portada; más alto para OCR legible).
 * Devuelve [{ buffer, pagina, etiqueta }] (la 1ª = 'portada'). Si pdftoppm no está instalado
 * (ENOENT, p. ej. en desarrollo local) o algo falla, devuelve [] → degradación elegante.
 */
export async function rasterizarPaginas(ruta, { numPaginas = 2, paginas = null, ancho = ANCHO } = {}) {
    const total = paginas && paginas.length ? Math.max(...paginas) : numPaginas;
    const objetivo = (paginas && paginas.length)
        ? [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b)
        : paginasObjetivo(numPaginas);
    let dir;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raster-'));
    } catch {
        return [];
    }

    const salida = [];
    try {
        for (const p of objetivo) {
            try {
                const buffer = await rasterizarUna(ruta, p, dir, ancho);
                const etiqueta = p === 1 ? 'portada' : (p === total ? 'contraportada' : `pagina-${p}`);
                salida.push({ buffer, pagina: p, etiqueta });
            } catch (e) {
                if (e.code === 'ENOENT') {
                    console.warn('[Raster] pdftoppm (poppler-utils) no disponible: se omite el rasterizado del PDF.');
                    break;
                }
                if (PDF_ILEGIBLE.test(e.message || '')) {
                    // El PDF está estructuralmente dañado: las demás páginas fallarían igual.
                    console.warn(`[Raster] PDF ilegible (estructura dañada, p. ej. xref): se omite el rasterizado de "${path.basename(ruta)}". Requiere una copia mejor.`);
                    break;
                }
                console.warn(`[Raster] página ${p} no rasterizada: ${e.message}`);
            }
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return salida;
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
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: 15000 });
        if (APPS_ESCANEO.test(stdout)) return true;
    } catch { /* sin pdfinfo o PDF raro */ }
    try {
        const { stdout } = await execFileP('pdffonts', [ruta], { timeout: 15000 });
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
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: 30000 });
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
        ], { timeout: 60000 });
        return await fs.readFile(`${prefijo}.jpg`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[Raster] recorte p${pagina} no generado: ${e.message}`);
        return null;
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
