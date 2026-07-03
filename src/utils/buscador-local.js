/**
 * Buscador en el FICHERO LOCAL (fichero.db) — los volcados de Open Library + BNE en un SQLite
 * de solo lectura, construido por scripts/etl-fichero.js (esquema en scripts/etl-map.js).
 *
 * Es la AUTORIDAD PRINCIPAL de Tier 2: offline, sin red, ~instantáneo, y contiene lo que antes
 * pedíamos online a OpenLibrary y BNE. El pipeline lo consulta ANTES que las APIs online, que
 * quedan como fallback de FRESCURA (libros recientes que no están en el volcado).
 *
 * Un ISBN puede tener VARIAS filas (ediciones OL duplicadas + el registro BNE del mismo libro):
 * se fusionan dando prioridad a BNE para CDU/idioma/tema (catalogación profesional española) y a
 * OL para Dewey/LCC/portada/sinopsis. La fusión es "primer valor no nulo" sobre [BNE…, OL…].
 *
 * Degradación elegante: si falta el .db o better-sqlite3 no carga, el proveedor se DESACTIVA
 * (devuelve null) sin romper la ingesta — el pipeline sigue con las APIs online.
 *
 * Ruta del .db: PATH_FICHERO (.env). Si es un directorio → <dir>/fichero.db; si acaba en .db,
 * se usa tal cual. Por defecto 'Fichero/fichero.db' relativo a la raíz del repo (en el NAS,
 * /app/Fichero/fichero.db por el bind mount; ver docker-compose.yml).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { extraerContribucionesBNE } from './contribuciones.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// La columna `autores` puede venir como MENCIÓN de la BNE («Apellido, Nombre, ( fechas)( autor) /**​/
// Otro( traductor)») o como nombres OL limpios unidos por «;». Devuelve autores LIMPIOS (sin roles/fechas/
// marcadores) + contribuciones con rol → así ni se cuela basura como autor ni se pierden los roles.
const RE_ROL_MENCION = /\/\*+\/|\(\s*(autor|coautor|traductor|traduc|ilustrad|ilustrac|dibuj|guionist|grabad|editor|edici|director|prolog|introduc|prefac|compil|selecc|antolog|anotad|notas|colaborad)/i;
function separarAutoresYRoles(raw) {
    const s = String(raw || '').trim();
    if (!s) return { autores: [], contribuciones_nombres: [] };
    if (RE_ROL_MENCION.test(s)) {
        const todos = extraerContribucionesBNE(s, { incluirAutor: true });
        const autores = todos.filter((c) => c.rol === 'autor').map((c) => c.nombre);
        const contribuciones_nombres = todos.filter((c) => c.rol && c.rol !== 'autor');
        if (autores.length || contribuciones_nombres.length) return { autores, contribuciones_nombres };
        // La mención no dejó nada reconocible → cae al reparto simple por «;».
    }
    return { autores: s.split(';').map((x) => x.trim()).filter(Boolean), contribuciones_nombres: [] };
}
const RAIZ = path.resolve(__dirname, '..', '..');
function resolverDB() {
    const v = process.env.PATH_FICHERO;
    const base = v && path.isAbsolute(v) ? v : path.resolve(RAIZ, v || 'Fichero');
    return /\.db$/i.test(base) ? base : path.join(base, 'fichero.db');
}

let db = null, stmt = null, stmtFts = null, intentado = false, disponible = false;

/** Abre el .db una sola vez (lazy, solo-lectura). Devuelve si el proveedor está disponible. */
async function asegurarDB() {
    if (intentado) return disponible;
    intentado = true;
    const ruta = resolverDB();
    try {
        if (!fs.existsSync(ruta)) {
            console.warn(`⚠️  Fichero local no encontrado en ${ruta}: proveedor offline desactivado.`);
            return false;
        }
        const { default: Database } = await import('better-sqlite3');
        db = new Database(ruta, { readonly: true, fileMustExist: true });
        db.pragma('query_only = true');
        stmt = db.prepare('SELECT * FROM fichero WHERE isbn = ?');
        // Búsqueda de TEXTO (Descubrir): FTS5 sobre título/subtítulo/autores. Puede no existir en .db
        // antiguos → se prepara con guarda y, si falla, la función de texto se desactiva sola.
        try {
            stmtFts = db.prepare(`SELECT f.isbn, f.titulo, f.subtitulo, f.autores, f.editorial, f.anio_edicion,
                f.cdu, f.dewey, f.idioma, f.portada_url FROM fichero_fts ft JOIN fichero f ON f.rowid = ft.rowid
                WHERE fichero_fts MATCH ? ORDER BY bm25(fichero_fts) LIMIT ?`);
        } catch (e) { stmtFts = null; console.warn(`⚠️  Fichero sin índice FTS (Descubrir desactivado): ${e.message}`); }
        disponible = true;
        console.log(`📖 Fichero local conectado: ${ruta}`);
    } catch (e) {
        console.warn(`⚠️  Fichero local no disponible (${e.message}): proveedor offline desactivado.`);
        disponible = false;
    }
    return disponible;
}

