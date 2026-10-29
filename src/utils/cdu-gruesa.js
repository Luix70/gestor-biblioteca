/**
 * ¿Una CDU es DÉBIL? — el criterio único de «esta CDU todavía no dice gran cosa», compartido por la campaña Refinar CDU
 * (qué libros refinar) y por la regla de prioridad (cuándo una CDU deducida puede sustituir a otra deducida de OTRA
 * rama). Vive aparte para que prioridad-cdu.js lo use sin importar refinar-cdu.js (que importa prioridad-cdu.js).
 */

/**
 * GRUESA: vacía, 000, o de 1-2 cifras sin un auxiliar que la precise (vale «94(460)», «27-23», «82-31», «91.0»; no
 * valen «51», «82(075)», «94"19"», «32:…»). Ver la explicación completa en refinar-cdu.js.
 */
export const RE_CDU_GRUESA = String.raw`^\s*$|^0+$|^[0-9]{1,2}$|^[0-9]{1,2}\(0|^[0-9]{1,2}["=:+/]`;
const reGruesa = new RegExp(RE_CDU_GRUESA);

export function esCduGruesa(cdu) {
  return reGruesa.test(String(cdu ?? '').trim());
}

const cifrasPrincipales = (cdu) => (String(cdu || '').trim().match(/^\d+(?:\.\d+)*/)?.[0] || '').replace(/\./g, '');

/**
 * ¿`a` es más GRUESA que `b` en la misma rama? Su número principal es un prefijo más corto («51» de «512.64»), o
 * `a` es literalmente el principio de `b` y le faltan los auxiliares que la precisan («94» de «94(460)»: el lugar).
 */
export function esAntepasadoCdu(a, b) {
  const sa = String(a || '').trim(), sb = String(b || '').trim();
  if (sa && sb.length > sa.length && sb.startsWith(sa)) return true;
  const ca = cifrasPrincipales(sa), cb = cifrasPrincipales(sb);
  return !!ca && cb.length > ca.length && cb.startsWith(ca);
}

/** Marca de los libros cuya CDU salió de una equivalencia contaminada (reparar-cdu-contaminada, 9-oct). */
export const FIRMA_CDU_CONTAMINADA = 'pendiente-cdu-contaminada';

/**
 * DÉBIL = no merece defenderse frente a otra CDU deducida: gruesa, de la clase 4 (VACANTE en la CDU desde 1964: un
 * «428.6» es un número Dewey copiado, no una CDU) o marcada como contaminada.
 */
export function esCduDebil(cdu, doc = null) {
  const s = String(cdu ?? '').trim();
  if (esCduGruesa(s)) return true;
  if (/^4/.test(s)) return true;
  if (doc?.mantenimiento_firma === FIRMA_CDU_CONTAMINADA) return true;
  return false;
}
