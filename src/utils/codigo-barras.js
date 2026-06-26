/**
 * Decodificación del código de barras de una cubierta (leído por visión).
 *
 *   977………  → EAN-13 de un PERIÓDICO: codifica el ISSN → es una REVISTA.
 *   978 / 979 → EAN-13 de un LIBRO: el propio EAN-13 ES el ISBN-13.
 *
 * Un 977 en la cubierta es señal FUERTE de revista (los libros llevan 978/979). Solo se extrae el
 * IDENTIFICADOR (ISSN/ISBN): el add-on EAN-2/5 NO es fiable como nº de ejemplar (p. ej. en Paranormal
 * el add-on es "01" pero la portada dice "ISSUE 44"), así que el nº/mes se toman del TEXTO de la portada.
 */
import { validarISBN } from './identificadores.js';

// Dígito de control de un EAN-13 (mod 10, pesos alternos 1/3). Filtra lecturas erróneas de la visión.
function ean13Valido(d) {
    if (!/^\d{13}$/.test(d)) return false;
    let s = 0;
    for (let i = 0; i < 12; i++) s += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
    return (10 - (s % 10)) % 10 === Number(d[12]);
}

// Dígito de control del ISSN (mod 11, pesos 8…2) sobre los 7 dígitos base. 10 → 'X'.
function checkISSN(base7) {
    let s = 0;
    for (let i = 0; i < 7; i++) s += Number(base7[i]) * (8 - i);
    const r = (11 - (s % 11)) % 11;
    return r === 10 ? 'X' : String(r);
}

/**
 * @param {string} principal  los 13 dígitos del EAN-13 (lo que hay bajo las barras; orientación da igual).
 * @returns {{issn?:string, isbn?:string, comercial?:boolean, ean?:string, esRevista:boolean}|null}
 *          - { issn, esRevista:true }   si es 977 (periódico)
 *          - { isbn, esRevista:false }  si es 978/979 (libro)
 *          - { comercial:true, ean }    si es un EAN-13 VÁLIDO pero NO ISSN/ISBN (código COMERCIAL/UPC):
 *                                       hay código de barras, pero el ISSN hay que buscarlo en el interior.
 *          - null                       si no es un EAN-13 válido (lectura dudosa → no se inventa nada).
 */
export function decodificarCodigoBarras(principal) {
    const d = String(principal || '').replace(/\D/g, '');
    if (!ean13Valido(d)) return null;

    if (d.startsWith('977')) {
        const base = d.slice(3, 10);                       // 7 dígitos base del ISSN
        const issn = `${base.slice(0, 4)}-${base.slice(4)}${checkISSN(base)}`;
        return { issn, esRevista: true };
    }
    if (d.startsWith('978') || d.startsWith('979')) {
        const isbn = validarISBN(d);                       // el EAN-13 ES el ISBN-13
        return isbn ? { isbn, esRevista: false } : null;
    }
    return { comercial: true, ean: d, esRevista: false };  // EAN válido pero comercial (UPC): no es ISSN/ISBN
}
