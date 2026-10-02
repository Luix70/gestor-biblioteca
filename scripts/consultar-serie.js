#!/usr/bin/env node
/**
 * CONSULTAR UNA SERIE en el índice de series (series.db): qué libros tiene, cuáles tienes tú y qué números faltan.
 *
 *   node scripts/consultar-serie.js "Graduate texts in mathematics"
 *   node scripts/consultar-serie.js --isbn 9783030628130          (¿de qué serie es este libro?)
 *   node scripts/consultar-serie.js "Ancora y delfin" --editorial Destino
 *   … --clave <clave>     una serie concreta (la primera columna de la lista de coincidencias)
 *   … --sin-base          sin consultar la biblioteca (no marca lo que tienes)
 *   … --sin-crossref      sin completar con crossref.db (si está, añade los libros de la serie por su ISSN)
 *   … --todos             listar todos los títulos sin número (por defecto, 40)
 *
 * Cada número junta sus ediciones Y los registros sin número con el mismo título (otra edición del mismo libro), con
 * todos sus ISBN: «✓» si tienes cualquiera de ellos (papel, ebook, otra edición). Si está crossref.db, se suman los
 * libros de la serie que da Crossref por su ISSN: no traen el número, pero sí títulos e ISBN hasta hoy (el Fichero
 * se queda antes), así que aparecen los libros recientes y se reconocen más de los que tienes. Y los números que el
 * Fichero no conoce se toman de TUS fichas de la colección (`coleccion_numero`), marcados «[nº de tu ficha]».
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { disponible, seriesDeISBN, buscarSeries, serie, librosDeSerie } from '../src/utils/buscador-series.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { entradasDeSerie, numerosDeTusFichas, numerosDesconocidos, rangos, claveTitulo } from '../src/utils/serie-completa.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ISBN = arg('--isbn');
const CLAVE = arg('--clave');
const EDITORIAL = arg('--editorial');
const SIN_BASE = args.includes('--sin-base');   // sin la base tampoco se usan los números de tus fichas
const SIN_CROSSREF = args.includes('--sin-crossref');
const TODOS = args.includes('--todos');
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
const issnFicha = serie(clave)?.issn || null;
const e = entradasDeSerie({ clave, issn: issnFicha, editorial: EDITORIAL, conCrossref: !SIN_CROSSREF });
const { ficha, porNumero, sinNumero, soloCrossref, reunidos } = e;
console.log(`
📚 ${ficha?.nombre || clave}${EDITORIAL ? ` (${EDITORIAL})` : ''} · ${e.registros} registros en el Fichero`);
if (e.deCrossref) console.log(`   + Crossref (ISSN ${e.issn}): ${e.deCrossref} libros, ${soloCrossref.size} que el Fichero no tiene.`);
console.log('');

const db = SIN_BASE ? null : await (await import('../src/database.js')).conectarDB();

// Números de TUS fichas: tus libros de la colección de esta serie (mismo nombre sin la puntuación de la ficha, o
// mismo ISSN) que llevan coleccion_numero dan el número que el Fichero no conoce.
if (db) {
    const nombreSerie = claveTitulo(ficha?.nombre || TEXTO);
    const idsColeccion = (await db.collection('colecciones').find({}, { projection: { nombre: 1, issn: 1 } }).toArray())
        .filter((c) => claveTitulo(c.nombre) === nombreSerie || (e.issn && c.issn === e.issn))
        .map((c) => c._id);
    const conNumero = idsColeccion.length
        ? await db.collection('biblioteca')
            .find({ coleccion: { $in: idsColeccion }, coleccion_numero: { $nin: [null, ''] } }, { projection: { titulo: 1, isbn: 1, coleccion_numero: 1 } })
            .toArray()
        : [];
    const deTusFichas = numerosDeTusFichas(e, conNumero);
    if (deTusFichas) console.log(`   + ${deTusFichas} números sacados de tus fichas (coleccion_numero).
`);
}

// ─── Lo que tienes: por cualquiera de los ISBN de cada entrada.
const tengo = new Set();
if (db) {
    const entradas = [...porNumero.values(), ...sinNumero.values(), ...soloCrossref.values()];
    const todos = [...new Set(entradas.flatMap((e) => [...e.isbns]))];
    for (let i = 0; i < todos.length; i += 5000) {
        const docs = await db.collection('biblioteca').find({ isbn: { $in: todos.slice(i, i + 5000) } }, { projection: { isbn: 1 } }).toArray();
        for (const d of docs) for (const v of variantesISBN(d.isbn)) tengo.add(v);
    }
}
const laTengo = (e) => [...e.isbns].some((v) => tengo.has(v));
const linea = (e, columnaNumero) => {
    const extra = e.ediciones > 1 ? `  +${e.ediciones - 1} ed.` : '';
    const marcaCrossref = !e.fuentes.has('fichero') && e.fuentes.has('crossref') ? '  [Crossref]' : '';
    const marcaFicha = e.fuentes.has('ficha') ? '  [nº de tu ficha]' : '';
    return `  ${laTengo(e) ? '✓' : '·'} ${columnaNumero}  ${String(e.titulo).slice(0, 70)}${e.anio ? ` (${e.anio})` : ''}${extra}${marcaCrossref}${marcaFicha}`;
};

let tenidos = 0;
for (const [n, e] of [...porNumero.entries()].sort((a, b) => a[0] - b[0])) {
    if (laTengo(e)) tenidos++;
    console.log(linea(e, String(n).padStart(5)));
}

// Sin número: primero los que tienes (lo útil es saber qué tienes de la serie), luego por año.
const ordenar = (lista) => lista.sort((a, b) => (laTengo(b) - laTengo(a)) || ((a.anio || 9999) - (b.anio || 9999)));
const listar = (titulo, lista) => {
    if (!lista.length) return;
    console.log(`\n  ${titulo}:`);
    for (const e of lista.slice(0, TODOS ? Infinity : 40)) console.log(linea(e, '     '));
    if (!TODOS && lista.length > 40) console.log(`  … y ${lista.length - 40} más (--todos para verlos)`);
};
const sinNum = ordenar([...sinNumero.values()]);
const soloCr = ordenar([...soloCrossref.values()]);
listar(`Sin número en el Fichero (${sinNum.length} títulos; ${reunidos} registros más eran otra edición de un número)`, sinNum);
listar(`Solo en Crossref (${soloCr.length}; Crossref no da el número de la serie)`, soloCr);

// Huecos: números entre 1 y el mayor conocido que no figuran (la serie existe, pero no sabemos cuál es).
const desconocidos = numerosDesconocidos(porNumero);
const max = Math.max(0, ...porNumero.keys());
const tenidosSinNumero = sinNum.filter(laTengo).length + soloCr.filter(laTengo).length;
console.log(`\nTienes ${tenidos} de ${porNumero.size} números conocidos`
    + `${tenidosSinNumero ? `, y ${tenidosSinNumero} títulos más de la serie sin número` : ''}`
    + `${SIN_BASE ? ' (sin consultar la biblioteca)' : ''}.`);
if (desconocidos.length && desconocidos.length < 400) console.log(`Números que no conocemos (hasta el ${max}): ${rangos(desconocidos)}`);
process.exit(0);
