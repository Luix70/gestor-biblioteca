/**
 * AUDITAR ISBN (solo DIAGNÓSTICO, no escribe nada). Dos comprobaciones sobre toda la biblioteca:
 *   A. ISBN DUPLICADOS: cuántos documentos comparten cada ISBN. Lo normal es 1, 2 (epub+pdf) o como mucho 4
 *      (varias ediciones/formatos). Un ISBN con MUCHOS docs es sospechoso (p. ej. el bogus 0140110925 de Osprey).
 *   B. TÍTULO ≠ FICHERO: documentos con ISBN presente en el Fichero (fichero.db) cuyo TÍTULO NO casa con el del
 *      Fichero (mal catalogados). Comparación TOLERANTE (≥60% de tokens ≥3 letras en común): la grafía leve no
 *      cuenta (mayúsculas, acentos, subtítulo de más/menos, orden…).
 *
 * Uso:  node scripts/auditar-isbn.js  [--limite-ejemplos 30]
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { validarISBN } from '../src/utils/identificadores.js';

const LIM = (() => { const i = process.argv.indexOf('--limite-ejemplos'); return i >= 0 ? Number(process.argv[i + 1]) || 30 : 30; })();

// Normalización + casamiento tolerante de títulos (misma idea que buscador-local·tituloCasa).
const normTitulo = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function tituloCasa(a, b) {
    const ta = new Set(normTitulo(a).split(' ').filter((t) => t.length >= 3));
    const tb = new Set(normTitulo(b).split(' ').filter((t) => t.length >= 3));
    if (ta.size < 1 || tb.size < 1) return false;
    const [chico, grande] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let inter = 0; for (const t of chico) if (grande.has(t)) inter++;
    return inter / chico.size >= 0.6;
}

const db = await conectarDB();
const bib = db.collection('biblioteca');

console.log('\n=== AUDITAR ISBN (diagnóstico, sin escribir) ===\n');

// ── A. ISBN duplicados ────────────────────────────────────────────────────────
console.log('── A. ISBN compartidos por varios documentos ──');
const porN = await bib.aggregate([
    { $match: { isbn: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$isbn', n: { $sum: 1 } } },
    { $group: { _id: '$n', isbns: { $sum: 1 } } },
    { $sort: { _id: 1 } },
]).toArray();
const cubeta = (n) => (n <= 4 ? String(n) : n <= 10 ? '5–10' : n <= 50 ? '11–50' : '51+');
const dist = {};
for (const x of porN) dist[cubeta(x._id)] = (dist[cubeta(x._id)] || 0) + x.isbns;
console.log('  Distribución (nº de docs por ISBN → cuántos ISBN):');
for (const k of ['1', '2', '3', '4', '5–10', '11–50', '51+']) if (dist[k]) console.log(`    ${k} doc(s): ${dist[k]} ISBN`);
const sospechosos = await bib.aggregate([
    { $match: { isbn: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$isbn', n: { $sum: 1 }, titulos: { $addToSet: '$titulo' } } },
    { $match: { n: { $gt: 4 } } },
    { $sort: { n: -1 } }, { $limit: 25 },
]).toArray();
console.log(`\n  ISBN con MÁS de 4 documentos (sospechosos): ${sospechosos.length > 0 ? '' : 'ninguno'}`);
for (const s of sospechosos) console.log(`    ${s._id} → ${s.n} docs · ${s.titulos.length} título(s) distinto(s) [${s.titulos.slice(0, 2).map((t) => String(t).slice(0, 30)).join(' | ')}${s.titulos.length > 2 ? '…' : ''}]`);
const totalSosp = (await bib.aggregate([{ $match: { isbn: { $type: 'string', $ne: '' } } }, { $group: { _id: '$isbn', n: { $sum: 1 } } }, { $match: { n: { $gt: 4 } } }, { $count: 'x' } ]).toArray())[0]?.x || 0;
console.log(`  → TOTAL de ISBN con >4 docs: ${totalSosp}`);

// ── B. Título ≠ Fichero ───────────────────────────────────────────────────────
console.log('\n── B. Documentos con ISBN válido cuyo título NO casa con el del Fichero ──');
const conIsbn = await bib.find({ isbn: { $type: 'string', $ne: '' } }, { projection: { titulo: 1, isbn: 1 } }).toArray();
console.log(`  Documentos con ISBN: ${conIsbn.length}`);
const cache = new Map();
let checksumInvalido = 0, comparables = 0, noEnFichero = 0, discrepan = 0;
const ejemplos = [];
for (const d of conIsbn) {
    if (!validarISBN(d.isbn)) { checksumInvalido++; continue; }
    let fic = cache.get(d.isbn);
    if (fic === undefined) { const r = await buscarEnFicheroLocal({ isbns: [d.isbn] }).catch(() => null); fic = r && r.titulo ? r.titulo : null; cache.set(d.isbn, fic); }
    if (!fic) { noEnFichero++; continue; }
    comparables++;
    if (!tituloCasa(d.titulo, fic)) { discrepan++; if (ejemplos.length < LIM && !ejemplos.some((e) => e.isbn === d.isbn)) ejemplos.push({ isbn: d.isbn, doc: d.titulo, fichero: fic }); }
}
console.log(`  ISBN con checksum inválido: ${checksumInvalido}`);
console.log(`  ISBN válidos NO presentes en el Fichero (no comparables): ${noEnFichero}`);
console.log(`  Comparables (ISBN válido y en el Fichero): ${comparables}`);
console.log(`  → TÍTULO DISCREPANTE: ${discrepan}  (${comparables ? ((discrepan / comparables) * 100).toFixed(1) : 0}% de los comparables)\n`);
console.log(`  Ejemplos (doc → fichero):`);
for (const e of ejemplos) console.log(`    [${e.isbn}] «${String(e.doc).slice(0, 34)}»  →  «${String(e.fichero).slice(0, 44)}»`);

process.exit(0);
