/**
 * DjVu → PDF para la PREVISUALIZACIÓN del panel. En vez de un visor DjVu propio (no hay librería JS libre
 * apta para el Atom), se convierte el .djvu a PDF con `ddjvu` (paquete djvulibre-bin, C plano, sin SIMD →
 * apto para el Atom, como poppler) y se reutiliza el visor de PDF (pdf.js) que ya tiene el panel.
 *
 * La conversión se CACHEA por archivo (TTL DJVU_CACHE_TTL_MS) en un tmp efímero; se poda en cada acceso.
 * Es una acción a demanda del usuario (abrir la ficha), no del pipeline: el coste puntual es aceptable.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileP = promisify(execFile);
const TTL = Number(process.env.DJVU_CACHE_TTL_MS || 30 * 60 * 1000);
const cache = new Map(); // ruta → { pdf, dir, ts }

async function podar() {
    const ahora = Date.now();
    for (const [k, v] of cache) {
        if (ahora - v.ts <= TTL) continue;
        cache.delete(k);
        await fs.rm(v.dir, { recursive: true, force: true }).catch(() => {});
    }
}

// ── Páginas de MUESTRA para la VISIÓN (igual que un cómic/PDF): 5 primeras + última ──────────────
const PAG_FRENTE = Number(process.env.DJVU_PAGINAS_FRENTE || 5);
const PAG_FONDO  = Number(process.env.DJVU_PAGINAS_FONDO  || 1);

function indicesMuestra(n) {
    const s = new Set();
    for (let i = 0; i < Math.min(PAG_FRENTE, n); i++) s.add(i);
    for (let i = Math.max(0, n - PAG_FONDO); i < n; i++) s.add(i);
    return [...s].sort((a, b) => a - b);
}

/** Nº de páginas de un DjVu (djvused). 0 si no se puede leer. */
async function contarPaginasDjvu(ruta) {
    try {
        const { stdout } = await execFileP('djvused', ['-e', 'n', ruta], { timeout: 30000 });
        const n = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
        return n > 0 ? n : 0;
    } catch { return 0; }
}

/** Rasteriza la página `n1` (1-indexada) de un DjVu a JPEG: ddjvu→PDF de 1 página → pdftoppm→JPEG. */
async function paginaDjvuJpeg(ruta, n1) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'djvu-pg-'));
    try {
        const pdf = path.join(dir, 'p.pdf');
        await execFileP('ddjvu', ['-format=pdf', `-page=${n1}`, ruta, pdf], { timeout: 120000 });
        await execFileP('pdftoppm', ['-jpeg', '-r', '150', '-singlefile', pdf, path.join(dir, 'out')], { timeout: 120000 });
        return await fs.readFile(path.join(dir, 'out.jpg'));
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Páginas de MUESTRA de un DjVu (5 primeras + última) como JPEG base64, para mandarlas a la visión
 * (código de barras / ISBN / ISSN). Devuelve { paginas, cubierta_base64, muestra } — análogo a leerCbz.
 */
export async function paginasMuestraDjvu(ruta) {
    const total = await contarPaginasDjvu(ruta);
    if (!total) return { paginas: 0, muestra: [] };
    const muestra = [];
    for (const i of indicesMuestra(total)) {
        try { muestra.push({ base64: (await paginaDjvuJpeg(ruta, i + 1)).toString('base64'), mimeType: 'image/jpeg' }); }
        catch { /* una página suelta ilegible no aborta el resto */ }
    }
    return { paginas: total, cubierta_base64: muestra[0]?.base64 || null, muestra };
}

/** Convierte (y cachea) un .djvu a PDF; devuelve la ruta absoluta del PDF. */
export async function djvuAPdf(ruta) {
    await podar();
    const ya = cache.get(ruta);
    if (ya) { try { await fs.access(ya.pdf); ya.ts = Date.now(); return ya.pdf; } catch { cache.delete(ruta); } }

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'djvu-'));
    const pdf = path.join(dir, 'doc.pdf');
    await execFileP('ddjvu', ['-format=pdf', ruta, pdf], { timeout: 600000 });
    cache.set(ruta, { pdf, dir, ts: Date.now() });
    return pdf;
}
