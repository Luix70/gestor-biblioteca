/**
 * scripts/test-bne-verify.js
 * Verificación rápida: stats de bne_cdus + spot-check contra biblioteca.
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEnBNE } from '../src/utils/buscador-bne.js';

const db = await conectarDB();

// 1. Stats de la colección bne_cdus
const stats = await db.command({ collStats: 'bne_cdus' });
const count = stats.count || stats.ns;
console.log(`\nbne_cdus:`);
console.log(`  Documentos:  ${(stats.count || 0).toLocaleString()}`);
console.log(`  Tamaño datos: ${(stats.size / 1024 / 1024).toFixed(0)} MB`);
console.log(`  Índices:     ${(stats.totalIndexSize / 1024 / 1024).toFixed(0)} MB`);

// 2. Spot-check: 15 libros de la biblioteca con ISBN
const libros = await db.collection('biblioteca')
    .find({ isbn: { $exists: true } }, { projection: { titulo: 1, isbn: 1, cdu: 1 } })
    .limit(15).toArray();

console.log('\n── Spot-check ISBNs de nuestra biblioteca ──');
let hits = 0;
for (const l of libros) {
    const r = await buscarEnBNE(l.isbn);
    if (r) {
        hits++;
        const cduBNE = r.cdus[0];
        const cambio = cduBNE !== l.cdu ? ` ← actual en BD: ${l.cdu}` : ' (misma CDU)';
        console.log(`  ✔ ${cduBNE}${cambio}`);
        console.log(`    "${l.titulo?.slice(0, 55)}"  ISBN:${l.isbn}`);
    } else {
        console.log(`  ✘ no en BNE`);
        console.log(`    "${l.titulo?.slice(0, 55)}"  ISBN:${l.isbn}`);
    }
}
console.log(`\nCobertura: ${hits}/${libros.length} libros encontrados en BNE local`);

process.exit(0);
