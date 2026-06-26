/**
 * Decodificación del código de barras de una cubierta (leído por visión).
 *
 *   977………  → EAN-13 de un PERIÓDICO: codifica el ISSN → es una REVISTA. El pequeño add-on
 *               EAN-2/EAN-5 a su derecha lleva el nº de ejemplar/mes.
 *   978 / 979 → EAN-13 de un LIBRO: el propio EAN-13 ES el ISBN-13.
 *
 * Un 977 en la cubierta es señal FUERTE de revista (los libros llevan 978/979). Por eso, si vemos un
 * 977 válido, marcamos el recurso como revista y extraemos ISSN + nº de ejemplar.
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
 * @param {string} principal  los 13 dígitos del EAN-13 (lo que hay bajo las barras).
 * @param {string|null} sufijo  el add-on de 2-5 dígitos a la derecha (nº de ejemplar/mes), si lo hay.
 * @returns {{issn?:string, isbn?:string, numero_issue?:string, esRevista:boolean}|null}
 *          null si no es un EAN-13 válido (lectura dudosa → no se inventa nada).
 */
export function decodificarCodigoBarras(principal, sufijo = null) {
    const d = String(principal || '').replace(/\D/g, '');
    if (!ean13Valido(d)) return null;
    const add = String(sufijo || '').replace(/\D/g, '');
    const numero_issue = add ? String(parseInt(add, 10)) : undefined; // EAN-2/5 → nº de ejemplar (sin ceros)

    if (d.startsWith('977')) {
        const base = d.slice(3, 10);                       // 7 dígitos base del ISSN
        const issn = `${base.slice(0, 4)}-${base.slice(4)}${checkISSN(base)}`;
        return { issn, numero_issue, esRevista: true };
    }
    if (d.startsWith('978') || d.startsWith('979')) {
        const isbn = validarISBN(d);                       // el EAN-13 ES el ISBN-13
        return isbn ? { isbn, esRevista: false } : null;
    }
    return null;                                            // otro prefijo: no es ISSN ni ISBN
}
