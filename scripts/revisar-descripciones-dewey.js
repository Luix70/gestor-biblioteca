/**
 * REVISAR LAS DESCRIPCIONES DEL DEWEY escritas por la IA contra sus referencias oficiales (13-oct).
 *
 * El motor está en src/utils/revision-dewey.js (lo comparte la campaña de fondo «revisar-dewey», que hace lo mismo
 * escalonado, por tandas, al reposo). Este script es para lanzarlo de golpe o para ver antes qué haría.
 *
 * En seco: juzga (IA, ~25 por llamada) y enseña el veredicto, sin escribir nada en la base; guarda los veredictos en
 * logs/clasificaciones/veredictos-dewey.json para que --ejecutar no vuelva a pedirlos.
 * Con --ejecutar: pasa esos veredictos a la base (campo `juicio` de cada descripción, el mismo que usa la campaña) y
 * juzga + rehace por tandas hasta --limite.
 *
 * SOLO IA GRATUITA por defecto (si las gratis se saturan, para: relánzalo más tarde o deja que siga la campaña).
 * --con-pago permite además el proveedor de pago si está activo en el panel.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-dewey.js [--limite N]
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-dewey.js --ejecutar [--limite N]
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import {
  TANDA_JUEZ, contarDeweyPendientes, descripcionesPorJuzgar, juzgarTanda, guardarJuicio, librosPorDewey, revisarTandaDewey,
} from '../src/utils/revision-dewey.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SOLO_GRATIS = !args.includes('--con-pago');
const LIMITE = Number(arg('--limite')) || Infinity;
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(RAIZ, 'logs', 'clasificaciones', 'veredictos-dewey.json');

const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · descripciones del Dewey contra sus referencias oficiales · IA ${SOLO_GRATIS ? 'SOLO gratuita' : 'gratuita y de pago'}\n`);
if (!(await db.collection('clasificacion_oficial').countDocuments({ sistema: 'dewey' }))) {
  console.log('❌ No hay referencias del Dewey: primero scripts/importar-referencias-clasificacion.js --ejecutar');
  process.exit(1);
}

const libros = await librosPorDewey(db);
const descs = await descripcionesPorJuzgar(db, LIMITE);
const pend = await contarDeweyPendientes(db);
console.log(`Por juzgar: ${pend.juzgar} · juzgadas incoherentes por rehacer: ${pend.rehacer} · en esta pasada: ${descs.length}`);

// Veredictos de una pasada en seco anterior (clave código|título: si el título cambió, no valen).
let veredictos = {};
try { veredictos = JSON.parse(await fs.readFile(CACHE, 'utf8')); } catch { /* primera vez */ }
const clave = (d) => `${d.codigo}|${d.titulo_es}`;

if (!EJECUTAR) {
  // ── EN SECO: juzgar sin tocar la base ───────────────────────────────────────────────────────
  const pendientes = descs.filter((d) => !veredictos[clave(d)]);
  if (pendientes.length) {
    await fs.mkdir(path.dirname(CACHE), { recursive: true });
    const p = progreso(Math.ceil(pendientes.length / TANDA_JUEZ), 'Juzgando (IA)');
    for (let i = 0; i < pendientes.length; i += TANDA_JUEZ) {
      const tanda = pendientes.slice(i, i + TANDA_JUEZ);
      p.paso(`tanda ${i / TANDA_JUEZ + 1}`);
      try {
        const v = await juzgarTanda(db, tanda, { soloGratis: SOLO_GRATIS });
        for (const d of tanda) if (v.has(d.codigo)) veredictos[clave(d)] = v.get(d.codigo);
        if (v.size < tanda.length / 2) p.nota(`   ⚠ tanda ${i / TANDA_JUEZ + 1}: solo ${v.size} de ${tanda.length} veredictos legibles`);
      } catch (e) {
        p.nota(`   ⚠ tanda ${i / TANDA_JUEZ + 1}: ${e.message} — se para aquí (relanza más tarde: sigue donde lo dejó)`);
        break;
      }
      await fs.writeFile(CACHE, JSON.stringify(veredictos));
    }
    p.fin();
  }
  const juzgadas = descs.filter((d) => veredictos[clave(d)]);
  const incoherentes = juzgadas.filter((d) => !veredictos[clave(d)].coherente);
  console.log(`\nJuzgadas: ${juzgadas.length} de ${descs.length} · coherentes: ${juzgadas.length - incoherentes.length} · incoherentes: ${incoherentes.length}`);
  incoherentes.slice(0, 40).forEach((d) => console.log(`   ✗ ${String(libros.get(d.codigo) || 0).padStart(4)}  Dewey ${d.codigo.padEnd(12)} «${String(d.titulo_es).slice(0, 50)}» · ${String(veredictos[clave(d)].motivo).slice(0, 70)}`));
  console.log(`\n=== DRY-RUN · se rehacerían ${incoherentes.length} ===`);
  console.log('▶ Repite con --ejecutar (reutiliza los veredictos guardados), o enciende la campaña «Revisar descripciones Dewey».');
  process.exit(0);
}

// ── EJECUCIÓN ─────────────────────────────────────────────────────────────────────────────────
// 1) Los veredictos de la pasada en seco pasan a la base (así no se vuelven a pedir).
const conVeredicto = descs.filter((d) => veredictos[clave(d)]);
if (conVeredicto.length) {
  const p = progreso(conVeredicto.length, 'Guardando veredictos previos');
  for (const d of conVeredicto) {
    p.paso(d.codigo);
    await guardarJuicio(db, d, veredictos[clave(d)]);
  }
  p.fin();
}

// 2) Rehacer las incoherentes y juzgar el resto, por tandas del motor, hasta el límite.
const objetivo = Math.min(LIMITE, pend.total + conVeredicto.length);
const p = progreso(objetivo, 'Revisando');
let procesados = 0, cambios = 0, sinIA = false;
while (procesados < objetivo) {
  const r = await revisarTandaDewey(db, { limite: Math.min(100, objetivo - procesados), soloGratis: SOLO_GRATIS });
  procesados += r.procesados;
  cambios += r.cambios;
  for (let i = 0; i < r.procesados; i++) p.paso(`${cambios} rehechas`);
  if (r.sinIA) { sinIA = true; p.nota('   ⏸ IA gratuita saturada o no disponible: se para (relanza más tarde, o deja que siga la campaña).'); break; }
  if (!r.procesados) break;
}
p.fin();
const fin = await contarDeweyPendientes(db);
console.log(`\n=== HECHO · ${procesados} revisadas · ${cambios} rehechas · quedan ${fin.juzgar} por juzgar y ${fin.rehacer} por rehacer${sinIA ? ' (parado por la IA)' : ''} ===`);
process.exit(0);
