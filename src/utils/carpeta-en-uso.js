/**
 * ¿OTRO DOCUMENTO VIVE EN ESTA CARPETA O DENTRO DE ELLA? Antes de mandar a la Papelera la carpeta de un documento
 * (borrarlo, reprocesarlo, fundirlo con otra versión, quitarlo por duplicado) hay que saberlo: si otro apunta a la
 * misma carpeta, o a una SUBCARPETA suya (carpetas anidadas: 118 el 7-oct, «Historia de Iberia Vieja»…), reciclarla
 * se llevaría los ficheros del otro. Antes solo se miraba la misma carpeta, no las de dentro.
 *
 * Consumidores: utils/reproceso.js, utils/fusionar-versiones.js, integridad.js (duplicados por hash).
 */
const escaparRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** El primer documento (distinto de `exceptoIds`) cuya carpeta es `rutaBase` o cuelga de ella, o null. */
export async function otroDocEnCarpeta(db, rutaBase, exceptoIds = []) {
  if (!rutaBase) return null;
  const fuera = (Array.isArray(exceptoIds) ? exceptoIds : [exceptoIds]).filter(Boolean);
  return db.collection('biblioteca').findOne({
    _id: { $nin: fuera },
    $or: [{ ruta_base: rutaBase }, { ruta_base: { $regex: `^${escaparRegex(rutaBase)}/` } }],
  }, { projection: { _id: 1, titulo: 1, ruta_base: 1 } });
}
