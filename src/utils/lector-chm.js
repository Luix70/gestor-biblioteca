/**
 * Lector de CHM (Microsoft Compiled HTML Help) — un empaquetado de HTML+imágenes muy común para MANUALES y
 * LIBROS técnicos. Extrae el contenido con `extract_chmLib` (paquete libchm-bin: C nativo, libre, apto para
 * el Atom) a un directorio temporal y deduce los metadatos SIN IA:
 *   · título  → del proyecto .hhp (línea `Title=`) → primer <title> de los HTML → (si nada, lo pone el nombre);
 *   · ISBN    → escaneando el texto de los primeros HTML (pista/pivote barato para el enriquecimiento);
 *   · ISSN    → ídem (por si es un manual serializado);
 *   · portada → una imagen llamada «cover/portada/front», o la imagen JPG/PNG más grande del paquete.
 *
 * DEGRADA CON ELEGANCIA: si falta `extract_chmLib` (libchm-bin no instalado) o el CHM está corrupto, LANZA;
 * el orquestador lo captura y cataloga el documento por su nombre (como cualquier «otro-formato»). Nunca
 * rompe la ingesta.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { validarISBN, extraerISSNs } from './identificadores.js';

const execFileP = promisify(execFile);

const MAX_HTML_ESCANEO = 40;    // nº máximo de HTML a inspeccionar (un CHM puede tener cientos de temas)
const MAX_BYTES_HTML = 400000;  // no leer enteros los HTML gigantes (basta el principio para título/ISBN)
// Igual que en lector-pdf: captura candidatos a ISBN; validarISBN filtra los que tienen checksum válido.
const RE_ISBN = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])/g;

// Decodifica las entidades HTML más comunes de un título (sin cargar un parser entero para una línea).
function decodificarEntidades(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

/** Extrae TODO el contenido del CHM a `destino` con libchm-bin. Lanza si la herramienta no está o falla. */
async function extraerChm(ruta, destino) {
    await execFileP('extract_chmLib', [ruta, destino], { timeout: 120000 });
}

/** Lista recursiva de ficheros (rutas absolutas) bajo `dir`. */
async function listarFicheros(dir) {
    const out = [];
    async function rec(d) {
        let entradas;
        try { entradas = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await rec(p);
            else out.push(p);
        }
    }
    await rec(dir);
    return out;
}

const MIME_IMG = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp' };

/**
 * Lee un CHM → { titulo, isbn, isbn_candidatos, issn, portada:{buf,mime}|null }.
 * `error` (opcional) si algo no crítico falló pero se pudo seguir. Lanza solo si la extracción entera falla.
 */
export async function leerChm(ruta) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chm-'));
    try {
        await extraerChm(ruta, dir);                       // ← lanza si falta libchm-bin / CHM corrupto
        const ficheros = await listarFicheros(dir);

        // 1) Título: del .hhp (Title=) — es el más fiable (lo fija el autor del CHM).
        let titulo = null;
        const hhp = ficheros.find(f => f.toLowerCase().endsWith('.hhp'));
        if (hhp) {
            const txt = await fs.readFile(hhp, 'utf8').catch(() => '');
            const m = txt.match(/^\s*Title\s*=\s*(.+?)\s*$/im);
            if (m && m[1].trim()) titulo = decodificarEntidades(m[1]);
        }

        // 2) HTML: si falta título, el primer <title> no vacío; y ISBN/ISSN del texto (pista para el enriquecimiento).
        const htmls = ficheros.filter(f => /\.html?$/i.test(f));
        const isbnCandidatos = new Set();
        let issn = null, escaneados = 0;
        for (const h of htmls) {
            if (escaneados >= MAX_HTML_ESCANEO) break;
            let raw;
            try { raw = await fs.readFile(h, 'utf8'); } catch { continue; }
            if (raw.length > MAX_BYTES_HTML) raw = raw.slice(0, MAX_BYTES_HTML);
            escaneados++;
            if (!titulo) {
                const mt = raw.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (mt && mt[1].trim()) titulo = decodificarEntidades(mt[1]);
            }
            for (const m of raw.matchAll(RE_ISBN)) { const v = validarISBN(m[1]); if (v) isbnCandidatos.add(v); }
            if (!issn) { const is = extraerISSNs(raw); if (is.length) issn = is[0]; }
        }

        // 3) Portada: preferimos una imagen «cover/portada/front»; si no, la JPG/PNG más grande.
        const imgs = ficheros.filter(f => /\.(jpe?g|png)$/i.test(f));  // JPG/PNG (medibles por resolverPortada); GIF/BMP se omiten
        let elegida = imgs.find(f => /cover|portada|front|caratula|cubierta/i.test(path.basename(f)));
        if (!elegida && imgs.length) {
            let maxSz = -1;
            for (const f of imgs) { const st = await fs.stat(f).catch(() => null); if (st && st.size > maxSz) { maxSz = st.size; elegida = f; } }
        }
        let portada = null;
        if (elegida) {
            const buf = await fs.readFile(elegida).catch(() => null);
            if (buf && buf.length) portada = { buf, mime: MIME_IMG[path.extname(elegida).toLowerCase()] || 'image/jpeg' };
        }

        const candidatos = [...isbnCandidatos];
        const isbn = candidatos.find(c => c.length === 13) || candidatos[0] || null;
        return { titulo, isbn, isbn_candidatos: candidatos, issn, portada };
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
