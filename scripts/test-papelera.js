import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Pruebas de la Papelera de Reciclaje (política "nunca borrar").
 * Ejecuta:  node scripts/test-papelera.js
 */

let ok = 0, fallos = 0;
const existe = (p) => fs.access(p).then(() => true).catch(() => false);
async function comprobar(nombre, real, esperado) {
    if (real === esperado) { ok++; console.log(`  ✓ ${nombre}`); }
    else { fallos++; console.log(`  ✗ ${nombre} — esperado ${esperado}, real ${real}`); }
}

// La papelera lee PATH_RECICLAJE en cada uso → apuntarla a un temporal ANTES de importar.
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'papelera-'));
const bin = path.join(raiz, 'Recycling');
process.env.PATH_RECICLAJE = bin;
const { reciclar } = await import('../src/utils/papelera.js');

// Origen con 2 ficheros.
const origen = path.join(raiz, 'origen');
await fs.mkdir(origen, { recursive: true });
const a = path.join(origen, 'doc-A.pdf');
const b = path.join(origen, 'doc-B.pdf');
await fs.writeFile(a, 'AAA');
await fs.writeFile(b, 'BBBBB');

console.log('reciclar:');
const sub = await reciclar([a, b], 'lote-1');
await comprobar('origen A movido (ya no está)', await existe(a), false);
await comprobar('origen B movido (ya no está)', await existe(b), false);
await comprobar('A presente en la papelera', await existe(path.join(sub, 'doc-A.pdf')), true);
await comprobar('B presente en la papelera', await existe(path.join(sub, 'doc-B.pdf')), true);
await comprobar('subcarpeta serializada (000001_…)', /[/\\]000001_/.test(sub), true);

// Segunda llamada → serial incremental.
await fs.writeFile(a, 'AAA');
const sub2 = await reciclar(a);
await comprobar('segundo lote serial 000002', /[/\\]000002_/.test(sub2), true);

// Entradas inexistentes → null, sin crear subcarpeta.
await comprobar('nada que reciclar → null', await reciclar([path.join(origen, 'no-existe.pdf')]), null);
await comprobar('lista vacía → null', await reciclar([]), null);

await fs.rm(raiz, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
