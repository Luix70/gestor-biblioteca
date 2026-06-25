/**
 * Relleno TOTAL de descripciones de clasificación (CDU + Dewey + LCC) para los códigos presentes en la
 * biblioteca que aún no las tienen. Reutiliza el mismo backfill que el mantenimiento (IA + caché); es
 * la versión "de una sentada" del relleno perezoso que hace el Conformador en tandas pequeñas.
 *
 *   node scripts/describir-clasificaciones.js              (DRY-RUN: cuenta las que faltan)
 *   node scripts/describir-clasificaciones.js --ejecutar   (genera TODAS las que falten)
 *   node scripts/describir-clasificaciones.js --limite 20  (genera solo 20, para probar)
 *
 * En el NAS: docker exec gestor-biblioteca node scripts/describir-clasificaciones.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { rellenarDescripcionesFaltantes, contarFaltantes } from '../src/mantenimiento/backfill-descripciones.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const idx = process.argv.indexOf('--limite');
const LIMITE = idx >= 0 ? Number(process.argv[idx + 1]) : Infinity;

const db = await conectarDB();
const c0 = await contarFaltantes(db);
console.log(`\n═══ DESCRIPCIONES DE CLASIFICACIÓN · ${EJECUTAR || Number.isFinite(LIMITE) ? 'GENERAR' : 'DRY-RUN'} ═══`);
console.log(`  Faltan → CDU: ${c0.cdu} · Dewey: ${c0.dewey} · LCC: ${c0.lcc} · TOTAL: ${c0.total}\n`);

if (!EJECUTAR && !Number.isFinite(LIMITE)) {
    console.log('  DRY-RUN: ejecuta con --ejecutar (o --limite N para probar).');
    process.exit(0);
}

const BATCH = 5;
const tope = Number.isFinite(LIMITE) ? LIMITE : Infinity;
let generadas = 0;
while (generadas < tope) {
    const r = await rellenarDescripcionesFaltantes({ limite: Math.min(BATCH, tope - generadas), db });
    generadas += r.generadas;
    if (r.generadas) console.log(`  +${r.generadas}  (acumulado ${generadas}, faltan ${r.pendientes})`);
    if (r.pendientes === 0 || r.generadas === 0) break; // nada más que hacer (o solo fallos → reintentar luego)
}
console.log(`\n  Generadas: ${generadas}.`);
process.exit(0);
