/**
 * DESHACER LOS CAMBIOS DE RAMA DEL CONFORMADOR (23-25 oct).
 *
 * Por qué: la tarea re-clasificar-cdu del Conformador recalculó la CDU de 2.878 libros con su Dewey/LCC y la caché de
 * equivalencias, y la regla de prioridad dejaba que una CDU deducida sustituyera a otra deducida de OTRA rama. Unos
 * 2.330 cambiaron de rama, con disparates medidos («What Are Gamma-Ray Bursts?» 524.3 → 27-23, la Biblia, porque su
 * Dewey era de otro libro; «Islam in Pakistan» 28 → 254, de una equivalencia que contradecía la tabla; «The Routledge
 * Handbook of Scripts and Alphabets» 003 → 821.411), y 376 de ellos sobre libros recién afinados por «Refinar CDU».
 * Las tres causas ya están corregidas (prioridad-cdu: deducida contra deducida de otra rama solo si la actual es
 * débil; clasificador-cdu: la caché no cambia de división respecto a la tabla Dewey ni lleva la lengua fuera del 81;
 * re-clasificar-cdu: no cambia nada si el Dewey y el LCC del libro discrepan de clase).
 *
 * Qué deshace: los libros cuyo ÚLTIMO cambio de CDU fue del Conformador desde el 23-oct 20:00 («CDU actualizada: "X"
 * → "Y" [clasificador…]»), que siguen con «Y», y en los que con las reglas de HOY ese cambio no se habría hecho:
 *   · la ENGROSÓ (530.145 → 53), o
 *   · la cambió de RAMA cuando la anterior NO era débil (gruesa, de la clase 4 vacante o contaminada).
 * Se respetan: los que la AFINARON (51 → 512), los que venían de una CDU débil (82 → 523.7) y los de la BNE/autoridad.
 * Vuelve cada uno a su CDU anterior (la de su alerta), MOVIENDO su carpeta, con alerta y sidecars al día. No toca la
 * caché ni el sello del Conformador (re-clasificar-cdu ya no lo repetiría con las reglas nuevas).
 *
 * Solo en el NAS (mueve carpetas). Copia de la base antes.
 *   sudo docker exec -it gestor-biblioteca node scripts/revertir-reclasificacion-conformador.js             (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/revertir-reclasificacion-conformador.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { esAntepasadoCdu } from '../src/utils/prioridad-cdu.js';
import { esCduDebil } from '../src/utils/cdu-gruesa.js';
import { equivalenciaUsable } from '../src/clasificador-cdu.js';
import { docsDeSeleccion, listarSelecciones } from '../src/utils/selecciones.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const DESDE = new Date('2026-10-23T20:00:00+02:00');   // arranque del Conformador
const SELECCION_CONTAMINADOS = 'CDU contaminada sin resolver (23-oct)';
const RE_ALERTA = /^CDU actualizada: "([^"]*)" → "([^"]*)" \[([^\]]*)\]/;

const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · deshacer los cambios de rama del Conformador (desde ${DESDE.toLocaleString('es-ES')})\n`);

// Los que tenían la CDU contaminada cuando pasó el Conformador: su CDU anterior era débil (el cambio se respeta).
const sel = (await listarSelecciones(db)).find((s) => s.nombre === SELECCION_CONTAMINADOS);
const contaminados = new Set(sel ? (await docsDeSeleccion(db, String(sel._id))).map(String) : []);

const docs = await col.find(
  { fecha_actualizacion: { $gte: DESDE }, alertas_agente: { $elemMatch: { $regex: '^CDU actualizada: ' } } },
  { projection: { titulo: 1, cdu: 1, obra: 1, cdu_manual: 1, ruta_base: 1, portada: 1, imagenes: 1, tipo_recurso: 1, alertas_agente: 1, mantenimiento_firma: 1, isbn: 1, issn: 1, dewey: 1 } },
).toArray();

const cuenta = { afina: 0, desdeDebil: 0, autoridad: 0, yaCambiada: 0, manualOObra: 0 };
const revertir = [];
const pDec = progreso(docs.length, 'Decidiendo');
for (const d of docs) {
  pDec.paso(d.titulo);
  const alertas = (d.alertas_agente || []).filter((a) => typeof a === 'string');
  const ultima = [...alertas].reverse().find((a) => RE_ALERTA.test(a));
  if (!ultima) { cuenta.otroFormato = (cuenta.otroFormato || 0) + 1; continue; }   // «CDU actualizada…» de otro tipo
  const [, de, a, fuente] = ultima.match(RE_ALERTA);
  if (!/^clasificador/.test(fuente)) { cuenta.autoridad++; continue; }       // BNE/Fichero/autoridad: rango mayor, bien
  if (String(d.cdu) !== a) { cuenta.yaCambiada++; continue; }               // después la cambió otro (tú, otra tarea)
  if (d.cdu_manual || d.obra) { cuenta.manualOObra++; continue; }
  if (esAntepasadoCdu(de, a)) { cuenta.afina++; continue; }                  // la afinó: bien
  const engrosa = esAntepasadoCdu(a, de);
  const deDebil = esCduDebil(de) || contaminados.has(String(d._id));
  if (!engrosa && deDebil) {
    // Venía de una débil: se respeta… salvo que la nueva saliera de una equivalencia Dewey de la caché que con las
    // reglas del 25-oct YA NO se usa («Islam in Pakistan»: 28 → 254, de una entrada que contradecía la tabla «28»).
    const eq = /^clasificador:cache:dewey/.test(fuente) && d.dewey
      ? await db.collection('equivalencias_cdu').findOne({ sistema_origen: 'dewey', codigo_origen: String(d.dewey).trim().toLowerCase() })
      : null;
    if (eq && String(eq.cdu) === a && !equivalenciaUsable('dewey', String(d.dewey).trim().toLowerCase(), eq).usable) {
      revertir.push({ d, de, a, motivo: 'salió de una equivalencia que ya no se usa' });
      continue;
    }
    cuenta.desdeDebil++;
    continue;
  }
  revertir.push({ d, de, a, motivo: engrosa ? 'la engrosó' : 'cambió de rama' });
}
pDec.fin();

const porMotivo = revertir.reduce((m, r) => ({ ...m, [r.motivo]: (m[r.motivo] || 0) + 1 }), {});
console.log(`\nCambios del Conformador revisados: ${docs.length}`);
console.log(`  se respetan · la afinaron: ${cuenta.afina} · venían de una CDU débil: ${cuenta.desdeDebil} · BNE/autoridad: ${cuenta.autoridad} · cambiada después: ${cuenta.yaCambiada} · manual/tomo: ${cuenta.manualOObra}`);
console.log(`  A DESHACER: ${revertir.length}`, porMotivo);
for (const r of revertir.slice(0, 40)) console.log(`   ${String(r.a).padEnd(18)} → vuelve a ${String(r.de).padEnd(18)} (${r.motivo}) «${String(r.d.titulo).slice(0, 50)}»`);

if (!EJECUTAR) {
  console.log('\nDRY-RUN: no se ha tocado nada. Repite con --ejecutar (mueve las carpetas).\n');
  process.exit(0);
}

let hechos = 0, fallos = 0;
const p = progreso(revertir.length, 'Deshaciendo');
for (const { d, de, a, motivo } of revertir) {
  p.paso(d.titulo);
  try {
    const reub = await reubicarPorCdu(d, de);
    const set = { ...(reub?.set || { cdu: de }), cdu_fuente: 'clasificador' };
    await aplicarCambio(col, d, carpetaDeDoc({ ...d, ...set }), {
      set,
      alertas: [`CDU devuelta a «${de}»: el Conformador la había pasado a «${a}» (${motivo}), un cambio que con las reglas del 25-oct no se hace (scripts/revertir-reclasificacion-conformador).`, ...(reub?.alertas || [])],
    });
    const actual = await col.findOne({ _id: d._id });
    await regenerarSidecarsDoc(db, actual, carpetaDeDoc(actual)).catch(() => {});
    await indexarDoc(db, d._id).catch(() => {});
    hechos++;
  } catch (e) {
    fallos++;
    p.nota(`⛔ ${d._id}: ${e.message}`);
  }
}
p.fin();
console.log(`\n=== HECHO · ${hechos} devueltos a su CDU anterior · ${fallos} fallos ===\n`);
process.exit(fallos ? 1 : 0);
