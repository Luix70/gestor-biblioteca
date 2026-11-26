/**
 * EL ISBN Y EL TÍTULO QUE TRAE EL NOMBRE DEL FICHERO — puro, sin red ni disco.
 *
 * Un nombre como «9780321179142 - Sanders, Bill - Reality Macromedia Flash MX_ Flash Communication Server.pdf»
 * (Calibre) o «9780801469114.Cornell.On_the_Republic….pdf» (lotes de editorial) lleva el registro de ESE fichero.
 * En un PDF escaneado la visión no debe pisarlo (26-nov: 145 fichas medidas con el ISBN de otra edición o de otro
 * libro). Lo usan orquestador (rama del PDF escaneado) y scripts/detectar-isbn-nombre-escaneados.js.
 */
import { parsearNombre } from './parsear-nombre.js';
import { validarISBN, variantesISBN } from './identificadores.js';

/** Dígitos (y X) del nombre, para ver si un ISBN va escrito en él en cualquiera de sus formas. */
const digitosDe = (nombre) => String(nombre || '').replace(/[^\dXx]/g, '').toUpperCase();

/** ¿Va `isbn` (en su forma de 10 o de 13) escrito en el nombre? */
export function isbnEstaEnNombre(nombre, isbn) {
    const v = isbn ? validarISBN(isbn) : null;
    if (!v) return false;
    const digitos = digitosDe(nombre);
    return variantesISBN(v).some((x) => digitos.includes(String(x).toUpperCase()));
}

/**
 * El ISBN escrito en el NOMBRE del fichero, o null. `preferido` (p. ej. el isbn_propio de lector-pdf, o el que leyó
 * la visión) gana si también está en el nombre: con varios ISBN en el nombre, decide cuál es.
 */
export function isbnDelNombreFichero(nombre, preferido = null) {
    for (const c of [preferido, parsearNombre(nombre).isbn]) {
        const v = c ? validarISBN(c) : null;
        if (v && isbnEstaEnNombre(nombre, v)) return v;
    }
    return null;
}

/**
 * Título de un nombre «<ISBN> - Autor - Título.ext»: lo que va tras el último « - ». El «_» hacía de «:» (no vale en
 * nombres de Windows). null si el nombre no tiene esa forma.
 */
export function tituloDeNombreConIsbn(nombre) {
    const base = String(nombre || '').replace(/\.[^.]+$/, '');
    const m = base.match(/^\s*(?:97[89])?\d{9}[\dXx]\s+-\s+.+?\s+-\s+(.+)$/);
    return m ? m[1].replace(/_\s*/g, ': ').replace(/\s+/g, ' ').trim() : null;
}
