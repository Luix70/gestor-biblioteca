/**
 * Árbol CDU: convierte un código CDU (posiblemente sucio: con nombres/títulos pegados por el
 * clasificador, mojibake, signos sanitizados…) en una ruta jerárquica de 3 niveles
 *   <clase 1 dígito> / <división dígitos iniciales> / <código limpio>
 * para no tener 1000+ carpetas planas bajo CDU/.
 *
 * PRINCIPIO: el código original NUNCA se modifica en MongoDB; esto solo decide DÓNDE se archiva.
 * Por eso se puede recortar agresivamente el texto libre del nombre de carpeta sin perder dato.
 */

// Caracteres prohibidos en rutas (Windows ∪ Linux). NO incluye - ( ) = + . , que son válidos.
const PROHIBIDOS = /[<>/\\|?*\x00-\x1f]/g;

/** Recorta un paréntesis de apertura sin cerrar (resultado de cortar un literal a media expresión). */
function equilibrarParentesis(s) {
    let d = 0, corte = s.length;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') d++;
        else if (s[i] === ')' && d > 0) d--;
        if (d === 0) corte = i + 1;
    }
    return d > 0 ? s.slice(0, corte) : s;
}

/**
 * Limpia un CDU para usarlo como segmento de ruta: recorta el texto libre (nombres, títulos),
 * quita los caracteres prohibidos por el SO y normaliza. Devuelve '' si no queda nada utilizable.
 */
export function sanitizarCDU(cdu) {
    let s = String(cdu || '').trim();

    // 1. Cortar en el primer "espacio + letra": ahí empieza un literal (nombre/título). Las
    //    relaciones legítimas sanitizadas usan " _ " (espacio+guion bajo) o " (" — nunca una letra.
    const lit = s.match(/\s+\p{L}/u);
    if (lit) s = s.slice(0, lit.index);

    // 2. ':' (relación) y '"' (tiempo) → '_' para conservar la separación; resto de prohibidos fuera.
    s = s.replace(/[:"]/g, '_').replace(PROHIBIDOS, '');

    // 3. Quitar espacios y colapsar guiones bajos repetidos.
    s = s.replace(/\s+/g, '').replace(/_+/g, '_');

    // 4. Equilibrar paréntesis colgantes y limpiar separadores en los extremos.
    s = equilibrarParentesis(s);
    s = s.replace(/^[._\-]+/, '').replace(/[._\-_(]+$/, '');

    return s.slice(0, 60);
}

const BUCKET_SIN_CLASE = '_sin_clasificar';

/**
 * Devuelve { clase, division, hoja, segmentos } para un CDU.
 *   - clase:    primer dígito (0–9) del código limpio.
 *   - division: dígitos iniciales antes del primer signo (2–3 normalmente; NO se rellena).
 *   - hoja:     el código limpio completo (sin literales).
 *   - segmentos: la ruta jerárquica [clase, division, hoja] (o [BUCKET, hoja] si no hay clase).
 */
export function arbolCDU(cdu) {
    const hoja = sanitizarCDU(cdu) || BUCKET_SIN_CLASE;

    // Sin dígito inicial (p. ej. "(460.23)", "=111", o puro texto): cae al cajón de revisión.
    if (!/^[0-9]/.test(hoja)) {
        const segmentos = hoja === BUCKET_SIN_CLASE ? [BUCKET_SIN_CLASE] : [BUCKET_SIN_CLASE, hoja];
        return { clase: BUCKET_SIN_CLASE, division: BUCKET_SIN_CLASE, hoja, segmentos };
    }

    const clase = hoja[0];
    const division = (hoja.match(/^[0-9]+/)[0]).slice(0, 3);
    return { clase, division, hoja, segmentos: [clase, division, hoja] };
}
