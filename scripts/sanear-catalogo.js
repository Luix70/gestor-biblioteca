/**
 * Sanea el catálogo con el pipeline ACTUAL (deshace daños de ingestas viejas), sin pérdida de datos.
 *   node scripts/sanear-catalogo.js                      (DRY-RUN: informa, no toca nada)
 *   node scripts/sanear-catalogo.js --limite 50          (prueba con los primeros 50 docs)
 *   node scripts/sanear-catalogo.js --ejecutar           (re-home + portadas; sin red)
 *   node scripts/sanear-catalogo.js --ejecutar --reclasificar   (+ re-ingiere cómics mal archivados; usa IA)
 * También en el panel (Actividad → Sanear catálogo). Detalle de las tareas en src/sanear-catalogo.js.
 */
import 'dotenv/config';
import '../src/config.js';
import { sanearCatalogo } from '../src/sanear-catalogo.js';

const ejecutar = process.argv.includes('--ejecutar');
const reclasificar = process.argv.includes('--reclasificar');
const idx = process.argv.indexOf('--limite');
const limite = idx >= 0 ? Number(process.argv[idx + 1]) : Infinity;

(async () => {
    console.log(`\nSanear catálogo  [${ejecutar ? 'EJECUTAR' : 'DRY-RUN'}${reclasificar ? ' +reclasificar' : ''}]${Number.isFinite(limite) ? ` · límite ${limite}` : ''}`);
    if (!ejecutar) console.log('  ℹ️  DRY-RUN: no se escribe nada.');
    const inf = await sanearCatalogo({ ejecutar, reclasificar, limite });
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`Total documentos: ${inf.total}`);
    console.log('DIAGNÓSTICO (candidatos):');
    console.log(`  · re-home (carpeta con #/%):     ${inf.diagnostico.rehome}`);
    console.log(`  · portada que falta:             ${inf.diagnostico.portada}`);
    console.log(`  · re-clasificar (cómic↔obra):    ${inf.diagnostico.reclasificar}${reclasificar ? '' : '  (necesita --reclasificar)'}`);
    if (inf.hecho) {
        console.log('HECHO:');
        console.log(`  · re-alojados:   ${inf.hecho.rehome}`);
        console.log(`  · portadas:      ${inf.hecho.portada}`);
        console.log(`  · re-ingeridos:  ${inf.hecho.reclasificar}`);
        console.log(`  · errores:       ${inf.hecho.errores}`);
    }
    for (const k of ['rehome', 'portada', 'reclasificar']) {
        if (inf.muestras[k]?.length) {
            console.log(`\nMuestra «${k}»:`);
            for (const m of inf.muestras[k]) console.log(`  [${m.id}] ${m.titulo || ''}${m.ruta ? '  → ' + m.ruta : ''}`);
        }
    }
    process.exit(0);
})().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
