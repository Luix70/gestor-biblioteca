// Alertas de la ficha que NO aportan nada: notas de traza repetidas miles de veces.
//
// Medido el 26-nov: `alertas_agente` ocupaba 46 MB de los 512 MB del Atlas gratuito. Casi todo es útil y se
// CONSERVA: el rastro de cada cambio (de qué CDU/colección/título a cuál y por qué), los avisos de revisión,
// la procedencia de los datos —«Datos del Fichero local», «complementados con Google Books», «validados
// contra OpenLibrary» los LEE revistas·RE_DATOS_DE_CATALOGO_DE_LIBROS para detectar números de revista
// contaminados— y las señales de APIs caídas («… inalcanzable», que decide la tarea re-enriquecer-degradados).
//
// Lo que se quita es solo lo que no dice nada que la base no sepa ya:
//   · «Nuevo autor/editorial/colección/obra… registrado/a: X» → la entidad existe; basta con mirarla.
//   · «OpenLibrary online omitida: ya la sirve el Fichero local.» → lo dice ya «Datos del Fichero local».
//   · «Fecha del nombre ignorada: hay bloque CIP/ISBN propio → es un LIBRO…» → explica una decisión que ya
//     se ve en la ficha (tipo libro + su CIP/ISBN), idéntica en 13.000 fichas.
// Y las repetidas literalmente dentro de la misma ficha.
//
// Puerta única: la ingesta (motor-catalogo, antes de insertar o fusionar) y scripts/adelgazar-bd.js (lo ya
// catalogado) usan esta misma lista. Añadir aquí un patrón solo si NINGÚN código lee esa alerta (grep
// «alertas_agente» en src/ y scripts/).

const PATRONES_INFORMATIVOS = [
    /^Nuev[oa] (autor|editorial|colección|obra multivolumen|cabecera de revista|serie de libros|revista)\b[^:]*registrad[oa]\b/,
    /^Nuevo contribuyente \([^)]*\): /,
    /^OpenLibrary online omitida: ya la sirve el Fichero local\.$/,
    /^Fecha del nombre ignorada: hay bloque CIP\/ISBN propio/,
];

/** true si la alerta es una nota de traza que no hace falta guardar. */
export function esAlertaInformativa(alerta) {
    if (typeof alerta !== 'string') return false;
    return PATRONES_INFORMATIVOS.some((re) => re.test(alerta));
}

/**
 * Alertas que merece la pena guardar: sin las informativas y sin repeticiones literales, en su orden
 * original (la primera aparición manda). Lo que no es texto se conserva tal cual.
 */
export function alertasDepuradas(alertas) {
    if (!Array.isArray(alertas)) return alertas;
    const vistas = new Set();
    const quedan = [];
    for (const a of alertas) {
        if (esAlertaInformativa(a)) continue;
        if (typeof a === 'string') {
            if (vistas.has(a)) continue;
            vistas.add(a);
        }
        quedan.push(a);
    }
    return quedan;
}
