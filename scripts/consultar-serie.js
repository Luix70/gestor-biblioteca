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
const ficha = serie(clave);
const libros = librosDeSerie(clave, { editorial: EDITORIAL });
console.log(`\n📚 ${ficha?.nombre || clave}${EDITORIAL ? ` (${EDITORIAL})` : ''} · ${libros.length} registros en el Fichero`);

// ─── Título comparable: el mismo libro sale con grafías distintas («A course in arithmetic» / «course in arithmetic.»).
const claveTitulo = (t) => String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/^\s*(a|an|the|el|la|los|las|le|les|der|die|das)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

const tieneNumero = (l) => l.orden !== null && l.orden !== undefined;

// ─── ENTRADAS: una por número; las de sin número, una por título. Cada una junta sus ediciones y TODOS sus ISBN.
const porNumero = new Map();     // orden → entrada
const sinNumero = new Map();     // claveTitulo → entrada
const nueva = (titulo, anio, numero) => ({ numero, titulo, anio: anio || null, ediciones: 0, isbns: new Set(), fuentes: new Set() });
const anadir = (entrada, isbns, fuente) => {
    entrada.ediciones++;
    for (const x of isbns) for (const v of variantesISBN(x)) entrada.isbns.add(v);
    entrada.fuentes.add(fuente);
};
for (const l of libros.filter(tieneNumero)) {
    if (!porNumero.has(l.orden)) porNumero.set(l.orden, nueva(l.titulo, l.anio, l.orden));
    anadir(porNumero.get(l.orden), [l.isbn], 'fichero');
}

// Título → número, solo si ese título es de UN solo número («Graph theory» es el 63, el 173 y el 244: no se adivina).
const numerosDeTitulo = new Map();
for (const l of libros.filter(tieneNumero)) {
    const k = claveTitulo(l.titulo);
    if (!numerosDeTitulo.has(k)) numerosDeTitulo.set(k, new Set());
    numerosDeTitulo.get(k).add(l.orden);
}
const numeroUnico = (titulo) => {
    const s = numerosDeTitulo.get(claveTitulo(titulo));
    return s && s.size === 1 ? [...s][0] : null;
};

// Un registro SIN número cuyo título es el de un número conocido es otra edición de ese número.
let reunidos = 0;
for (const l of libros.filter((x) => !tieneNumero(x))) {
    const n = numeroUnico(l.titulo);
    if (n !== null) {
        anadir(porNumero.get(n), [l.isbn], 'fichero');
        reunidos++;
        continue;
    }
    const k = claveTitulo(l.titulo);
    if (!sinNumero.has(k)) sinNumero.set(k, nueva(l.titulo, l.anio, null));
    anadir(sinNumero.get(k), [l.isbn], 'fichero');
}

// ─── CROSSREF (crossref.db, si está): los libros de la serie por su ISSN. Springer y compañía no depositan el número
//     de volumen, pero sí el título y los ISBN (papel + ebook). Cada uno se une a la entrada con la que comparte un
//     ISBN o el título; si no, es un libro que el Fichero no conoce (suelen ser los recientes).
const soloCrossref = new Map();
if (!SIN_CROSSREF) {
    const { crossrefLocalDisponible, librosDeSerieCrossrefLocal, seriesCrossrefPorNombre } = await import('../src/utils/crossref-local.js');
    if (crossrefLocalDisponible()) {
        const issnSerie = ficha?.issn || seriesCrossrefPorNombre(ficha?.nombre || TEXTO)[0]?.issn || null;
        const deLaSerie = issnSerie ? librosDeSerieCrossrefLocal(issnSerie) : [];
        const entradaPorIsbn = new Map();
        for (const e of [...porNumero.values(), ...sinNumero.values()]) for (const v of e.isbns) entradaPorIsbn.set(v, e);
        for (const c of deLaSerie) {
            const variantes = c.isbns.flatMap((x) => variantesISBN(x));
            let entrada = variantes.map((v) => entradaPorIsbn.get(v)).find(Boolean);
            if (!entrada) {
                const n = c.coleccion_numero ? Number.parseInt(c.coleccion_numero, 10) : numeroUnico(c.titulo);
                const k = claveTitulo(c.titulo);
                entrada = (Number.isFinite(n) && porNumero.get(n)) || sinNumero.get(k) || soloCrossref.get(k);
                if (!entrada) {
                    entrada = nueva(c.titulo, c.año_edicion, null);
                    soloCrossref.set(k, entrada);
                }
            }
            anadir(entrada, c.isbns, 'crossref');
            for (const v of entrada.isbns) entradaPorIsbn.set(v, entrada);
        }
        console.log(`   + Crossref (ISSN ${issnSerie || 'desconocido'}): ${deLaSerie.length} libros, ${soloCrossref.size} que el Fichero no tiene.`);
    }
}
console.log('');

