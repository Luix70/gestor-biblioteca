/**
 * MODERNIZAR LA CDU DE RELIGIÓN (clase 2) — la notación anterior a 2000 a la actual, y recoloca las carpetas (13-oct).
 *
 * La clase 2 se rehízo entera en 2000: el «282» antiguo (Iglesia católica) es hoy el islam suní, el «297» antiguo
 * (islam) cae entre los movimientos espirituales modernos, el «220» (Biblia), en las religiones del Lejano Oriente.
 * Las reglas y la tabla están en src/utils/cdu-religion.js (las comparte la ingesta): un número que no existe hoy se
 * traduce; uno que vale en los dos esquemas, solo si el libro (Dewey, LCC, título, materias) confirma la lectura
 * antigua; el 27x no se toca. Lo que no se puede decidir queda como está y va a una selección para revisarlo a mano.
 *
 * No toca las CDU puestas a mano (cdu_manual): las lista. El número antiguo queda en la alerta del documento.
 *
 * Dos fases, como modernizar-cdu.js:
 *   1. BASE: cdu y cdu_autoridad (y la caché equivalencias_cdu, con el código de origen como contexto).
 *   2. DISCO: cada documento cambiado cuya carpeta ya no refleja su ficha se mueve a su árbol (con verificación de
 *      la copia; si la carpeta vieja no está en disco, no se toca). Nada se borra.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/modernizar-cdu-religion.js              (DRY-RUN)
 *   sudo docker exec -t gestor-biblioteca node scripts/modernizar-cdu-religion.js --ejecutar
 *   … --rehacer [--ejecutar]   además, vuelve a traducir (desde la CDU original de su alerta) los libros que una
 *                              versión anterior de la tabla dejó peor (13-oct: 291 → «2» en vez de 2-65)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { cduReligionModerna } from '../src/utils/cdu-religion.js';
import { carpetaReflejaFicha, recolocarSegunCdu, aplicarCambio, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion, anadirDocs } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const REHACER = process.argv.includes('--rehacer');
const nuevaCdu = new Map();   // _id → CDU nueva (para mirar en seco dónde iría la carpeta)

const db = await conectarDB();
const col = db.collection('biblioteca');

// Solo las CDU con alguna faceta de la clase 2 de tres cifras o más (el resto no puede ser notación antigua).
const RE_CLASE2 = '(^|:)\\s*2[0-9][0-9]';
const filtro = {
  $or: [{ cdu: { $regex: RE_CLASE2 } }, { cdu_autoridad: { $regex: RE_CLASE2 } }],
  mantenimiento_firma: { $ne: 'pendiente-cdu-contaminada' },
  // Una CDU que ya tradujo este script está en notación ACTUAL: no se vuelve a examinar. Releída, «255» (292
  // antiguo → religiones clásicas) vale también en el esquema antiguo, y con vocabulario cristiano en el título se
  // «traduciría» otra vez a 27-46. (Lo que haya que rehacer con una tabla mejor lo hace --rehacer, desde la original.)
  alertas_agente: { $not: { $elemMatch: { $regex: 'modernizar-cdu-religion' } } },
};
const PROYECCION = { cdu: 1, cdu_autoridad: 1, cdu_manual: 1, titulo: 1, subtitulo: 1, palabras_clave: 1, dewey: 1, lcc: 1 };
const raizDe = (cdu) => String(cdu).match(/^[\d.\-]+/)?.[0] || String(cdu);
// La transición de la faceta que cambió (en «94(460):297 → 94(460):28», la segunda), por su número principal.
const transicionDe = (a, b) => {
  const fa = String(a).split(':');
  const fb = String(b).split(':');
  const i = Math.max(0, fa.findIndex((x, k) => x !== fb[k]));
  return `${raizDe(fa[i] ?? a)} → ${raizDe(fb[i] ?? b)}`;
};

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · CDU de religión (clase 2) en notación antigua\n`);

// ─── FASE 1: la base ─────────────────────────────────────────────────────────────────────────────────────────
const afectados = [];
const dudosos = [];
const manuales = [];
const transiciones = new Map();
let cambiadas = 0;
const p1 = progreso(await col.countDocuments(filtro), 'Fase 1 · base');
for await (const d of col.find(filtro, { projection: PROYECCION })) {
  p1.paso(d.titulo);
  const rCdu = cduReligionModerna(d.cdu, d);
  const rAut = cduReligionModerna(d.cdu_autoridad, d);
  if (rCdu.dudosa) {
    dudosos.push(d._id);
    if (dudosos.length <= 25) p1.nota(`❔ ${String(d.cdu).padEnd(22)} «${String(d.titulo || '').slice(0, 45)}» · ${rCdu.motivos.join('; ')}`);
  }
  const set = {};
  if (rCdu.cambio) {
    // Una CDU puesta a mano no se toca: se avisa.
    if (d.cdu_manual) {
      manuales.push(`${d._id}  ${d.cdu} → ${rCdu.cdu}  «${String(d.titulo || '').slice(0, 45)}»`);
    } else {
      set.cdu = rCdu.cdu;
    }
  }
  if (rAut.cambio) set.cdu_autoridad = rAut.cdu;
  if (!Object.keys(set).length) continue;
  cambiadas++;
  if (set.cdu) {
    afectados.push(d._id);
    nuevaCdu.set(String(d._id), set.cdu);
    const t = transicionDe(d.cdu, set.cdu);
    transiciones.set(t, (transiciones.get(t) || 0) + 1);
  }
  if (cambiadas <= 60) {
    p1.nota(`${set.cdu ? `cdu ${d.cdu} → ${set.cdu}` : `cdu_autoridad ${d.cdu_autoridad} → ${set.cdu_autoridad}`}  «${String(d.titulo || '').slice(0, 45)}»${rCdu.religion ? ` [${rCdu.religion}]` : ''}`);
  }
  if (EJECUTAR) {
    const antes = [set.cdu && `cdu ${d.cdu}`, set.cdu_autoridad && `cdu_autoridad ${d.cdu_autoridad}`].filter(Boolean).join(', ');
    await col.updateOne({ _id: d._id }, {
      $set: { ...set, fecha_actualizacion: new Date() },
      $push: { alertas_agente: `CDU de religión en notación actual (scripts/modernizar-cdu-religion): ${antes} → ${set.cdu || set.cdu_autoridad}. ${(rCdu.cambio ? rCdu : rAut).motivos.join('; ')}` },
    });
  }
}
p1.fin();

// La caché: una CDU antigua aprendida para un Dewey/LCC se serviría a los libros siguientes. El código de origen da
// la religión (Dewey 282 → cristianismo).
let equivalencias = 0;
for await (const e of db.collection('equivalencias_cdu').find({ cdu: { $regex: RE_CLASE2 } }, { projection: { cdu: 1, sistema_origen: 1, codigo_origen: 1 } })) {
  const contexto = String(e.sistema_origen).toLowerCase() === 'dewey' ? { dewey: e.codigo_origen } : { lcc: e.codigo_origen };
  const r = cduReligionModerna(e.cdu, contexto);
  if (!r.cambio) continue;
  equivalencias++;
  if (equivalencias <= 20) console.log(`   caché ${e.sistema_origen}:${e.codigo_origen}  ${e.cdu} → ${r.cdu}`);
  if (EJECUTAR) await db.collection('equivalencias_cdu').updateOne({ _id: e._id }, { $set: { cdu: r.cdu } });
}

// ─── --rehacer: los ya traducidos con una versión anterior de la tabla ─────────────────────────────────────────
// La primera pasada (13-oct) llevó el 291 (religión comparada) y el 299 (otras religiones) a «2» a secas. La CDU
// original está en la alerta que dejó cada libro: se vuelve a traducir con la tabla actual y, si sale distinta y
// nadie ha tocado la CDU desde entonces (sigue siendo la que puso la pasada), se aplica.
let rehechos = 0;
if (REHACER) {
  const RE_ALERTA = /modernizar-cdu-religion\): cdu (.+?)(?:, cdu_autoridad .+?)? → (\S+?)\. /;
  const conAlerta = { alertas_agente: { $elemMatch: { $regex: 'modernizar-cdu-religion\\): cdu ' } }, cdu_manual: { $ne: true } };
  const pR = progreso(await col.countDocuments(conAlerta), 'Rehacer · base');
  for await (const d of col.find(conAlerta, { projection: { ...PROYECCION, alertas_agente: 1 } })) {
    pR.paso(d.titulo);
    // (Una CDU con espacios dentro —«726.6(445.1 Chart.)»— no se lee bien de la alerta: se salta, no es 291/299.)
    const alerta = [...d.alertas_agente].reverse().find((a) => RE_ALERTA.test(a));
    if (!alerta) continue;
    const [, original, puesta] = alerta.match(RE_ALERTA);
    if (d.cdu !== puesta) continue;                       // cambiada después: no se toca
    const r = cduReligionModerna(original, d);
    if (!r.cambio || r.cdu === puesta) continue;
    rehechos++;
    afectados.push(d._id);
    nuevaCdu.set(String(d._id), r.cdu);
    const t = `${transicionDe(original, puesta)} ⇒ ${raizDe(r.cdu)}`;
    transiciones.set(t, (transiciones.get(t) || 0) + 1);
    if (rehechos <= 40) pR.nota(`↻ ${original} → ${puesta} ⇒ ${r.cdu}  «${String(d.titulo || '').slice(0, 45)}»`);
    if (EJECUTAR) {
      await col.updateOne({ _id: d._id }, {
        $set: { cdu: r.cdu, fecha_actualizacion: new Date() },
        $push: { alertas_agente: `CDU de religión rehecha con la tabla corregida (scripts/modernizar-cdu-religion --rehacer): ${puesta} → ${r.cdu} (original: ${original}).` },
      });
    }
  }
  pR.fin();
  // La caché: las equivalencias Dewey 29x que quedaron en «2» a secas (o con solo un lugar) se recalculan desde el
  // propio código Dewey (el Dewey 29x anterior a 2000 y la CDU antigua 29x coinciden).
  for await (const e of db.collection('equivalencias_cdu').find({ sistema_origen: /^dewey$/i, codigo_origen: /^29/, cdu: /^2($|\()/ })) {
    // Sin las marcas de segmentación del Dewey («299/.16113», «291.1/3» → 299.16113, 291.13).
    const dewey = String(e.codigo_origen).replace(/[/']/g, '');
    const r = cduReligionModerna(dewey, { dewey });
    if (!r.cambio || r.cdu === e.cdu) continue;
    equivalencias++;
    console.log(`   caché ↻ dewey:${e.codigo_origen}  ${e.cdu} ⇒ ${r.cdu}`);
    if (EJECUTAR) await db.collection('equivalencias_cdu').updateOne({ _id: e._id }, { $set: { cdu: r.cdu } });
  }
  console.log(`\n--rehacer: ${rehechos} documento(s) con una traducción mejor que la de la primera pasada.`);
}

console.log(`\nFase 1: ${cambiadas} documento(s) con CDU de religión antigua${EJECUTAR ? ' corregidos' : ''} · ${equivalencias} equivalencia(s) de la caché.`);
console.log('Por transición:');
for (const [t, n] of [...transiciones].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`  ${String(n).padStart(5)}  ${t}`);
if (manuales.length) {
  console.log(`\nCDU puestas a MANO que parecen antiguas (no se tocan; revísalas tú): ${manuales.length}`);
  manuales.slice(0, 30).forEach((m) => console.log(`   ✋ ${m}`));
}
console.log(`\nDudosas (valen en los dos esquemas y el libro no dice de qué religión trata): ${dudosos.length}`);
console.log('');

// ─── FASE 2: el disco ────────────────────────────────────────────────────────────────────────────────────────
let movidos = 0, sinCarpeta = 0, fallos = 0, enSuSitio = 0;
const p2 = progreso(afectados.length, EJECUTAR ? 'Fase 2 · recolocando' : 'Fase 2 · revisando');
for (const _id of afectados) {
  const doc = await col.findOne({ _id });
  p2.paso(doc?.titulo);
  if (!doc?.ruta_base) continue;
  // En seco la fase 1 no se aplicó: se mira dónde iría con la CDU nueva.
  const comoQuedaria = EJECUTAR ? doc : { ...doc, cdu: nuevaCdu.get(String(_id)) ?? doc.cdu };
  if (carpetaReflejaFicha(comoQuedaria)) { enSuSitio++; continue; }
  if (!EJECUTAR) continue;
  try {
    const reub = await recolocarSegunCdu(doc);
    if (!reub?.set?.ruta_base) { sinCarpeta++; continue; }
    const carpeta = reub.carpetaNueva || carpetaDeDoc({ ...doc, ...reub.set });
    await aplicarCambio(col, doc, carpeta, {
      set: reub.set,
      alertas: ['Carpeta recolocada: CDU de religión en notación actual (scripts/modernizar-cdu-religion).', ...(reub.alertas || [])],
    });
    await regenerarSidecarsDoc(db, { ...doc, ...reub.set }, carpeta).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
    movidos++;
  } catch (e) {
    fallos++;
    p2.nota(`⛔ ${doc._id}: ${e.message}`);
  }
}
const tiempo = p2.fin();

// Las dudosas, a una selección para revisarlas a mano (sin tocar su CDU).
if (EJECUTAR && dudosos.length) {
  // Si ya hay una de una pasada anterior, se le añaden (sin repetir) en vez de crear otra igual.
  const previa = await db.collection('selecciones').findOne({ nombre: /^CDU de religión por revisar/ }, { sort: { fecha_creacion: -1 } });
  if (previa) {
    await anadirDocs(db, String(previa._id), dudosos);
    console.log(`\n   Dudosas añadidas a la selección «${previa.nombre}» (las que ya estaban no se repiten).`);
  }
  const fecha = new Date().toISOString().slice(0, 10);
  if (!previa) await crearSeleccion(db, {
    nombre: `CDU de religión por revisar (¿notación antigua?) ${fecha}`,
    descripcion: 'Libros con una CDU de la clase 2 que vale en los dos esquemas (anterior y posterior a 2000) con significados distintos — p. ej. 282 = Iglesia católica (antigua) o islam suní (actual) — y cuyo Dewey, LCC, título y materias no dicen de qué religión tratan. No se ha tocado su CDU. scripts/modernizar-cdu-religion.js.',
    docs: dudosos,
  });
  if (!previa) console.log(`\n   ${dudosos.length} documento(s) a la selección «CDU de religión por revisar (¿notación antigua?) ${fecha}».`);
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${tiempo} ===`);
console.log(`  CDU pasadas a notación actual : ${cambiadas}`);
if (REHACER) console.log(`  rehechas con la tabla corregida: ${rehechos}`);
console.log(`  equivalencias de la caché     : ${equivalencias}`);
console.log(`  dudosas (a revisar a mano)    : ${dudosos.length}${EJECUTAR ? ' (en una selección)' : ''}`);
console.log(`  puestas a mano (no se tocan)  : ${manuales.length}`);
console.log(`  carpetas ${EJECUTAR ? 'recolocadas           ' : 'que se recolocarían   '}: ${EJECUTAR ? movidos : afectados.length - enSuSitio}`);
if (EJECUTAR) console.log(`  sin carpeta en disco (no se tocan): ${sinCarpeta} · fallos: ${fallos}`);
console.log(`  ya en su sitio                : ${enSuSitio}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo (después de una copia de la base).');
process.exit(fallos ? 1 : 0);
