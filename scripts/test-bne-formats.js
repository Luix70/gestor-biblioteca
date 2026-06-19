/**
 * Diagnóstico: ¿qué formato de ISBN tiene bne_cdus?
 * ¿Hay ISBN-10 Y ISBN-13 o solo uno de ellos?
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';

const db = await conectarDB();
const col = db.collection('bne_cdus');

// Contar por longitud de ISBN
const pipeline = [
    { $project: { longitud: { $strLenCP: '$isbn' } } },
    { $group: { _id: '$longitud', total: { $sum: 1 } } },
    { $sort: { _id: 1 } }
];
const distribucion = await col.aggregate(pipeline).toArray();
console.log('\nDistribución por longitud de ISBN en bne_cdus:');
for (const d of distribucion) {
    console.log(`  ${d._id} dígitos: ${d.total.toLocaleString()}`);
}

// Verificar si La Regenta está como ISBN-10 o ISBN-13
// ISBN-13: 9788437604947  ISBN-10: 8437604944
const tests = [
    ['9788437604947', 'La Regenta (ISBN-13)'],
    ['8437604944',   'La Regenta (ISBN-10)'],
    ['9788420471839', 'Cien años de soledad (ISBN-13)'],
    ['8420471839',   'Cien años de soledad (ISBN-10, posible)'],
    ['9788408049272', 'El código Da Vinci (ISBN-13)'],
    ['8408049270',   'El código Da Vinci (ISBN-10, posible)'],
];
console.log('\nBúsqueda directa de ISBNs conocidos:');
for (const [isbn, label] of tests) {
    const doc = await col.findOne({ isbn });
    if (doc) {
        console.log(`  ✔ ${isbn} → ${doc.cdus?.[0]} | ${label}`);
    } else {
        console.log(`  ✘ ${isbn} | ${label}`);
    }
}

// Muestra de 10 ISBNs de la colección para ver el formato real
console.log('\nMuestra aleatoria de ISBNs en bne_cdus:');
const muestra = await col.find({}).limit(10).toArray();
for (const m of muestra) {
    console.log(`  isbn:"${m.isbn}" (${m.isbn.length} dig) → ${m.cdus?.[0]}`);
}

process.exit(0);
