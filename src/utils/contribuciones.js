/**
 * Extrae CONTRIBUYENTES con su ROL a partir de una mención de responsabilidad en TEXTO LIBRE, que es como
 * lo publican las fuentes: OpenLibrary `by_statement` («… translated … by David McDuff», «edición de Jacques
 * Joset») y BNE `mencion_de_autores` (contribuyentes separados por «/**​/»). No hay campo estructurado de
 * roles, así que se detectan por PALABRAS CLAVE (ES/EN/algo de FR/DE) y se toma el nombre que sigue a
 * «by/de/di/von». Heurístico y conservador: ante la duda NO inventa un rol.
 *
 * Roles reconocidos (canónicos): autor · traductor · ilustrador · prologuista · anotador · editor · compilador.
 * Devuelve [{ nombre, rol }] SIN el autor principal (ese va por `autores`); dedup por (nombre,rol).
 */

// Marca de la BNE que separa contribuyentes en `mencion_de_autores`. Construida con new RegExp (regla del
// proyecto para clases de caracteres frágiles).
const RE_MARCA_BNE = new RegExp('\\/\\*+\\/?', 'g');

// Cada rol con las palabras clave que lo delatan en la mención (minúsculas, sin acento se normaliza antes).
const REGLAS_ROL = [
    { rol: 'traductor', re: /traduc|translat|ubersetz|traduction/ },
    { rol: 'ilustrador', re: /ilustrac|ilustrad|dibujos|grabados|illustrat|laminas/ },
    { rol: 'prologuista', re: /prologo|prologad|introduccion|introduction|preface|prefacio|estudio preliminar|vorwort/ },
    { rol: 'anotador', re: /\bnotas\b|anotad|\bnotes\b|comentari|annotat/ },
    { rol: 'editor', re: /edicion de|edited by|\beditor|a cura|herausg|edicion literaria|edicion a cargo/ },
    { rol: 'compilador', re: /compilac|compilad|compiled|seleccion|antolog|recopilac/ },
];

// Conector tras el cual viene el NOMBRE en la mención («… by X», «… de X», «… por X», «… di X», «… von X»).
// «por» es el «by» español (traducido POR X, ilustrado POR X); se toma el nombre tras el ÚLTIMO conector.
const RE_TRAS_CONECTOR = /\b(?:by|de|del|por|di|von|par|av)\b\s+([^;]+)$/i;

// Quita acentos y baja a minúsculas para casar las palabras clave sin depender de tildes.
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const sinAcentos = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '');

// Limpia un nombre suelto: recorta, quita puntuación de borde y fechas de vida «(1857-1924)».
function limpiarNombre(raw) {
    return String(raw || '')
        .replace(/\(\s*(?:n\.\s*)?\d{3,4}\s*[-–—]?\s*\d{0,4}\s*\)?/g, ' ') // fechas de vida
        .replace(/\s+/g, ' ')
        .replace(/^[\s.,;:—–-]+|[\s.,;:—–-]+$/g, '')
        .trim();
}

// Parte una lista de nombres unidos por « y / and / & / e ».
function partirNombres(s) {
    return String(s || '')
        .split(/\s+(?:y|e|and|&|und|et)\s+/i)
        .map(limpiarNombre)
        .filter((n) => n && n.length >= 3 && /[a-zà-ÿ]/i.test(n));
}

/**
 * Analiza UN segmento (una responsabilidad) y devuelve sus contribuciones. Un segmento puede llevar varios
 * roles a la vez para el mismo nombre («translated with an introduction and notes by X» → traductor +
 * prologuista + anotador). Sin conector «by/de…» o sin rol reconocido → no aporta nada.
 */
function analizarSegmento(segmento) {
    const norm = sinAcentos(segmento);
    const roles = REGLAS_ROL.filter((r) => r.re.test(norm)).map((r) => r.rol);
    if (!roles.length) return [];
    const m = segmento.match(RE_TRAS_CONECTOR);
    if (!m) return [];
    const nombres = partirNombres(m[1]);
    const out = [];
    for (const nombre of nombres) for (const rol of roles) out.push({ nombre, rol });
    return out;
}

/**
 * Extrae contribuciones (con rol) de una mención de responsabilidad en texto libre.
 * @param {string} texto  by_statement (OL) o mencion_de_autores (BNE).
 * @param {{ autoresConocidos?: string[] }} opciones  nombres de autores ya conocidos (se excluyen).
 * @returns {{nombre:string, rol:string}[]}
 */
export function extraerContribuciones(texto, { autoresConocidos = [] } = {}) {
    const base = String(texto || '').trim();
    if (!base) return [];
    // Segmentos: por «;» y por la marca «/**​/» de la BNE.
    const segmentos = base.replace(RE_MARCA_BNE, ';').split(';').map((s) => s.trim()).filter(Boolean);
    const autoresNorm = new Set(autoresConocidos.map((a) => sinAcentos(a).replace(/\s+/g, ' ').trim()));

    const vistos = new Set();
    const out = [];
    for (const seg of segmentos) {
        for (const c of analizarSegmento(seg)) {
            const claveNombre = sinAcentos(c.nombre).replace(/\s+/g, ' ').trim();
            if (autoresNorm.has(claveNombre)) continue; // ya es autor principal: no duplicar como contribuyente
            const clave = `${claveNombre}|${c.rol}`;
            if (vistos.has(clave)) continue;
            vistos.add(clave);
            out.push(c);
        }
    }
    return out;
}

// Roles válidos (para validar entradas manuales del panel). 'autor' incluido por completitud.
export const ROLES_VALIDOS = ['autor', 'traductor', 'ilustrador', 'prologuista', 'anotador', 'editor', 'compilador'];

// Rol canónico → relator MARC 21 (para el $e de los campos 700/701 en marc21.js).
export const REL_MARC = {
    autor: 'aut', traductor: 'trl', ilustrador: 'ill', prologuista: 'aui',
    anotador: 'ann', editor: 'edt', compilador: 'com',
};
