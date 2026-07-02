/**
 * Backfill de autores: rellena foto + biografía + seudónimos/heterónimos + fechas desde APIs PÚBLICAS y
 * GRATUITAS (OpenLibrary + Wikidata + Wikipedia), SIN clave y SIN IA. Conservador (solo huecos) salvo
 * --sobrescribir. Procesa por TANDAS DE 25 con una pausa entre autores (no saturar Wikimedia/OpenLibrary).
 * Solo toca autores QUE TIENEN LIBROS y a los que les falta biografía o foto.
 *
 *   node scripts/enriquecer-autores.js                 (DRY-RUN: cuenta los candidatos)
 *   node scripts/enriquecer-autores.js --ejecutar      (rellena TODOS los que falten)
 *   node scripts/enriquecer-autores.js --ejecutar --limite 50
 *   node scripts/enriquecer-autores.js --ejecutar --sobrescribir   (pisa lo existente)
 *
 * En el NAS: docker exec gestor-biblioteca node scripts/enriquecer-autores.js --ejecutar
 * (En Windows, si Atlas rechaza el TLS: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/enriquecer-autores.js …)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { autoresEnriquecibles, enriquecerAutor } from '../src/utils/enriquecer-autor.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const SOBRESCRIBIR = process.argv.includes('--sobrescribir');
const idx = process.argv.indexOf('--limite');
const LIMITE = idx >= 0 ? Number(process.argv[idx + 1]) : Infinity;

const TANDA = 25;                                            // autores por tanda (igual que el mantenimiento)
const PAUSA_MS = Number(process.env.ENRIQUECER_PAUSA_MS || 600); // ritmo entre autores (respeta a las APIs)
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await conectarDB();
const candidatos = await autoresEnriquecibles(db);
console.log(`\n═══ ENRIQUECER AUTORES · ${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'} ═══`);
console.log(`  Autores con libros y SIN biografía o SIN foto: ${candidatos.length}`);

if (!EJECUTAR) {
    console.log('\n  DRY-RUN: no se ha escrito nada. Repite con --ejecutar (o --limite N para probar).\n');
    process.exit(0);
}

const objetivo = candidatos.slice(0, Number.isFinite(LIMITE) ? LIMITE : candidatos.length);
let procesados = 0, enriquecidos = 0, sinDatos = 0, fallos = 0;

for (let i = 0; i < objetivo.length; i += TANDA) {
    const tanda = objetivo.slice(i, i + TANDA);
    console.log(`\n── Tanda ${Math.floor(i / TANDA) + 1} (${i + 1}–${i + tanda.length} de ${objetivo.length}) ──`);
    for (const a of tanda) {
        procesados++;
        try {
            const r = await enriquecerAutor(db, a._id, { sobrescribir: SOBRESCRIBIR });
            if (r.ok && r.cambios.length) {
                enriquecidos++;
                console.log(`  ✅ «${a.nombre}» ← ${r.cambios.join(', ')} (${r.fuentes.join(', ')})`);
            } else {
                sinDatos++;
                console.log(`  ·  «${a.nombre}» — sin datos nuevos`);
            }
        } catch (e) {
            fallos++;
            console.warn(`  ⚠️ «${a.nombre}»: ${e.message}`);
        }
        await espera(PAUSA_MS);
    }
}

console.log(`\n✅ Hecho: ${procesados} procesados · ${enriquecidos} enriquecidos · ${sinDatos} sin datos · ${fallos} fallo(s).\n`);
process.exit(0);
