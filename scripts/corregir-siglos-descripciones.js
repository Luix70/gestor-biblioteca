/**
 * CORREGIR LAS DESCRIPCIONES DE CDU CON EL SIGLO EQUIVOCADO (14-oct).
 *
 * En la CDU, un auxiliar de tiempo de 2 cifras es un SIGLO contando los años: «"19"» = los años 1900 = siglo XX,
 * «"04"» = siglo V. La IA escribió muchas descripciones leyéndolo como el siglo NN: «821.111(73)-31"19"» =
 * «Novelas estadounidenses en inglés del siglo XIX» (medido: 366 descripciones, todas de junio-julio, de antes de
 * que la IA recibiera los tiempos descifrados). Muchas de ellas tienen además otros disparates, porque se escribieron
 * viendo solo la clave saneada («…-31_19», sin comillas ni «:»).
 *
 * Se rehacen con la NOTACIÓN real (sacada de los libros que usan esa CDU): con IA (los tiempos descifrados van en
 * las referencias y la respuesta se rechaza si dice otro siglo: descripcion-cdu.js·sigloIncoherente), o —sin IA, o
 * si la IA falla— compuesta con las piezas oficiales del UDC Summary. La vieja va a cdu_descripciones_retiradas.
 * Solo cambia textos: ni la CDU de ningún libro ni las carpetas.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-siglos-descripciones.js                 (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-siglos-descripciones.js --ejecutar      (IA solo gratis)
 *   … --ejecutar --sin-ia     compuestas con las piezas oficiales, sin IA
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { sanitizarCDU } from '../src/utils/cdu-arbol.js';
import { sigloIncoherente, regenerarDescripcionCDU } from '../src/utils/descripcion-cdu.js';
import { conPoliticaIA } from '../src/utils/politica-ia.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const SIN_IA = process.argv.includes('--sin-ia');
const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · descripciones de CDU con el siglo equivocado${EJECUTAR ? ` · ${SIN_IA ? 'sin IA (piezas oficiales)' : 'IA solo gratis (y si falla, piezas oficiales)'}` : ''}\n`);

// La notación REAL de cada clave (la clave pierde las comillas: «…-31"19"» → «…-31_19»).
const notacionDe = new Map();
for (const c of await db.collection('biblioteca').distinct('cdu', { cdu: { $regex: '"' } })) {
  const k = sanitizarCDU(c);
  if (k && !notacionDe.has(k)) notacionDe.set(k, String(c).trim());
}
console.log(`CDU con auxiliar de tiempo en los libros: ${notacionDe.size}`);

const descs = await db.collection('cdu_descripciones').find(
  { codigo: { $in: [...notacionDe.keys()] }, verificado: { $ne: true } },
  { projection: { codigo: 1, titulo_es: 1, descripcion_es: 1, fuente: 1 } },
).toArray();
const malas = [];
for (const d of descs) {
  const notacion = notacionDe.get(d.codigo);
  const siglo = sigloIncoherente(notacion, `${d.titulo_es || ''} ${d.descripcion_es || ''}`);
  if (siglo) malas.push({ ...d, notacion, siglo });
}
console.log(`Descripciones de esas CDU: ${descs.length} · con un siglo que no es el suyo: ${malas.length}\n`);
for (const m of malas.slice(0, 40)) console.log(`   ${m.notacion.padEnd(30)} «${String(m.titulo_es).slice(0, 60)}» · dice ${m.siglo}`);

if (!EJECUTAR) {
  console.log('\n▶ Repite con --ejecutar (IA solo gratis; o --sin-ia: compuestas con las piezas oficiales).');
  process.exit(0);
}

let conIA = 0, sinIA = 0, fallos = 0;
const p = progreso(malas.length, 'Rehaciendo');
await conPoliticaIA(SIN_IA ? 'ninguna' : 'gratis', async () => {
  for (const m of malas) {
    p.paso(m.notacion);
    let nueva = null;
    if (!SIN_IA) {
      try { nueva = await regenerarDescripcionCDU(db, m.notacion, { conIA: true }); conIA++; } catch { /* sin IA, abajo */ }
    }
    if (!nueva) {
      try { nueva = await regenerarDescripcionCDU(db, m.notacion, { conIA: false }); sinIA++; } catch { fallos++; }
    }
    if (nueva && conIA + sinIA <= 25) p.nota(`   ${m.notacion.padEnd(30)} «${String(m.titulo_es).slice(0, 40)}» → «${String(nueva.titulo_es).slice(0, 55)}»`);
  }
});
p.fin();
console.log(`\n=== HECHO · ${conIA} con IA · ${sinIA} con las piezas oficiales · ${fallos} sin rehacer (relanza) ===`);
process.exit(0);
