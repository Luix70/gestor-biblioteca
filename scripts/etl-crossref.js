#!/usr/bin/env node
/**
 * ETL DE CROSSREF — construye `crossref.db` (junto a fichero.db) con los LIBROS del volcado público anual de
 * Crossref (March 2026 Public Data File: 35.909 ficheros .jsonl.gz de 5.000 registros, ~180 M registros, ~240 GB).
 *
 * Por qué: para los libros académicos (Springer, Routledge, Cambridge, Oxford, Wiley, De Gruyter, Elsevier…)
 * Crossref sabe lo que al Fichero (OpenLibrary + BNE) le falta: la SERIE con su ISSN y su número de volumen, el DOI,
 * los editores y lo reciente. Con este índice local la cascada lo consulta SIN conexión y sin límites (la API queda
 * para lo registrado después de marzo de 2026), y las colecciones pueden ratificarse y mostrar sus huecos por ISSN.
 *
 * Qué se guarda (solo lo que tiene ISBN; los artículos de revista, que son el 70 %, se saltan sin leerlos):
 *   · los LIBROS (book, monograph, edited-book, reference-book, book-set, proceedings): título, subtítulo, título
 *     original, autores, editores, editorial, lugar, año, edición, serie + ISSN + volumen, DOI, idioma y el RESUMEN
 *     (lo trae más de la mitad de los libros: es una sinopsis de la editorial);
 *   · los libros que solo aparecen a través de sus CAPÍTULOS (book-chapter, other…): el título del libro y su
 *     serie salen del `container-title` del capítulo (con ISSN, el primero es la serie y el último el libro).
 *     Si después aparece el registro del libro, lo sustituye.
 *
 * Es un trabajo de UNA VEZ en el PC (horas; REANUDABLE: cada fichero del volcado se apunta al terminarlo, y al
 * relanzar sigue por donde iba). Como series.db, es DERIVADO y reconstruible: fuera de git y del despliegue; se
 * COPIA a la carpeta Fichero del NAS. Usa varios hilos: el trabajo es descomprimir y leer JSON.
 *
 *   node scripts/etl-crossref.js
 *   node scripts/etl-crossref.js --dir "U:/_DUMPEDCATALOGS/March 2026 Public Data File from Crossref" --hilos 6
 *   … --limite 200     solo los primeros N ficheros (para probar)
 *   … --desde-cero     descarta lo hecho y empieza de nuevo
 *   … --capitulos      guarda también el ÍNDICE de capítulos de los libros (título, autores, DOI): más GB y tiempo
 *
 * Tablas:
 *   libros(id, isbns, titulo, subtitulo, titulo_original, autores, editores, editorial, lugar, anio, edicion, serie,
 *          serie_issn, volumen, doi, idioma, sinopsis, tipo, fuente)   fuente: 'libro' (propio) | 'capitulo' (deducido)
 *
 *   isbn_libro(isbn → libro, tipo)                   tipo del ISBN: 'print' (papel) | 'electronic' (ebook)
 *   revistas(issn, titulo, editorial, n)             las REVISTAS (de los artículos): nombre de cabecera por ISSN
 *   capitulos(libro, orden, titulo, autores, doi)    con --capitulos: el ÍNDICE de los libros colectivos
 *
 * El año: el de la edición IMPRESA si lo hay (en un 36 % de los libros difiere del de la edición en línea, que suele
 * salir antes); el de la en línea se guarda aparte.
 * Lo que se DEJA FUERA: los artículos (salvo el nombre de su revista), actas, datasets…; las bibliografías
 * (`reference`), licencias, enlaces, financiadores, recuentos de citas y relaciones entre registros (casi no las hay).
 *   isbn_libro(isbn → libro)                         ISBN-13 sin guiones; uno por cada ISBN del libro
 *   series(issn, nombre, n)                          al final: las series por ISSN y cuántos libros tienen
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { limpiarTextoCrossref } from '../src/utils/texto-crossref.js';

// ─── Extracción (en cada hilo) ──────────────────────────────────────────────────────────────────────────────
const TIPOS_LIBRO = new Set(['book', 'monograph', 'edited-book', 'reference-book', 'book-set', 'proceedings']);
const TIPOS_PARTE = new Set(['book-chapter', 'book-part', 'book-section', 'book-track', 'other', 'reference-entry']);

/** ISBN-13 sin guiones (convierte los de 10). null si no tiene forma de ISBN. */
function isbn13(valor) {
    const d = String(valor || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (d.length === 13 && /^97[89]\d{10}$/.test(d)) return d;
    if (d.length !== 10 || !/^\d{9}[\dX]$/.test(d)) return null;
    const base = `978${d.slice(0, 9)}`;
    let suma = 0;
    for (let i = 0; i < 12; i++) suma += Number(base[i]) * (i % 2 ? 3 : 1);
    return base + ((10 - (suma % 10)) % 10);
}
const persona = (p) => [p.given, p.family].filter(Boolean).join(' ').trim() || p.name || null;
const anioDe = (w) => (w['published-print'] || w.published || w['published-online'] || w.issued)?.['date-parts']?.[0]?.[0] || null;
const anioOnline = (w) => w['published-online']?.['date-parts']?.[0]?.[0] || null;
/** Los ISBN con su tipo (papel / ebook), en forma de 13. */
const isbnsConTipo = (w) => (w['isbn-type'] || []).map((x) => ({ isbn: isbn13(x.value), tipo: x.type })).filter((x) => x.isbn);
const issnDe = (w) => (w['issn-type'] || []).find((x) => x.type === 'print')?.value || (w.ISSN || [])[0] || null;
const corta = (s, n) => (s ? String(s).slice(0, n) : null);
// Texto para leer (títulos, nombres, resúmenes): sin entidades HTML ni etiquetas de formato. NO para el DOI (los SICI
// llevan «<» y «>» de verdad).
const cortaTexto = (s, n) => (s ? limpiarTextoCrossref(String(s)).slice(0, n) || null : null);

/** Un registro de Crossref → la fila de su LIBRO (o null si no hay libro que sacar). */
function filaDe(w) {
    const isbns = [...new Set((w.ISBN || []).map(isbn13).filter(Boolean))];
    if (!isbns.length) return null;
    const titulos = (w['container-title'] || []).filter(Boolean);
    if (TIPOS_LIBRO.has(w.type)) {
        const titulo = (w.title || [])[0];
        if (!titulo) return null;
        // En un libro, el container-title es su SERIE (el primero que no sea el propio título).
        const serie = titulos.find((c) => c !== titulo) || null;
        return {
            isbns, fuente: 'libro', tipo: w.type,
            titulo: cortaTexto(titulo, 400), subtitulo: cortaTexto((w.subtitle || [])[0], 400),
            autores: cortaTexto((w.author || []).map(persona).filter(Boolean).join('; '), 600),
            editores: cortaTexto((w.editor || []).map(persona).filter(Boolean).join('; '), 600),
            editorial: cortaTexto(w.publisher, 200), lugar: corta(w['publisher-location'], 120), anio: anioDe(w),
            serie: cortaTexto(serie, 300), serie_issn: serie ? issnDe(w) : null, volumen: serie ? corta(w.volume, 40) : null,
            doi: corta(w.DOI, 200), idioma: w.language ? String(w.language).slice(0, 2) : null,
            titulo_original: cortaTexto((w['original-title'] || [])[0], 400),
            edicion: corta(w['edition-number'], 20),
            anio_online: anioOnline(w),
            tipos: isbnsConTipo(w),
            // El resumen viene en JATS (XML): se le quitan las etiquetas.
            sinopsis: w.abstract ? cortaTexto(String(w.abstract).replace(/<[^>]+>/g, ' '), 4000) : null,
        };
    }
    if (TIPOS_PARTE.has(w.type) && titulos.length) {
        // Capítulo: el último container-title es el LIBRO; si hay más de uno y el registro trae ISSN, el primero
        // es la SERIE (Springer: ["Respiratory Medicine", "Echocardiography and Ultrasonography in the ICU"]).
        const titulo = titulos[titulos.length - 1];
        const serie = titulos.length > 1 ? titulos[0] : null;
        return {
            isbns, fuente: 'capitulo', tipo: 'book',
            titulo: cortaTexto(titulo, 400), subtitulo: null, autores: null,
            editores: cortaTexto((w.editor || []).map(persona).filter(Boolean).join('; '), 600),
            editorial: cortaTexto(w.publisher, 200), lugar: corta(w['publisher-location'], 120), anio: anioDe(w),
            serie: cortaTexto(serie, 300), serie_issn: serie ? issnDe(w) : null, volumen: null, doi: null, idioma: w.language ? String(w.language).slice(0, 2) : null,
            titulo_original: null, edicion: null, sinopsis: null, anio_online: anioOnline(w), tipos: isbnsConTipo(w),
            // El capítulo mismo, para el ÍNDICE del libro (solo se guarda con --capitulos).
            capitulo: w.type === 'book-chapter' && (w.title || [])[0] ? {
                titulo: cortaTexto(w.title[0], 400),
                autores: cortaTexto((w.author || []).map(persona).filter(Boolean).join('; '), 400),
                doi: corta(w.DOI, 200),
                orden: Number(String(w.DOI || '').match(/_(\d+)$/)?.[1]) || null,   // Springer: …_27 = capítulo 27
            } : null,
        };
    }
    return null;
}

/** Lee un fichero del volcado y devuelve las filas de libro, una por libro (los capítulos se repiten mucho). */
// Nombre de la REVISTA de un artículo, sin parsear el JSON entero (son el 70 % del volcado): tres expresiones.
// (El volcado lleva un espacio tras cada «:» y cada «[»: `"ISSN": ["0740-0020"]`.)
const RE_TIPO_ARTICULO = /"type":\s*"journal-article"/;
const RE_ISSN = /"ISSN":\s*\[\s*"([0-9]{4}-[0-9]{3}[0-9X])"/;
const RE_CONTENEDOR = /"container-title":\s*\[\s*"((?:[^"\\]|\\.)*)"/;
const RE_EDITORIAL = /"publisher":\s*"((?:[^"\\]|\\.)*)"/;
const desescapar = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };

