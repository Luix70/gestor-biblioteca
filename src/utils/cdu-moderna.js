/**
 * CDU: LIMPIA, EN NOTACIÓN MODERNA, y CÓMO UBICAR una CDU compuesta.
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
 *
 * 3) Lo que enseñó el log completo de la pasada (30-sep, 1.219 CDU de la BNE aplicadas) y la base entera:
 *    · ENCABEZAMIENTOS pegados al número: «929 Tesla, Nikola», «821.111 Shakespeare, William 1.07», «004.438
 *      Python», «53 Feynman, Richard Phillips» (456 documentos). Es la extensión alfabética de la BNE: como código
 *      convertía cada persona en una CDU distinta (una carpeta y una descripción con IA por persona). El número se
 *      queda solo; el nombre no se pierde: `encabezamientoCDU` lo devuelve para guardarlo como materia.
 *    · Espacios sueltos: «821.111 (73)-31"19"» → «821.111(73)-31"19"».
 *    · HISTORIA en notación antigua (o Dewey, que aquí coincide): el número era 9 + el auxiliar de lugar — 946
 *      España, 944 Francia, 937 Roma, 938 Grecia, 973 EE. UU.… (más de 1.500 documentos, de la BNE y de la IA).
 *      Hoy es 94(lugar): 946.081 → 94(460).081 · 937 → 94(37) · 949.5 → 94(495) · 940.53 → 94(100)"1939/1945".
 *    · Biografía: 92 → 929. Informática: 681.3 → 004. Más literaturas: 871 latina, 875 griega clásica, 839.x
 *      nórdicas y neerlandesa, 894.5xx ugrofinesas, 895.x china y japonesa, 892.x árabe y hebrea.
 */

// ─── Literatura: número principal antiguo → moderno. Clave = número de la faceta tal cual (sin auxiliares). ─────
const LITERATURA_ANTIGUA = {
    '820': '821.111',        // inglesa
    '830': '821.112.2',      // alemana
    '839.3': '821.112.5',    // neerlandesa
    '839.31': '821.112.5',
    '839.7': '821.113.6',    // sueca
    '839.8': '821.113.4',    // danesa (839.8 = danesa y noruega; 839.82, la noruega)
    '839.81': '821.113.4',
    '839.82': '821.113.5',   // noruega
    '840': '821.133.1',      // francesa
    '849.9': '821.134.1',    // catalana
    '850': '821.131.1',      // italiana
    '859.0': '821.135.1',    // rumana
    '860': '821.134.2',      // española
    '869': '821.134.3',      // portuguesa
    '869.0': '821.134.3',
    '869.9': '821.134.4',    // gallega
    '870': '821.124',        // latina
    '871': '821.124',
    '875': "821.14'02",      // griega clásica
    '882': '821.161.1',      // rusa
    '883': '821.161.2',      // ucraniana
    '884': '821.162.1',      // polaca
    '885': '821.162.3',      // checa
    '892.4': '821.411.16',   // hebrea
    '892.7': '821.411.21',   // árabe
    '894.511': '821.511.141', // húngara
    '894.541': '821.511.111', // finesa
    '894.545': '821.511.113', // estonia
    '895.1': '821.581',      // china
    '895.6': '821.521',      // japonesa
};

// ─── Historia: 9 + auxiliar de lugar → 94(lugar). Lugares cuyo auxiliar cambió de forma con la notación. ───────
const LUGAR_MODERNO = {
    '41': '410',     // Reino Unido
    '42': '410.1',   // Inglaterra
    '43': '430',     // Alemania
    '45': '450',     // Italia
    '46': '460',     // España
    '51': '510',     // China
    '52': '520',     // Japón
    '54': '540',     // India
    '62': '620',     // Egipto
};

/** Pone los puntos de un auxiliar de lugar escrito de corrido: «5491» → «549.1». */
const conPuntos = (cifras) => cifras.replace(/(\d{3})(?=\d)/g, '$1.');

