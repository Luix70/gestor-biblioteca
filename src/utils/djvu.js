/**
 * DjVu — páginas a imagen, BAJO DEMANDA (una por petición), tanto para la VISIÓN al ingerir como para el
 * visor del panel. Se rasteriza cada página con `ddjvu` (djvulibre-bin) → PDF de 1 página → `pdftoppm`
 * → JPEG (ambas herramientas ya instaladas, C nativo apto para el Atom).
 *
 * NO se convierte el documento ENTERO a PDF: para un libro escaneado de cientos de páginas eso es lento
 * y pesado (y fallaba). Página a página es instantáneo y barato: 1 página por petición del visor.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const execFileP = promisify(execFile);

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
export async function contarPaginasDjvu(ruta) {
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

/** Página `n0` (0-indexada) de un DjVu como { buffer, mimeType }, o null si no se pudo. (Para el visor.) */
export async function leerPaginaDjvu(ruta, n0) {
    try { return { buffer: await paginaDjvuJpeg(ruta, n0 + 1), mimeType: 'image/jpeg' }; }
    catch { return null; }
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
