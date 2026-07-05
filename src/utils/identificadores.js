/**
 * Validación y normalización de identificadores bibliográficos (ISBN-10/13, ISSN).
 * Una visión IA o un OCR pueden devolver números con dígitos de más/menos; aquí se
 * descartan los que no superan el dígito de control, para no almacenar identificadores falsos.
 */

export function normalizarIdentificador(valor) {
    return valor ? String(valor).replace(/[-\s]/g, '').toUpperCase() : '';
}

export function validarISBN13(isbn) {
    if (!/^\d{13}$/.test(isbn)) return false;
    let suma = 0;
    for (let i = 0; i < 12; i++) suma += Number(isbn[i]) * (i % 2 === 0 ? 1 : 3);
    const control = (10 - (suma % 10)) % 10;
    return control === Number(isbn[12]);
}

export function validarISBN10(isbn) {
    if (!/^\d{9}[\dX]$/.test(isbn)) return false;
    let suma = 0;
    for (let i = 0; i < 9; i++) suma += Number(isbn[i]) * (10 - i);
    suma += (isbn[9] === 'X' ? 10 : Number(isbn[9]));
    return suma % 11 === 0;
}

/** Devuelve el ISBN normalizado si es válido (10 o 13), o null. */
export function validarISBN(valor) {
    const n = normalizarIdentificador(valor);
    if (n.length === 13 && validarISBN13(n)) return n;
    if (n.length === 10 && validarISBN10(n)) return n;
    return null;
}

/** Convierte un ISBN-10 válido a su ISBN-13 equivalente (prefijo 978), o null. */
export function isbn10a13(valor) {
    const n = normalizarIdentificador(valor);
    if (!(n.length === 10 && validarISBN10(n))) return null;
    const cuerpo = '978' + n.slice(0, 9);
    let suma = 0;
    for (let i = 0; i < 12; i++) suma += Number(cuerpo[i]) * (i % 2 === 0 ? 1 : 3);
    return cuerpo + String((10 - (suma % 10)) % 10);
}

/** Convierte un ISBN-13 con prefijo 978 a su ISBN-10 equivalente, o null (979 no tiene ISBN-10). */
export function isbn13a10(valor) {
    const n = normalizarIdentificador(valor);
    if (!(n.length === 13 && validarISBN13(n)) || !n.startsWith('978')) return null;
    const cuerpo = n.slice(3, 12);
    let suma = 0;
    for (let i = 0; i < 9; i++) suma += Number(cuerpo[i]) * (10 - i);
    const control = (11 - (suma % 11)) % 11;
    return cuerpo + (control === 10 ? 'X' : String(control));
}

/**
 * Dado un ISBN válido devuelve sus formas equivalentes (10 y 13) normalizadas y sin duplicar.
 * Un libro suele estar indexado en las APIs por una de sus dos formas, no necesariamente
 * por la que trae el archivo; probar ambas evita falsos 404. Devuelve [] si no es válido.
 */
export function variantesISBN(valor) {
    const v = validarISBN(valor);
    if (!v) return [];
    const set = new Set([v]);
    const otro = v.length === 10 ? isbn10a13(v) : isbn13a10(v);
    if (otro) set.add(otro);
    return [...set];
}

/** Devuelve el ISSN normalizado "NNNN-NNNC" si es válido, o null. */
export function validarISSN(valor) {
    const n = normalizarIdentificador(valor);
    if (!/^\d{7}[\dX]$/.test(n)) return null;
    let suma = 0;
    for (let i = 0; i < 7; i++) suma += Number(n[i]) * (8 - i);
    const resto = suma % 11;
    const control = resto === 0 ? '0' : (11 - resto === 10 ? 'X' : String(11 - resto));
    if (control !== n[7]) return null;
    return `${n.slice(0, 4)}-${n.slice(4)}`;
}

/** Extrae un ISSN válido de texto libre (p. ej. capa de texto de un PDF de revista). */
export function extraerISSN(texto) {
    return extraerISSNs(texto)[0] || null;
}

// TODOS los ISSN válidos del texto, en orden de aparición y sin repetir. Una serie/revista suele llevar
// VARIOS en el CIP (impreso + electrónico; p. ej. Astronomers' Universe: 1614-659X impreso + 2197-6651
// e-ISSN). Capturarlos TODOS abre más caminos para resolver el nombre de la serie/cabecera por ISSN.
export function extraerISSNs(texto) {
    if (!texto) return [];
    // Tolerante a separadores raros entre "ISSN" y el número (p. ej. el espacio fino francés U+202F antes
    // de ':' → "ISSN : 2267-4284"). \D = cualquier no-dígito.
    const re = /ISSN\D{0,6}(\d{4}[-\s]?\d{3}[\dXx])/gi;
    const out = new Set();
    let m;
    while ((m = re.exec(texto)) !== null) {
        const v = validarISSN(m[1]);
        if (v) out.add(v);
    }
    return [...out];
}
