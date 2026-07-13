/**
 * ÍNDICE DE BÚSQUEDA local (busqueda.db) — un SQLite FTS5 que ESPEJA el texto buscable del catálogo
 * (colección `biblioteca`) para una búsqueda de texto completo RÁPIDA, RANQUEADA y, sobre todo,
 * INSENSIBLE A ACENTOS/MAYÚSCULAS (tokenizador unicode61 + remove_diacritics): "matematicas" encuentra
 * "Matemáticas". MongoDB sigue siendo la FUENTE DE LA VERDAD — esto es solo un acelerador del texto.
 *
 * Mismo patrón que buscador-local.js (better-sqlite3, ya en el stack y probado en el Atom: C plano, sin
 * SIMD): apertura perezosa, y DEGRADACIÓN ELEGANTE — si falta el .db o better-sqlite3 no carga, `buscar`
 * devuelve null y el llamante (/catalogo) CAE a la búsqueda Mongo $regex de siempre. Nunca rompe la búsqueda.
 *
 * Frescura: se mantiene incrementalmente en los puntos de escritura (ingesta, edición manual, borrado) con
 * indexarDoc/desindexarDoc; y se reconstruye entero desde Mongo con `reconstruir` (scripts/reindexar-busqueda.js
 * o el botón de Mantenimiento del panel). El fichero NO está en git ni viaja en el rsync del deploy: se
 * (re)construye en destino.
 *
 * Ruta del .db: PATH_BUSQUEDA (.env) si se define; por defecto, junto a fichero.db en el directorio
 * PATH_FICHERO (bind-mounted y persistente en el NAS → sobrevive a los despliegues y al `down -v`).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');

function resolverRutaIndice() {
    const v = process.env.PATH_BUSQUEDA;
    if (v && v.trim()) return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
    // Por defecto: en el mismo directorio que el Fichero local (persistente, bind-mounted).
    const f = process.env.PATH_FICHERO;
    const base = f && path.isAbsolute(f) ? f : path.resolve(RAIZ, f || 'Fichero');
    const dir = /\.db$/i.test(base) ? path.dirname(base) : base;
    return path.join(dir, 'busqueda.db');
}

// Columnas del FTS: `id` UNINDEXED (el _id de Mongo en texto; no se busca, solo se recupera) + los
// campos de texto buscables. unicode61 + remove_diacritics 2 → acentos/mayúsculas indiferentes.
const COLUMNAS = ['titulo', 'subtitulo', 'obra', 'autores', 'editorial', 'coleccion', 'palabras_clave', 'identificadores', 'nombre_archivo'];
const PROY = { titulo: 1, titulo_original: 1, titulos_originales: 1, subtitulo: 1, obra_titulo: 1, autores: 1, editorial: 1, coleccion: 1, coleccion_nombre: 1, palabras_clave: 1, isbn: 1, issn: 1, isbn_obra: 1, nombre_archivo: 1 };

let db = null, intentado = false, disponible = false;
let stmtInsert = null, stmtDelete = null, stmtCount = null, stmtBuscar = null;

/** Abre/crea el .db una sola vez (lazy, ESCRIBIBLE). Devuelve si el índice está disponible. */
async function asegurar() {
    if (intentado) return disponible;
    intentado = true;
    const ruta = resolverRutaIndice();
    try {
        fs.mkdirSync(path.dirname(ruta), { recursive: true });
        const { default: Database } = await import('better-sqlite3');
        db = new Database(ruta);
        db.pragma('journal_mode = WAL');   // lectores concurrentes + un escritor (app/script)
        db.pragma('busy_timeout = 5000');  // espera en vez de fallar si coincide otro escritor
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
            id UNINDEXED, ${COLUMNAS.join(', ')},
            tokenize='unicode61 remove_diacritics 2');`);
        const cols = ['id', ...COLUMNAS];
        stmtInsert = db.prepare(`INSERT INTO docs (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`);
        stmtDelete = db.prepare('DELETE FROM docs WHERE id = ?');
        stmtCount = db.prepare('SELECT count(*) AS n FROM docs');
        stmtBuscar = db.prepare('SELECT id FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT ?');
        disponible = true;
        console.log(`🔎 Índice de búsqueda conectado: ${ruta}`);
    } catch (e) {
        console.warn(`⚠️  Índice de búsqueda no disponible (${e.message}): se usará la búsqueda Mongo.`);
        disponible = false;
    }
    return disponible;
}

// Construye la fila FTS a partir de un doc de Mongo + los nombres YA resueltos (autores/editorial/colección).
function filaDe(doc, { autores = '', editorial = '', coleccion = '' } = {}) {
    const pk = Array.isArray(doc.palabras_clave) ? doc.palabras_clave.join(' ') : (doc.palabras_clave || '');
    const issn = doc.issn || '';
    // Identificadores: ISBN(s) + ISSN con y sin guion, para encontrarlo se escriba como se escriba.
    const identificadores = [doc.isbn, issn, issn.replace(/-/g, ''), doc.isbn_obra].filter(Boolean).join(' ');
    // El TÍTULO ORIGINAL (y los de una antología) se pliegan en la columna `titulo` para poder buscar también
    // por él (p. ej. «War and Peace» encuentra «Guerra y paz»), sin añadir una columna nueva (que obligaría a
    // recrear la tabla FTS). Se re-poblará al reindexar.
    const titulo = [doc.titulo, doc.titulo_original, ...(Array.isArray(doc.titulos_originales) ? doc.titulos_originales : [])]
        .filter(Boolean).join(' · ');
    return {
        id: String(doc._id),
        titulo,
        subtitulo: doc.subtitulo || '',
        obra: doc.obra_titulo || '',
        autores, editorial, coleccion,
        palabras_clave: pk,
        identificadores,
        nombre_archivo: doc.nombre_archivo || '',
    };
}

function upsertFila(fila) {
    const tx = db.transaction((f) => { stmtDelete.run(f.id); stmtInsert.run(f); });
    tx(fila);
}

async function nombresDe(dbMongo, col, ids) {
    if (!Array.isArray(ids) || !ids.length) return '';
    const docs = await dbMongo.collection(col).find({ _id: { $in: ids } }, { projection: { nombre: 1 } }).toArray();
    return docs.map(d => d.nombre).filter(Boolean).join(' · ');
}
async function nombreDe(dbMongo, col, id) {
    if (!id) return '';
    const d = await dbMongo.collection(col).findOne({ _id: id }, { projection: { nombre: 1 } });
    return d?.nombre || '';
}

/**
 * Indexa (upsert) UN documento por su _id. Resuelve autores/editorial/colección por nombre desde Mongo.
 * Best-effort: nunca lanza (un fallo del índice no debe tumbar la ingesta/edición). Devuelve bool.
 */
export async function indexarDoc(dbMongo, id) {
    if (!(await asegurar())) return false;
    try {
        const _id = id instanceof ObjectId ? id : new ObjectId(String(id));
        const doc = await dbMongo.collection('biblioteca').findOne({ _id }, { projection: PROY });
        if (!doc) return false;
        const autores = await nombresDe(dbMongo, 'autores', doc.autores);
        const editorial = doc.editorial ? await nombreDe(dbMongo, 'editoriales', doc.editorial) : '';
        let coleccion = doc.coleccion_nombre || '';
        if (!coleccion && doc.coleccion) coleccion = await nombreDe(dbMongo, 'colecciones', doc.coleccion);
        upsertFila(filaDe(doc, { autores, editorial, coleccion }));
        return true;
    } catch (e) {
        console.warn(`[Índice] no se pudo indexar ${id}: ${e.message}`);
        return false;
    }
}

/** Quita un documento del índice por su _id. Best-effort. */
export async function desindexarDoc(id) {
    if (!(await asegurar())) return false;
    try { stmtDelete.run(String(id)); return true; }
    catch (e) { console.warn(`[Índice] no se pudo desindexar ${id}: ${e.message}`); return false; }
}

/**
 * Busca texto y devuelve los _id (string) ORDENADOS por relevancia (bm25).
 * @returns {Promise<string[]|null>} array de ids · [] sin términos/sin resultados · null = índice NO
 *          disponible (el llamante debe CAER a la búsqueda Mongo).
 */
export async function buscar(q, { limite = 1000, estricto = false } = {}) {
    if (!(await asegurar())) return null;
    const tokens = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (!tokens || !tokens.length) return [];
    // LAXO (por defecto): cada término como PREFIJO con AND implícito → todas las palabras, en cualquier
    // posición y orden («history* of* philosophy*»). ESTRICTO: FRASE EXACTA entre comillas → esos términos
    // ADYACENTES y en ese orden («"history of philosophy"»). El tokenizer quita acentos, así que la frase
    // también es insensible a acentos/mayúsculas.
    const match = estricto
        ? '"' + tokens.join(' ') + '"'
        : tokens.map(t => t + '*').join(' ');
    try {
        return stmtBuscar.all(match, limite).map(r => r.id);
    } catch (e) {
        console.warn(`[Índice] consulta falló (${e.message}); se usará la búsqueda Mongo.`);
        return null;
    }
}

/** Estado del índice (para el panel): disponible, nº de filas, ruta. */
export async function estadoIndice() {
    const ruta = resolverRutaIndice();
    if (!(await asegurar())) return { disponible: false, total: 0, ruta };
    try { return { disponible: true, total: stmtCount.get().n, ruta }; }
    catch (e) { return { disponible: false, total: 0, ruta, error: e.message }; }
}

/**
 * Reconstruye el índice ENTERO desde Mongo (vacía y re-inserta). Precarga los nombres de
 * autores/editoriales/colecciones en memoria (mucho más rápido que una consulta por documento) e inserta
 * por lotes en transacción. `onProgress({fase,total,hechos})` para el panel.
 */
export async function reconstruir(dbMongo, onProgress = () => {}) {
    if (!(await asegurar())) throw new Error('índice de búsqueda no disponible (better-sqlite3/.db)');
    const mapaDe = async (col) => {
        const m = new Map();
        for (const d of await dbMongo.collection(col).find({}, { projection: { nombre: 1 } }).toArray()) m.set(String(d._id), d.nombre);
        return m;
    };
    const [autoresM, edsM, colsM] = await Promise.all([mapaDe('autores'), mapaDe('editoriales'), mapaDe('colecciones')]);

    const total = await dbMongo.collection('biblioteca').countDocuments();
    onProgress({ fase: 'reconstruyendo', total, hechos: 0 });
    db.exec('DELETE FROM docs;');

    const insertarLote = db.transaction((filas) => { for (const f of filas) stmtInsert.run(f); });
    const cursor = dbMongo.collection('biblioteca').find({}, { projection: PROY });
    let hechos = 0, lote = [];
    for await (const doc of cursor) {
        const autores = (Array.isArray(doc.autores) ? doc.autores : []).map(i => autoresM.get(String(i))).filter(Boolean).join(' · ');
        const editorial = doc.editorial ? (edsM.get(String(doc.editorial)) || '') : '';
        let coleccion = doc.coleccion_nombre || '';
        if (!coleccion && doc.coleccion) coleccion = colsM.get(String(doc.coleccion)) || '';
        lote.push(filaDe(doc, { autores, editorial, coleccion }));
        if (lote.length >= 500) { insertarLote(lote); hechos += lote.length; lote = []; onProgress({ fase: 'reconstruyendo', total, hechos }); }
    }
    if (lote.length) { insertarLote(lote); hechos += lote.length; }
    try { db.exec("INSERT INTO docs(docs) VALUES('optimize');"); } catch { /* optimize es opcional */ }
    onProgress({ fase: 'completado', total, hechos });
    return { total: hechos };
}

// ── Reconstrucción en 2º PLANO con progreso (para el panel; evita que un proxy corte la petición larga,
//    como en integridad). POST arranca; GET de estado da fase + resultado. ──
let trabajoIndice = { en_curso: false, fase: null, progreso: {}, ts: null, resultado: null, error: null };
export function estadoReindexado() { return { ...trabajoIndice }; }
export function lanzarReindexado(dbMongo) {
    if (trabajoIndice.en_curso) return { ok: false, motivo: 'ya hay una reindexación en curso' };
    trabajoIndice = { en_curso: true, fase: 'cargando', progreso: {}, ts: new Date().toISOString(), resultado: null, error: null };
    (async () => {
        try {
            const res = await reconstruir(dbMongo, (p) => { trabajoIndice.fase = p.fase; trabajoIndice.progreso = p; });
            trabajoIndice.resultado = res;
        } catch (e) { trabajoIndice.error = e.message; }
        finally { trabajoIndice.en_curso = false; trabajoIndice.fase = 'hecho'; }
    })();
    return { ok: true };
}

/** Cierra el .db (para scripts/pruebas; en la app vive lo que dure el proceso). */
export function cerrarIndice() {
    if (db) { try { db.close(); } catch { /* ignore */ } }
    db = null; intentado = false; disponible = false;
    stmtInsert = stmtDelete = stmtCount = stmtBuscar = null;
}
