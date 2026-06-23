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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
function resolverDB() {
    const v = process.env.PATH_FICHERO;
    const base = v && path.isAbsolute(v) ? v : path.resolve(RAIZ, v || 'Fichero');
    return /\.db$/i.test(base) ? base : path.join(base, 'fichero.db');
}

let db = null, stmt = null, intentado = false, disponible = false;

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
    return {
        isbn: primero('isbn'),
        titulo,
        subtitulo: primero('subtitulo'),
        autores: lista(primero('autores')),
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

/** Cierra el .db (para scripts/pruebas; en la app vive lo que dure el proceso). */
export function cerrarFicheroLocal() {
    if (db) { try { db.close(); } catch { /* ignore */ } db = null; stmt = null; intentado = false; disponible = false; }
}
