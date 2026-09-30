#!/usr/bin/env node
/**
 * CONSULTAR UNA SERIE en el índice de series (series.db): qué libros tiene, cuáles tienes tú y qué números faltan.
 *
 *   node scripts/consultar-serie.js "Graduate texts in mathematics"
 *   node scripts/consultar-serie.js --isbn 9783030628130          (¿de qué serie es este libro?)
 *   node scripts/consultar-serie.js "Ancora y delfin" --editorial Destino
 *   … --clave <clave>     una serie concreta (la primera columna de la lista de coincidencias)
 *   … --sin-base          sin consultar la biblioteca (no marca lo que tienes)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { disponible, seriesDeISBN, buscarSeries, serie, librosDeSerie } from '../src/utils/buscador-series.js';
import { variantesISBN } from '../src/utils/identificadores.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ISBN = arg('--isbn');
const CLAVE = arg('--clave');
const EDITORIAL = arg('--editorial');
const SIN_BASE = args.includes('--sin-base');
const TEXTO = args.filter((a, i) => !a.startsWith('--') && !['--isbn', '--clave', '--editorial'].includes(args[i - 1])).join(' ');

if (!disponible()) { console.error('No está series.db: constrúyelo con  node scripts/etl-series.js'); process.exit(1); }

if (ISBN) {
    const s = seriesDeISBN(ISBN);
    if (!s.length) console.log(`El ISBN ${ISBN} no figura en ninguna serie del Fichero.`);
    for (const x of s) console.log(`  ${x.nombre}${x.subserie ? ` — ${x.subserie}` : ''} · nº ${x.numero || '?'} · ${x.editorial || '?'} · (${x.n} registros)  [--clave "${x.clave}"]`);
    process.exit(0);
}

let clave = CLAVE;
if (!clave) {
    const encontradas = buscarSeries(TEXTO, { limite: 8 });
    if (!encontradas.length) { console.log(`Ninguna serie casa con «${TEXTO}».`); process.exit(0); }
    console.log('Series que casan:');
    for (const s of encontradas) console.log(`  ${String(s.n).padStart(6)} reg. · ${s.nombre} · ${s.editorial || '?'} · ${s.desde || '?'}–${s.hasta || '?'}   [--clave "${s.clave}"]`);
    clave = encontradas[0].clave;
}
const ficha = serie(clave);
const libros = librosDeSerie(clave, { editorial: EDITORIAL });
console.log(`\n📚 ${ficha?.nombre || clave}${EDITORIAL ? ` (${EDITORIAL})` : ''} · ${libros.length} registros\n`);

// Lo que tienes: por ISBN en la biblioteca.
let tengo = new Set();
if (!SIN_BASE) {
    const { conectarDB } = await import('../src/database.js');
    const db = await conectarDB();
    const isbns = [...new Set(libros.flatMap((l) => variantesISBN(l.isbn)))];
    for (let i = 0; i < isbns.length; i += 5000) {
        const docs = await db.collection('biblioteca').find({ isbn: { $in: isbns.slice(i, i + 5000) } }, { projection: { isbn: 1 } }).toArray();
        for (const d of docs) for (const v of variantesISBN(d.isbn)) tengo.add(v);
    }
}

// Por número: cada número una línea (las reediciones del mismo número se juntan).
const porNumero = new Map();
const sinNumero = [];
for (const l of libros) {
    if (l.orden === null || l.orden === undefined) { sinNumero.push(l); continue; }
    const g = porNumero.get(l.orden) || [];
    g.push(l);
    porNumero.set(l.orden, g);
}
const loTengo = (l) => variantesISBN(l.isbn).some((v) => tengo.has(v));
let tenidos = 0;
for (const [n, g] of [...porNumero.entries()].sort((a, b) => a[0] - b[0])) {
    const mio = g.some(loTengo);
    if (mio) tenidos++;
    const l = g.find(loTengo) || g[0];
    console.log(`  ${mio ? '✓' : '·'} ${String(n).padStart(5)}  ${String(l.titulo).slice(0, 70)}${l.anio ? ` (${l.anio})` : ''}${g.length > 1 ? `  +${g.length - 1} ed.` : ''}`);
}
if (sinNumero.length) {
    console.log(`\n  Sin número (${sinNumero.length}):`);
    for (const l of sinNumero.slice(0, 40)) console.log(`  ${loTengo(l) ? '✓' : '·'}        ${String(l.titulo).slice(0, 70)}${l.anio ? ` (${l.anio})` : ''}`);
    if (sinNumero.length > 40) console.log(`  … y ${sinNumero.length - 40} más`);
}

// Huecos: números entre 1 y el mayor conocido que no figuran en el Fichero (la serie existe, pero no sabemos cuál es).
const numeros = [...porNumero.keys()].sort((a, b) => a - b);
const max = numeros.length ? numeros[numeros.length - 1] : 0;
const desconocidos = [];
for (let i = 1; i <= max; i++) if (!porNumero.has(i)) desconocidos.push(i);
const rangos = (lista) => {
    const out = [];
    for (let i = 0; i < lista.length; i++) {
        let j = i;
        while (j + 1 < lista.length && lista[j + 1] === lista[j] + 1) j++;
        out.push(i === j ? `${lista[i]}` : `${lista[i]}-${lista[j]}`);
        i = j;
    }
    return out.join(', ');
};
console.log(`\nTienes ${tenidos} de ${porNumero.size} números conocidos${SIN_BASE ? ' (sin consultar la biblioteca)' : ''}.`);
if (desconocidos.length && desconocidos.length < 400) console.log(`Números que el Fichero no conoce (hasta el ${max}): ${rangos(desconocidos)}`);
process.exit(0);
