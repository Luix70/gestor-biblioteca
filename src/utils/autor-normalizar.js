/**
 * Normaliza el nombre de un autor tal y como puede venir del Fichero (BNE/OL): el volcado de la BNE une
 * varios contribuyentes con el marcador «/**​/» (autor /**​/ traductor /**​/ …) e incluye las FECHAS de vida
 * entre paréntesis. Aquí:
 *   1) nos quedamos con el PRIMER contribuyente (el autor); el resto (traductor, ilustrador…) se ignora de
 *      momento — la captura de TODOS los contribuyentes con su rol es una feature aparte (roles, pendiente).
 *   2) extraemos las fechas «(1857-1924)» → nacimiento/fallecimiento (campos biográficos del autor), y las
 *      QUITAMOS del nombre.
 *   3) limpiamos el marcador suelto y comas/espacios sobrantes.
 * @returns {{ nombre: string, nacimiento: number|null, fallecimiento: number|null }}
 */
/**
 * Separa una cadena de autor que en realidad contiene VARIAS personas unidas por un separador de coautoría
 * (« & », « ; », « / »): p. ej. «Carroll, Lewis & Gardner, Martin» → ["Carroll, Lewis", "Gardner, Martin"].
 * NO separa por « y » (ambiguo: puede ser parte de un apellido) ni toca el marcador «/**​/» de la BNE (ese
 * lleva ROLES y lo maneja el parser de contribuciones). Devuelve la lista de nombres (>=1).
 */
export function separarAutores(raw) {
    const s = String(raw || '').trim();
    if (!s) return [];
    if (/\/\*+\//.test(s)) return [s]; // mención BNE con roles: no partir aquí (la trata contribuciones.js)
    const partes = s.split(/\s*&\s*|\s*;\s*|\s+\/\s+/).map((x) => x.trim()).filter(Boolean);
    return partes.length ? partes : [s];
}

export function normalizarAutor(raw) {
    let s = String(raw || '').trim();
    if (!s) return { nombre: '', nacimiento: null, fallecimiento: null };
    // 1) Solo el primer contribuyente (antes del primer marcador /**​/).
    s = s.split(/\/\*+\/?/)[0];
    // 2) Fechas de vida: (1857-1924) · (1939- ) · (n. 1939) · (1990). nacimiento[-fallecimiento].
    let nacimiento = null, fallecimiento = null;
    const m = s.match(/\(\s*(?:n\.\s*)?(\d{3,4})\s*[-–—]?\s*(\d{3,4})?\s*\)?/);
    if (m) {
        nacimiento = Number(m[1]) || null;
        fallecimiento = m[2] ? (Number(m[2]) || null) : null;
        s = s.slice(0, m.index) + s.slice(m.index + m[0].length);
    }
    // 3) Marcador suelto + espacios/comas/punto y coma sobrantes.
    s = s.replace(/\/\*+\/?/g, ' ').replace(/\s+/g, ' ').replace(/[\s,;]+$/, '').replace(/^[\s,;]+/, '').trim();
    // 4) Puntuación de más (7-oct: «Charles H.. Anderson» salía del nombre de fichero «Anderson,_Charles_H_.»;
    //    «Rene Chartrand -», «Noam Chomsky.»): puntos repetidos, un guion colgando y el punto final tras una
    //    palabra entera (no tras una inicial ni «Jr.»: «Tolkien, J. R. R.» lo conserva).
    s = s.replace(/\.{2,}/g, '.').replace(/\s+[-–—]+$/, '').replace(/(\p{L}{4,})\.$/u, '$1').trim();
    return { nombre: s, nacimiento, fallecimiento };
}

// ─── Grafías de una misma persona y listas sucias ──────────────────────────────────────────────────────────
const RE_DIACRITICOS_AUTOR = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * CLAVE de un nombre de autor: sin mayúsculas, acentos, puntuación ni espacios de más. «Tolkien, J. R. R.»,
 * «Tolkien, J.R.R.» y «TOLKIEN, J R R» dan la misma; «J. R. R. Tolkien» (otro orden) no. Mismo nombre escrito de
 * otra forma, nunca dos personas distintas: no tolera erratas ni cambia el orden de las palabras.
 */
export function claveAutor(nombre) {
    return String(nombre || '')
        .replace(/^\[\?\]_/, '')
        .toLowerCase()
        .normalize('NFD').replace(RE_DIACRITICOS_AUTOR, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();
}

/**
 * DEPURA la lista de autores de un documento antes de resolverla: separa las cadenas con varias personas
 * («A & B & C»), quita los ARTEFACTOS uno a uno (antes solo si lo eran TODOS: «Canada Research Chair In
 * Theoretical Neuroscience Chris Eliasmith & Chris Eliasmith & Charles H. Anderson & Charles H.. Anderson» dejaba
 * los cuatro), y las grafías repetidas de la misma persona («Charles H. Anderson» / «Charles H.. Anderson»). Quita
 * también el que es otro de la lista con palabras de más delante («… Chris Eliasmith» con «Chris Eliasmith» al lado).
 * `esArtefacto` lo pasa quien llama (parsear-nombre · esAutorArtefacto; aquí no se importa para no crear un ciclo).
 * @returns {{ autores: string[], descartados: string[] }}
 */
export function depurarAutores(lista, { esArtefacto = () => false } = {}) {
    const partes = (Array.isArray(lista) ? lista : [lista])
        .flatMap((x) => (typeof x === 'string' ? separarAutores(x) : [x]))
        .filter((x) => x != null && x !== '');
    const descartados = [];
    const cadenas = partes.filter((x) => typeof x === 'string');
    const claves = cadenas.map((x) => claveAutor(normalizarAutor(x).nombre || x));
    const autores = [];
    const vistas = new Set();
    for (const x of partes) {
        if (typeof x !== 'string') { autores.push(x); continue; }     // ya resuelto (ObjectId)
        const nombre = normalizarAutor(x).nombre || x.trim();
        const k = claveAutor(nombre);
        if (!k || esArtefacto(nombre) || nombre.startsWith('[?]_')) { descartados.push(x); continue; }
        if (vistas.has(k)) { descartados.push(x); continue; }        // otra grafía de uno que ya está
        // «<cargo o institución> Chris Eliasmith» junto a «Chris Eliasmith»: el largo acaba en otro nombre de la lista.
        if (claves.some((otra) => otra !== k && otra.length >= 6 && k.length > otra.length + 8 && k.endsWith(otra))) {
            descartados.push(x);
            continue;
        }
        vistas.add(k);
        autores.push(x);
    }
    return { autores, descartados };
}
