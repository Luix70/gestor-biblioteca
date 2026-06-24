/**
 * Tarea ÚNICA de integridad: diagnostica (y opcionalmente repara) el archivo en una sola pasada
 * — consolida auditoria-integridad + resolver-duplicados + dedup por hash.
 *
 *   node scripts/integridad.js              → DIAGNÓSTICO (no toca nada)
 *   node scripts/integridad.js --reparar    → DIAGNÓSTICO + REPARACIÓN SEGURA (todo a la Papelera)
 *
 * En el NAS, dentro del contenedor:
 *   docker exec gestor-biblioteca node scripts/integridad.js [--reparar]
 * Para programarlo (diario/semanal): Programador de tareas de DSM con ese mismo comando.
 */
import 'dotenv/config';
import '../src/config.js';
import { verificarIntegridad } from '../src/integridad.js';

const REPARAR = process.argv.includes('--reparar');
const inf = await verificarIntegridad({ reparar: REPARAR });

console.log(`\n═══ INTEGRIDAD · ${REPARAR ? 'DIAGNÓSTICO + REPARACIÓN' : 'DIAGNÓSTICO'} · ${inf.ts} ═══`);
console.log(`Total documentos en BD: ${inf.totalDocs}\n`);
console.log('Diagnóstico:');
for (const [k, v] of Object.entries(inf.diagnostico)) console.log(`  ${k.padEnd(26)} ${v}`);
if (inf.reparado) {
    console.log('\nReparado (a la Papelera):');
    for (const [k, v] of Object.entries(inf.reparado)) console.log(`  ${k.padEnd(26)} ${v}`);
}
// Muestras útiles para revisar a mano lo NO auto-reparable.
if (inf.muestras.docsSinCarpeta?.length) { console.log('\nDocs sin carpeta (muestra):'); for (const x of inf.muestras.docsSinCarpeta) console.log(`  [${x.id}] "${x.titulo}" → ${x.ruta}`); }
if (inf.muestras.docsSinFicheroOriginal?.length) { console.log('\nDocs sin fichero original (muestra):'); for (const x of inf.muestras.docsSinFicheroOriginal) console.log(`  [${x.id}] "${x.titulo}" (${x.archivo || '—'})`); }
if (!REPARAR) console.log('\n(diagnóstico) Re-ejecuta con --reparar para aplicar las correcciones seguras.');
process.exit(0);
