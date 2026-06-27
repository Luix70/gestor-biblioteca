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
