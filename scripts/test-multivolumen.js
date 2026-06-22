/** Test offline del parseo de obras multivolumen. node scripts/test-multivolumen.js */
import path from 'path';
import { parsearVolumen, extraerISBNsConRol, discriminarMultivolumen, discriminarMultivolumenes, totalDeclarado, aArabigo } from '../src/utils/multivolumen.js';

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

// ── discriminarMultivolumenes: DOS obras en subcarpetas distintas NO se funden (bug real) ──
const drop = '/Inbox/31.Multipart Inconsistent';
const dosObras = [
    `${drop}/Encyclopedia Of Alternative Medicine/The Gale Encyclopedia Of Alternative Medicine, Vol 1 - A-C - 2005 2Ed.pdf`,
    `${drop}/Encyclopedia Of Alternative Medicine/The Gale Encyclopedia Of Alternative Medicine, Vol 2 - D-K - 2005 2Ed.pdf`,
    `${drop}/Encyclopedia Of Alternative Medicine/The Gale Encyclopedia Of Alternative Medicine, Vol 3 - L-R - 2005 2Ed.pdf`,
    `${drop}/Encyclopedia Of Alternative Medicine/The Gale Encyclopedia Of Alternative Medicine, Vol 4 - S-Z - 2005 2Ed.pdf`,
    `${drop}/Unusual and Unexplained Vol 1-3/Gale, Unusual and Unexplained Vol. 1.pdf`,
    `${drop}/Unusual and Unexplained Vol 1-3/Gale, Unusual and Unexplained Vol. 2.pdf`,
    `${drop}/Unusual and Unexplained Vol 1-3/Gale, Unusual and Unexplained Vol. 3.pdf`,
];
const { obras, resto } = discriminarMultivolumenes(dosObras);
eq(obras.length === 2, `dos subcarpetas → 2 obras (no 1) → ${obras.length}`);
const alt = obras.find(o => /Alternative/.test(o.titulo_obra));
const unu = obras.find(o => /Unusual/.test(o.titulo_obra));
eq(alt && alt.volumenes.length === 4 && alt.total === 4, `Alternative Medicine → 4 tomos, total 4`);
eq(unu && unu.volumenes.length === 3 && unu.total === 3, `Unusual (carpeta "Vol 1-3") → total declarado 3`);
eq(resto.length === 0, `sin resto suelto → ${resto.length}`);
// Números NO duplicados dentro de cada obra (el bug daba 1,1,2,2,3,3,4).
eq(alt && new Set(alt.volumenes.map(v => v.numero)).size === 4, 'Alternative: 4 números distintos');

// ── totalDeclarado ──
eq(totalDeclarado('Algo Vol 1-3') === 3, 'totalDeclarado "Vol 1-3" → 3');
eq(totalDeclarado('Obra en 5 tomos') === 5, 'totalDeclarado "en 5 tomos" → 5');
eq(totalDeclarado('Sin pista') === null, 'totalDeclarado sin pista → null');

console.log(`\n${ok} OK · ${fail} fallos`);
process.exit(fail ? 1 : 0);
