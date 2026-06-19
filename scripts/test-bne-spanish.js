/**
 * Verifica la colección bne_cdus con ISBNs españoles (84-xxx).
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEnBNE } from '../src/utils/buscador-bne.js';

const db = await conectarDB();

// Obtener libros con ISBN español (empieza por 84 en ISBN-13 o ISBN-10)
const librosES = await db.collection('biblioteca')
    .find({
        $or: [
            { isbn: /^978-84/ },
            { isbn: /^97884/ },
            { isbn: /^84/ }
        ]
    }, { projection: { titulo: 1, isbn: 1, cdu: 1 } })
    .limit(10).toArray();

if (librosES.length === 0) {
    console.log('Sin ISBNs españoles en la biblioteca; probando con ISBNs conocidos de la BNE...');
}

// ISBNs de muestra de libros publicados en España (conocidos)
const muestraDirecta = [
    { isbn: '9788437604947', titulo: 'La Regenta - Clarín' },
    { isbn: '9788420471839', titulo: 'Cien años de soledad - García Márquez' },
    { isbn: '9788408049272', titulo: 'El código Da Vinci' },
    { isbn: '9788497937337', titulo: '1984 de Orwell (ed. española)' },
    { isbn: '9788467034929', titulo: 'El Quijote - Cervantes' },
];

console.log('\n── Búsqueda directa con ISBNs españoles ──');
let hits = 0;
const todosISBNs = [
    ...librosES.map(l => ({ isbn: l.isbn, titulo: l.titulo })),
    ...muestraDirecta,
];

for (const { isbn, titulo } of todosISBNs) {
    const r = await buscarEnBNE(isbn);
    if (r) {
        hits++;
        console.log(`  ✔ ISBN:${isbn} → CDU: ${r.cdus.join(' / ')}${r.paginas ? ` (${r.paginas}p)` : ''}`);
        console.log(`    "${titulo?.slice(0, 60)}"`);
    } else {
        console.log(`  ✘ ISBN:${isbn} — no en BNE local`);
        console.log(`    "${titulo?.slice(0, 60)}"`);
    }
}
console.log(`\nCobertura: ${hits}/${todosISBNs.length}`);

// Buscar directamente en bne_cdus para confirmar que hay docs con ISBN español
const ejemplos = await db.collection('bne_cdus')
    .find({ isbn: /^97884/ })
    .limit(5)
    .toArray();
console.log(`\nEjemplos de bne_cdus con ISBN 97884-xxx (confirma que hay datos españoles):`);
for (const e of ejemplos) {
    console.log(`  ${e.isbn} → ${e.cdus?.[0] || '?'} ${e.paginas ? `(${e.paginas}p)` : ''} ${e.fecha || ''}`);
}

process.exit(0);
