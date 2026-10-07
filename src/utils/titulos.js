/**
 * Normalización de TÍTULOS del volcado bibliográfico (BNE / MARC 245).
 *
 * El dump de la BNE arrastra la PUNTUACIÓN ISBD del campo 245: el subcampo de título ($a) va seguido de un
 * « :» antes del subtítulo ($b), y algunos registros unen ambos con «::». Al catalogar por Fichero eso deja
 * títulos con «::» (en medio o al final) y con «:» colgando al final. Este módulo lo limpia:
 *
 *   · «::»  → delimitador TÍTULO :: SUBTÍTULO. Se divide en el PRIMERO; lo de después ocupa el subtítulo SOLO
 *             si el documento no traía uno (no se pisa un subtítulo ya presente).
 *   · «:» FINAL (uno o varios, con espacios) → puntuación ISBD colgante: se quita del título y del subtítulo.
 *
 * NO toca un «:» INTERIOR legítimo (p. ej. «Sapiens: de animales a dioses»): solo divide en «::» y quita los
 * dos-puntos FINALES. Es idempotente. Devuelve { titulo, subtitulo }.
 */

// Colapsa espacios y quita la ristra final de dos-puntos/espacios (ISBD colgante). No toca los «:» interiores.
const pulir = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').replace(/[\s:]+$/, '').trim();

export function normalizarTituloBibliografico(titulo, subtitulo = null) {
    const tOrig = String(titulo == null ? '' : titulo).replace(/\s+/g, ' ').trim();
    let t = tOrig;
    let s = String(subtitulo == null ? '' : subtitulo).replace(/\s+/g, ' ').trim();

    // «::» separa título :: subtítulo (subcampos del dump). Se parte en el PRIMERO; cualquier «::» que quedara
    // en el resto se rebaja a un « : » normal (para no dejar dobles dos-puntos en ningún lado).
    const idx = t.indexOf('::');
    if (idx >= 0) {
        const despues = t.slice(idx + 2).replace(/\s*::\s*/g, ' : ').replace(/\s+/g, ' ').trim();
        t = t.slice(0, idx).trim();
        if (!s && despues) s = despues; // solo si el doc no traía subtítulo
    }

    t = pulir(t);
    s = pulir(s);

    // Salvaguarda: si tras limpiar el título quedara vacío (título degenerado, p. ej. solo «:»), se conserva el
    // original recortado — nunca se devuelve un título en blanco.
    if (!t) t = tOrig;

    return { titulo: t, subtitulo: s || null };
}

// ─── Mención de responsabilidad pegada al título ────────────────────────────────────────────────────────────
// «DICTIONARY OF SCIENCE; ED. BY JOHN DAINTITH.», «La isla del tesoro (il. N. C. Wyeth; trad. Francisco Torres
// Oliver)», «Mathematical methods in the physical sciences, by Mary L. Boas». 8-oct: 91 títulos así. La cola se
// lee con explotar-mencion (personas + rol) y SOLO se separa si TODA ella son nombres: «Java FX 8. Introduction by
// example» o «… By Andrew Russell Forsyth.Vol. 3» no se tocan.
const RE_INICIO_MENCION = new RegExp(
    '\\s*(?:[;/:,.]|\\s-|\\()\\s*(?=(?:\\[?(?:ed(?:ited)?\\.?\\s+(?:by|and)|edited\\s+and\\s+translated\\s+by|by\\s+\\p{Lu}'
    + '|trans(?:lated)?\\.?(?:\\s+\\w+)?\\s+by|with\\s+(?:an?\\s+)?(?:introduction|foreword|preface|notes|commentary)'
    + '|introd(?:uction|\\.)\\s+by|selected\\s+(?:and\\s+\\w+\\s+)?by|compiled\\s+by|general\\s+editors?|editors?:'
    + '|edici[oó]n\\s+(?:de|a\\s+cargo)|traducci[oó]n\\s+(?:de|y)|trad\\.\\s|pr[oó]logo\\s+(?:de|y)|introducci[oó]n\\s+(?:de|y)'
    + '|selecci[oó]n\\s+(?:de|y)|ilustraciones\\s+de|il\\.\\s|herausgegeben|hrsg\\.|[ée]dit[ée]\\s+par|traduit\\s+(?:de|par)|a\\s+cura\\s+di)))',
    'iu');

/**
 * Separa la mención de responsabilidad del final del título. Devuelve { titulo, personas:[{nombre,rol}], mencion } o
 * null si no hay mención o no son todo nombres. `explotar` es explotar-mencion · explotarMencion (lo pasa quien llama
 * para no crear un ciclo de importaciones).
 */
