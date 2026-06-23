import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { leerOverride } from '../src/orquestador.js';
import { enriquecerMetadatos } from '../src/motor-enriquecimiento.js';

/**
 * Override manual (.meta.json) para FORZAR la catalogación de un documento mal identificado.
 * Ejecuta:  node scripts/test-override.js
 */
let ok = 0, fallos = 0;
const eq = (c, m) => { if (c) { ok++; console.log('  ✓', m); } else { fallos++; console.log('  ✗', m); } };

// ── leerOverride encuentra el sidecar (ambas convenciones) ──
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'override-'));
await fs.writeFile(path.join(dir, 'Guns.pdf'), 'x');
await fs.writeFile(path.join(dir, 'Guns.pdf.meta.json'), JSON.stringify({ coleccion_nombre: 'Armas' }));
console.log('leerOverride:');
eq((await leerOverride(path.join(dir, 'Guns.pdf')))?.coleccion_nombre === 'Armas', 'encuentra <fichero>.meta.json');
await fs.rm(path.join(dir, 'Guns.pdf.meta.json'));
await fs.writeFile(path.join(dir, 'Guns.meta.json'), JSON.stringify({ cdu: '623.44' }));
eq((await leerOverride(path.join(dir, 'Guns.pdf')))?.cdu === '623.44', 'encuentra <base>.meta.json');
eq((await leerOverride(path.join(dir, 'no-existe.pdf'))) === null, 'sin sidecar → null');
await fs.rm(dir, { recursive: true, force: true });

// ── enriquecimiento con sin_apis + sin_isbn: fuerza y NO adjudica ISBN ajeno ──
console.log('enriquecimiento (sin_apis + sin_isbn):');
const d1 = await enriquecerMetadatos(
    { titulo: 'Guns', autores: ['X'], coleccion_nombre: 'Armas', cdu: '623.44', _isbnBloqueado: true, isbn_candidatos: [] },
    { tipo_recurso: 'libro', formatos: ['pdf'], sinApis: true });
eq(d1.titulo === 'Guns', 'título conservado');
eq(!d1.isbn, 'sin ISBN (no se adjudica el de un homónimo)');
eq(d1.coleccion_nombre === 'Armas', 'colección forzada');
eq(!('_isbnBloqueado' in d1), 'la marca interna no se persiste');

// ── enriquecimiento con sin_apis + ISBN forzado: ese ISBN manda ──
console.log('enriquecimiento (sin_apis + ISBN forzado):');
const d2 = await enriquecerMetadatos(
    { titulo: 'Guns', isbn: '9780099302780', isbn_candidatos: ['9780099302780'] },
    { tipo_recurso: 'libro', formatos: ['pdf'], sinApis: true });
eq(d2.isbn === '9780099302780', 'ISBN forzado conservado sin tocar la red');

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
