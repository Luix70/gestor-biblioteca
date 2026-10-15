/**
 * CORREGIR LA «HISTORIA DE CHINA» QUE ERA HISTORIA ANTIGUA (15-oct).
 *
 * En la CDU ANTIGUA, 931 era la HISTORIA ANTIGUA en general; hoy es 94(3) («mundo antiguo»). La traducción de la
 * notación antigua (cdu-moderna.js) lo llevaba a 94(31) —el auxiliar (31) es CHINA— como hace bien con el resto del
 * 93x (932 Egipto → 94(32), 937 Roma → 94(37), 938 Grecia → 94(38)). Medido: 59 libros con 94(31), uno solo de China
 * (la Cambridge Ancient History, Diodoro de Sicilia, Dión Crisóstomo…). El traductor ya está corregido (y el Dewey
 * 931, que SÍ es China, se trata aparte en clasificador-cdu.js).
 *
 * Pasa a 94(3) (conservando lo que siga: «94(31):94(33)» → «94(3):94(33)») los libros con 94(31)… que NO son de China:
 * ni su título habla de China/Asia ni su Dewey es 931. Mueve sus carpetas (reubicarPorCdu; los tomos de una obra
 * solo cambian en la base: su carpeta es la de la obra). Una CDU manual también se corrige: el 931 lo escribió una
 * persona en la notación antigua, y su intención era la historia antigua. También la caché equivalencias_cdu.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-cdu-931.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-cdu-931.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · 94(31) (China) que era 931 antigua (historia antigua) → 94(3)\n`);

const DE_CHINA = /chin|han dynasty|qin|zhou|\btang\b|\bming\b|confuc|beijing|pek[ií]n|\bmao\b|tao|asia|oriente|orient/i;
const nueva = (cdu) => String(cdu).replace(/^94\(31\)/, '94(3)');

const docs = await col.find({ cdu: { $regex: '^94\\(31\\)' } }).toArray();
const cambiar = docs.filter((d) => !DE_CHINA.test(`${d.titulo || ''} ${d.subtitulo || ''}`) && !/^931/.test(String(d.dewey || '')));
console.log(`Con 94(31): ${docs.length} · se quedan (China o Dewey 931): ${docs.length - cambiar.length} · a 94(3): ${cambiar.length}\n`);
for (const d of cambiar.slice(0, 60)) console.log(`   ${String(d.cdu).padEnd(16)} → ${nueva(d.cdu).padEnd(16)} ${d.obra ? '(tomo de obra) ' : ''}«${String(d.titulo).slice(0, 55)}»`);
for (const d of docs.filter((x) => !cambiar.includes(x))) console.log(`   (se queda) ${d.cdu} «${String(d.titulo).slice(0, 55)}»`);

// La caché: una equivalencia que da 94(31) desde algo que no es el Dewey 931.
const eq = await db.collection('equivalencias_cdu').find({ cdu: { $regex: '^94\\(31\\)' } }).toArray();
const eqMal = eq.filter((e) => !(String(e.sistema_origen).toLowerCase() === 'dewey' && /^931/.test(String(e.codigo_origen))));
console.log(`\nCaché: ${eq.length} con 94(31) · a corregir (no vienen del Dewey 931): ${eqMal.length}`);
for (const e of eqMal.slice(0, 15)) console.log(`   ${e.sistema_origen}:${e.codigo_origen}  ${e.cdu} → ${nueva(e.cdu)}`);

if (!EJECUTAR) {
  console.log('\n▶ Repite con --ejecutar para aplicarlo (mueve las carpetas de los que no son tomos de obra).');
  process.exit(0);
}

for (const e of eqMal) await db.collection('equivalencias_cdu').updateOne({ _id: e._id }, { $set: { cdu: nueva(e.cdu) } });
let hechos = 0, fallos = 0;
const p = progreso(cambiar.length, 'Corrigiendo');
for (const d of cambiar) {
  p.paso(d.titulo);
  try {
    const cdu = nueva(d.cdu);
    const reub = await reubicarPorCdu(d, cdu);
    const set = { ...(reub?.set || { cdu }) };
    await aplicarCambio(col, d, carpetaDeDoc({ ...d, ...set }), {
      set,
      alertas: [`CDU «${d.cdu}» → «${cdu}»: el 931 de la CDU antigua era la historia antigua, no China (scripts/corregir-cdu-931).`, ...(reub?.alertas || [])],
    });
    await regenerarSidecarsDoc(db, { ...d, ...set }, carpetaDeDoc({ ...d, ...set })).catch(() => {});
    await indexarDoc(db, d._id).catch(() => {});
    hechos++;
  } catch (e) {
    fallos++;
    p.nota(`⛔ ${d._id}: ${e.message}`);
  }
}
p.fin();
console.log(`\n=== HECHO · ${hechos} libros · ${eqMal.length} de la caché · ${fallos} fallos ===`);
process.exit(fallos ? 1 : 0);
