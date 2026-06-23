/**
 * Lógica PURA del ETL del Fichero (sin SQLite): normalizadores + mapeo de un registro de Open
 * Library / BNE a una fila de `fichero`. Separado de etl-fichero.js para poder testearlo sin
 * better-sqlite3 (ver scripts/test-etl-map.js).
 */

export function isbn10a13(s) { const core = '978' + s.slice(0, 9); let sum = 0; for (let i = 0; i < 12; i++) sum += (+core[i]) * (i % 2 ? 3 : 1); return core + ((10 - (sum % 10)) % 10); }
export function norm13(raw) { if (!raw) return null; const s = String(raw).toUpperCase().replace(/[^0-9X]/g, ''); if (s.length === 13) return s; if (s.length === 10) return isbn10a13(s); return null; }
export function anioDe(s) { const m = String(s || '').match(/(1[4-9]\d{2}|20\d{2})/); return m ? +m[1] : null; }
export function paginasDe(s) { if (typeof s === 'number') return s; const m = String(s || '').match(/(\d{1,5})/); return m ? +m[1] : null; }

const LANG_OL = { eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', dut: 'nl', nld: 'nl', lat: 'la', grc: 'el', gre: 'el', ell: 'el', rus: 'ru', jpn: 'ja', chi: 'zh', zho: 'zh', ara: 'ar', cat: 'ca', glg: 'gl', eus: 'eu', baq: 'eu' };
export function idiomaOL(key) { const c = String(key || '').split('/').pop(); return LANG_OL[c] || (c ? c.slice(0, 2) : null); }
const LANG_BNE = { 'español': 'es', 'castellano': 'es', 'inglés': 'en', 'ingles': 'en', 'francés': 'fr', 'frances': 'fr', 'alemán': 'de', 'aleman': 'de', 'italiano': 'it', 'portugués': 'pt', 'portugues': 'pt', 'catalán': 'ca', 'catalan': 'ca', 'gallego': 'gl', 'euskera': 'eu', 'vasco': 'eu', 'latín': 'la', 'latin': 'la' };
export function idiomaBNE(s) { return s ? (LANG_BNE[String(s).trim().toLowerCase()] || null) : null; }
export function limpiarCDU(s) { if (!s) return null; const t = String(s).replace(/\/\*+\/?/g, ' ').replace(/\s+/g, ' ').trim(); return t || null; }
export const txt = (s) => { const t = s == null ? null : String(s).trim(); return t || null; };

/** Edición de Open Library → fila de `fichero`. getAutor(key) resuelve el nombre del autor. */
export function mapOL(e, getAutor = () => null, raw = false) {
    const isbn = norm13((e.isbn_13 && e.isbn_13[0]) || (e.isbn_10 && e.isbn_10[0]));
    const desc = typeof e.description === 'string' ? e.description : (e.description && e.description.value) || null;
    return {
        isbn, isbn_10: (e.isbn_10 && e.isbn_10[0]) || null,
        titulo: txt(e.title), subtitulo: txt(e.subtitle),
        autores: (e.authors || []).map(a => getAutor(a.key)).filter(Boolean).join('; ') || null,
        editorial: txt(e.publishers && e.publishers[0]), anio_edicion: anioDe(e.publish_date),
        idioma: e.languages && e.languages[0] ? idiomaOL(e.languages[0].key) : null,
        cdu: null, dewey: txt(e.dewey_decimal_class && e.dewey_decimal_class[0]),
        lcc: txt(e.lc_classifications && e.lc_classifications[0]), lccn: txt(e.lccn && e.lccn[0]),
        paginas: e.number_of_pages || paginasDe(e.pagination),
        dimensiones: null, palabras_clave: (e.subjects || []).join('; ') || null,
        coleccion_nombre: txt(e.series && e.series[0]), sinopsis: txt(desc),
        tipo_documento: txt(e.physical_format), pais: txt(e.publish_country),
        lugar_publicacion: txt(e.publish_places && e.publish_places[0]), genero_forma: txt(e.genres && e.genres[0]),
        lengua_original: null,
        portada_url: (e.covers && e.covers[0] > 0) ? `https://covers.openlibrary.org/b/id/${e.covers[0]}-L.jpg` : null,
        fuente: 'openlibrary', fuente_id: e.key || null, extra: raw ? JSON.stringify(e) : null,
    };
}

/** Registro de BNE → fila de `fichero`. */
export function mapBNE(r, raw = false) {
    return {
        isbn: norm13(r.isbn), isbn_10: null,
        titulo: txt(r.titulo), subtitulo: null,
        autores: txt(r.autores || r.mencion_de_autores), editorial: txt(r.editorial),
        anio_edicion: anioDe(r.fecha_de_publicacion), idioma: idiomaBNE(r.lengua_principal),
        cdu: limpiarCDU(r.cdu), dewey: null, lcc: null, lccn: null,
        paginas: paginasDe(r.extension), dimensiones: txt(r.dimensiones),
        palabras_clave: txt(r.tema), coleccion_nombre: txt(r.serie), sinopsis: txt(r.nota_de_contenido),
        tipo_documento: txt(r.tipo_de_documento), pais: txt(r.pais_de_publicacion),
        lugar_publicacion: txt(r.lugar_de_publicacion), genero_forma: txt(r.genero_forma),
        lengua_original: idiomaBNE(r.lengua_original), portada_url: null,
        fuente: 'bne', fuente_id: txt(r.id), extra: raw ? JSON.stringify(r) : null,
    };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ESQUEMA DEL FICHERO — ÚNICA FUENTE DE VERDAD de la estructura del SQLite.
// Lo importan el ETL (etl-fichero.js, lo CREA) y el futuro proveedor (buscador-local.js, lo CONSULTA).
// Nombres ASCII al estilo de Biblioteca.biblioteca (anio_edicion ≈ año_edicion). El comentario de
// cada columna indica su PROCEDENCIA en cada dump. Si cambias columnas: ajusta también COLS (abajo)
// y, para que tome efecto, hay que RE-CONSTRUIR el fichero.db (no hay migraciones: es read-only).
// ════════════════════════════════════════════════════════════════════════════════════════════════
export const ESQUEMA_FICHERO = `
CREATE TABLE IF NOT EXISTS fichero (
  isbn             TEXT,    -- ISBN-13 normalizado · clave de búsqueda  | OL isbn_13/isbn_10 · BNE isbn
  isbn_10          TEXT,    --                                          | OL isbn_10
  titulo           TEXT,    --                                          | OL title · BNE titulo
  subtitulo        TEXT,    --                                          | OL subtitle
  autores          TEXT,    -- nombres unidos "; "                      | OL authors(resueltos) · BNE autores/mencion
  editorial        TEXT,    --                                          | OL publishers[0] · BNE editorial
  anio_edicion     INTEGER, --                                          | OL publish_date · BNE fecha_de_publicacion
  idioma           TEXT,    -- 2 letras                                 | OL languages · BNE lengua_principal
  cdu              TEXT,    --                                          | BNE cdu
  dewey            TEXT,    --                                          | OL dewey_decimal_class[0]
  lcc              TEXT,    --                                          | OL lc_classifications[0]
  lccn             TEXT,    --                                          | OL lccn[0]
  paginas          INTEGER, --                                          | OL number_of_pages/pagination · BNE extension
  dimensiones      TEXT,    --                                          | BNE dimensiones
  palabras_clave   TEXT,    --                                          | OL subjects · BNE tema
  coleccion_nombre TEXT,    --                                          | OL series[0] · BNE serie
  sinopsis         TEXT,    --                                          | OL description · BNE nota_de_contenido
  tipo_documento   TEXT,    --                                          | OL physical_format · BNE tipo_de_documento
  pais             TEXT,    --                                          | OL publish_country · BNE pais_de_publicacion
  lugar_publicacion TEXT,   --                                          | BNE lugar_de_publicacion
  genero_forma     TEXT,    --                                          | BNE genero_forma
  lengua_original  TEXT,    --                                          | BNE lengua_original
  portada_url      TEXT,    -- construida desde covers[0]               | OL covers
  fuente           TEXT,    -- 'openlibrary' | 'bne'
  fuente_id        TEXT,    -- OL key (/books/OL…M) · BNE id
  extra            TEXT     -- JSON del registro original (solo con --raw)
);`;

// Índices + búsqueda por texto (FTS5 sobre título/subtítulo/autor). Se crean al final del ETL.
export const ESQUEMA_INDICES = `
CREATE INDEX IF NOT EXISTS idx_isbn ON fichero(isbn);
DROP TABLE IF EXISTS fichero_fts;
CREATE VIRTUAL TABLE fichero_fts USING fts5(titulo, subtitulo, autores, content='fichero', content_rowid='rowid');
INSERT INTO fichero_fts(rowid, titulo, subtitulo, autores) SELECT rowid, titulo, subtitulo, autores FROM fichero;`;

// Columnas del INSERT (orden estable; DEBE coincidir con ESQUEMA_FICHERO).
export const COLS = ['isbn', 'isbn_10', 'titulo', 'subtitulo', 'autores', 'editorial', 'anio_edicion', 'idioma', 'cdu', 'dewey', 'lcc', 'lccn', 'paginas', 'dimensiones', 'palabras_clave', 'coleccion_nombre', 'sinopsis', 'tipo_documento', 'pais', 'lugar_publicacion', 'genero_forma', 'lengua_original', 'portada_url', 'fuente', 'fuente_id', 'extra'];

// Parsers de línea (Open Library = TSV; el JSON es la 5ª columna).
function col5(l) { let i = -1; for (let n = 0; n < 4; n++) { i = l.indexOf('\t', i + 1); if (i < 0) return ''; } return l.slice(i + 1); }
export function parseAutorLine(l) { if (!l.startsWith('/type/author\t')) return null; try { const e = JSON.parse(col5(l)); const nombre = txt(e.name || e.personal_name); return nombre ? { key: e.key, nombre } : null; } catch { return null; } }
export function parseEdicionLine(l, getAutor, raw) { if (!l.startsWith('/type/edition\t')) return null; try { return mapOL(JSON.parse(col5(l)), getAutor, raw); } catch { return null; } }
export function parseBneLine(l, raw) { const s = l.trim().replace(/^\[/, '').replace(/,$/, ''); if (!s.startsWith('{')) return null; try { return mapBNE(JSON.parse(s), raw); } catch { return null; } }
