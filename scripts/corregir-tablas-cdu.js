/**
 * CORREGIR LO QUE DEJARON DOS FALLOS DE LAS TABLAS DETERMINISTAS (13-oct).
 *
 *   1. Dewey 070 (periodismo) → «07»: en la CDU el periodismo es 070 («07» no existe). resolverCDU APRENDE lo que
 *      da la tabla, así que la caché tenía 25 equivalencias «Dewey 070… → 07» como «Manual verificado» — y la caché
 *      se lee ANTES que la tabla: cada libro nuevo con Dewey 070 seguiría cayendo en «07» aunque la tabla esté bien.
 *      Se corrigen la caché (070…, 075, 078, «07») y los libros con CDU «07…» → «070…» (auxiliares conservados).
 *   2. LCC con una marca de autor en «E» («PN5214.E8», «TK7895.E42»): parseFloat leía «.E8» como EXPONENTE, el número
 *      se salía de todo tramo y la tabla daba la CDU de la clase entera: periodismo (PN4699-5650) en 82, sistemas
 *      empotrados (TK7895) en 621.3, epistemología (BD161) en 11. Se corrigen los libros cuya CDU es EXACTAMENTE la
 *      que daba el fallo y la tabla ahora da otra — nunca si su CDU es de la BNE, impresa o manual.
 *
 * Mueve las carpetas (reubicarPorCdu: copia verificada). En seco no escribe nada.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-tablas-cdu.js
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-tablas-cdu.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEquivalenciaExterna, claseLcc } from '../src/clasificador-cdu.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · CDU que dejaron dos fallos de las tablas (Dewey 070 → «07»; LCC con marca en «E»)\n`);

// «07…» → «070…» (el periodismo); «07» seguido de un auxiliar o nada. No toca «070», «071»… ni «07.2» (otro caso).
const RE_07 = /^07(?=$|[^0-9.])/;
const con070 = (cdu) => String(cdu).replace(RE_07, '070');

// ─── 1a. La caché ──────────────────────────────────────────────────────────────────────────────────────────────
const eq = db.collection('equivalencias_cdu');
const malas = (await eq.find({ sistema_origen: /^dewey$/i }).toArray())
  .filter((e) => /^07/.test(String(e.codigo_origen)) && RE_07.test(String(e.cdu)));
console.log(`Caché: ${malas.length} equivalencia(s) Dewey 07x → «07…»`);
for (const e of malas.slice(0, 10)) console.log(`   dewey ${e.codigo_origen}  ${e.cdu} → ${con070(e.cdu)}  (${e.fuente}${e.verificado ? ', verificada' : ''})`);
if (EJECUTAR) for (const e of malas) await eq.updateOne({ _id: e._id }, { $set: { cdu: con070(e.cdu) } });

// ─── 1b y 2. Los libros ────────────────────────────────────────────────────────────────────────────────────────
const cambios = [];
for (const d of await col.find({ cdu: { $regex: '^07($|[^0-9.])' }, cdu_manual: { $ne: true } }).toArray()) {
  cambios.push({ doc: d, nueva: con070(d.cdu), motivo: 'Dewey 070 → «07» (en la CDU el periodismo es 070)' });
}
// LCC: la cifra que se leía mal (parseFloat a secas) frente a la buena.
const numeroViejo = (c) => parseFloat(String(c || '').trim().toUpperCase().replace(/^[A-Z]{1,3}/, '').replace(/^[^0-9]+/, ''));
const numeroBueno = (c) => {
  const m = String(c || '').trim().toUpperCase().replace(/^[A-Z]{1,3}/, '').replace(/^[^0-9]+/, '').match(/^\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
};
const conLcc = await col.find({ lcc: { $type: 'string' }, cdu_manual: { $ne: true } }).toArray();
const p = progreso(conLcc.length, 'LCC con marca en «E»');
for (const d of conLcc) {
  p.paso(d.titulo);
  const bueno = numeroBueno(d.lcc);
  if (!Number.isFinite(bueno) || numeroViejo(d.lcc) === bueno) continue;              // no le afectaba
  if (['bne', 'bnf', 'impresa', 'manual'].includes(d.cdu_fuente)) continue;            // con autoridad: no se toca
  const conFallo = await buscarEquivalenciaExterna('lcc', claseLcc(d.lcc));            // lo que daba: la de la clase
  const ahora = await buscarEquivalenciaExterna('lcc', d.lcc);
  if (!ahora || String(d.cdu) !== String(conFallo) || ahora === conFallo) continue;
  cambios.push({ doc: d, nueva: ahora, motivo: `LCC ${d.lcc}: su número se leía mal («.E…» como exponente) y la tabla daba la clase entera` });
}
p.fin();

// 3. La primera ejecución de refinar-cdu (13-oct) «refinó» dos CDU con RANGO («5/6(035.062)» → «52/6(035.062)»,
// «51/53(091)» → «517/53(091)»): sin sentido. Vuelven a la que tenían, que está en su alerta.
for (const d of await col.find({ alertas_agente: { $elemMatch: { $regex: '^CDU refinada: «[0-9]{1,2}/' } }, cdu_manual: { $ne: true } }).toArray()) {
  const alerta = [...d.alertas_agente].reverse().find((a) => /^CDU refinada: «[0-9]{1,2}\//.test(a));
  const m = alerta.match(/^CDU refinada: «([^»]+)» → «([^»]+)»/);
  if (m && d.cdu === m[2]) cambios.push({ doc: d, nueva: m[1], motivo: 'un rango de CDU no se refina: vuelve a la que tenía' });
}

console.log(`\nLibros a corregir: ${cambios.length}`);
for (const c of cambios.slice(0, 60)) console.log(`   ${String(c.doc.cdu).padEnd(14)} → ${String(c.nueva).padEnd(14)} «${String(c.doc.titulo || '').slice(0, 50)}»`);

if (!EJECUTAR) {
  console.log('\n▶ Repite con --ejecutar para aplicarlo (mueve las carpetas).');
  process.exit(0);
}

// SALVAGUARDA: solo donde vive el árbol CDU.
const muestra = cambios.slice(0, 20);
let vistas = 0;
for (const c of muestra) if (await carpetaExiste(carpetaDeDoc(c.doc))) vistas++;
if (muestra.length && vistas < Math.ceil(muestra.length / 2)) {
  console.error(`\n❌ Solo ${vistas} de ${muestra.length} carpetas de muestra existen en ESTA máquina: ejecútalo en el NAS.\n`);
  process.exit(1);
}

let hechos = 0, fallos = 0;
const p2 = progreso(cambios.length, 'Corrigiendo');
for (const c of cambios) {
  p2.paso(c.doc.titulo);
  try {
    const reub = await reubicarPorCdu(c.doc, c.nueva);
    const set = reub?.set || { cdu: c.nueva };
    await aplicarCambio(col, c.doc, carpetaDeDoc({ ...c.doc, ...set }), {
      set,
      alertas: [`CDU corregida: «${c.doc.cdu}» → «${c.nueva}» (${c.motivo}; scripts/corregir-tablas-cdu).`, ...(reub?.alertas || [])],
    });
    await indexarDoc(db, c.doc._id).catch(() => {});
    hechos++;
  } catch (e) {
    fallos++;
    p2.nota(`⛔ ${c.doc._id}: ${e.message}`);
  }
}
p2.fin();
console.log(`\n=== HECHO · caché: ${malas.length} · libros: ${hechos} · fallos: ${fallos} ===`);
process.exit(fallos ? 1 : 0);
