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

// ── COLA de rasterización (evita CUELGUES del NAS) ────────────────────────────────────────────────
// Cada página DjVu lanza DOS procesos nativos PESADOS (ddjvu→PDF + pdftoppm) con una página escaneada
// entera en memoria. El visor del panel pide MUCHAS miniaturas A LA VEZ (el IntersectionObserver dispara
// toda la primera pantalla de golpe) → una docena de ddjvu+pdftoppm simultáneos saturaban CPU/RAM y
// COLGABAN TODO EL NAS (Atom, 2 núcleos, poca RAM). Con esta cola solo se rasterizan DJVU_CONCURRENCIA
// páginas a la vez (por defecto 1): el visor se va rellenando poco a poco, pero el NAS nunca se ahoga.
const DJVU_CONCURRENCIA = Math.max(1, Number(process.env.DJVU_CONCURRENCIA) || 1);
let _enCurso = 0;
const _pendientes = [];
function _adquirir() {
    if (_enCurso < DJVU_CONCURRENCIA) { _enCurso++; return Promise.resolve(); }
    return new Promise(resolver => _pendientes.push(resolver));
}
function _liberar() {
    const siguiente = _pendientes.shift();
    if (siguiente) siguiente();          // cede el turno (mantiene _enCurso)
    else _enCurso--;                     // nadie espera → baja el contador
}
// `estaVivo` (opcional): se comprueba JUSTO ANTES de rasterizar (ya con el turno). Si la petición se
// CANCELÓ mientras esperaba en la cola (p. ej. el usuario cerró la rejilla de miniaturas o añadió su
// página), NO se rasteriza — así no se malgasta el Atom renderizando páginas que ya nadie quiere ver.
async function enCola(fn, estaVivo) {
    await _adquirir();
    try {
        if (estaVivo && !estaVivo()) return null;   // cancelada mientras hacía cola → se salta
        return await fn();
    } finally { _liberar(); }
}

// ── CACHÉ en memoria de páginas ya rasterizadas ───────────────────────────────────────────────────
// Clave: ruta|mtime|página|dpi. Re-ver o RE-SELECCIONAR una página es INSTANTÁNEO (sin cola ni procesos):
// atajo directo que descarga el Atom. LRU acotada por nº de entradas (una página a 72 dpi ~30 KB, a 150 ~300 KB).
const CACHE_MAX = Math.max(20, Number(process.env.DJVU_CACHE_PAGINAS) || 300);
const _cache = new Map();
function _cacheGet(clave) { const v = _cache.get(clave); if (v) { _cache.delete(clave); _cache.set(clave, v); } return v; }
function _cacheSet(clave, buf) { _cache.set(clave, buf); while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value); }

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

/**
 * Rasteriza la página `n1` (1-indexada) de un DjVu a JPEG: ddjvu→PDF de 1 página → pdftoppm→JPEG.
 * SIEMPRE a través de la COLA (`enCola`): impide que varias rasterizaciones simultáneas cuelguen el NAS.
 * `dpi` = resolución del pdftoppm (150 para la imagen definitiva; ~72 para miniaturas de la rejilla, ~4×
 * más rápido y ligero). Se acota para no disparar el coste en el Atom.
 */
async function paginaDjvuJpeg(ruta, n1, dpi = 150, estaVivo) {
    const r = Math.max(36, Math.min(200, Number(dpi) || 150));
    let mtime = 0; try { mtime = (await fs.stat(ruta)).mtimeMs; } catch { /* sin stat → clave sin mtime */ }
    const clave = `${ruta}|${mtime}|${n1}|${r}`;
    const cacheado = _cacheGet(clave);
    if (cacheado) return cacheado;                       // atajo instantáneo (sin cola ni procesos)
    return enCola(async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'djvu-pg-'));
        try {
            const pdf = path.join(dir, 'p.pdf');
            await execFileP('ddjvu', ['-format=pdf', `-page=${n1}`, ruta, pdf], { timeout: 120000 });
            await execFileP('pdftoppm', ['-jpeg', '-r', String(r), '-singlefile', pdf, path.join(dir, 'out')], { timeout: 120000 });
            const buf = await fs.readFile(path.join(dir, 'out.jpg'));
            _cacheSet(clave, buf);
            return buf;
        } finally {
            await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        }
    }, estaVivo);
}

/**
 * Página `n0` (0-indexada) de un DjVu como { buffer, mimeType }, o null si no se pudo (o se canceló). (Visor.)
 * `dpi` opcional: el visor pide las MINIATURAS a baja resolución (rápidas) y la imagen a añadir a 150.
 * `estaVivo` opcional: función que devuelve false si la petición se canceló (para no rasterizar de balde).
 */
export async function leerPaginaDjvu(ruta, n0, dpi = 150, estaVivo) {
    try {
        const buf = await paginaDjvuJpeg(ruta, n0 + 1, dpi, estaVivo);
        return buf ? { buffer: buf, mimeType: 'image/jpeg' } : null;
    } catch { return null; }
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
