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
    // DISTRIBUIDORES e inventarios de librería: las APIs los dan como «editorial» de la edición que importan
    // (medido el 30-sep: «Distribooks Inc» sustituyendo a «Hodder Children's Books» en los Astérix, «Firebird
    // Distributing», «Libros Sin Fronteras Inventory»). No editan: distribuyen.
    /distribooks/i,
    /\bdistribut(ing|ors?|ion)\b/i,
    /\binventory\b/i,
    /libros\s+sin\s+fronteras/i,
    // Marcadores de «editorial desconocida» que algunas fuentes ponen en vez de dejar el campo vacío (medido:
    // «Unknown Publisher - Being Researched» en el Fichero): no son una editorial.
    /^(unknown|other|others|n\/a|none|desconocid[ao]|varios|various)$/i,
    /unknown\s+publisher|being\s+researched|publisher\s+not\s+identified|^\[?s\.\s?n\.\]?$|^sin\s+editorial$|editor\s+no\s+identificado/i,
];

/** ¿Es `nombre` uno de esos grupos/re-editores (no una editorial real)? */
export function esEditorialFalsa(nombre) {
    return !!nombre && EDITORIALES_NO_VALIDAS.some((re) => re.test(String(nombre)));
}

/**
 * Nombre de editorial LIMPIO de la puntuación que arrastra de la ficha catalográfica (ISBD: «Valdemar,»,
 * «Ultramar.», «Alianza, etc.»). Medido el 30-sep: esas variantes creaban editoriales duplicadas.
 * El punto final se quita solo tras una PALABRA (4+ letras): «S.A.» o «Ed.» se quedan como están.
 */
export function limpiarNombreEditorial(nombre) {
    if (nombre === undefined || nombre === null) return nombre;
    let s = String(nombre).replace(/\s+/g, ' ').trim();
    s = s.replace(/^[\s.,;:·\-«»"'\[\]]+/, '');   // restos al principio: «[Destino», «, Planeta»
    s = s.replace(/[\s,;]+etc\.?$/i, '');         // «Alianza, etc» (la ficha abrevia varios pies de imprenta)
    s = s.replace(/[\s,;:/·\-«»"'\[\]]+$/, '');   // al final: «Planeta]», «Acantilado,», «Anagrama;»
    // Un paréntesis final solo se quita si está DESPAREJADO («Orion (an Imprint of … Ltd)» se queda).
    if (/\)$/.test(s) && (s.match(/\(/g) || []).length < (s.match(/\)/g) || []).length) s = s.replace(/\)+$/, '').trim();
    if (/^\(/.test(s) && (s.match(/\(/g) || []).length > (s.match(/\)/g) || []).length) s = s.replace(/^\(+/, '').trim();
    s = s.replace(/(\p{L}{4,})\.$/u, '$1');   // «Ultramar.» → «Ultramar» (pero «S.A.» sigue igual)
    return s.trim();
}