const db = SIN_BASE ? null : await (await import('../src/database.js')).conectarDB();

// ─── NÚMEROS DE TUS FICHAS: tus libros de esta colección que llevan `coleccion_numero` dan el número que el Fichero
//     no conoce («Categories for the working mathematician» es el GTM 5). Se busca la entrada por ISBN o título y,
//     si no tiene número y ese número está libre, pasa a él. Cordura: el número no puede pasar mucho del mayor
//     conocido (hay fichas con un trozo de ISBN o ISSN como «número»: 852, 6056…).
let deTusFichas = 0;
if (db) {
    const nombreSerie = claveTitulo(ficha?.nombre || TEXTO);
    const issnSerie = ficha?.issn || null;
    const candidatas = await db.collection('colecciones')
        .find({}, { projection: { nombre: 1, issn: 1 } })
        .toArray();
    // La colección de la biblioteca es la de la serie si su nombre, sin la puntuación de la ficha («Graduate texts in
    // mathematics ;»), es el mismo, o si comparten ISSN.
    const idsColeccion = candidatas
        .filter((c) => claveTitulo(c.nombre) === nombreSerie || (issnSerie && c.issn === issnSerie))
        .map((c) => c._id);
    const mayorConocido = Math.max(0, ...porNumero.keys());
    const conNumero = idsColeccion.length
        ? await db.collection('biblioteca')
            .find({ coleccion: { $in: idsColeccion }, coleccion_numero: { $nin: [null, ''] } }, { projection: { titulo: 1, isbn: 1, coleccion_numero: 1 } })
            .toArray()
        : [];
    // Título de la ficha sin coletillas de edición o de catálogo («… - 2. edición», «(Graduate Texts…)»).
    const tituloDeFicha = (t) => claveTitulo(String(t || '').replace(/\s+-\s+.*$/, '').replace(/\([^)]*\)/g, ''));
    const entradaPorIsbn = new Map();
    for (const e of [...sinNumero.values(), ...soloCrossref.values()]) for (const v of e.isbns) entradaPorIsbn.set(v, e);
    for (const d of conNumero) {
        const n = Number.parseInt(String(d.coleccion_numero), 10);
        if (!Number.isFinite(n) || n < 1 || n > mayorConocido + 50 || porNumero.has(n)) continue;
        const k = tituloDeFicha(d.titulo);
        const entrada = variantesISBN(d.isbn).map((v) => entradaPorIsbn.get(v)).find(Boolean)
            || sinNumero.get(k) || soloCrossref.get(k);
        if (!entrada) continue;
        // Sale de su lista y pasa a su número.
        for (const lista of [sinNumero, soloCrossref]) for (const [clave, e] of lista) if (e === entrada) lista.delete(clave);
        entrada.numero = n;
        entrada.fuentes.add('ficha');
        porNumero.set(n, entrada);
        deTusFichas++;
    }
    if (deTusFichas) console.log(`   + ${deTusFichas} números sacados de tus fichas (coleccion_numero).\n`);
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
const tenidosSinNumero = sinNum.filter(laTengo).length + soloCr.filter(laTengo).length;
console.log(`\nTienes ${tenidos} de ${porNumero.size} números conocidos`
    + `${tenidosSinNumero ? `, y ${tenidosSinNumero} títulos más de la serie sin número` : ''}`
    + `${SIN_BASE ? ' (sin consultar la biblioteca)' : ''}.`);
if (desconocidos.length && desconocidos.length < 400) console.log(`Números que no conocemos (hasta el ${max}): ${rangos(desconocidos)}`);
process.exit(0);
