/**
 * CDU: NOTACIÓN ANTIGUA → MODERNA, y CÓMO UBICAR una CDU compuesta.
 *
 * 1) Notación antigua de la literatura. Hasta los años 90 la CDU ponía la literatura de cada lengua con el
 *    número de la lengua en la clase 8: 820 inglesa, 840 francesa, 860 española… Hoy es 821.<lengua>: 821.111,
 *    821.133.1, 821.134.2. Muchas fichas de la BNE (y CIP impresos de libros viejos) siguen con la antigua.
 *    Aplicarla tal cual partía el árbol en dos: Asimov en 8/821/821.111(73)… y en 8/820/820(73)-31"19"
 *    (medido el 30-sep en la pasada de reidentificar-sin-isbn: toda la tanda de Ultramar, Destino, Caralt…).
 *    `modernizarCDU` traduce SOLO el número principal de cada faceta; los auxiliares (lugar, forma, época) se
 *    conservan: 820(73)-31"19" → 821.111(73)-31"19"; 860(82)-31 → 821.134.2(82)-31.
 *    Conservador: solo las equivalencias seguras; lo demás se deja como está.
 *
 * 2) Publicaciones juveniles (087.5). La BNE clasifica los clásicos juveniles como 087.5:82 («publicaciones para
 *    jóvenes» : literatura). Es correcto, pero ubicarlo por la primera faceta los mandaba a la clase 0 (obras
 *    generales). Decisión del usuario (30-sep, opción A): se UBICAN por la parte literaria. `cduParaUbicar`
 *    pone la faceta 087… al final (la relación «:» es reversible en la CDU): 087.5:821.111 → 821.111:087.5.
 *    El valor guardado en la base no cambia; solo decide la carpeta.
 */

// Número principal antiguo → moderno. Clave = número de la faceta tal cual (sin auxiliares).
const LITERATURA_ANTIGUA = {
    '820': '821.111',       // inglesa
    '830': '821.112.2',     // alemana
    '840': '821.133.1',     // francesa
    '849.9': '821.134.1',   // catalana
    '850': '821.131.1',     // italiana
    '860': '821.134.2',     // española
    '869': '821.134.3',     // portuguesa
    '869.0': '821.134.3',
    '870': '821.124',       // latina
    '882': '821.161.1',     // rusa
    '884': '821.162.1',     // polaca
    '885': '821.162.3',     // checa
};

/** Traduce una faceta («820(73)-31"19"») si su número principal es de la notación antigua. */
function modernizarFaceta(faceta) {
    const m = faceta.match(/^(\s*)(\d+(?:\.\d+)*)(.*)$/s);
    if (!m) return faceta;
    const [, espacio, numero, resto] = m;
    const moderno = LITERATURA_ANTIGUA[numero];
    return moderno ? `${espacio}${moderno}${resto}` : faceta;
}

/**
 * CDU con la literatura en notación moderna. Cada faceta de una relación («087.5:820(73)») se traduce por
 * separado. Devuelve la misma cadena si no hay nada que traducir (o si no es una CDU).
 */
export function modernizarCDU(cdu) {
    if (cdu === undefined || cdu === null) return cdu;
    const s = String(cdu);
    if (!/\d/.test(s)) return cdu;
    return s.split(':').map(modernizarFaceta).join(':');
}

/** ¿Tiene alguna faceta en notación antigua? (para diagnósticos y el script de saneado) */
export function esCduAntigua(cdu) {
    return typeof cdu === 'string' && modernizarCDU(cdu) !== cdu;
}

/**
 * La CDU tal como se usa para decidir la CARPETA: moderna y, si empieza por una faceta de publicación especial
 * (087…, p. ej. 087.5 juvenil) relacionada con otra, con esa faceta al final.
 *   087.5:82                    → 82:087.5
 *   087.5:820(73)-34"18"        → 821.111(73)-34"18":087.5
 *   087.5                       → 087.5          (sin otra faceta: se queda en la clase 0)
 */
export function cduParaUbicar(cdu) {
    const moderna = modernizarCDU(cdu);
    if (typeof moderna !== 'string') return moderna;
    const facetas = moderna.split(':');
    if (facetas.length < 2 || !/^\s*087(?:\.\d+)*/.test(facetas[0])) return moderna;
    const resto = facetas.slice(1);
    if (!/^\s*\d/.test(resto[0])) return moderna;
    return [...resto, facetas[0]].map((f) => f.trim()).join(':');
}
