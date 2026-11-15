/**
 * ¿Es este comprimido un CÓMIC / LIBRO DE LÁMINAS? (15-nov)
 *
 * Un .zip/.rar/.7z que solo trae imágenes («Fate Stay Night Visual Collection.zip», 60 png) es un libro de láminas:
 * lo correcto es catalogarlo como UN cómic (.cbz/.cbr/.cb7), no abrirlo. Abrirlo dejaba una carpeta de imágenes
 * sueltas que la ingesta convertía en otra cosa, y el comprimido original iba a la Papelera (regla del usuario: «lo
 * correcto sería convertirlos en .CBZ y tratarlo como tal»).
 *
 * Se decide LISTANDO el comprimido (sin extraerlo):
 *   · todas sus entradas son imágenes, salvo morralla (Thumbs.db, .nfo, .txt, .url, .sfv, __MACOSX…);
 *   · al menos MIN_IMAGENES imágenes;
 *   · las imágenes no están repartidas en VARIAS carpetas grandes: eso es un paquete de varios libros, y entonces sí
 *     se abre (cada carpeta se cataloga por su lado). Una carpeta con 8 .bmp junto a la principal no cuenta.
 *
 * Qué se hace con él (`destinoComic`):
 *   · .rar → .cbr, .7z → .cb7: se RENOMBRA tal cual (se leen con bsdtar, sin cargarlos en memoria);
 *   · .zip → .cbz si cabe en CBZ_MAX_BYTES (el visor y la ingesta abren el cbz EN MEMORIA con adm-zip: el Atom no
 *     aguanta uno de 800 MB). Si es más grande, se abre y su carpeta se guía «empaquetar» (alcance «todo»), que lo
 *     reparte en tomos .cbz de ese tamaño como máximo;
 *   · .iso/.tar…: no (no son cómics).
 *
 * Lo usan el Vigilante y PreProceso (vigilante·expandirComprimidos) y el arreglo de lo ya abierto
 * (scripts/recomprimir-laminas-expandidas.js).
 */
import path from 'node:path';
import { ficherosDelListado } from './extraer-archivo.js';

export const EXT_IMAGEN = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.jfif']);
// Morralla habitual de una descarga o de un escaneo: no hace que el comprimido deje de ser «solo imágenes».
const EXT_MORRALLA = new Set(['.txt', '.nfo', '.diz', '.url', '.sfv', '.md5', '.db', '.ini', '.ds_store', '.htm', '.html', '.xml', '.log']);
const NOMBRE_MORRALLA = /^(thumbs\.db|desktop\.ini|\.ds_store|folder\.jpg\.db)$/i;
const MIN_IMAGENES = 3;
// Una carpeta interna con al menos tantas imágenes es «un libro»; si hay dos o más así, el comprimido es un paquete.
const IMAGENES_POR_LIBRO = 20;
const MAX_MORRALLA = 12;

const COMIC_DE = { '.zip': '.cbz', '.rar': '.cbr', '.7z': '.cb7' };

/**
 * A partir de la lista de entradas (listarComprimido), ¿es un libro de láminas?
 * @returns {{imagenes:number, carpetas:number}|null}
 */
export function esComprimidoDeImagenes(entradas) {
    let imagenes = 0, morralla = 0;
    const porCarpeta = new Map();
    for (const rel of ficherosDelListado(entradas)) {               // sin las carpetas (ni las de un RAR, sin «/»)
        if (/(^|\/)__MACOSX\//i.test(rel)) continue;                 // metadatos de macOS
        const nombre = path.posix.basename(rel);
        const ext = path.posix.extname(nombre).toLowerCase();
        if (EXT_IMAGEN.has(ext)) {
            imagenes++;
            const dir = path.posix.dirname(rel);
            porCarpeta.set(dir, (porCarpeta.get(dir) || 0) + 1);
        } else if (NOMBRE_MORRALLA.test(nombre) || EXT_MORRALLA.has(ext) || nombre.startsWith('.')) {
            morralla++;
        } else {
            return null;   // un PDF, un EPUB, otro comprimido, un ejecutable… → no es solo láminas: se abre
        }
    }
    if (imagenes < MIN_IMAGENES || morralla > MAX_MORRALLA) return null;
    const grandes = [...porCarpeta.values()].filter((n) => n >= IMAGENES_POR_LIBRO).length;
    if (grandes >= 2) return null;   // varias carpetas grandes = varios libros en un paquete
    return { imagenes, carpetas: porCarpeta.size };
}

/**
 * Qué hacer con un comprimido de láminas: `{ ext: '.cbz' }` = renombrarlo a esa extensión; `{ empaquetar: true }` =
 * abrirlo y guiar su carpeta «empaquetar»; null = no es un tipo de comprimido que se trate como cómic.
 */
export function destinoComic(nombre, bytes) {
    const ext = path.extname(String(nombre)).toLowerCase();
    const comic = COMIC_DE[ext];
    if (!comic) return null;
    const max = Number(process.env.CBZ_MAX_BYTES || 400 * 1024 * 1024);
    if (comic === '.cbz' && bytes > max) return { empaquetar: true };
    return { ext: comic };
}
