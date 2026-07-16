/**
 * LECTOR WORD (.docx / .doc) — título, autor, texto y una previsualización HTML, SIN dependencias nuevas.
 *
 * `.docx` es un ZIP OOXML: se abre con **adm-zip** y se parsea con **cheerio** (ambos ya en el proyecto, JS
 * puro → aptos para el Atom del NAS: ni sharp, ni SIMD, ni binarios). Mismo patrón que lector-epub/lector-chm.
 *   · `docProps/core.xml` → METADATOS de verdad (dc:title, dc:creator, dc:language…): identificación GRATIS,
 *     sin IA — es la fuente más barata, como el ID3 de un audiolibro.
 *   · `word/document.xml` → cuerpo: párrafos (w:p), runs (w:r/w:t), saltos (w:br), tablas (w:tbl) y estilos
 *     (negrita/cursiva/subrayado, encabezados) → HTML legible para el visor de la ficha.
 *
 * `.doc` (binario OLE de Word 97-2003) NO es un ZIP y no hay parser JS puro razonable: se delega en `antiword`
 * o `catdoc` SI están instalados (mismo criterio que poppler/libchm-bin). Si no lo están, el documento SE
 * CATALOGA IGUAL (por nombre) y la ficha ofrece la descarga: nunca se pierde, solo se queda sin previsualizar.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

const ejecutar = promisify(execFile);
const TIMEOUT_MS = Number(process.env.WORD_TIMEOUT_MS) || 20000;
const MAX_HTML = Number(process.env.WORD_MAX_HTML) || 2_000_000; // tope del HTML servido (docs enormes)

export const esDocx = (n) => path.extname(String(n || '')).toLowerCase() === '.docx';
export const esDoc = (n) => path.extname(String(n || '')).toLowerCase() === '.doc';
export const esWord = (n) => esDocx(n) || esDoc(n);

const escapar = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Metadatos de `docProps/core.xml` (los que Word guarda de verdad). {} si no hay. */
function metadatosDocx(zip) {
    try {
        const e = zip.getEntry('docProps/core.xml');
        if (!e) return {};
        const $ = cheerio.load(e.getData().toString('utf8'), { xmlMode: true });
        const v = (sel) => { const t = $(sel).first().text().trim(); return t || null; };
        return {
            titulo: v('dc\\:title'),
            autor: v('dc\\:creator'),
            idioma: v('dc\\:language'),
            asunto: v('dc\\:subject'),
            descripcion: v('dc\\:description'),
        };
    } catch { return {}; }
}

/**
 * `word/document.xml` → { html, texto }. Se respetan párrafos, encabezados, negrita/cursiva/subrayado, saltos
 * y tablas; se ignora todo lo demás (imágenes incrustadas, campos, revisiones): el objetivo es LEER, no
 * reproducir Word. El HTML sale ya escapado (se inyecta en la ficha).
 */
function cuerpoDocx(zip) {
    const e = zip.getEntry('word/document.xml');
    if (!e) return { html: '', texto: '' };
    const $ = cheerio.load(e.getData().toString('utf8'), { xmlMode: true });

    const textoDeRun = (r) => {
        const $r = $(r);
        let t = '';
        $r.find('w\\:t, w\\:tab, w\\:br').each((_, n) => {
            const tag = (n.tagName || n.name || '').toLowerCase();
            if (tag === 'w:t') t += $(n).text();
            else if (tag === 'w:tab') t += '\t';
            else t += '\n';
        });
        if (!t) return '';
        let h = escapar(t).replace(/\n/g, '<br>').replace(/\t/g, '&emsp;');
        const pr = $r.find('w\\:rPr').first();
        if (pr.find('w\\:b').length) h = `<b>${h}</b>`;
        if (pr.find('w\\:i').length) h = `<i>${h}</i>`;
        if (pr.find('w\\:u').length) h = `<u>${h}</u>`;
        return h;
    };

    const parrafo = (p) => {
        const $p = $(p);
        let h = '';
        $p.children('w\\:r, w\\:hyperlink').each((_, n) => {
            const tag = (n.tagName || n.name || '').toLowerCase();
            h += tag === 'w:hyperlink' ? $(n).children('w\\:r').map((__, r) => textoDeRun(r)).get().join('') : textoDeRun(n);
        });
        if (!h.trim()) return '<p><br></p>';                       // párrafo vacío = espaciado del autor
        const estilo = ($p.find('w\\:pStyle').first().attr('w:val') || '').toLowerCase();
        const m = estilo.match(/^(?:heading|titulo|título)\s*(\d)/);
        if (m) { const n = Math.min(6, Math.max(1, Number(m[1]) + 1)); return `<h${n}>${h}</h${n}>`; }
        return `<p>${h}</p>`;
    };

    const partes = [];
    $('w\\:body').children().each((_, n) => {
        const tag = (n.tagName || n.name || '').toLowerCase();
        if (tag === 'w:p') partes.push(parrafo(n));
        else if (tag === 'w:tbl') {
            const filas = $(n).find('w\\:tr').map((__, tr) => {
                const celdas = $(tr).find('w\\:tc').map((___, tc) =>
                    `<td>${$(tc).find('w\\:p').map((____, p) => parrafo(p)).get().join('')}</td>`).get().join('');
                return `<tr>${celdas}</tr>`;
            }).get().join('');
            if (filas) partes.push(`<table>${filas}</table>`);
        }
        if (partes.join('').length > MAX_HTML) return false;        // corta un documento desmesurado
    });

    const html = partes.join('\n');
    const texto = cheerio.load(`<div>${html}</div>`).text().replace(/\n{3,}/g, '\n\n').trim();
    return { html, texto };
}

/** Lee un .docx: metadatos + cuerpo. Lanza si el fichero no es un OOXML legible. */
export async function leerDocxCompleto(ruta) {
    const zip = new AdmZip(await fs.readFile(ruta));
    const meta = metadatosDocx(zip);
    const { html, texto } = cuerpoDocx(zip);
    return { ...meta, html, texto, formato: 'docx' };
}

/**
 * Lee un .doc (binario OLE) con `antiword` o `catdoc` si están instalados. Devuelve solo TEXTO (sin formato).
 * `{ texto: '', sinHerramienta: true }` si no hay ninguna → el doc se cataloga igual y se ofrece la descarga.
 */
export async function leerDocLegado(ruta) {
    for (const [cmd, args] of [['antiword', [ruta]], ['catdoc', ['-d', 'utf-8', ruta]]]) {
        try {
            const { stdout } = await ejecutar(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
            const texto = String(stdout || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            if (texto) return { texto, html: texto.split(/\n{2,}/).map((p) => `<p>${escapar(p).replace(/\n/g, '<br>')}</p>`).join('\n'), formato: 'doc' };
        } catch { /* no instalado o falló: se prueba el siguiente */ }
    }
    return { texto: '', html: '', formato: 'doc', sinHerramienta: true };
}

/** Lee un Word (.docx o .doc). Nunca lanza: ante un fichero ilegible devuelve texto vacío (se cataloga igual). */
export async function leerWord(ruta) {
    try {
        return esDocx(ruta) ? await leerDocxCompleto(ruta) : await leerDocLegado(ruta);
    } catch (e) {
        return { titulo: null, autor: null, texto: '', html: '', formato: esDocx(ruta) ? 'docx' : 'doc', error: e.message };
    }
}
