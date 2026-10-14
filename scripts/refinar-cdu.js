/**
 * REFINAR CDU — que ningún libro se quede con una CDU de 1 o 2 cifras ni en 000 (13-oct).
 *
 * El motor (la cascada autoridad → tablas → hermanos → árbol oficial → IA con menú cerrado, y sus reglas) está en
 * src/utils/refinar-cdu.js: lo comparten la campaña de fondo «Refinar CDU» (escalonada) y la ingesta. Este script
 * es para lanzarlo de golpe o para ver antes qué haría.
 *
 * El SECO decide y guarda un GUION (utils/guion-seco.js): un --ejecutar poco después con los mismos parámetros lo
 * aplica sin volver a decidir (ni volver a gastar IA); cada libro se comprueba antes (si su CDU cambió entretanto,
 * se salta). Mueve las carpetas: ejecútalo en el NAS.
 *
 * IA: por defecto SOLO la gratuita (--con-pago para permitir la de pago; --sin-ia, solo los pasos 1-3).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/refinar-cdu.js [--sin-ia|--con-pago] [--limite N]
 *   sudo docker exec -it gestor-biblioteca node scripts/refinar-cdu.js --ejecutar [--sin-ia|--con-pago] [--limite N]
 *   … --contaminados   en vez de los gruesos, los que la reparación del 9-oct dejó con la CDU contaminada
 *                      (mantenimiento_firma 'pendiente-cdu-contaminada'), reclasificados DESDE CERO
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { decidirLote, aplicarRefinamiento, filtroRefinarCdu, filtroContaminados, esCduGruesa, VERSION_REFINAR } from '../src/utils/refinar-cdu.js';
import { conPoliticaIA } from '../src/utils/politica-ia.js';
import { abrirGuion, sigueIgual } from '../src/utils/guion-seco.js';
import { carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const MODO_IA = args.includes('--sin-ia') ? 'ninguna' : args.includes('--con-pago') ? 'todas' : 'gratis';
const LIMITE = Number(arg('--limite')) || 0;
// --contaminados: los que la reparación del 9-oct dejó con la CDU contaminada, reclasificados DESDE CERO.
const CONTAMINADOS = args.includes('--contaminados');
const TROZO = 40;   // libros por lote del motor (la IA agrupa los de la misma rama dentro de cada lote)

const db = await conectarDB();
const col = db.collection('biblioteca');
const conIA = MODO_IA !== 'ninguna';
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · refinar las CDU de 1-2 cifras y 000 · IA: ${{ ninguna: 'ninguna', gratis: 'solo gratuita', todas: 'gratuita y de pago' }[MODO_IA]}\n`);

const guion = abrirGuion(CONTAMINADOS ? 'refinar-cdu-contaminados' : 'refinar-cdu', { parametros: { modo: MODO_IA, limite: LIMITE } });
let plan = EJECUTAR ? await guion.leer() : null;
const usandoGuion = !!plan;

// ─── DECIDIR (o tomar el guion del seco) ────────────────────────────────────────────────────────────────────────
if (!plan) {
  let consulta = col.find(CONTAMINADOS ? filtroContaminados({ conIA }) : filtroRefinarCdu({ conIA })).sort({ cdu: 1 });   // por CDU: la IA agrupa por rama
  if (LIMITE) consulta = consulta.limit(LIMITE);
  const docs = await consulta.toArray();
  console.log(`Libros con la CDU gruesa por mirar: ${docs.length}`);
  const acciones = [];
  const sinResolver = [];
  let iaNoDisponible = false;
  const p = progreso(docs.length, 'Decidiendo');
  await conPoliticaIA(MODO_IA, async () => {
    for (let i = 0; i < docs.length; i += TROZO) {
      const trozo = docs.slice(i, i + TROZO);
      const r = await decidirLote(db, trozo, { conIA: conIA && !iaNoDisponible, enLinea: true, desdeCero: CONTAMINADOS, onPaso: (_, __, titulo) => p.paso(titulo) });
      if (r.iaNoDisponible && !iaNoDisponible) {
        iaNoDisponible = true;
        p.nota(`   ⏸ La IA no está disponible (${r.errorIA}): el resto se decide solo con los pasos sin IA.`);
      }
      for (const d of r.decisiones) {
        acciones.push({ id: String(d.doc._id), antes: { cdu: d.doc.cdu ?? null }, cdu: d.cdu, fuente: d.fuente, via: d.via, titulo: d.doc.titulo, desdeCero: !!d.desdeCero });
      }
      for (const d of r.sinResolver) sinResolver.push(String(d._id));
    }
  });
  p.fin();
  plan = { acciones, resumen: { mirados: docs.length, sinResolver, iaNoDisponible, ids: docs.map((d) => String(d._id)) } };
}

// ─── Resumen ───────────────────────────────────────────────────────────────────────────────────────────────────
const { acciones, resumen } = plan;
const porFuente = {};
const transiciones = {};
for (const a of acciones) {
  porFuente[a.fuente] = (porFuente[a.fuente] || 0) + 1;
  const t = `${a.antes.cdu || '000'} → ${a.cdu}`;
  transiciones[t] = (transiciones[t] || 0) + 1;
}
const siguenGruesas = acciones.filter((a) => esCduGruesa(a.cdu)).length;
console.log(`\nMirados: ${resumen.mirados} · refinados: ${acciones.length} (${siguenGruesas} mejoran pero siguen gruesos) · sin resolver: ${resumen.sinResolver.length}${resumen.iaNoDisponible ? ' (la IA no estuvo disponible para todos)' : ''}`);
console.log('Por vía:', Object.entries(porFuente).map(([f, n]) => `${f} ${n}`).join(' · '));
console.log('Transiciones más frecuentes:');
for (const [t, n] of Object.entries(transiciones).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`  ${String(n).padStart(5)}  ${t}`);
console.log('Ejemplos:');
for (const a of acciones.slice(0, 40)) console.log(`   ${String(a.antes.cdu || '000').padEnd(10)} → ${String(a.cdu).padEnd(16)} «${String(a.titulo || '').slice(0, 45)}» · ${String(a.via).slice(0, 110)}`);

if (!EJECUTAR) {
  await guion.guardar(acciones, resumen);
  console.log('\n▶ Repite con --ejecutar (y los mismos parámetros) para aplicarlo: usará este guion sin volver a decidir.');
  process.exit(0);
}

// ─── APLICAR ───────────────────────────────────────────────────────────────────────────────────────────────────
// SALVAGUARDA: solo donde vive el árbol CDU (si no, la base se desincronizaría del disco).
const muestra = acciones.slice(0, 20);
let vistas = 0;
for (const a of muestra) {
  const doc = await col.findOne({ _id: new ObjectId(a.id) }, { projection: { ruta_base: 1, cdu: 1, tipo_recurso: 1 } });
  if (doc && await carpetaExiste(carpetaDeDoc(doc))) vistas++;
}
if (muestra.length && vistas < Math.ceil(muestra.length / 2)) {
  console.error(`\n❌ Solo ${vistas} de ${muestra.length} carpetas de muestra existen en ESTA máquina: ejecútalo en el NAS.\n`);
  process.exit(1);
}

let hechos = 0, movidos = 0, cambiados = 0, fallos = 0, corregidas = 0, descartadas = 0;
const p2 = progreso(acciones.length, 'Aplicando');
for (const a of acciones) {
  p2.paso(a.titulo);
  try {
    const doc = await col.findOne({ _id: new ObjectId(a.id) });
    if (!doc || !sigueIgual(doc, a.antes) || doc.cdu_manual) { cambiados++; continue; }   // cambió desde el seco: no se toca
    // Con un guion: lo decidido SIN la BNE en línea ni la IA (tablas, hermanos, árbol) se vuelve a comprobar con el
    // motor ACTUAL — barato, sin red —, por si el motor se corrigió entre el seco y la ejecución (13-oct: el árbol
    // aceptaba nombres de una palabra genérica, la tabla LCC leía «.E8» como exponente). Lo de la BNE y la IA,
    // que es lo caro, se aplica tal cual.
    let decision = a;
    if (usandoGuion && a.fuente !== 'bne' && !/IA con menú/.test(a.via)) {
      const d = (await decidirLote(db, [doc], { conIA: false, enLinea: false, desdeCero: !!a.desdeCero })).decisiones[0];
      if (!d) { descartadas++; continue; }
      if (d.cdu !== a.cdu) { corregidas++; decision = { cdu: d.cdu, fuente: d.fuente, via: d.via, desdeCero: !!a.desdeCero }; }
    }
    const r = await aplicarRefinamiento(db, doc, decision);
    if (r.aplicado) {
      hechos++;
      if (r.movida) movidos++;
      await indexarDoc(db, doc._id).catch(() => {});
    }
  } catch (e) {
    fallos++;
    p2.nota(`⛔ ${a.id}: ${e.message}`);
  }
}
p2.fin();

// Sello (como la campaña): intentados en esta versión; con IA solo si la IA llegó a participar.
const ids = (resumen.ids || []).map((i) => new ObjectId(i));
await col.updateMany({ _id: { $in: ids } }, { $set: { refinar_cdu: { v: VERSION_REFINAR, ia: conIA && !resumen.iaNoDisponible, fecha: new Date() } } });

// Los que no se pudieron refinar ni con IA: a una selección para revisarlos a mano.
if (resumen.sinResolver.length && conIA && !resumen.iaNoDisponible) {
  const fecha = new Date().toISOString().slice(0, 10);
  await crearSeleccion(db, {
    nombre: `${CONTAMINADOS ? 'CDU contaminada sin reclasificar' : 'CDU sin refinar'} ${fecha}`,
    descripcion: 'Libros con la CDU de 1-2 cifras o 000 que ni la autoridad por ISBN, ni las tablas Dewey/LCC, ni otros ejemplares, ni el árbol oficial, ni la IA con el menú oficial pudieron refinar con seguridad. scripts/refinar-cdu.js.',
    docs: resumen.sinResolver.map((i) => new ObjectId(i)),
  });
  console.log(`\n   ${resumen.sinResolver.length} sin resolver → selección «CDU sin refinar ${fecha}».`);
}
await guion.archivar();

if (usandoGuion) console.log(`\nComprobación con el motor actual: ${corregidas} corregidas · ${descartadas} descartadas (ya no pasan las reglas).`);
console.log(`\n=== HECHO · ${hechos} refinados · ${movidos} carpetas movidas · ${cambiados} cambiados desde el seco (no se tocan) · ${fallos} fallos ===`);
process.exit(fallos ? 1 : 0);