function procesarFichero(ruta, { capitulos = false } = {}) {
    const texto = zlib.gunzipSync(fs.readFileSync(ruta)).toString('utf8');
    const porClave = new Map();
    const indices = [];           // capítulos: { isbn del libro, …capítulo }
    const revistas = new Map();   // issn → { titulo, editorial, n }
    // Revistas: una pasada línea a línea solo con expresiones regulares (barato).
    for (let i = 0, fin; i < texto.length; i = fin + 1) {
        fin = texto.indexOf('\n', i);
        if (fin < 0) fin = texto.length;
        const linea = texto.slice(i, fin);
        if (!RE_TIPO_ARTICULO.test(linea)) continue;
        const issn = linea.match(RE_ISSN)?.[1];
        const titulo = linea.match(RE_CONTENEDOR)?.[1];
        if (!issn || !titulo) continue;
        const r = revistas.get(issn);
        if (r) r.n++;
        else revistas.set(issn, { titulo: desescapar(titulo).slice(0, 300), editorial: desescapar(linea.match(RE_EDITORIAL)?.[1] || '').slice(0, 200) || null, n: 1 });
    }
    // Solo se parsean las líneas con ISBN: un artículo de revista no lo lleva (el 90 % se salta sin leerlo). Se
    // salta de una aparición de «"ISBN"» a la siguiente, no línea a línea: buscar desde cada línea hasta la próxima
    // aparición recorría el texto una y otra vez (medido: 5 s por fichero en vez de 0,5).
    let siguienteIsbn = texto.indexOf('"ISBN"');
    while (siguienteIsbn >= 0) {
        const inicio = texto.lastIndexOf('\n', siguienteIsbn) + 1;
        let fin = texto.indexOf('\n', siguienteIsbn);
        if (fin < 0) fin = texto.length;
        siguienteIsbn = texto.indexOf('"ISBN"', fin);
        try {
            const fila = filaDe(JSON.parse(texto.slice(inicio, fin)));
            if (fila?.capitulo && capitulos) indices.push({ isbn: fila.isbns[0], ...fila.capitulo });
            if (fila) {
                delete fila.capitulo;
                const clave = fila.isbns[0];
                const previa = porClave.get(clave);
                if (!previa || (previa.fuente === 'capitulo' && fila.fuente === 'libro')) porClave.set(clave, fila);
            }
        } catch { /* línea corrupta: se ignora */ }
    }
    return { filas: [...porClave.values()], indices, revistas: [...revistas].map(([issn, r]) => ({ issn, ...r })) };
}