// Normaliza cualquier ISBN a la forma 13 (la que guarda el fichero).
function isbn13(raw) {
    const s = String(raw || '').toUpperCase().replace(/[^0-9X]/g, '');
    if (s.length === 13) return s;
    if (s.length === 10) {
        const core = '978' + s.slice(0, 9);
        let sum = 0; for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1);
        return core + ((10 - (sum % 10)) % 10);
    }
    return null;
}

// Fusiona las filas de un ISBN en un único registro (BNE primero, luego OL; primer valor no nulo).
function fusionar(filas) {
    const orden = [...filas.filter(f => f.fuente === 'bne'), ...filas.filter(f => f.fuente !== 'bne')];
    const primero = (c) => { for (const f of orden) { const v = f[c]; if (v !== null && v !== undefined && v !== '') return v; } return null; };
    const titulo = primero('titulo');
    if (!titulo) return null; // sin título no es un acierto útil
    const lista = (s) => s ? String(s).split(';').map(x => x.trim()).filter(Boolean) : [];
    const { autores, contribuciones_nombres } = separarAutoresYRoles(primero('autores'));
    return {
        isbn: primero('isbn'),
        titulo,
        subtitulo: primero('subtitulo'),
        autores,
        contribuciones_nombres,   // [{nombre,rol}] (traductor/ilustrador/…) parseados de la mención BNE
        editorial: primero('editorial'),
        año_edicion: primero('anio_edicion'),
        idioma: primero('idioma'),
        dewey: primero('dewey'),
        lcc: primero('lcc'),
        cdu: primero('cdu'),
        paginas: primero('paginas'),
        dimensiones: primero('dimensiones'),
        categorias: lista(primero('palabras_clave')),
        coleccion_nombre: primero('coleccion_nombre'),
        sinopsis: primero('sinopsis'),
        portada_url: primero('portada_url'),
        lengua_original: primero('lengua_original'),   // → idioma_original del documento (traducciones)
        fuentes: [...new Set(orden.map(f => f.fuente))],
    };
}

/**
 * Busca un ISBN (o varios candidatos 10/13) en el fichero local.
 * @returns {Promise<object|null>} null=proveedor no disponible · {}=no hallado · objeto=registro fusionado
 */
export async function buscarEnFicheroLocal({ isbns }) {
    if (!(await asegurarDB())) return null;
    const candidatos = [...new Set((Array.isArray(isbns) ? isbns : [isbns]).map(isbn13).filter(Boolean))];
    if (candidatos.length === 0) return {};
    try {
        for (const c of candidatos) {
            const filas = stmt.all(c);
            if (filas.length) {
                const r = fusionar(filas);
                if (r) return r;
            }
        }
        return {};
    } catch (e) {
        console.warn(`⚠️  Fichero local: error de consulta (${e.message}): omitido.`);
        return null;
    }
}

/**
 * DESCUBRIR: búsqueda de TEXTO en el Fichero (OL+BNE, 58,7 M) por título/subtítulo/autores (FTS5), para
 * proponer libros que NO están en la biblioteca. Dedup por ISBN (o título|autores si no hay ISBN).
 * @returns {Promise<Array|null>} candidatos · [] sin términos/sin resultados · null = no disponible (sin
 *          .db / sin índice FTS) → el llamante avisa de que Descubrir no está operativo.
 */
export async function buscarTextoEnFichero(q, { limite = 40 } = {}) {
    if (!(await asegurarDB()) || !stmtFts) return null;
    const tokens = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu);
    if (!tokens || !tokens.length) return [];
    const match = tokens.map(t => t + '*').join(' ');   // prefijo + AND implícito
    try {
        const filas = stmtFts.all(match, limite * 3);   // sobre-pedir para deduplicar por ISBN
        const vistos = new Set(), out = [];
        for (const f of filas) {
            const clave = f.isbn || `${(f.titulo || '').toLowerCase()}|${(f.autores || '').toLowerCase()}`;
            if (!clave || vistos.has(clave)) continue;
            vistos.add(clave);
            out.push({
                isbn: f.isbn || null, titulo: f.titulo || '', subtitulo: f.subtitulo || null,
                autores: f.autores ? f.autores.split(';').map(s => s.trim()).filter(Boolean) : [],
                editorial: f.editorial || null, anio: f.anio_edicion || null,
                cdu: f.cdu || null, dewey: f.dewey || null, idioma: f.idioma || null, portada_url: f.portada_url || null,
            });
            if (out.length >= limite) break;
        }
        return out;
    } catch (e) { console.warn(`[Fichero/FTS] consulta falló: ${e.message}`); return null; }
}

/** Cierra el .db (para scripts/pruebas; en la app vive lo que dure el proceso). */
export function cerrarFicheroLocal() {
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; stmt = null; stmtFts = null; intentado = false; disponible = false; }
}
