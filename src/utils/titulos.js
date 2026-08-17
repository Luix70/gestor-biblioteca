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
