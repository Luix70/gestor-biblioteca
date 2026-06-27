/**
 * Servidor de PÁGINAS de un cómic para la PREVISUALIZACIÓN del panel (como el visor de PDF/EPUB, pero las
 * páginas son imágenes dentro del comprimido):
 *   · .cbz (ZIP) → adm-zip (en memoria, sin dependencias de sistema),
 *   · .cbr (RAR/RAR5) / .cb7 (7z) → bsdtar (→unar de respaldo) (extrae UNA vez a un tmp y lo CACHEA).
 *
 * Una CACHÉ en memoria (por ruta de archivo) evita re-leer/re-extraer en cada página; se PODA por TTL
 * (COMIC_CACHE_TTL_MS) en cada acceso, borrando los tmp. El visor pagina bajo demanda, así que el coste
 * en el Atom es 1 lectura de imagen por página vista (despreciable frente a la ingesta).
 */
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { extraerArchivoComic } from './extraer-archivo.js';

const ES_IMG = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ORDEN = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const mimeDe = (n) => MIME[path.extname(n).toLowerCase()] || 'image/jpeg';
const TTL = Number(process.env.COMIC_CACHE_TTL_MS || 20 * 60 * 1000);

// Caché: ruta de archivo → { tipo, ts, zip?, entradas?, dir?, files? }
const cache = new Map();

async function podar() {
    const ahora = Date.now();
    for (const [k, v] of cache) {
        if (ahora - v.ts <= TTL) continue;
        cache.delete(k);
        if (v.dir) await fs.rm(v.dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Lista (recursiva) de imágenes bajo `dir`, en orden natural. */
async function listarImagenes(dir) {
    const out = [];
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entradas) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await listarImagenes(p));
        else if (ES_IMG.test(e.name)) out.push(p);
    }
    return out.sort(ORDEN);
}

/** Prepara (y cachea) el acceso a las páginas de un cómic. Devuelve la entrada de caché o lanza. */
async function preparar(ruta) {
    await podar();
    const ya = cache.get(ruta);
    if (ya) { ya.ts = Date.now(); return ya; }

    const ext = path.extname(ruta).toLowerCase();
    let entrada;
    if (ext === '.cbz') {
        const zip = new AdmZip(ruta);
        const entradas = zip.getEntries()
            .filter(e => !e.isDirectory && ES_IMG.test(e.entryName))
            .sort((a, b) => ORDEN(a.entryName, b.entryName));
        entrada = { tipo: 'cbz', zip, entradas };
    } else {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'comic-prev-'));
        await extraerArchivoComic(ruta, dir);
        const files = await listarImagenes(dir);
        entrada = { tipo: 'arch', dir, files };
    }
    entrada.ts = Date.now();
    cache.set(ruta, entrada);
    return entrada;
}

/** Nº de páginas (imágenes) de un cómic. 0 si no se puede abrir. */
export async function contarPaginasComic(ruta) {
    try {
        const e = await preparar(ruta);
        return e.tipo === 'cbz' ? e.entradas.length : e.files.length;
    } catch { return 0; }
}

/** Página `n` (0-indexada) de un cómic como { buffer, mimeType }, o null si no existe. */
export async function leerPaginaComic(ruta, n) {
    const e = await preparar(ruta);
    if (e.tipo === 'cbz') {
        const ent = e.entradas[n];
        if (!ent) return null;
        return { buffer: ent.getData(), mimeType: mimeDe(ent.entryName) };
    }
    const f = e.files[n];
    if (!f) return null;
    return { buffer: await fs.readFile(f), mimeType: mimeDe(f) };
}
