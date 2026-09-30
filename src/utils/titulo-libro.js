/**
 * ¿MISMO TÍTULO DE LIBRO? Para decidir si dos documentos con el mismo ISBN son el MISMO libro (otra versión u otro
 * formato) o dos libros distintos que comparten un ISBN equivocado.
 *
 * Antes se exigía igualdad exacta, y el 30-sep salieron como «otro título» parejas que eran el mismo libro:
 *   «Colmillo Blanco (Ilustrado)» / «Colmillo Blanco» · «Un drama en Livonia (ilustrado)» / «Un drama en Livonia»
 *   «La flecha negra (Ilustrado)» / «La flecha negra» · «Tom Sawyer … - Tom Sawyer detective» / «… : … detective.»
 *   «The Elegant Universe: Superstrings, Hidden…» / «The Elegant Universe» (con y sin subtítulo)
 * Ahora se quitan los paréntesis y corchetes (ilustrado, trad., ed.…), y basta con que sean iguales, que uno sea el
 * comienzo del otro (subtítulo; el corto con 2+ palabras) o que difieran en 1-2 letras (títulos de 8+ letras).
 * «El monstruo subatómico» / «Isaac Asimov» o «El fin de la eternidad» / «The End of Eternity» siguen siendo
 * distintos (el segundo, otro idioma: se revisa a mano).
 */
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const RE_PARENTESIS = new RegExp('\\([^()]*\\)|\\[[^\\]]*\\]', 'g');

/** Título reducido a letras y números, sin acentos ni lo que va entre paréntesis o corchetes. */
export function tituloComparable(titulo) {
    return String(titulo || '')
        .replace(RE_PARENTESIS, ' ')
        .toLowerCase()
        .normalize('NFD')
        .replace(RE_DIACRITICOS, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Distancia de edición (Levenshtein); devuelve 3 en cuanto se sabe que pasa de 2 (no hace falta más). */
function distanciaEdicion(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let previa = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const fila = [i];
        for (let j = 1; j <= b.length; j++) {
            const sustituir = previa[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            fila[j] = Math.min(previa[j] + 1, fila[j - 1] + 1, sustituir);
        }
        previa = fila;
    }
    return previa[b.length];
}

/** Los números del título (arábigos y romanos sueltos), en orden, como texto comparable. */
const RE_ROMANO = /^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
function numerosDe(comparable) {
    return comparable.split(' ').filter((t) => /^\d+$/.test(t) || RE_ROMANO.test(t)).join(' ');
}

/**
 * Errata de OCR en un número: «II3» por «113», «l0» por «10». Solo en palabras que MEZCLAN cifras con I/l (una
 * palabra solo de letras —«II», «Ill»— no se toca: es un romano o una palabra).
 */
const corregirNumerosOcr = (texto) => String(texto || '').replace(/\b(?=[Il|\d]*\d)[Il|\d]{2,}\b/g, (p) => p.replace(/[Il|]/g, '1'));

/**
 * Las PARTES de un título separadas por «:» o «,» con cuerpo («Microcosmos: cuatro mil millones de años…»,
 * «Constantinopla, El imperio olvidado», «Historia universal Asimov: El Imperio Romano»).
 */
const partesDelTitulo = (titulo) => String(titulo || '').replace(RE_PARENTESIS, ' ').split(/\s*[:,]\s+|\s+[-–—]\s+/)
    .map(tituloComparable).filter((p) => p.length >= 4);

export function mismoTituloLibro(a, b) {
    a = corregirNumerosOcr(a);
    b = corregirNumerosOcr(b);
    const A = tituloComparable(a);
    const B = tituloComparable(b);
    if (!A || !B) return false;
    if (A === B) return true;

    // Uno es entero una PARTE del otro (título y subtítulo separados por «:» o «,»): «Microcosmos» y «Microcosmos:
    // cuatro mil millones de años…»; «El Imperio Romano» y «Historia universal Asimov: El Imperio Romano». Medido en
    // el log del 1-oct: salían como «otro título» y el libro se quedaba sin su ISBN. Una palabra suelta vale solo si
    // tiene cuerpo (6+ letras) y los números coinciden: «Dune» / «Casa Capitular Dune» no tiene separador.
    const [cortoA, largoA] = A.length <= B.length ? [a, b] : [b, a];
    const corto0 = tituloComparable(cortoA);
    if (numerosDe(A) === numerosDe(B) && partesDelTitulo(largoA).slice(0, 2).concat(partesDelTitulo(largoA).slice(-1)).includes(corto0)
        && (corto0.split(' ').length >= 2 || corto0.length >= 6)) return true;

    // Los NÚMEROS deben coincidir: «El señor de los anillos 2» empieza por «El señor de los anillos», y «Tomo 1» /
    // «Tomo 2» se diferencian en una letra, pero son tomos distintos (el caso que motivó esta comprobación).
    // Precio: «El expediente 113» / «II3» queda como distinto → se revisa a mano (mejor que fusionar dos tomos).
    if (numerosDe(A) !== numerosDe(B)) return false;

    // Uno es el comienzo del otro: el mismo título con y sin subtítulo.
    const [corto, largo] = A.length <= B.length ? [A, B] : [B, A];
    if (corto.split(' ').length >= 2 && largo.startsWith(corto + ' ')) return true;

    // Una errata (OCR, tilde perdida, «113» / «II3»): solo en títulos con cuerpo, o «Ella» = «Eva».
    return corto.length >= 8 && distanciaEdicion(A, B) <= 2;
}

/**
 * Comparación MÁS HOLGADA, para títulos que aún arrastran restos del nombre del fichero: «Homer - Odyssey (Barnes &
 * Noble, 2003)» / «Odyssey (Barnes & Noble Classics Series)», «A Neolithic Ceremonial Complex…» / «Neolithic
 * Ceremonial Complex…», «STORK, P. (2008), Index of Verb Forms in Thucydides» / «Index of Verb Forms in Thucydides».
 * Mismo libro si los números coinciden y casi todas las palabras con cuerpo del título más corto están en el otro.
 * Sirve para decidir si dos documentos con el mismo ISBN son sospechosos (dos títulos) o no (dos copias); NO para
 * dar por bueno un ISBN.
 */
export function mismoLibroHolgado(a, b) {
    if (mismoTituloLibro(a, b)) return true;
    const A = tituloComparable(a);
    const B = tituloComparable(b);
    if (!A || !B || numerosDe(A) !== numerosDe(B)) return false;
    const palabras = (texto) => new Set(texto.split(' ').filter((w) => w.length > 3));
    const [corto, largo] = palabras(A).size <= palabras(B).size ? [palabras(A), palabras(B)] : [palabras(B), palabras(A)];
    if (corto.size < 2) return false;
    const comunes = [...corto].filter((w) => largo.has(w)).length;
    return comunes / corto.size >= 0.8;
}
