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
    return { nombre: s, nacimiento, fallecimiento };
}
