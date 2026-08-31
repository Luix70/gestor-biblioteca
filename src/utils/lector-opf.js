/**
 * LECTOR DE .opf SUELTO (fichero de metadatos Calibre/OPF junto al documento).
 *
 * Un `.opf` es el mismo formato de metadatos que lleva un EPUB dentro, pero aquí viene SUELTO en la carpeta,
 * hermano del PDF/EPUB/DjVu (típico de una exportación de Calibre: «Título - Autor.opf» + «… .jpg» + el libro).
 * Trae catalogación FIABLE hecha por una persona: título, autor(es) + rol, editorial, ISBN, idioma, serie
 * (colección) + índice, sinopsis, materias y —clave para nosotros— la PORTADA real referenciada en `<guide>`
 * (la cubierta que el escaneador dejó aparte, y que la ingesta ignoraba extrayendo la página 1 del PDF).
 *
 * Reutiliza los extractores de OPF ya probados de `lector-epub.js` (ISBN Dublin Core, contribuciones por rol
 * MARC, serie Calibre/EPUB3) para no duplicar reglas; añade lo específico del `.opf` de disco: leer el fichero,
 * limpiar la sinopsis HTML de Calibre y resolver el href de la cubierta a una ruta ABSOLUTA en disco.
 */
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extraerIsbnDublinCore, extraerContribucionesEpub, extraerSerieEpub } from './lector-epub.js';

const normNum = (v) => (v == null ? null : String(v).trim().replace(/\.0+$/, '') || null);

// Sinopsis de Calibre: viene como HTML ESCAPADO dentro de <dc:description>. cheerio `.text()` ya deshace el
// primer escapado (→ etiquetas reales); aquí se quitan las etiquetas y se deshacen las entidades restantes.
function limpiarHtml(s, max = 5000) {
    if (!s) return null;
    let t = String(s).replace(/<[^>]+>/g, ' ');
    t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
    t = t.replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
}

/**
 * Parsea el XML de un OPF. `dirBase` = carpeta del .opf (para resolver el href de la cubierta a ruta absoluta).
 * Devuelve el objeto de metadatos o null si no hay <metadata>. Nunca lanza.
 */
export function parsearOPF(xml, dirBase = '') {
    let $;
    try { $ = cheerio.load(xml, { xmlMode: true }); } catch { return null; }
    const metadata = $('metadata').first();
    if (!metadata.length) return null;

    const primerTexto = (sel) => { const el = metadata.find(sel).first(); return el.length ? (el.text() || '').trim() || null : null; };

    // Autores: dc:creator sin rol o con opf:role='aut' (los demás roles → contribuciones).
    const autores = [];
    metadata.find('dc\\:creator').each((i, el) => {
        const $el = $(el);
        const nombre = ($el.attr('opf:file-as') || $el.text() || '').trim();
        const role = ($el.attr('opf:role') || '').toLowerCase();
        if (nombre && (!role || role === 'aut')) autores.push(nombre);
    });

    const materias = [];
    metadata.find('dc\\:subject').each((i, el) => { const s = ($(el).text() || '').trim(); if (s) materias.push(s); });

    const serie = extraerSerieEpub($, metadata);   // { nombre, numero }

    // Portada: <guide><reference type="cover" href="…"> (Calibre) o <meta name="cover" content="id"> → manifest.
    let coverHref = $('guide > reference[type="cover"]').first().attr('href')
        || $('reference[type="cover"]').first().attr('href') || null;
    if (!coverHref) {
        const coverId = $('meta[name="cover"]').attr('content');
        if (coverId) coverHref = $(`manifest > item[id="${coverId}"]`).attr('href') || null;
    }
    let coverPath = null;
    if (coverHref) {
        try { coverPath = path.resolve(dirBase, decodeURIComponent(coverHref.split('#')[0].split('?')[0])); }
        catch { coverPath = path.resolve(dirBase, coverHref.split('#')[0].split('?')[0]); }
    }

    return {
        titulo: primerTexto('dc\\:title'),
        autores,
        contribuciones: extraerContribucionesEpub($, metadata),   // [{nombre, rol}]
        editorial: primerTexto('dc\\:publisher'),
        isbn: extraerIsbnDublinCore($, metadata),
        // Igual que lector-epub: 2 primeras letras del código de lengua (eng→en, fra→fr…).
        idioma: (primerTexto('dc\\:language') || '').substring(0, 2).toLowerCase() || null,
        serie_nombre: serie.nombre,
        serie_indice: normNum(serie.numero),
        sinopsis: limpiarHtml(primerTexto('dc\\:description')),
        materias,
        cover_href: coverHref,
        cover_path: coverPath,   // ruta ABSOLUTA en disco (puede no existir; el llamador comprueba)
    };
}

/** Lee y parsea un .opf de disco. `null` si no se puede leer o no tiene metadatos. Nunca lanza. */
export async function leerOPF(rutaOpf) {
    let xml;
    try { xml = await fs.readFile(rutaOpf, 'utf8'); } catch { return null; }
    return parsearOPF(xml, path.dirname(rutaOpf));
}

/** ¿Tiene el OPF algún metadato aprovechable? (para no molestar con un .opf vacío/roto). */
export function opfEsSignificativo(meta) {
    if (!meta) return false;
    return !!(meta.titulo || meta.isbn || (meta.autores && meta.autores.length) || meta.editorial
        || meta.serie_nombre || meta.sinopsis || meta.cover_path);
}
