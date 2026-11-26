/**
 * PORTADA SIN LIBRO — una carpeta que solo trae la PORTADA de un libro (y sus metadatos), pero no el libro.
 *
 * Caso medido el 26-nov en «Science & Technology Studies/Computer»: una exportación de Calibre de ~445 títulos donde
 * cada carpeta trae «<ISBN> - Autor - Título.jpg» + su «.opf», y solo ~49 traían además el libro (pdf/chm/epub). Sin
 * documento, el Vigilante tomaba la imagen por un ESCANEO: la unía en un PDF de 1 página y la catalogaba como
 * «artículo» (28 fichas falsas) o, por un JPG que declara 1 ppp, la mandaba a Cuarentena/ilegibles (367).
 *
 * Una portada no es un libro. Decisión del usuario (26-nov): estas carpetas se APARTAN a
 * `PreProceso/_Portadas sin libro/<misma ruta relativa que tenían en el Inbox>/` —nada se pierde, y con sus .opf es
 * una lista de los libros que faltan—. PreProceso no toca esa carpeta. Si el libro está en una carpeta SUPERIOR del
 * mismo drop, la portada no se aparta: espera a que se catalogue el libro (que busca su portada hacia arriba desde
 * su propia carpeta; ver vigilante·buscarPortadaPreextraida).
 *
 * Consumidores: vigilante·clasificarDirectorio (al formar las unidades) y scripts/apartar-portadas-sin-libro.js (lo
 * que ya entró: las fichas falsas y los depósitos de ilegibles).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { esDocumentoLeible, esImagenArchivo } from './criba-material.js';
import { leerOPF } from './lector-opf.js';
import { moverArbol, destinoLibre } from './mover-arbol.js';

/** Carpeta de PreProceso donde se apartan las portadas sin libro. PreProceso la ignora. */
export const CARPETA_PORTADAS_SIN_LIBRO = '_Portadas sin libro';

// Más imágenes ya no es «una portada»: delante y detrás (2) es lo más que deja una exportación de catálogo.
const MAX_IMAGENES = 2;

// Lo que acompaña a una portada en una exportación y no es material (Calibre, gestores de descargas, Windows).
const RE_ACOMPANANTE = /\.(opf|nfo|txt|url|db|ini|json|xml|sfv|md5)$/i;

// Nombre GENÉRICO de cubierta (el mismo criterio que vigilante·NOMBRE_PORTADA_GENERICA).
const RE_NOMBRE_PORTADA = /^(cover|portada|cubierta|frontcover|front[-_ ]?cover|back[-_ ]?cover|contraportada)$/i;