export function separarMencionDelTitulo(titulo, explotar) {
    const t = String(titulo || '');
    const m = t.match(RE_INICIO_MENCION);
    if (!m || m.index < 3) return null;
    const cabeza = t.slice(0, m.index).replace(/[\s;:,./-]+$/, '').trim();
    let cola = t.slice(m.index + m[0].length).trim().replace(/^\(|\)$/g, '').replace(/^\[|\]$/g, '').trim();
    cola = cola.replace(/^by\s+/i, '').replace(/\.\s*$/, '');
    if (!cabeza || !cola) return null;
    // «by X» es el AUTOR; lo demás, lo que diga su marcador (ed. by → editor, trad. → traductor…).
    const conMarcador = /^(?:ed(?:ited)?\.?\s|trans|with\s|introd|selected|compiled|general\s+editor|editors?:|edici|traduc|trad\.|pr[oó]logo|introducci|selecci|ilustraciones|il\.)/i.test(t.slice(m.index + m[0].length).trim().replace(/^[([]/, ''));
    const r = explotar(conMarcador ? t.slice(m.index + m[0].length).trim().replace(/^\(|\)$/g, '') : cola);
    if (!r?.fiable || !r.personas.length) return null;
    return { titulo: cabeza, personas: r.personas, mencion: cola };
}

// ─── Títulos en MAYÚSCULAS ───────────────────────────────────────────────────────────────────────────────────
// 856 títulos (8-oct) escritos enteros en mayúsculas («THE CAMBRIDGE ENCYCLOPEDIA OF THE ENGLISH LANGUAGE»,
// «HOMBRE LOBO INSOLITO,EL»). Lo mejor: el título de la autoridad del mismo ISBN si dice LO MISMO (trae la grafía de
// verdad, con acentos). Si no, mayúscula inicial en cada palabra salvo las vacías, y respetando los números romanos.
const VACIAS_TITULO = new Set(('a an the of and or in on to for at by from with as '
    + 'el la los las un una unos unas de del al y e o u en con por para sin sobre '
    + 'le les des du et au aux une dans pour sur '
    + 'der die das den dem und ein eine von zu mit im '
    + 'il lo gli i dei delle della di che').split(' '));
const RE_ROMANO_T = /^(?=[ivxlcdm]+$)m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i;
const comparableT = (s) => String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').replace(/[^a-z0-9]+/g, ' ').trim();

/** ¿Está el título entero en mayúsculas (y es un título, no una sigla)? */
export function tituloEnMayusculas(titulo) {
    const t = String(titulo || '');
    return t.length > 8 && !/\p{Ll}/u.test(t) && /\p{Lu}{3}/u.test(t) && t.trim().split(/\s+/).length >= 2;
}

/**
 * La grafía buena de un título en mayúsculas: la de la `autoridad` si dice lo mismo (mismas palabras), o Title Case
 * con cuidado. null si el título no está en mayúsculas.
 */
export function capitalizarTitulo(titulo, { autoridad = null } = {}) {
    if (!tituloEnMayusculas(titulo)) return null;
    // Artículo pospuesto de los catálogos («HOMBRE LOBO INSOLITO,EL», «HOTEL DE LOS ANIMALES, EL») → delante.
    const t = String(titulo).trim().replace(/^(.+?)\s*,\s*(EL|LA|LOS|LAS|LO|UN|UNA|THE|LE|LA|LES|IL|LO|GLI|DER|DIE|DAS)$/u, '$2 $1');
    if (autoridad && !tituloEnMayusculas(autoridad) && comparableT(autoridad) === comparableT(t)) return conGrafiaDe(t, autoridad);
    let primera = true;
    const palabras = t.toLowerCase().match(/[\p{L}\p{N}'’+#]+/gu) || [];
    let n = 0;
    return t.toLowerCase().replace(/[\p{L}\p{N}'’+#]+/gu, (w, pos, todo) => {
        const tras = todo.slice(0, pos).trimEnd();
        const ultima = ++n === palabras.length;
        const inicio = primera || ultima || /[:.;!?¿¡(—–-]$/.test(tras);   // primera, última o tras un signo fuerte
        primera = false;
        if (RE_ROMANO_T.test(w) && w.length <= 5 && w !== 'mix' && w !== 'dim') return w.toUpperCase();   // «II», «XX»
        if (/^[\p{L}]{2,5}$/u.test(w) && !/[aeiouyáéíóúàèìòùäëïöü]/i.test(w)) return w.toUpperCase();    // sigla sin vocales: «PQR»
        if (!inicio && VACIAS_TITULO.has(w)) return w;
        return w.charAt(0).toUpperCase() + w.slice(1);
    });
}

/**
 * La grafía de la autoridad aplicada al título original, SIN perder lo que el original tenía de más: sus acentos
 * («BALCÓN» frente a «balcon» del Fichero). Se toma de la autoridad solo si mayúscula o minúscula; sin el punto final
 * de los catálogos («Understanding digital computers.») ni el espacio tras el apóstrofo («L' ensorcellement»).
 */
function conGrafiaDe(original, autoridad) {
    const sinAcento = (c) => c.normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '');
    let a = String(autoridad).trim().replace(/\s*\.$/, '').replace(/(\p{L})['’]\s+(\p{L})/gu, "$1'$2");
    const o = String(original).trim().replace(/\s*\.$/, '');
    // Letra a letra solo si se corresponden (misma longitud una vez normalizadas); si no, la de la autoridad tal cual.
    if (o.normalize('NFC').length !== a.normalize('NFC').length) return a;
    const O = [...o.normalize('NFC')], A = [...a.normalize('NFC')];
    return A.map((c, i) => {
        const oc = O[i];
        if (oc === undefined) return c;
        const minuscula = c === c.toLowerCase() && c !== c.toUpperCase();
        if (sinAcento(oc).toLowerCase() === sinAcento(c).toLowerCase() && oc.toLowerCase() !== c.toLowerCase()) {
            return minuscula ? oc.toLowerCase() : oc.toUpperCase();   // el original lleva acento y la autoridad no
        }
        return c;
    }).join('');
}
