#!/usr/bin/env node
/**
 * ETL DE SERIES — construye `series.db` (junto a fichero.db) a partir del Fichero: TODAS las series editoriales
 * que conocen OpenLibrary y la BNE, con sus libros (nº, ISBN, título, autor, editorial, año).
 *
 * Por qué (30-sep): el Fichero tiene 10,2 M registros con serie, pero sin índice por serie cada consulta recorre las
 * 58,7 M filas (133 s). Con este índice derivado, «¿de qué serie es este ISBN?» y «¿qué libros tiene la serie X y
 * cuáles me faltan?» son instantáneos y sin conexión. Sirve para ratificar colecciones (una serie REAL frente a un
 * artefacto de carpeta) y para ver los huecos de una colección.
 *
 * Es un trabajo de UNA VEZ (unas horas; se puede interrumpir y REANUDA donde iba). Como busqueda.db, es DERIVADO y
 * reconstruible: no va en git ni en el despliegue. Se construye en `series.db.tmp` y solo al terminar se renombra.
 *
 *   node scripts/etl-series.js                 (en el PC, con el Fichero local; luego copiar series.db al NAS)
 *   sudo docker exec -t gestor-biblioteca node scripts/etl-series.js     (en el NAS, más lento)
 *   … --desde-cero     descarta un .tmp a medias y empieza de nuevo
 *   … --limite N       solo las primeras N filas del Fichero (para probar)
 *
 * Tablas:
 *   libros(clave, nombre, subserie, numero, orden, issn, isbn, titulo, autores, editorial, anio, idioma, fuente)
 *   series(clave, nombre, editorial, issn, n, n_isbn, n_numerados, max_orden, desde, hasta)   + series_fts (búsqueda)
 * (El ISSN pegado al nombre de la serie —«Graduate Texts in Mathematics, 0072-5285»— se separa y se guarda.)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { progreso } from '../src/utils/progreso-cli.js';
import { separarSerie, claveSerie, seriesDelCampo } from '../src/utils/series-texto.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DESDE_CERO = args.includes('--desde-cero');
const LIMITE = arg('--limite') ? Number(arg('--limite')) : null;

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rutaFichero = (() => {
    const v = process.env.PATH_FICHERO;
    const base = v && path.isAbsolute(v) ? v : path.resolve(RAIZ, v || 'Fichero');
    return /\.db$/i.test(base) ? base : path.join(base, 'fichero.db');
})();
const rutaSeries = process.env.PATH_SERIES
    ? (path.isAbsolute(process.env.PATH_SERIES) ? process.env.PATH_SERIES : path.resolve(RAIZ, process.env.PATH_SERIES))
    : path.join(path.dirname(rutaFichero), 'series.db');
const rutaTmp = `${rutaSeries}.tmp`;

if (!fs.existsSync(rutaFichero)) { console.error(`No está el Fichero: ${rutaFichero}`); process.exit(1); }
if (DESDE_CERO && fs.existsSync(rutaTmp)) fs.rmSync(rutaTmp);

const origen = new Database(rutaFichero, { readonly: true });
const destino = new Database(rutaTmp);
destino.pragma('journal_mode = OFF');   // derivado y reconstruible: velocidad antes que durabilidad
destino.pragma('synchronous = OFF');
destino.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS libros (
        clave TEXT, nombre TEXT, subserie TEXT, numero TEXT, orden INTEGER, issn TEXT,
        isbn TEXT, titulo TEXT, autores TEXT, editorial TEXT, anio INTEGER, idioma TEXT, fuente TEXT
    );
`);
const leerMeta = (k) => destino.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
const ponerMeta = destino.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v');

console.log(`\n📚 ETL de series · ${rutaFichero} → ${rutaSeries}\n`);

// ─── FASE 1: leer el Fichero (reanudable por rowid) ─────────────────────────────────────────────────────────
const maxRowid = origen.prepare('SELECT max(rowid) AS m FROM fichero').get().m;
const tope = LIMITE ? Math.min(maxRowid, LIMITE) : maxRowid;
let ultimo = Number(leerMeta('ultimo_rowid') || 0);
if (leerMeta('fase1') === 'hecha') {
    console.log('Fase 1 ya hecha (se reanuda en la fase 2).');
} else {
    if (ultimo) console.log(`Reanudando la fase 1 desde la fila ${ultimo.toLocaleString('es')}.`);
    const insertar = destino.prepare(`INSERT INTO libros
        (clave, nombre, subserie, numero, orden, issn, isbn, titulo, autores, editorial, anio, idioma, fuente)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const leer = origen.prepare(`SELECT rowid AS fila, isbn, isbn_10, titulo, autores, editorial, anio_edicion, idioma,
        coleccion_nombre, fuente FROM fichero WHERE rowid > ? AND rowid <= ? AND coleccion_nombre IS NOT NULL AND coleccion_nombre <> ''
        ORDER BY rowid`);
    const p = progreso(tope, 'Fase 1 · leyendo el Fichero');
    p.paso('', ultimo);
    const LOTE = 500_000;   // filas del Fichero por transacción (y punto de reanudación)
    let series = 0;
    while (ultimo < tope) {
        const hasta = Math.min(ultimo + LOTE, tope);
        const lote = destino.transaction(() => {
            for (const f of leer.iterate(ultimo, hasta)) {
                // Un libro puede estar en VARIAS series (la BNE las junta con « /**/ »): cuenta en cada una.
                for (const mencion of seriesDelCampo(f.coleccion_nombre)) {
                    const s = separarSerie(mencion);
                    const clave = claveSerie(s.nombre);
                    if (!clave || clave.length < 2) continue;
                    insertar.run(clave, s.nombre, s.subserie, s.numero, s.orden, s.issn,
                        f.isbn || f.isbn_10 || null,
                        String(f.titulo || '').slice(0, 250), String(f.autores || '').slice(0, 200),
                        f.editorial ? String(f.editorial).slice(0, 150) : null,
                        Number.isFinite(f.anio_edicion) ? f.anio_edicion : (parseInt(f.anio_edicion, 10) || null),
                        f.idioma || null, f.fuente || null);
                    series++;
                }
            }
            ponerMeta.run('ultimo_rowid', String(hasta));
        });
        lote();
        p.paso(`${series.toLocaleString('es')} con serie`, hasta - ultimo);
        ultimo = hasta;
    }
    ponerMeta.run('fase1', 'hecha');
    p.nota(`Fase 1: ${Number(destino.prepare('SELECT count(*) AS n FROM libros').get().n).toLocaleString('es')} libros con serie · ${p.fin()}`);
}