const oculto = (n) => /^[.@#]/.test(n) || n === '_guia.json' || /^(thumbs\.db|desktop\.ini)$/i.test(n);

/** Clave de comparación de nombres: minúsculas, sin acentos ni signos, espacios simples. */
function clave(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** ISBN (10 o 13, solo dígitos/X) al principio de un nombre «<ISBN> - Autor - Título». */
function isbnDelNombre(nombre) {
    const m = String(nombre || '').match(/^\s*((?:97[89])?\d{9}[\dXx])\b/);
    return m ? m[1].toUpperCase() : null;
}

/**
 * ¿Es `dir` una carpeta que solo trae la portada de un libro? Mira solo su primer nivel. Condiciones: ningún
 * documento, ninguna subcarpeta con algo dentro, 1-2 imágenes, nada más que acompañantes (.opf, .nfo…), y una señal
 * de que la imagen es una PORTADA y no la página de un escaneo: un .opf al lado, o un nombre de cubierta.
 * @returns {Promise<null | { imagenes:string[], opf:string|null, isbn:string|null, titulo:string|null, nombres:string[] }>}
 */
export async function examinarPortadaSinLibro(dir) {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
    const imagenes = [];
    const opfs = [];
    for (const e of ents) {
        if (oculto(e.name)) continue;
        if (e.isDirectory()) {
            // Una subcarpeta vacía no estorba; con algo dentro, la carpeta ya no es «solo una portada».
            const dentro = await fs.readdir(path.join(dir, e.name)).catch(() => []);
            if (dentro.some((n) => !oculto(n))) return null;
            continue;
        }
        if (!e.isFile()) continue;
        if (esDocumentoLeible(e.name)) return null;
        if (esImagenArchivo(e.name)) { imagenes.push(path.join(dir, e.name)); continue; }
        if (/\.opf$/i.test(e.name)) { opfs.push(path.join(dir, e.name)); continue; }
        if (!RE_ACOMPANANTE.test(e.name)) return null;   // otra cosa (un comprimido, un audio…): no es este caso
    }
    if (!imagenes.length || imagenes.length > MAX_IMAGENES) return null;

    const nombreDePortada = imagenes.every((r) => RE_NOMBRE_PORTADA.test(path.parse(r).name));
    if (!opfs.length && !nombreDePortada) return null;

    const meta = opfs.length ? await leerOPF(opfs[0]) : null;
    const base = path.parse(imagenes[0]).name;
    return {
        imagenes,
        opf: opfs[0] || null,
        isbn: meta?.isbn || isbnDelNombre(base),
        titulo: meta?.titulo || null,
        nombres: [base, ...opfs.map((o) => path.parse(o).name)],
    };
}

/**
 * ¿Está el libro de esta portada en una carpeta SUPERIOR del drop (de `dir` hacia arriba, hasta `tope` incluido)?
 * Solo mira el primer nivel de cada carpeta (barato aunque la superior tenga cientos de subcarpetas). Casa por
 * nombre (el documento se llama como la portada o su .opf), por ISBN en el nombre, o por el título del .opf.
 * @returns {Promise<string|null>} la ruta del documento, o null.
 */
export async function libroEnCarpetaSuperior(dir, tope, examen) {
    const nombres = new Set(examen.nombres.map(clave).filter(Boolean));
    const titulo = clave(examen.titulo);
    const isbn = examen.isbn ? String(examen.isbn).replace(/[^\dX]/gi, '') : null;
    const topeAbs = path.resolve(tope);
    let d = path.dirname(path.resolve(dir));
    while (d.startsWith(topeAbs)) {
        let ents = [];
        try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { /* sin acceso */ }
        for (const e of ents) {
            if (!e.isFile() || !esDocumentoLeible(e.name)) continue;
            const base = path.parse(e.name).name;
            const k = clave(base);
            if (nombres.has(k)) return path.join(d, e.name);
            if (isbn && base.replace(/[^\dX]/gi, '').includes(isbn)) return path.join(d, e.name);
            if (titulo && titulo.length >= 8 && (k === titulo || k.endsWith(' ' + titulo))) return path.join(d, e.name);
        }
        if (d === topeAbs) break;
        const padre = path.dirname(d);
        if (padre === d) break;
        d = padre;
    }
    return null;
}

/**
 * Aparta la carpeta entera (portada + .opf + acompañantes) a `<preproceso>/_Portadas sin libro/<ruta relativa a
 * inbox>/`. Copia verificada entre montajes (mover-arbol); nunca pisa nada. Devuelve la carpeta destino.
 */
export async function apartarPortadaSinLibro(dir, { inbox, preproceso }) {
    const rel = path.relative(path.resolve(inbox), path.resolve(dir));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`«${dir}» no está dentro del Inbox`);
    const destino = await destinoLibre(path.join(preproceso, CARPETA_PORTADAS_SIN_LIBRO, rel));
    await moverArbol(dir, destino);
    return destino;
}

/**
 * Aparta FICHEROS sueltos (lo que ya entró: la portada que estaba en Cuarentena o en la Papelera) a la carpeta de
 * apartados que corresponde a `dirOriginal` (la carpeta del Inbox de la que salieron). Nunca pisa nada.
 * @returns {Promise<string>} la carpeta destino.
 */
export async function apartarFicheros(rutas, dirOriginal, { inbox, preproceso }) {
    const rel = path.relative(path.resolve(inbox), path.resolve(dirOriginal));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`«${dirOriginal}» no está dentro del Inbox`);
    const carpeta = path.join(preproceso, CARPETA_PORTADAS_SIN_LIBRO, rel);
    await fs.mkdir(carpeta, { recursive: true });
    for (const r of rutas) {
        const destino = await destinoLibre(path.join(carpeta, path.basename(r)));
        await moverArbol(r, destino);
    }
    return carpeta;
}
