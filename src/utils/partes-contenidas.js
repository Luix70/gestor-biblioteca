/**
 * ¿QUÉ PARTES DE UN LIBRO DESGLOSADO ESTÁN YA DENTRO DEL LIBRO ENTERO?
 *
 * Cuando una carpeta trae el libro completo y además sus capítulos, los capítulos sobran (decisión del usuario, 1-nov:
 * nada de basura). Pero «parecer un capítulo» no basta para retirar un fichero: en esas carpetas también hay otra
 * edición del libro, material del profesor o un apéndice que el PDF entero no trae. Por eso se mira el TEXTO: de cada
 * parte se toman tres muestras y se buscan en el libro entero. Las letras seguidas, sin espacios ni puntuación,
 * sobreviven a los cortes de línea, a los guiones y a las comillas tipográficas del manuscrito.
 *
 * Una parte solo se da por contenida si se pudo leer y casa. Lo que no se pueda comprobar se conserva: va a «Desglose/».
 * Lo contenido va a la Papelera, nunca se borra. Un fallo de lectura no rompe nada: todo queda como parte conservada.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paginasPdf } from './qpdf.js';

const ejecutar = promisify(execFile);
const TIEMPO_LIBRO_MS = 20 * 60 * 1000;   // el texto de un libro de 1.500 páginas en el Atom
const TIEMPO_PARTE_MS = 2 * 60 * 1000;
const LARGO_MUESTRA = 80;                 // letras seguidas: más de una línea, imposible por casualidad
const MIN_LETRAS = 600;                   // con menos no salen tres muestras distintas
const POSICIONES = [0.25, 0.5, 0.75];
const MIN_ACIERTOS = 2;                   // dos de tres: admite una errata o un párrafo reescrito

/** Solo las letras, sin acentos y en minúsculas. */
const soloLetras = (t) => String(t || '').normalize('NFD').toLowerCase().replace(/[^a-z]+/g, '');

async function textoPdf(ruta, timeout) {
    const { stdout } = await ejecutar('pdftotext', [ruta, '-'], { timeout, maxBuffer: 1 << 28 });
    return stdout || '';
}

/**
 * Texto de un .doc binario sin Word: sus tramos largos legibles, en cp1252 o en UTF-16. Solo sirve para comparar
 * (no conserva formato) y basta: Word guarda el cuerpo del documento en un tramo continuo.
 */
function textoDocBinario(buffer) {
    const tramos = buffer.toString('latin1').match(/[\x20-\x7e\x91-\x97\xc0-\xff\r\n\t]{200,}/g) || [];
    const anchos = buffer.toString('utf16le').match(/[ -~ -ɏ‐-‟\r\n\t]{200,}/g) || [];
    return [...tramos, ...anchos].join(' ');
}

/** Texto de una parte, o '' si no se puede leer. */
async function textoParte(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    try {
        if (ext === '.pdf') return await textoPdf(ruta, TIEMPO_PARTE_MS);
        if (ext === '.doc') return textoDocBinario(await fs.readFile(ruta));
    } catch { /* ilegible: no se puede comprobar */ }
    return '';
}

/** ¿Las muestras de `parte` están en `libro`? Ambos en solo letras. */
export function muestrasEnLibro(parte, libro) {
    if (parte.length < MIN_LETRAS) return false;
    const aciertos = POSICIONES.filter((p) => {
        const desde = Math.floor((parte.length - LARGO_MUESTRA) * p);
        return libro.includes(parte.slice(desde, desde + LARGO_MUESTRA));
    }).length;
    return aciertos >= MIN_ACIERTOS;
}

/**
 * Reparte las `partes` (rutas relativas a `dir`) según estén o no dentro de `principal`.
 * @returns {Promise<{contenidas: string[], conservadas: string[]}>}
 */
export async function partesContenidasEnLibro(dir, principal, partes) {
    const abs = (n) => path.join(dir, ...n.split('/'));
    let libro = '';
    try { libro = soloLetras(await textoPdf(abs(principal), TIEMPO_LIBRO_MS)); } catch { /* sin capa de texto o enorme */ }
    const paginasLibro = await paginasPdf(abs(principal)) || 0;
    // Un libro sin capa de texto (escaneado) no permite comprobar nada: se conserva todo.
    if (libro.length < paginasLibro * 200) return { contenidas: [], conservadas: [...partes] };

    const contenidas = [], conservadas = [];
    for (const parte of partes) {
        if (muestrasEnLibro(soloLetras(await textoParte(abs(parte))), libro)) contenidas.push(parte);
        else conservadas.push(parte);
    }
    return { contenidas, conservadas };
}
