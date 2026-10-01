/**
 * CROSSREF SIN CONEXIÓN: consultas al índice `crossref.db` (lo construye scripts/etl-crossref.js a partir del
 * volcado público anual de Crossref; vive junto a fichero.db).
 *
 *   libroCrossrefLocal(isbns)        → la ficha del libro con ese ISBN, con la forma de `fichaDeCrossref`
 *   librosDeSerieCrossrefLocal(issn) → los libros de una serie por su ISSN (para ratificar colecciones y ver huecos)
 *   serieCrossrefLocal(issn)         → { issn, nombre, n } de la serie
 *
 * Solo lectura, síncrono y por índice (milisegundos). Si el .db no está, `crossrefLocalDisponible()` es false y todo
 * devuelve null/[] — nunca rompe a quien lo llama, que sigue con la API.
 * Ruta: PATH_CROSSREF, o `crossref.db` junto a fichero.db (PATH_FICHERO).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { variantesISBN } from './identificadores.js';
import { limpiarNombreEditorial } from './editoriales-falsas.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function rutaCrossref() {
    const v = process.env.PATH_CROSSREF;
    if (v && v.trim()) return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
    const f = process.env.PATH_FICHERO;
    const base = f && path.isAbsolute(f) ? f : path.resolve(RAIZ, f || 'Fichero');
    return path.join(/\.db$/i.test(base) ? path.dirname(base) : base, 'crossref.db');
}

let db = null, intentado = false;
const stmts = {};

function abrir() {
    if (intentado) return db;
    intentado = true;
    const ruta = rutaCrossref();
    if (!fs.existsSync(ruta)) return null;
    try {
        db = new Database(ruta, { readonly: true, fileMustExist: true });
        stmts.porIsbn = db.prepare('SELECT l.* FROM isbn_libro i JOIN libros l ON l.id = i.libro WHERE i.isbn = ?');
        stmts.porSerie = db.prepare('SELECT * FROM libros WHERE serie_issn = ? ORDER BY anio, titulo LIMIT ?');
        // La tabla de series se crea al final del ETL: un índice a medias funciona sin ella.
        try { stmts.serie = db.prepare('SELECT issn, nombre, n FROM series WHERE issn = ?'); } catch { stmts.serie = null; }
        console.log(`📘 Crossref local conectado: ${ruta}`);
    } catch (e) {
        console.warn(`⚠️  Crossref local no disponible (${e.message}).`);
        db = null;
    }
    return db;
}

export const crossrefLocalDisponible = () => !!abrir();

const lista = (s) => String(s || '').split(';').map((x) => x.trim()).filter(Boolean);

/** Una fila de crossref.db → la ficha de siempre (la misma forma que `fichaDeCrossref` de la API). */
function fichaDeFila(f) {
    const isbns = String(f.isbns || '').split(' ').filter(Boolean);
    return {
        isbn: isbns[0] || null,
        isbns,
        titulo: f.titulo || null,
        subtitulo: f.subtitulo || null,
        autores: lista(f.autores),
        contribuciones_nombres: lista(f.editores).map((nombre) => ({ nombre, rol: 'editor' })),
        editorial: limpiarNombreEditorial(f.editorial) || null,
        año_edicion: f.anio || null,
        idioma: f.idioma || null,
        coleccion_nombre: f.serie || null,
        coleccion_issn: f.serie_issn || null,
        coleccion_numero: f.volumen || null,
        categorias: [],
        doi: f.doi || null,
        sinopsis: f.sinopsis || null,
        titulo_original: f.titulo_original || null,
        edicion: f.edicion || null,
        fuente: 'crossref',
        // Un libro que solo se conoce por sus capítulos trae menos (sin autores ni DOI propio).
        crossref_parcial: f.fuente === 'capitulo' || undefined,
    };
}

/** @returns {object|null} la ficha, o null si no está (o no hay índice). */
export function libroCrossrefLocal(isbns = []) {
    if (!abrir()) return null;
    const formas = [...new Set((Array.isArray(isbns) ? isbns : [isbns]).flatMap((i) => variantesISBN(i)))]
        .map((i) => String(i).replace(/[^0-9Xx]/g, '').toUpperCase()).filter((i) => i.length === 13);
    for (const isbn of formas) {
        const fila = stmts.porIsbn.get(isbn);
        if (fila) return fichaDeFila(fila);
    }
    return null;
}

/** Los libros de una serie por su ISSN. [] si no hay índice o no los tiene. */
export function librosDeSerieCrossrefLocal(issn, { max = 5000 } = {}) {
    if (!abrir() || !issn) return [];
    return stmts.porSerie.all(String(issn).toUpperCase(), max).map(fichaDeFila);
}

export function serieCrossrefLocal(issn) {
    if (!abrir() || !issn) return null;
    return stmts.serie?.get(String(issn).toUpperCase()) || null;
}