/** Historia de Europa en general (940.x): los periodos iban como decimales; hoy, como fechas. */
function europaModerna(decimales) {
    if (!decimales) return '94(4)';
    if (/^53|^54/.test(decimales)) return '94(100)"1939/1945"';   // Segunda Guerra Mundial
    if (/^[34]/.test(decimales)) return '94(100)"1914/1918"';      // Primera Guerra Mundial
    if (/^1/.test(decimales)) return '94(4)"04/14"';               // Edad Media
    if (/^2/.test(decimales)) return '94(4)"14/17"';               // Edad Moderna
    if (/^5/.test(decimales)) return '94(4)"19"';                  // siglo XX
    return '94(4)';
}

/** «946.081» → «94(460).081» · «949.5» → «94(495)» · «937» → «94(37)». null si no es historia antigua. */
function historiaModerna(numero) {
    const m = numero.match(/^9([3-9]\d)(?:\.(\d+(?:\.\d+)*))?$/);
    if (!m) return null;
    const [, base, decimales = ''] = m;
    if (base === '30') return null;                       // 930…: ciencia de la historia, vigente (930.1, 930.85)
    if (base === '40') return europaModerna(decimales.replace(/\./g, ''));
    // Tras el lugar, los decimales siguen siendo LUGAR hasta el primer 0 (949.5 = Grecia), y desde el 0 son el
    // PERIODO (946.081, 949.502). «946.0» a secas es España, sin periodo.
    const cifras = decimales.replace(/\./g, '');
    const partes = cifras.match(/^([1-9]*)(0\d*)?$/);
    if (!partes) return null;
    // Excepción: en la historia de EE. UU. los decimales sin cero son PERIODOS (973.2 colonial, 973.7 guerra civil),
    // no lugares. No hay traducción segura a fechas: se deja como está.
    if (base === '73' && partes[1]) return null;
    const lugar = conPuntos(base + partes[1]);
    const periodo = partes[2] && partes[2] !== '0' ? `.${conPuntos(partes[2])}` : '';
    return `94(${LUGAR_MODERNO[lugar] || lugar})${periodo}`;
}

/** Traduce el número principal de una faceta (sin auxiliares). Devuelve el mismo si no hay nada que traducir. */
function numeroModerno(numero) {
    if (LITERATURA_ANTIGUA[numero]) return LITERATURA_ANTIGUA[numero];
    // Historia y crítica de una literatura: «860.09» → «821.134.2.09».
    const critica = numero.match(/^(\d{3}(?:\.\d+)?)(\.0\d*)$/);
    if (critica && LITERATURA_ANTIGUA[critica[1]]) return LITERATURA_ANTIGUA[critica[1]] + critica[2];
    if (numero === '92') return '929';                                  // biografía
    if (/^681\.3\d?\.06/.test(numero)) return '004.4';                  // programación (681.3.06)
    if (/^681\.3/.test(numero)) return '004';                           // informática
    return historiaModerna(numero) || numero;
}

/**
 * Las facetas de una relación, partidas por los «:» que están FUERA de paréntesis y comillas: en «327(73:510)» o
 * «929(0:82)» los dos puntos son de un auxiliar, no separan facetas.
 */
function partirFacetas(cdu) {
    const facetas = [];
    let actual = '', hondura = 0, entreComillas = false;
    for (const c of cdu) {
        if (c === '"') entreComillas = !entreComillas;
        else if (c === '(' && !entreComillas) hondura++;
        else if (c === ')' && !entreComillas && hondura > 0) hondura--;
        if (c === ':' && hondura === 0 && !entreComillas) { facetas.push(actual); actual = ''; }
        else actual += c;
    }
    facetas.push(actual);
    return facetas;
}