// ─── FASE 2: índices, tabla de series y búsqueda ────────────────────────────────────────────────────────────
// Cada paso es una sola sentencia SQL (no se puede medir por dentro): el progreso va por pasos, con su tiempo.
const pasos = [
    ['índice por serie', 'CREATE INDEX IF NOT EXISTS libros_clave ON libros(clave, orden)'],
    ['índice por ISBN', 'CREATE INDEX IF NOT EXISTS libros_isbn ON libros(isbn)'],
    ['tabla de series', `
        DROP TABLE IF EXISTS series;
        CREATE TABLE series AS
        WITH
          nombres AS (SELECT clave, nombre, count(*) AS c FROM libros GROUP BY clave, nombre),
          nombre1 AS (SELECT clave, nombre FROM (SELECT clave, nombre, row_number() OVER (PARTITION BY clave ORDER BY c DESC) AS r FROM nombres) WHERE r = 1),
          eds AS (SELECT clave, editorial, count(*) AS c FROM libros WHERE editorial IS NOT NULL GROUP BY clave, editorial),
          editorial1 AS (SELECT clave, editorial FROM (SELECT clave, editorial, row_number() OVER (PARTITION BY clave ORDER BY c DESC) AS r FROM eds) WHERE r = 1),
          totales AS (SELECT clave, count(*) AS n, count(isbn) AS n_isbn, count(numero) AS n_numerados, max(orden) AS max_orden,
                             min(anio) AS desde, max(anio) AS hasta, max(issn) AS issn FROM libros GROUP BY clave)
        SELECT t.clave, n1.nombre, e1.editorial, t.issn, t.n, t.n_isbn, t.n_numerados, t.max_orden, t.desde, t.hasta
        FROM totales t JOIN nombre1 n1 USING (clave) LEFT JOIN editorial1 e1 USING (clave);
        CREATE UNIQUE INDEX series_clave ON series(clave);
        CREATE INDEX series_issn ON series(issn);`],
    ['búsqueda por nombre', `
        DROP TABLE IF EXISTS series_fts;
        CREATE VIRTUAL TABLE series_fts USING fts5(nombre, editorial, content='series', content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2');
        INSERT INTO series_fts(series_fts) VALUES ('rebuild');`],
    ['compactar', 'VACUUM'],
];
const hechos = new Set(JSON.parse(leerMeta('fase2') || '[]'));
const p2 = progreso(pasos.length, 'Fase 2 · índices');
for (const [nombre, sql] of pasos) {
    p2.paso(nombre);
    if (hechos.has(nombre)) continue;
    const t0 = Date.now();
    destino.exec(sql);
    hechos.add(nombre);
    ponerMeta.run('fase2', JSON.stringify([...hechos]));
    p2.nota(`   ✔ ${nombre} (${Math.round((Date.now() - t0) / 1000)} s)`);
}
p2.fin();

const r = destino.prepare('SELECT count(*) AS series, sum(n) AS libros FROM series').get();
ponerMeta.run('construido', new Date().toISOString());
ponerMeta.run('fichero', rutaFichero);
destino.close();
origen.close();
fs.renameSync(rutaTmp, rutaSeries);
console.log(`\n✅ ${rutaSeries}: ${Number(r.series).toLocaleString('es')} series con ${Number(r.libros).toLocaleString('es')} libros.\n`);
process.exit(0);
