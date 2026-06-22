import { registrarVolumenEnObra } from '../src/utils/obras.js';

/**
 * Prueba del inventario de tomos de una obra multivolumen (volumenes[], total, faltantes),
 * con un 'db' simulado en memoria (sin Atlas).
 * Ejecuta:  node scripts/test-obras-inventario.js
 */

let ok = 0, fallos = 0;
function comprobar(nombre, real, esperado) {
    const a = JSON.stringify(real), b = JSON.stringify(esperado);
    if (a === b) { ok++; console.log(`  ✓ ${nombre}`); }
    else { fallos++; console.log(`  ✗ ${nombre}\n      esperado: ${b}\n      real:     ${a}`); }
}

// 'db' mínimo: una colección 'obras' en memoria con findOne/updateOne($set).
function fakeDb(obra) {
    const store = new Map([[String(obra._id), obra]]);
    return {
        collection() {
            return {
                async findOne(f) { return store.get(String(f._id)) || null; },
                async updateOne(f, u) { Object.assign(store.get(String(f._id)), u.$set); },
            };
        },
        _obra() { return store.get(String(obra._id)); },
    };
}

const OBRA_ID = 'obra-1';
const db = fakeDb({ _id: OBRA_ID, titulo: 'Worldmark', total_volumenes: 3 });

// Catalogamos el tomo 1 y el 3 (falta el 2): inventario 1..3 con _id o null.
await registrarVolumenEnObra(db, OBRA_ID, 1, 'doc-1', 3);
await registrarVolumenEnObra(db, OBRA_ID, 3, 'doc-3', 3);
let o = db._obra();
console.log('obra tras tomos 1 y 3 (falta 2):');
comprobar('volumenes', o.volumenes, [
    { numero: 1, _id: 'doc-1' }, { numero: 2, _id: null }, { numero: 3, _id: 'doc-3' },
]);
comprobar('total_volumenes', o.total_volumenes, 3);
comprobar('volumenes_presentes', o.volumenes_presentes, 2);
comprobar('completa', o.completa, false);

// Llega el tomo 2 → obra completa.
await registrarVolumenEnObra(db, OBRA_ID, 2, 'doc-2', 3);
o = db._obra();
console.log('obra tras el tomo 2:');
comprobar('completa', o.completa, true);
comprobar('presentes', o.volumenes_presentes, 3);
comprobar('tomo 2 con _id', o.volumenes[1], { numero: 2, _id: 'doc-2' });

// Re-catalogar el tomo 1 (idempotente): refresca _id, no duplica.
await registrarVolumenEnObra(db, OBRA_ID, 1, 'doc-1b', 3);
o = db._obra();
comprobar('idempotente: sigue 3 presentes', o.volumenes_presentes, 3);
comprobar('tomo 1 refrescado', o.volumenes[0], { numero: 1, _id: 'doc-1b' });

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