if (!isMainThread) {
    parentPort.on('message', (tarea) => {
        try { parentPort.postMessage({ numero: tarea.numero, ...procesarFichero(tarea.ruta, { capitulos: tarea.capitulos }) }); }
        catch (e) { parentPort.postMessage({ numero: tarea.numero, error: e.message }); }
    });
} else {
    await principal();
}

// ─── Hilo principal: reparte los ficheros y escribe la base ─────────────────────────────────────────────────
async function principal() {
    const { default: Database } = await import('better-sqlite3');
    const { progreso } = await import('../src/utils/progreso-cli.js');
    const args = process.argv.slice(2);
    const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
    const DIR = arg('--dir') || 'U:/_DUMPEDCATALOGS/March 2026 Public Data File from Crossref';
    const HILOS = Math.max(1, Number(arg('--hilos')) || Math.min(6, os.cpus().length - 1));
    const LIMITE = arg('--limite') ? Number(arg('--limite')) : null;
    const CAPITULOS = args.includes('--capitulos');   // guardar también el índice de capítulos (más GB, más tiempo)
    const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const rutaFichero = (() => {
        const v = process.env.PATH_FICHERO;
        const base = v && path.isAbsolute(v) ? v : path.resolve(RAIZ, v || 'Fichero');
        return /\.db$/i.test(base) ? base : path.join(base, 'fichero.db');
    })();
    const OUT = arg('--out') || path.join(path.dirname(rutaFichero), 'crossref.db');
    const TMP = `${OUT}.tmp`;

    if (!fs.existsSync(DIR)) { console.error(`No está la carpeta del volcado: ${DIR}`); process.exit(1); }
    if (args.includes('--desde-cero') && fs.existsSync(TMP)) fs.rmSync(TMP);

    const db = new Database(TMP);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(`
        CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS hechos (fichero INTEGER PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS libros (
            id INTEGER PRIMARY KEY, isbns TEXT, titulo TEXT, subtitulo TEXT, titulo_original TEXT, autores TEXT, editores TEXT,
            editorial TEXT, lugar TEXT, anio INTEGER, edicion TEXT, serie TEXT, serie_issn TEXT, volumen TEXT, doi TEXT,
            idioma TEXT, sinopsis TEXT, anio_online INTEGER, tipo TEXT, fuente TEXT
        );
        CREATE TABLE IF NOT EXISTS isbn_libro (isbn TEXT PRIMARY KEY, libro INTEGER, tipo TEXT) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS revistas (issn TEXT PRIMARY KEY, titulo TEXT, editorial TEXT, n INTEGER) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS capitulos (libro_isbn TEXT, orden INTEGER, titulo TEXT, autores TEXT, doi TEXT);
    `);
    const buscar = db.prepare('SELECT l.id, l.fuente, l.serie FROM isbn_libro i JOIN libros l ON l.id = i.libro WHERE i.isbn = ?');
    const insertar = db.prepare(`INSERT INTO libros (isbns, titulo, subtitulo, titulo_original, autores, editores, editorial,
        lugar, anio, edicion, serie, serie_issn, volumen, doi, idioma, sinopsis, anio_online, tipo, fuente) VALUES (@isbns,
        @titulo, @subtitulo, @titulo_original, @autores, @editores, @editorial, @lugar, @anio, @edicion, @serie, @serie_issn,
        @volumen, @doi, @idioma, @sinopsis, @anio_online, @tipo, @fuente)`);
    const sustituir = db.prepare(`UPDATE libros SET isbns=@isbns, titulo=@titulo, subtitulo=@subtitulo,
        titulo_original=@titulo_original, autores=@autores, editores=@editores, editorial=@editorial, lugar=@lugar,
        anio=@anio, edicion=@edicion, serie=COALESCE(@serie, serie), serie_issn=COALESCE(@serie_issn, serie_issn),
        volumen=@volumen, doi=@doi, idioma=@idioma, sinopsis=@sinopsis, anio_online=@anio_online, tipo=@tipo,
        fuente=@fuente WHERE id=@id`);
    const completarSerie = db.prepare('UPDATE libros SET serie=@serie, serie_issn=@serie_issn WHERE id=@id AND serie IS NULL');
    const enlazar = db.prepare('INSERT OR IGNORE INTO isbn_libro (isbn, libro, tipo) VALUES (?, ?, ?)');
    const ponerTipo = db.prepare('UPDATE isbn_libro SET tipo = ? WHERE isbn = ? AND tipo IS NULL');
    const sumarRevista = db.prepare(`INSERT INTO revistas (issn, titulo, editorial, n) VALUES (@issn, @titulo, @editorial, @n)
        ON CONFLICT(issn) DO UPDATE SET n = n + excluded.n`);
    const insertarCapitulo = db.prepare('INSERT INTO capitulos (libro_isbn, orden, titulo, autores, doi) VALUES (@isbn, @orden, @titulo, @autores, @doi)');
    const marcar = db.prepare('INSERT OR IGNORE INTO hechos (fichero) VALUES (?)');

    // Escribir lo de un fichero del volcado: una transacción, con el fichero marcado como hecho dentro.
    const guardar = db.transaction((numero, filas, indices, revistas) => {
        for (const r of revistas) sumarRevista.run(r);
        for (const c of indices) insertarCapitulo.run(c);
        for (const f of filas) {
            const tipoDe = (isbn) => (f.tipos || []).find((t) => t.isbn === isbn)?.tipo || null;
            const { tipos, ...resto } = f;
            const fila = { ...resto, isbns: f.isbns.join(' ') };
            const existente = f.isbns.map((i) => buscar.get(i)).find(Boolean);
            if (!existente) {
                const id = insertar.run(fila).lastInsertRowid;
                for (const i of f.isbns) enlazar.run(i, id, tipoDe(i));
            } else if (existente.fuente === 'capitulo' && f.fuente === 'libro') {
                sustituir.run({ ...fila, id: existente.id });   // el registro del propio libro manda sobre lo deducido
                for (const i of f.isbns) { enlazar.run(i, existente.id, tipoDe(i)); ponerTipo.run(tipoDe(i), i); }
            } else {
                if (!existente.serie && f.serie) completarSerie.run({ serie: f.serie, serie_issn: f.serie_issn, id: existente.id });
                for (const i of f.isbns) { if (tipoDe(i)) ponerTipo.run(tipoDe(i), i); }
            }
        }
        marcar.run(numero);
    });

    const todos = fs.readdirSync(DIR).filter((n) => /^\d+\.jsonl\.gz$/.test(n)).map((n) => Number(n.split('.')[0])).sort((a, b) => a - b);
    const hechos = new Set(db.prepare('SELECT fichero FROM hechos').all().map((r) => r.fichero));
    const cola = todos.filter((n) => !hechos.has(n)).slice(0, LIMITE ?? undefined);
    console.log(`\n📚 ETL de Crossref · ${DIR}\n   → ${OUT} · ${todos.length} ficheros en el volcado, ${hechos.size} ya hechos, ${cola.length} por hacer · ${HILOS} hilos\n`);

    let parar = false;
    process.on('SIGINT', () => { if (!parar) { parar = true; console.log('\n⏸  Parando: termino los ficheros en curso (relanza para seguir)…'); } });

    const p = progreso(cola.length, 'Leyendo el volcado');
    let libros = 0, siguiente = 0, enMarcha = 0;
    await new Promise((resolver) => {
        if (!cola.length) return resolver();
        const hilos = Array.from({ length: Math.min(HILOS, cola.length) }, () => new Worker(fileURLToPath(import.meta.url)));
        const darTrabajo = (w) => {
            if (parar || siguiente >= cola.length) {
                w.terminate();
                if (enMarcha === 0) resolver();
                return;
            }
            const numero = cola[siguiente++];
            enMarcha++;
            w.postMessage({ numero, ruta: path.join(DIR, `${numero}.jsonl.gz`), capitulos: CAPITULOS });
        };
        for (const w of hilos) {
            w.on('message', (m) => {
                enMarcha--;
                if (m.error) p.nota(`⚠️  ${m.numero}.jsonl.gz: ${m.error} (se reintentará al relanzar)`);
                else { guardar(m.numero, m.filas, m.indices || [], m.revistas || []); libros += m.filas.length; }
                p.paso(`${libros.toLocaleString('es')} libros`);
                darTrabajo(w);
            });
            w.on('error', (e) => { p.nota(`⚠️  hilo: ${e.message}`); enMarcha = Math.max(0, enMarcha - 1); darTrabajo(w); });
            darTrabajo(w);
        }
    });
    p.fin();

    const quedan = todos.length - db.prepare('SELECT count(*) AS n FROM hechos').get().n;
    if (quedan > 0) {
        console.log(`\n⏸  Quedan ${quedan} ficheros por leer: relanza el mismo comando para seguir.\n`);
        db.close();
        process.exit(0);
    }

    // ─── Índices y tabla de series (al terminar todo) ───────────────────────────────────────────────────────
    console.log('\nÍndices y series…');
    db.exec(`
        CREATE INDEX IF NOT EXISTS libros_serie_issn ON libros(serie_issn);
        CREATE INDEX IF NOT EXISTS capitulos_libro ON capitulos(libro_isbn, orden);
        DROP TABLE IF EXISTS series;
        CREATE TABLE series AS
            SELECT serie_issn AS issn, serie AS nombre, count(*) AS n FROM libros
            WHERE serie_issn IS NOT NULL GROUP BY serie_issn
            ORDER BY n DESC;
        CREATE UNIQUE INDEX series_issn ON series(issn);
    `);
    db.pragma('journal_mode = DELETE');
    db.exec('VACUUM');
    const r = db.prepare('SELECT count(*) AS libros, sum(serie_issn IS NOT NULL) AS con_serie FROM libros').get();
    const s = db.prepare('SELECT count(*) AS n FROM series').get();
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run('construido', new Date().toISOString());
    db.close();
    fs.renameSync(TMP, OUT);
    console.log(`\n✅ ${OUT}: ${Number(r.libros).toLocaleString('es')} libros (${Number(r.con_serie).toLocaleString('es')} con serie e ISSN) · ${Number(s.n).toLocaleString('es')} series.\n`);
    process.exit(0);
}
