/** Test offline del parseo de obras multivolumen. node scripts/test-multivolumen.js */
import path from 'path';
import { parsearVolumen, extraerISBNsConRol, discriminarMultivolumen, aArabigo } from '../src/utils/multivolumen.js';

let ok = 0, fail = 0;
const eq = (cond, msg) => { if (cond) ok++; else { fail++; console.log('  ❌', msg); } };

// ── parsearVolumen ─────────────────────────────────────────────────────────
for (const [n, num, tit] of [
    ['Vol. 1 - United Nations.pdf', 1, 'United Nations'],
    ['Vol. 6 - World Leaders 2003.pdf', 6, 'World Leaders 2003'],
    ['Tomo I - Teatro.pdf', 1, 'Teatro'],
    ['Volumen 3. Américas.epub', 3, 'Américas'],
    ['Band 2 — Die Welt.pdf', 2, 'Die Welt'],
    ['Tome IV.pdf', 4, null],
    ['Un libro normal sin tomo.pdf', null, null],
]) {
    const r = parsearVolumen(n);
    eq((r?.numero ?? null) === num && (r?.titulo ?? null) === tit, `parsearVolumen("${n}") → ${JSON.stringify(r)}`);
}
eq(aArabigo('XII') === 12 && aArabigo('4') === 4 && aArabigo('IV') === 4, 'aArabigo romano/árabe');

// ── extraerISBNsConRol (créditos estilo Sartre/Aguilar) ────────────────────
const creditos = `edición española
ISBN 84-03-04989-7 (obra completa)
ISBN 84-03-04071-7 (tomo I)`;
const roles = extraerISBNsConRol(creditos);
const obra = roles.find(r => r.rol === 'obra');
const tomo = roles.find(r => r.rol === 'volumen');
eq(obra && obra.isbn === '8403049897', `ISBN obra → ${JSON.stringify(obra)}`);
eq(tomo && tomo.numero === 1, `ISBN tomo I → ${JSON.stringify(tomo)}`);

// ── discriminarMultivolumen (caso 30: Worldmark Encyclopedia) ──────────────
const base = '30/Gale.../Worldmark Encyclopedia of the Nations. 11th ed';
const worldmark = [1, 2, 3, 4, 5, 6].map(i => path.join(base, `Vol. ${i} - X${i}.pdf`));
const d = discriminarMultivolumen(worldmark);
eq(d && d.volumenes.length === 6, `discrimina 6 volúmenes → ${d?.volumenes.length}`);
eq(d && d.titulo_obra === 'Worldmark Encyclopedia of the Nations. 11th ed', `título obra → "${d?.titulo_obra}"`);
// Una colección normal (no volúmenes) NO debe discriminarse como obra.
eq(discriminarMultivolumen(['a/Libro uno.epub', 'a/Otro libro.epub']) === null, 'colección normal no es obra');

console.log(`\n${ok} OK · ${fail} fallos`);
process.exit(fail ? 1 : 0);
