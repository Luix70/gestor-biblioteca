/**
 * IMÁGENES QUE APUNTAN FUERA DE SU CARPETA. Las imágenes del carrusel (`imagenes[].ruta`) y la portada (`portada`)
 * cuelgan de la carpeta del documento (`ruta_base`). Si un movimiento cambia `ruta_base` y no ellas, la ficha enseña
 * imágenes rotas aunque los ficheros estén en la carpeta nueva (5-oct: 690 números de «Don Miki» y 3 libros; la
 * miniatura del catálogo usa `portada` y se veía bien, el carrusel de la ficha no).
 *
 * Reparación sin pérdida: una ruta rota cuyo fichero (mismo nombre) está en la carpeta actual se reescribe a ella.
 * Si el fichero no aparece, la ruta se deja como está (y se cuenta): nunca se borra una referencia por no encontrarla.
 *
 * Consumidores: src/integridad.js (categoría «imagenesFueraDeCarpeta», reparada con --reparar) y
 * scripts/reparar-rutas-imagenes.js.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const existe = (p) => fs.access(p).then(() => true, () => false);

/**
 * Lo que habría que cambiar en el documento, o null si nada apunta fuera.
 * `absDe(rutaWeb)` traduce «/recursos/…» a la ruta en disco.
 * Devuelve { set, rotas, arregladas, sinArreglo }.
 */
export async function rutasImagenesFueraDeCarpeta(doc, absDe) {
  const base = doc?.ruta_base;
  if (!base) return null;
  const dentro = (ruta) => typeof ruta === 'string' && ruta.startsWith(base + '/');
  const carpeta = absDe(base);

  // Una ruta fuera de la carpeta y cuyo fichero no existe → la misma en la carpeta, si está allí.
  const arreglar = async (ruta) => {
    if (!ruta || dentro(ruta)) return { ruta, estado: 'bien' };
    if (await existe(absDe(ruta))) return { ruta, estado: 'bien' };   // fuera, pero el fichero existe: no es asunto nuestro
    const nombre = path.posix.basename(ruta);
    if (await existe(path.join(carpeta, nombre))) return { ruta: `${base}/${nombre}`, estado: 'arreglada' };
    return { ruta, estado: 'perdida' };
  };

  let rotas = 0, arregladas = 0, sinArreglo = 0;
  const cuenta = (r) => {
    if (r.estado === 'bien') return;
    rotas++;
    if (r.estado === 'arreglada') arregladas++; else sinArreglo++;
  };

  const set = {};
  if (Array.isArray(doc.imagenes) && doc.imagenes.length) {
    let cambia = false;
    const nuevas = [];
    for (const im of doc.imagenes) {
      if (!im?.ruta) { nuevas.push(im); continue; }
      const r = await arreglar(im.ruta);
      cuenta(r);
      if (r.ruta !== im.ruta) cambia = true;
      nuevas.push(r.ruta !== im.ruta ? { ...im, ruta: r.ruta } : im);
    }
    if (cambia) set.imagenes = nuevas;
  }
  if (doc.portada) {
    const r = await arreglar(doc.portada);
    cuenta(r);
    if (r.ruta !== doc.portada) set.portada = r.ruta;
  }
  if (!rotas) return null;
  return { set, rotas, arregladas, sinArreglo };
}
