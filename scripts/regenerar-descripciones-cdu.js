/**
 * REHACER LAS DESCRIPCIONES DE CDU INCOHERENTES. La descripción de un código (el título con ⓘ que enseña la ficha)
 * la escribe la IA la primera vez y se guarda en `cdu_descripciones`. Sin referencias, se inventaba: «94(430).085»
 * salió como «Geología de la Antártida» (94 es HISTORIA y (430) es ALEMANIA). Desde el 8-oct la IA recibe la tabla
 * de la clase/división, los lugares del código y la descripción de su padre, y no se guarda una descripción que
 * contradiga su división (utils/descripcion-cdu.js). Este script retira las ya guardadas que la contradicen:
 *   · 94/93 que no hablan de historia, 91 que no habla de geografía, 929 que no habla de biografía;
 *   · con `--lugar`, además las que nombran OTRO lugar que el del código (más ruidosa: revisar la lista antes).
 * Se copian en `cdu_descripciones_retiradas` y se borran; se rehacen solas (Mantenimiento las rellena poco a poco)
 * o al momento con `--regenerar` (una llamada de IA de texto por código). Nunca toca las verificadas a mano.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/regenerar-descripciones-cdu.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/regenerar-descripciones-cdu.js --ejecutar [--regenerar] [--lugar]
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { descripcionContradice, lugarContradice, describirCDU } from '../src/utils/descripcion-cdu.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const REGENERAR = args.includes('--regenerar');
const LUGAR = args.includes('--lugar');

const db = await conectarDB();
const col = db.collection('cdu_descripciones');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · descripciones de CDU incoherentes${LUGAR ? ' (también por lugar)' : ''}\n`);

const todas = await col.find({ verificado: { $ne: true } }, { projection: { codigo: 1, titulo_es: 1, descripcion_es: 1 } }).toArray();
const malas = todas.filter((x) => descripcionContradice(x.codigo, x.titulo_es)
  || (LUGAR && lugarContradice(x.codigo, `${x.titulo_es || ''} ${x.descripcion_es || ''}`)));
console.log(`Descripciones revisadas: ${todas.length} · incoherentes: ${malas.length}\n`);
malas.slice(0, 40).forEach((x) => console.log(`   ${x.codigo.padEnd(28)} «${String(x.titulo_es || '').slice(0, 80)}»`));
if (malas.length > 40) console.log(`   … y ${malas.length - 40} más`);

let rehechas = 0, fallidas = 0;
if (EJECUTAR && malas.length) {
  const p = progreso(malas.length, REGENERAR ? 'Rehaciendo' : 'Retirando');
  for (const x of malas) {
    p.paso(x.codigo);
    const original = await col.findOne({ _id: x._id });
    if (!original) continue;
    const { _id, ...copia } = original;
    await db.collection('cdu_descripciones_retiradas').insertOne({ ...copia, _id_original: _id, retirada: { fecha: new Date(), motivo: 'incoherente con su división o su lugar' } });
    await col.deleteOne({ _id });
    if (REGENERAR) {
      const nueva = await describirCDU(db, x.codigo).catch(() => null);
      if (nueva) { rehechas++; p.nota(`   ${x.codigo}: «${String(x.titulo_es).slice(0, 40)}» → «${String(nueva.titulo_es).slice(0, 50)}»`); }
      else fallidas++;
    }
  }
  p.fin();
}
console.log(`\n=== ${EJECUTAR ? `HECHO · ${malas.length} retiradas${REGENERAR ? ` · ${rehechas} rehechas · ${fallidas} pendientes (las hará Mantenimiento)` : ' (las rehará Mantenimiento)'}` : `DRY-RUN · ${malas.length} se retirarían`} ===`);
process.exit(0);
