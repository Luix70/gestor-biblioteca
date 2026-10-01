/**
 * CONSULTAS al índice de SERIES (`series.db`, lo construye scripts/etl-series.js a partir del Fichero).
 *
 *   seriesDeISBN(isbn)          → ¿de qué serie(s) es este libro, y con qué número? (ratifica una colección)
 *   seriesDeISSN(issn)          → la serie de ese ISSN (el que imprimen Springer, Routledge… en el libro)
 *   buscarSeries(texto)         → series cuyo nombre casa (búsqueda sin acentos/mayúsculas)
 *   librosDeSerie(clave, {…})   → los libros de la serie, ordenados por número (para ver los huecos)
 *
 * Solo lectura y síncrono (better-sqlite3), pero todas las consultas van por índice: milisegundos. Si el .db no
 * está (aún no se ha construido), `disponible()` es false y todo devuelve vacío — nunca rompe a quien lo llama.
 * Ruta: PATH_SERIES, o `series.db` junto a fichero.db (PATH_FICHERO).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { variantesISBN } from './identificadores.js';
import { claveSerie } from './series-texto.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function rutaSeries() {
    const v = process.env.PATH_SERIES;
    if (v && v.trim()) return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
    const f = process.env.PATH_FICHERO;
    const base = f && path.isAbsolute(f) ? f : path.resolve(RAIZ, f || 'Fichero');
    return path.join(/\.db$/i.test(base) ? path.dirname(base) : base, 'series.db');
}

let db = null, intentado = false;
const stmts = {};

function abrir() {
    if (intentado) return db;
    intentado = true;
    const ruta = rutaSeries();
    if (!fs.existsSync(ruta)) return null;
    try {
        db = new Database(ruta, { readonly: true, fileMustExist: true });
        stmts.porIsbn = db.prepare(`SELECT l.clave, l.nombre AS nombre_ficha, l.subserie, l.numero, l.orden, l.editorial, l.fuente, l.titulo AS titulo_libro,
            s.nombre, s.n, s.issn FROM libros l JOIN series s USING (clave) WHERE l.isbn IN (SELECT value FROM json_each(?))`);
        stmts.fts = db.prepare(`SELECT s.clave, s.nombre, s.editorial, s.n, s.n_numerados, s.max_orden, s.desde, s.hasta
            FROM series_fts f JOIN series s ON s.rowid = f.rowid WHERE series_fts MATCH ? ORDER BY bm25(series_fts), s.n DESC LIMIT ?`);
        stmts.porClave = db.prepare('SELECT * FROM series WHERE clave = ?');
        stmts.porIssn = db.prepare('SELECT * FROM series WHERE issn = ? ORDER BY n DESC');
        stmts.libros = db.prepare(`SELECT numero, orden, subserie, isbn, titulo, autores, editorial, anio, idioma, fuente
            FROM libros WHERE clave = ? ORDER BY orden IS NULL, orden, anio`);
    } catch (e) {
        console.warn(`[series] no se pudo abrir ${ruta}: ${e.message}`);
        db = null;
    }
    return db;
}

export const disponible = () => !!abrir();

/** Series del libro con ese ISBN: [{ clave, nombre, numero, orden, subserie, editorial, n }]. */
export function seriesDeISBN(isbn) {
    if (!abrir()) return [];
    const vars = variantesISBN(isbn);
    if (!vars.length) return [];
    const vistos = new Map();
    for (const r of stmts.porIsbn.all(JSON.stringify(vars))) if (!vistos.has(r.clave)) vistos.set(r.clave, r);
    return [...vistos.values()];
}

/** Series cuyo nombre casa con el texto (todas las palabras, por prefijo). */
export function buscarSeries(texto, { limite = 10 } = {}) {
    if (!abrir()) return [];
    const palabras = claveSerie(texto).split(' ').filter((w) => w.length >= 2);
    if (!palabras.length) return [];
    try { return stmts.fts.all(palabras.map((w) => `"${w}"*`).join(' '), limite); } catch { return []; }
}

/** Series con ese ISSN (las variantes de nombre de una misma serie comparten ISSN), la más grande primero. */
export function seriesDeISSN(issn) {
    if (!abrir() || !issn) return [];
    try { return stmts.porIssn.all(String(issn).toUpperCase()); } catch { return []; }
}

/** La ficha de una serie por su clave. */
export function serie(clave) {
    return abrir() ? stmts.porClave.get(clave) || null : null;
}

/**
 * Los libros de la serie. Con `editorial`, solo los de esa editorial (dos editoriales pueden tener una serie con el
 * mismo nombre: «Biblioteca Oro» de Molino y de Bruguera).
 */
export function librosDeSerie(clave, { editorial = null } = {}) {
    if (!abrir()) return [];
    let filas = stmts.libros.all(clave);
    if (editorial) {
        const k = claveSerie(editorial).split(' ').filter((w) => w.length >= 4);
        filas = filas.filter((f) => k.some((w) => claveSerie(f.editorial || '').includes(w)));
    }
    return filas;
}
