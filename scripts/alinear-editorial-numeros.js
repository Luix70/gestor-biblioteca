/**
 * LA EDITORIAL DE LOS NÚMEROS DE UNA REVISTA = LA DE SU CABECERA. Medido el 5-oct en «Don Miki» (692 números): 541
 * Montena, 98 SIN editorial, y el resto grafías o lecturas erróneas de portada («Monterrey», «Antena», «McGregor
 * Pub.», «Walt Disney»…). Una revista la publica una editorial; lo que se aparta en un puñado de números es ruido.
 *
 * Por cada cabecera (colección tipo:'revista'):
 *   1. su editorial: la que ya tiene; si no tiene, la de la MAYORÍA de sus números (60 %+ de los que la llevan);
 *   2. números SIN editorial → la de la cabecera (hueco);
 *   3. números con OTRA editorial que aparece en menos del 10 % de los números → la de la cabecera (ruido). Una
 *      editorial con 10 %+ se respeta: puede ser un cambio de editor real con los años, y se informa.
 * Diario `deshacer[]` en cada número cambiado. La ingesta hace ya el paso 2 (motor-catalogo, paso 2d).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/alinear-editorial-numeros.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/alinear-editorial-numeros.js --ejecutar
 *   … --cabecera "<texto>"   solo las cabeceras cuyo nombre lo contenga (p. ej. «don miki»)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SOLO = arg('--cabecera');
const ORIGEN = 'alinear-editorial-numeros';
const UMBRAL_RUIDO = 0.10;      // una editorial en menos de este % de los números es ruido
const UMBRAL_MAYORIA = 0.60;    // para dar editorial a una cabecera que no la tiene

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');
const colEd = db.collection('editoriales');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · editorial de los números = la de su cabecera\n`);

const filtroCab = { tipo: 'revista' };
if (SOLO) filtroCab.nombre = { $regex: SOLO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
const cabeceras = await colCol.find(filtroCab, { projection: { nombre: 1, editorial: 1 } }).toArray();
const nombreEd = new Map((await colEd.find({}, { projection: { nombre: 1 } }).toArray()).map((e) => [String(e._id), e.nombre]));
const nombreDe = (id) => nombreEd.get(String(id)) || `(editorial ${id} borrada)`;

let cabSinEd = 0, huecos = 0, ruido = 0, respetadas = 0;
const cambios = [];            // { cab, editorial, set de la cabecera?, numeros: [{_id, antes}] }
const p = progreso(cabeceras.length, 'Cabeceras');
for (const cab of cabeceras) {
  p.paso(cab.nombre);
  const numeros = await bib.find({ coleccion: cab._id, tipo_recurso: 'revista' }, { projection: { editorial: 1 } }).toArray();
  if (!numeros.length) continue;

  // Recuento por editorial entre los números que la llevan.
  const cuenta = new Map();
  for (const n of numeros) if (n.editorial) cuenta.set(String(n.editorial), (cuenta.get(String(n.editorial)) || 0) + 1);

  // 1. La editorial de la cabecera.
  let editorial = cab.editorial ? String(cab.editorial) : null;
  let ponerACabecera = false;
  if (!editorial) {
    const conEd = [...cuenta.values()].reduce((s, x) => s + x, 0);
    const [mayor, n] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!mayor || n / conEd < UMBRAL_MAYORIA) continue;     // sin editorial clara: no se inventa
    editorial = mayor;
    ponerACabecera = true;
    cabSinEd++;
  }

  // 2 y 3. Números a alinear.
  const aCambiar = [];
  const respetar = new Set();
  for (const [ed, n] of cuenta) {
    if (ed !== editorial && n / numeros.length >= UMBRAL_RUIDO) respetar.add(ed);
  }
  for (const n of numeros) {
    if (!n.editorial) { aCambiar.push(n); huecos++; continue; }
    const ed = String(n.editorial);
    if (ed === editorial) continue;
    if (respetar.has(ed)) continue;
    aCambiar.push(n);
    ruido++;
  }
  respetadas += respetar.size;
  if (aCambiar.length || ponerACabecera || respetar.size) cambios.push({ cab, editorial, ponerACabecera, aCambiar, respetar, cuenta });
}
p.fin();

console.log(`Cabeceras con números a alinear: ${cambios.filter((c) => c.aCambiar.length).length} · sin editorial que la toman de sus números: ${cabSinEd}`);
console.log(`Números sin editorial → la de la cabecera: ${huecos} · con una editorial suelta (< ${UMBRAL_RUIDO * 100} %) → la de la cabecera: ${ruido}`);
console.log(`Editoriales respetadas (10 %+ de los números de su cabecera: ¿cambio de editor?): ${respetadas}\n`);
for (const c of cambios.sort((a, b) => b.aCambiar.length - a.aCambiar.length).slice(0, 50)) {
  const sueltas = [...c.cuenta.entries()].filter(([ed]) => ed !== c.editorial && !c.respetar.has(ed))
    .map(([ed, n]) => `${nombreDe(ed)} (${n})`).join(', ');
  const sinEd = c.aCambiar.filter((n) => !n.editorial).length;
  console.log(`  «${c.cab.nombre}» → ${nombreDe(c.editorial)}${c.ponerACabecera ? ' [la toma la cabecera]' : ''}: ${sinEd} sin editorial${sueltas ? ` · ${sueltas}` : ''}`
    + (c.respetar.size ? ` · se respeta: ${[...c.respetar].map((ed) => `${nombreDe(ed)} (${c.cuenta.get(ed)})`).join(', ')}` : ''));
}
if (cambios.length > 50) console.log(`  … y ${cambios.length - 50} cabeceras más`);

// ─── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────
let hechos = 0;
if (EJECUTAR) {
  const total = cambios.reduce((s, c) => s + c.aCambiar.length, 0);
  const pe = progreso(total || 1, 'Alineando');
  for (const c of cambios) {
    const { ObjectId } = await import('mongodb');
    const edId = new ObjectId(c.editorial);
    if (c.ponerACabecera) {
      await colCol.updateOne({ _id: c.cab._id }, { $set: { editorial: edId, fecha_actualizacion: new Date() } });
    }
    for (const n of c.aCambiar) {
      pe.paso(c.cab.nombre);
      await bib.updateOne({ _id: n._id }, {
        $set: { editorial: edId, fecha_actualizacion: new Date() },
        $push: {
          deshacer: { fecha: new Date(), origen: ORIGEN, antes: { editorial: n.editorial ?? null } },
          alertas_agente: `Editorial ${n.editorial ? `«${nombreDe(n.editorial)}»` : '(vacía)'} → «${nombreDe(c.editorial)}», la de su cabecera «${c.cab.nombre}» (scripts/${ORIGEN}).`,
        },
      });
      await indexarDoc(db, n._id).catch(() => {});
      hechos++;
    }
  }
  pe.fin();
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${hechos} números alineados` : `DRY-RUN · ${huecos + ruido} números cambiarían`} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
else console.log('▶ Los sidecars de esos números los rehace la campaña «sidecars».');
process.exit(0);
