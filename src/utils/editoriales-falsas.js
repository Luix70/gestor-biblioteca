/**
 * «Editoriales» que en realidad son GRUPOS DE MAQUETACIÓN/DIFUSIÓN o RE-EDITORES de dominio público, NO casas
 * editoriales de verdad. Fuente ÚNICA de la lista (antes estaba duplicada, con criterios distintos, en
 * `motor-enriquecimiento.js` y `utils/reclasificar-editorial.js`).
 *
 * Regla de uso: si el archivo o una API trae una de estas, NO es autoritativa —
 *  · en el enriquecimiento, una editorial REAL (de las APIs, del colofón o inferida de la colección) prevalece;
 *  · en el reclasificador, si no hallamos una real, se PROPONE QUITARLA (mejor sin editorial que una falsa).
 *
 * Dos familias:
 *  1. Repositorios/maquetadores de ebooks (a menudo escaneos de la comunidad): ePubLibre, Lectulandia, epubGratis…
 *  2. Re-editores de CLÁSICOS en dominio público que las APIs (Google Books) devuelven para un ISBN de una
 *     reedición barata: DigiCat, Good Press, e-artnow, Musaicum… (todos del mismo grupo). Para un clásico
 *     traducido, la editorial que importa es la de ESTA edición (p. ej. Anaya «Tus Libros»), no el re-editor.
 */
export const EDITORIALES_NO_VALIDAS = [
    /epub\s*libre/i,
    /lectulandia/i,
    /oz\s*epub/i,
    /todo\s*epub/i,
    /epub\s*gratis/i,
    /digicat/i,
    /good\s*press/i,
    /e-?artnow/i,
    /musaicum/i,
    // Plataformas de AUTOPUBLICACIÓN (Amazon KDP/CreateSpace, Lulu…): no son casas editoriales — las APIs las
    // devuelven como «editorial» de reediciones baratas de clásicos. Mismo tratamiento que los repackagers.
    /createspace/i,
    /independently\s+published/i,
    /\bkdp\b|kindle\s+direct/i,
    /\blulu(\.com|\s+press)?\b/i,
    // Marcadores de «editorial desconocida» que algunas fuentes ponen en vez de dejar el campo vacío (medido:
    // «Unknown Publisher - Being Researched» en el Fichero): no son una editorial.
    /unknown\s+publisher|being\s+researched|publisher\s+not\s+identified|^\[?s\.\s?n\.\]?$|^sin\s+editorial$|editor\s+no\s+identificado/i,
];

/** ¿Es `nombre` uno de esos grupos/re-editores (no una editorial real)? */
export function esEditorialFalsa(nombre) {
    return !!nombre && EDITORIALES_NO_VALIDAS.some((re) => re.test(String(nombre)));
}
