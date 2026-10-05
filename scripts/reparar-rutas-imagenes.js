/**
 * REPARAR LAS IMÁGENES QUE APUNTAN FUERA DE SU CARPETA. La portada o el carrusel (`imagenes[]`) de un documento
 * apuntan a una carpeta que ya no es la suya (un movimiento cambió `ruta_base` y no ellas) y la ficha las enseña
 * rotas, aunque los ficheros están en la carpeta nueva. Medido el 5-oct: 693 documentos (690 números de «Don Miki»),
 * todos con su imagen en la carpeta actual. Se reescriben a la carpeta actual cuando el fichero de ese nombre está
 * allí; las que no aparecen se dejan como están (nunca se borra una referencia). Diario `deshacer[]`.
 *
 * Es la misma comprobación que la categoría «Imágenes fuera de su carpeta» de Integridad (utils/rutas-imagenes.js);
 * este script la hace sola y rápido. En el NAS (donde están las carpetas):
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-rutas-imagenes.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-rutas-imagenes.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { rutasImagenesFueraDeCarpeta } from '../src/utils/rutas-imagenes.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGEN = 'reparar-rutas-imagenes';
const absDe = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · imágenes que apuntan fuera de su carpeta\n`);

const filtro = { ruta_base: { $exists: true }, $or: [{ 'imagenes.0': { $exists: true } }, { portada: { $exists: true } }] };
const total = await bib.countDocuments(filtro);
const p = progreso(total, 'Revisando');
const porColeccion = new Map();
let afectados = 0, reparados = 0, sinEncontrar = 0;
for await (const d of bib.find(filtro, { projection: { titulo: 1, ruta_base: 1, portada: 1, imagenes: 1, coleccion_nombre: 1 } })) {
  p.paso(d.titulo);
  const r = await rutasImagenesFueraDeCarpeta(d, absDe).catch(() => null);
  if (!r) continue;
  afectados++;
  sinEncontrar += r.sinArreglo;
  const c = d.coleccion_nombre || '(sin colección)';
  porColeccion.set(c, (porColeccion.get(c) || 0) + 1);
  if (!Object.keys(r.set).length) continue;
  if (EJECUTAR) {
    await bib.updateOne({ _id: d._id }, {
      $set: { ...r.set, fecha_actualizacion: new Date() },
      $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { portada: d.portada ?? null, imagenes: d.imagenes ?? null } } },
    });
  }
  reparados++;
}
p.fin();

console.log(`\nDocumentos con imágenes fuera de su carpeta: ${afectados} · se reparan: ${reparados} · rutas sin encontrar (se dejan): ${sinEncontrar}`);
for (const [c, n] of [...porColeccion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`   ${c}: ${n}`);
console.log(`\n=== ${EJECUTAR ? `HECHO · ${reparados} documentos reparados` : `DRY-RUN · ${reparados} documentos se repararían`} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar (en el NAS). Los sidecars los rehace la campaña «sidecars».');
process.exit(0);