/** Traduce una faceta («820(73)-31"19"») si su número principal es de la notación antigua. */
function modernizarFaceta(faceta) {
    const m = faceta.match(/^(\s*)(\d+(?:\.\d+)*)(.*)$/s);
    if (!m) return faceta;
    const [, espacio, numero, resto] = m;
    return `${espacio}${numeroModerno(numero)}${resto}`;
}

// Un ENCABEZAMIENTO tras el número: espacio + palabra que empieza por mayúscula y tiene 2+ letras («Tesla, Nikola»,
// «Python», «Alejandro Magno (38)»). «94(460.355 C.)"18"» no lo es (una letra, y dentro de un paréntesis).
const RE_ENCABEZAMIENTO = new RegExp(String.raw`^(.*?[\d)"'])\s+(\p{Lu}\p{L}.*)$`, 'su');

/** Parte una CDU con encabezamiento: { numero, encabezamiento }. Sin encabezamiento → { numero: cdu, encabezamiento: null }. */
function partirEncabezamiento(cdu) {
    const m = String(cdu).match(RE_ENCABEZAMIENTO);
    if (!m) return { numero: cdu, encabezamiento: null };
    const [, numero, texto] = m;
    // Dentro de un paréntesis abierto no es un encabezamiento, es parte de un auxiliar.
    const abiertos = (numero.match(/\(/g) || []).length - (numero.match(/\)/g) || []).length;
    if (abiertos !== 0) return { numero: cdu, encabezamiento: null };
    return { numero, encabezamiento: texto.trim() };
}

/**
 * El ENCABEZAMIENTO que acompaña a una CDU de la BNE («929 Tesla, Nikola» → «Tesla, Nikola»; «004.438 Python» →
 * «Python»), sin los auxiliares que lo siguen. null si no lo hay. Es una MATERIA: quien limpia la CDU lo guarda
 * como palabra clave para no perderlo.
 */
export function encabezamientoCDU(cdu) {
    if (typeof cdu !== 'string') return null;
    const { encabezamiento } = partirEncabezamiento(cdu);
    if (!encabezamiento) return null;
    // Sin los auxiliares ni los números de subdivisión que lo siguen: «Wilde, Oscar (0:82)» → «Wilde, Oscar».
    const limpio = encabezamiento.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+[\d.]+\s*$/, '').replace(/\s+/g, ' ').trim();
    return limpio.length >= 3 ? limpio : null;
}

/** CDU sin encabezamiento ni espacios sueltos: «929 Tesla, Nikola» → «929»; «821.111 (73)-31» → «821.111(73)-31». */
export function limpiarCDU(cdu) {
    if (typeof cdu !== 'string') return cdu;
    const { numero } = partirEncabezamiento(cdu.trim());
    // Espacios: sobran salvo que separen letras (un auxiliar con texto: «(460.355 C.)»).
    return numero.replace(/\s+(?=[("':\-/=+])/g, '').replace(/(?<=[)"':\-/=+.\d])\s+(?=[\d(])/g, '').trim();
}

/**
 * CDU limpia y con notación moderna. Cada faceta de una relación («087.5:820(73)») se traduce por separado.
 * Devuelve la misma cadena si no hay nada que cambiar (o si no es una CDU).
 */
export function modernizarCDU(cdu) {
    if (cdu === undefined || cdu === null) return cdu;
    const s = limpiarCDU(String(cdu));
    if (!/\d/.test(s)) return cdu;
    return partirFacetas(s).map(modernizarFaceta).join(':');
}

/** ¿Hay algo que limpiar o traducir? (para diagnósticos y el script de saneado) */
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
    const facetas = partirFacetas(moderna);
    if (facetas.length < 2 || !/^\s*087(?:\.\d+)*/.test(facetas[0])) return moderna;
    const resto = facetas.slice(1);
    if (!/^\s*\d/.test(resto[0])) return moderna;
    return [...resto, facetas[0]].map((f) => f.trim()).join(':');
}
