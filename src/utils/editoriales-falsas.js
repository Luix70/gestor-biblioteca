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
    // Grupo francés que digitaliza clásicos (Zola, Simenon…), como ePubLibre en español: no es la editorial (1-oct:
    // salía como «editorial» de «Los Rougon-Macquart», «Maigret» y «Le Livre de poche»).
    /alexandriz/i,
    /\bebsco\b/i,   // agregador de ebooks para bibliotecas: lo da como «editorial» de lo que distribuye (1-oct)
    /bibebook/i,   // ídem (bibliotecas francesas gratuitas: «Collection Folio» y «Le Livre de poche» salían de Bibebook)
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
 *
 * Paréntesis, corchetes y comillas de los bordes solo se quitan si están DESPAREJADOS («Planeta]», «[Destino»), o si
 * envuelven el nombre entero («"Catacora"», «[Society of Jesus]»). Los equilibrados se quedan: «Wiley [Imprint]»,
 * «Editorial «Mir»», «Orion (an Imprint of … Ltd)» (el primer ensayo, 30-sep, los rompía).
 * El punto final se quita solo tras una palabra de 5+ letras («Ultramar.», «Destino.»): las abreviaturas se quedan
 * («S.A.», «Corp.», «Comp.», «Inc.»).
 */
const PARES = [['(', ')'], ['[', ']'], ['«', '»'], ['"', '"'], ['“', '”']];
const veces = (s, c) => s.split(c).length - 1;
const desparejado = (s, abre, cierra) => (abre === cierra ? veces(s, abre) % 2 === 1 : veces(s, abre) !== veces(s, cierra));

export function limpiarNombreEditorial(nombre) {
    if (nombre === undefined || nombre === null) return nombre;
    let s = String(nombre).replace(/\s+/g, ' ').trim();
    // «Alianza, etc», «Printed for J. Johnson [etc.]», «…; [etc., etc.]»: la ficha abrevia varios pies de imprenta.
    s = s.replace(/[\s,;]+(\[?etc\.?\]?[\s,.]*)+$/i, '');

    let previo;
    do {
        previo = s;
        s = s.replace(/^[\s.,;:·\-/]+/, '').replace(/[\s,;:·\-/]+$/, '');   // «, Planeta», «Acantilado,», «Anagrama;»
        for (const [abre, cierra] of PARES) {
            if (s.endsWith(cierra) && desparejado(s, abre, cierra)) s = s.slice(0, -cierra.length);
            if (s.startsWith(abre) && desparejado(s, abre, cierra)) s = s.slice(abre.length);
            // El nombre ENTERO envuelto en un par, sin más pares dentro: se quita el par.
            const dentro = s.slice(abre.length, s.length - cierra.length);
            if (s.length > abre.length + cierra.length && s.startsWith(abre) && s.endsWith(cierra)
                && !dentro.includes(abre) && !dentro.includes(cierra)) s = dentro;
        }
        s = s.trim();
    } while (s !== previo);

    s = s.replace(/(\p{L}{5,})\.$/u, '$1');   // «Ultramar.» → «Ultramar» (pero «S.A.», «Corp.» siguen igual)
    return s.trim();
}
