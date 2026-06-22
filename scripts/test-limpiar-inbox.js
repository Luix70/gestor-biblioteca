import fs from 'fs/promises';
import os from 'os';
import path from 'path';

/**
 * Regresión del bug de PÉRDIDA DE DATOS en obras multivolumen:
 * al limpiar el Inbox tras catalogar el tomo 1, el barrido de "sidecars" de la carpeta
 * retiraba los tomos 2..N (PDFs válidos) que compartían la carpeta y aún no se habían
 * procesado. limpiarInbox NUNCA debe tocar un documento bibliográfico válido.
 * Además, política "nunca borrar": lo retirado se MUEVE a la Papelera, no se elimina.
 *
 * Ejecuta:  node scripts/test-limpiar-inbox.js
 */

let ok = 0, fallos = 0;
const existe = (p) => fs.access(p).then(() => true).catch(() => false);
async function comprobar(nombre, real, esperado) {
    if (real === esperado) { ok++; console.log(`  ✓ ${nombre}`); }
    else { fallos++; console.log(`  ✗ ${nombre} — esperado ${esperado}, real ${real}`); }
}

// Papelera a un temporal ANTES de importar el vigilante (papelera lee PATH_RECICLAJE en cada uso).
const raiz = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-multivol-'));
process.env.PATH_RECICLAJE = path.join(raiz, 'Recycling');
const { limpiarInbox } = await import('../src/vigilante.js');

const dir = path.join(raiz, 'Obra');
await fs.mkdir(dir, { recursive: true });
const vol1 = path.join(dir, 'Obra Vol 1 - A-C.pdf');
const vol2 = path.join(dir, 'Obra Vol 2 - D-K.pdf');
const vol3 = path.join(dir, 'Obra Vol 3 - L-Z.pdf');
const notas = path.join(dir, 'notas.txt');
const url = path.join(dir, 'enlace.url');
for (const f of [vol1, vol2, vol3, notas, url]) await fs.writeFile(f, 'x');

// Simula la limpieza tras catalogar SOLO el tomo 1 (como hace el vigilante con cada unidad).
await limpiarInbox({ rutas: [vol1], carpeta: dir, conservarCarpeta: false });

console.log('limpiarInbox (obra multivolumen, tomo 1):');
await comprobar('tomo 1 retirado del Inbox',    await existe(vol1), false);
await comprobar('tomo 2 CONSERVADO',            await existe(vol2), true);
await comprobar('tomo 3 CONSERVADO',            await existe(vol3), true);
await comprobar('sidecar .txt barrido',         await existe(notas), false);
await comprobar('sidecar .url barrido',         await existe(url), false);
// Lo retirado debe estar en la Papelera, NO perdido.
const enPapelera = async (nombre) => {
    for (const s of await fs.readdir(process.env.PATH_RECICLAJE).catch(() => [])) {
        if (await existe(path.join(process.env.PATH_RECICLAJE, s, nombre))) return true;
    }
    return false;
};
await comprobar('tomo 1 recuperable en la Papelera', await enPapelera('Obra Vol 1 - A-C.pdf'), true);
await comprobar('sidecar .txt recuperable en la Papelera', await enPapelera('notas.txt'), true);

await fs.rm(raiz, { recursive: true, force: true }).catch(() => {});
console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
