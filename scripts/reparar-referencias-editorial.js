/**
 * COLECCIONES Y OBRAS QUE APUNTAN A UNA EDITORIAL BORRADA. Fundir, explotar o borrar una editorial solo movía sus
 * LIBROS; las colecciones/cabeceras y las obras multivolumen que la nombraban se quedaban apuntando a un _id que ya no
 * existe (5-oct: 639 colecciones y 191 obras; 428 + 126 por scripts/fusionar-grafias-editoriales, el resto por
 * «🔗 Combinar» en el panel desde siempre). utils/gestion-editoriales.js ya mueve también esas referencias; esto
 * arregla las que quedaron:
 *   1. si la editorial se fundió en otra (copia en `editoriales_retiradas` con `fundida_en`), la de destino
 *      (siguiendo la cadena si la de destino también se fundió después);
 *   2. si no, la de la MAYORÍA de sus libros (60 %+ de los que tienen editorial);
 *   3. si no, se le quita (una referencia a nada no informa de nada). Diario `deshacer[]` en todos los casos.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-referencias-editorial.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-referencias-editorial.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGEN = 'reparar-referencias-editorial';
const MAYORIA = 0.6;

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · colecciones y obras con la editorial borrada\n`);

const existentes = new Map((await db.collection('editoriales').find({}, { projection: { nombre: 1 } }).toArray())
  .map((e) => [String(e._id), e]));
const retiradas = new Map((await db.collection('editoriales_retiradas').find({}, { projection: { _id_original: 1, nombre: 1, retirada: 1 } }).toArray())
  .map((r) => [String(r._id_original), r]));

/** La editorial en la que acabó una fundida (siguiendo la cadena), o null. */
function destinoDeFundida(id) {
  const vistos = new Set();
  let actual = String(id);
  while (!existentes.has(actual)) {
    if (vistos.has(actual)) return null;
    vistos.add(actual);
    const r = retiradas.get(actual);
    if (!r?.retirada?.fundida_en) return null;
    actual = String(r.retirada.fundida_en);
  }
  return existentes.get(actual);
}

/** La editorial de la mayoría de los libros de esa colección/obra, o null. */
async function editorialDeSusLibros(campo, id) {
  const filas = await bib.aggregate([
    { $match: { [campo]: id, editorial: { $ne: null } } },
    { $group: { _id: '$editorial', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();
  const total = filas.reduce((s, f) => s + f.n, 0);
  const vivas = filas.filter((f) => existentes.has(String(f._id)));
  if (!vivas.length || vivas[0].n / total < MAYORIA) return null;
  return existentes.get(String(vivas[0]._id));
}

const resumen = { fusion: 0, mayoria: 0, quitada: 0 };
const ejemplos = [];
for (const [coleccion, campoMiembro] of [['colecciones', 'coleccion'], ['obras', 'obra']]) {
  const col = db.collection(coleccion);
  const rotas = [];
  for await (const d of col.find({ editorial: { $type: 'objectId' } }, { projection: { nombre: 1, titulo: 1, editorial: 1 } })) {
    if (!existentes.has(String(d.editorial))) rotas.push(d);
  }
  const p = progreso(rotas.length || 1, coleccion);
  for (const d of rotas) {
    p.paso(d.nombre || d.titulo);
    let nueva = destinoDeFundida(d.editorial);
    let via = 'fusion';
    if (!nueva) { nueva = await editorialDeSusLibros(campoMiembro, d._id); via = 'mayoria'; }
    if (!nueva) via = 'quitada';
    resumen[via]++;
    const vieja = retiradas.get(String(d.editorial))?.nombre || `(${d.editorial})`;
    if (ejemplos.length < 40) ejemplos.push(`${coleccion} «${d.nombre || d.titulo}»: ${vieja} → ${nueva ? `«${nueva.nombre}» (${via === 'fusion' ? 'fundida en ella' : 'la de sus libros'})` : 'sin editorial'}`);
    if (!EJECUTAR) continue;
    const upd = nueva
      ? { $set: { editorial: nueva._id, fecha_actualizacion: new Date() } }
      : { $unset: { editorial: '' }, $set: { fecha_actualizacion: new Date() } };
    upd.$push = { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { editorial: d.editorial } } };
    await col.updateOne({ _id: d._id }, upd);
  }
  p.fin();
}

for (const e of ejemplos) console.log(`   ${e}`);
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · a la editorial en que se fundió: ${resumen.fusion} · a la de sus libros: ${resumen.mayoria} · sin editorial: ${resumen.quitada} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar.');
process.exit(0);
