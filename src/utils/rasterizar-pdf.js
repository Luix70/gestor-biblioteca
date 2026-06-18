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

// Páginas clave: las 2 primeras (portada/portadilla) y la última (contraportada).
function paginasObjetivo(numPaginas) {
    const set = new Set([1]);
    if (numPaginas >= 2) set.add(2);
    if (numPaginas >= 1) set.add(numPaginas);
    return [...set].sort((a, b) => a - b);
}

async function rasterizarUna(ruta, pagina, dir) {
    const prefijo = path.join(dir, `pag-${pagina}`);
    await execFileP('pdftoppm', [
        '-jpeg', '-singlefile',
        '-f', String(pagina), '-l', String(pagina),
        '-scale-to-x', String(ANCHO), '-scale-to-y', '-1',
        ruta, prefijo,
    ], { timeout: 60000 });
    return fs.readFile(`${prefijo}.jpg`);
}

/**
 * Rasteriza páginas clave de un PDF a JPEG (~ANCHO px de ancho) con poppler/pdftoppm.
 * Devuelve [{ buffer, pagina, etiqueta }] (la 1ª = 'portada'). Si pdftoppm no está instalado
 * (ENOENT, p. ej. en desarrollo local) o algo falla, devuelve [] → degradación elegante: se
 * usará una portada remota.
 */
export async function rasterizarPaginas(ruta, { numPaginas = 2 } = {}) {
    const paginas = paginasObjetivo(numPaginas);
    let dir;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raster-'));
    } catch {
        return [];
    }

    const salida = [];
    try {
        for (const p of paginas) {
            try {
                const buffer = await rasterizarUna(ruta, p, dir);
                const etiqueta = p === 1 ? 'portada' : (p === numPaginas ? 'contraportada' : `pagina-${p}`);
                salida.push({ buffer, pagina: p, etiqueta });
            } catch (e) {
                if (e.code === 'ENOENT') {
                    console.warn('[Raster] pdftoppm (poppler-utils) no disponible: se omite el rasterizado del PDF.');
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
