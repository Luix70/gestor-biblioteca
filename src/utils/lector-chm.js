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
import * as cheerio from 'cheerio';
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

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// PREVISUALIZACIÓN en el panel: se extrae el CHM UNA vez a un temporal (cacheado por ruta + TTL, como los
// cómics) y se sirve cada tema (HTML) como un documento AUTOCONTENIDO —imágenes y CSS INCRUSTADOS como
// data-URI—. Así el cliente lo pinta en un iframe `srcdoc` SANDBOX (sin scripts, sin peticiones extra que
// tendrían que llevar el token): mismo patrón seguro que el visor de MOBI.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
const MIME_PREVIEW = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const CHM_TTL = Number(process.env.CHM_CACHE_TTL_MS || 20 * 60 * 1000);
const cacheChm = new Map();   // ruta → { dir, ts }

async function podarChm() {
    const ahora = Date.now();
    for (const [k, v] of cacheChm) {
        if (ahora - v.ts <= CHM_TTL) continue;
        cacheChm.delete(k);
        await fs.rm(v.dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Extrae (y cachea) el CHM a un temporal; devuelve el directorio. Lanza si falta libchm-bin / CHM corrupto. */
async function prepararChm(ruta) {
    await podarChm();
    const ya = cacheChm.get(ruta);
    if (ya) { ya.ts = Date.now(); return ya.dir; }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chm-prev-'));
    try { await extraerChm(ruta, dir); }
    catch (e) { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); throw e; }
    cacheChm.set(ruta, { dir, ts: Date.now() });
    return dir;
}

/** Resuelve `partes` DENTRO de `dir` (bloquea el path-traversal: nunca sale del árbol extraído). null si escapa. */
function resolverDentro(dir, ...partes) {
    const limpio = partes.map(s => String(s || '').split(/[?#]/)[0].replace(/^[/\\]+/, ''));
    const abs = path.resolve(dir, ...limpio);
    const raiz = path.resolve(dir);
    return (abs === raiz || abs.startsWith(raiz + path.sep)) ? abs : null;
}

/**
 * ÍNDICE del CHM para el visor: { toc: [{titulo, href}], entrada: <href de la página inicial> }.
 * El TOC sale del `.hhc` (objetos con param Name/Local); la entrada, del `.hhp` (Default topic) o el 1er tema.
 * Los href son relativos a la raíz del CHM (= `dir`).
 */
export async function indiceChm(ruta) {
    const dir = await prepararChm(ruta);
    const ficheros = await listarFicheros(dir);
    const rel = (f) => path.relative(dir, f).replace(/\\/g, '/');

    const toc = [];
    const hhc = ficheros.find(f => f.toLowerCase().endsWith('.hhc'));
    if (hhc) {
        const txt = await fs.readFile(hhc, 'utf8').catch(() => '');
        for (const m of txt.matchAll(/<object[^>]*>([\s\S]*?)<\/object>/gi)) {
            const bloque = m[1];
            const name = (bloque.match(/name="Name"\s+value="([^"]*)"/i) || [])[1];
            const local = (bloque.match(/name="Local"\s+value="([^"]*)"/i) || [])[1];
            if (name && local) toc.push({ titulo: decodificarEntidades(name), href: local.replace(/\\/g, '/') });
        }
    }

    let entrada = null;
    const hhp = ficheros.find(f => f.toLowerCase().endsWith('.hhp'));
    if (hhp) {
        const txt = await fs.readFile(hhp, 'utf8').catch(() => '');
        const m = txt.match(/^\s*Default topic\s*=\s*(.+?)\s*$/im);
        if (m) entrada = m[1].trim().replace(/\\/g, '/');
    }
    if (!entrada) entrada = toc[0]?.href || (ficheros.filter(f => /\.html?$/i.test(f)).map(rel).sort()[0] || null);
    return { toc, entrada };
}

/**
 * Página (tema) del CHM como HTML AUTOCONTENIDO: se leen sus <img> y <link rel=stylesheet> del árbol
 * extraído y se INCRUSTAN como data-URI / <style>, se quitan los <script> y se neutralizan los enlaces
 * internos (la navegación es por el índice lateral). Devuelve la cadena HTML o null si no existe el tema.
 */
export async function paginaChmInline(ruta, href) {
    const dir = await prepararChm(ruta);
    const archivo = resolverDentro(dir, href);
    if (!archivo) return null;
    let html;
    try { html = await fs.readFile(archivo, 'utf8'); } catch { return null; }
    const baseDir = path.dirname(archivo);
    const $ = cheerio.load(html);
    $('script').remove();                               // defensa en profundidad (el iframe ya es sandbox)

    // <img src> → data-URI (imágenes locales; se dejan las remotas/data tal cual)
    for (const img of $('img').toArray()) {
        const src = $(img).attr('src');
        if (!src || /^(data:|https?:|\/\/)/i.test(src)) continue;
        const f = resolverDentro(baseDir, src);
        if (!f) continue;
        try {
            const buf = await fs.readFile(f);
            $(img).attr('src', `data:${MIME_PREVIEW[path.extname(f).toLowerCase()] || 'image/png'};base64,${buf.toString('base64')}`);
        } catch { /* imagen ausente: se deja el src roto, no rompe la página */ }
    }
    // <link rel=stylesheet href> → <style> incrustado
    for (const link of $('link[rel=stylesheet], link[type="text/css"]').toArray()) {
        const h = $(link).attr('href');
        if (!h || /^(https?:|\/\/)/i.test(h)) continue;
        const f = resolverDentro(baseDir, h);
        if (!f) continue;
        try { $(link).replaceWith(`<style>${await fs.readFile(f, 'utf8')}</style>`); } catch { /* css ausente */ }
    }
    return $.html();
}
