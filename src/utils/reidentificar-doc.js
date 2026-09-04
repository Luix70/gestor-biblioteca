/**
 * RE-IDENTIFICAR un documento a partir de SU PROPIO FICHERO: recuperar el ISBN que la ingesta no capturó
 * (típico de los MIEMBROS DE COLECCIÓN, catalogados por el nombre de archivo sin abrir el fichero — ver
 * `transmedia.js`) y, con él, PIVOTAR al Fichero local + APIs gratuitas para rellenar título/autores/editorial/
 * sinopsis/idioma/año. SIN IA (visión) por defecto: honra la máxima «identificar antes de clasificar,
 * minimizando la IA». Motor ÚNICO compartido por:
 *   · la INGESTA de colecciones (extrae el ISBN del miembro antes de insertarlo),
 *   · el script de BACKFILL `scripts/reidentificar-sin-isbn.js`,
 *   · la ACCIÓN de la Búsqueda sobre una selección (`/api/documentos/reidentificar-isbn`).
 *
 * Confianza del ISBN (misma política que el orquestador, para NO colgar un ISBN equivocado):
 *   · EPUB → dc:identifier del OPF (propio del libro) → se confía.
 *   · MOBI/AZW → registro EXTH (propio) → se confía.
 *   · PDF → el ISBN PROPIO (nombre-es-ISBN / DOI / bloque CIP) se confía; un candidato del CUERPO del texto
 *     solo se acepta si CORROBORA por título contra el Fichero (`corroborarISBNporTitulo`).
 *   · Nombre de archivo → un ISBN incrustado en el nombre se trata como propio.
 */
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../mantenimiento/util-mantenimiento.js';
import { isbnDesdeArchivo, tipoLibro } from './isbn-archivo.js';
import { variantesISBN, validarISBN } from './identificadores.js';
import { esTituloArtefacto } from './parsear-nombre.js';
import { leerCodigoBarrasPorVision } from './lector-barras.js';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { resolverCDU } from '../clasificador-cdu.js';
import { editarDocumento } from './editar-doc.js';
import { resolverPersona } from './resolver-persona.js';
import { indexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';

export { isbnDesdeArchivo } from './isbn-archivo.js'; // re-exportado por comodidad de los consumidores

// ¿El título actual es débil (heredado del nombre de archivo / vacío / "Vol. I")? Entonces la autoridad puede
// mejorarlo. Es una comprobación conservadora: si el título ya es bueno, NO se toca.
function tituloDebil(doc) {
    const t = String(doc.titulo || '').trim();
    if (!t) return true;
    const norm = (s) => String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/g, '');
    if (doc.nombre_archivo && norm(t) === norm(doc.nombre_archivo)) return true;      // = nombre de archivo
    if (/^(vol\.?|tomo|part[e]?|n[ºo.]|#)\s*[ivxlcdm\d]/i.test(t)) return true;        // "Vol. I", "Tomo 2"…
    if (t.length <= 3) return true;
    return false;
}

async function resolverAutores(db, nombres) {
    const out = [];
    for (const n of nombres || []) { const r = await resolverPersona(db, n).catch(() => null); if (r?._id) out.push(r._id); }
    return out;
}
async function resolverEditorial(db, nombre) {
    const t = String(nombre || '').trim();
    if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t }, { projection: { _id: 1 } });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}
// Normaliza un título para comparar (minúsculas, sin acentos ni puntuación).
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const normLite = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '').replace(/[^a-z0-9]+/g, ' ').trim();
// El título nuevo NO debe DEGRADAR el actual: si el actual ya CONTIENE (como frase) el nuevo y es más largo,
// el nuevo perdería información («Cinema 1: The Movement-Image» → «Cinema») → no se sustituye. (Igual que cotejarPorISBN.)
function noDegrada(actual, nuevo) {
    const a = normLite(actual), n = normLite(nuevo);
    if (!n) return false;
    if (a.length > n.length && (' ' + a + ' ').includes(' ' + n + ' ')) return false;
    return true;
}

/**
 * Re-identifica UN documento por su ISBN: lo obtiene (del fichero / a mano / por código de barras con IA / del
 * propio doc si se fuerza) y pivota al Fichero + APIs gratuitas para cotejar título y rellenar huecos.
 * @param {object} opts
 *   aplicar=false     dry-run (calcula pero no escribe).
 *   usarApis=true     consulta OpenLibrary/Google además del Fichero local.
 *   forzar=false      re-cotejar AUNQUE el doc ya tenga ISBN (para títulos-artefacto, series, truncados…).
 *   isbnManual=null   ISBN dado a mano → autoritativo (fuente = manual).
 *   conIA=false       permite IA: si el TEXTO no da ISBN, reextrae páginas y lee el código de barras/CIP por
 *                     VISIÓN (zxing local primero, sin coste); y permite el enriquecimiento con IA.
 * @returns {Promise<{estado, isbn?, via?, titulo?, resumen?, motivo?, set?}>}
 *   estado ∈ 'ya-tiene-isbn' | 'sin-fichero' | 'formato-no-soportado' | 'no-hallado' | 'identificado' | 'aplicado'
 */
export async function reidentificarDoc(db, doc, { aplicar = false, usarApis = true, forzar = false, isbnManual = null, conIA = false } = {}) {
    const manual = isbnManual ? validarISBN(isbnManual) : null;
    // Por defecto (sin forzar ni ISBN manual) solo se actúa sobre los que NO tienen ISBN (ingesta/backfill/lote).
    if (doc.isbn && !forzar && !manual) return { estado: 'ya-tiene-isbn' };

    const carpeta = carpetaDeDoc(doc);
    const abs = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);

    // 1) RESOLVER EL ISBN según la fuente. Prioridad: manual > texto del fichero > barras/visión (con IA) >
    //    el que ya tiene (al forzar). Así «datos existentes», «reextraer páginas» y «manual» son elegibles.
    let isbn = null, via = '', ext = { isbn: null, titulo: null, autores: [], editorial: null };
    if (manual) { isbn = manual; via = 'manual'; }
    else {
        if (abs && tipoLibro(abs)) { ext = await isbnDesdeArchivo(abs, { nombre: doc.nombre_archivo, tituloRef: doc.titulo }); if (ext.isbn) { isbn = ext.isbn; via = 'fichero'; } }
        if (!isbn && conIA && abs) {
            // Reextraer páginas y leer el EAN de la cubierta/contracubierta (o el CIP): zxing local sin coste y,
            // si falla, VISIÓN. Solo para PDF (los EPUB/MOBI ya dan su ISBN por el texto de arriba).
            const numPag = doc.paginas || (await numeroPaginasPdf(abs).catch(() => 0)) || 3;
            const bc = await leerCodigoBarrasPorVision(abs, numPag).catch(() => null);
            const v = bc?.isbn ? validarISBN(bc.isbn) : null;
            if (v) { isbn = v; via = 'barras/visión'; }
        }
        if (!isbn && forzar && doc.isbn) { isbn = validarISBN(doc.isbn) || doc.isbn; via = 'existente'; }
    }

    if (!isbn) {
        if (!abs && !manual) return { estado: 'sin-fichero', motivo: 'no se encontró el fichero del documento en su carpeta' };
        if (abs && !tipoLibro(abs) && !conIA) return { estado: 'formato-no-soportado', motivo: `${path.extname(abs)} no da un ISBN de texto (marca «con IA» para intentar el código de barras)` };
        return { estado: 'no-hallado', motivo: 'no se pudo obtener un ISBN (ni del texto, ni por barras/visión, ni a mano)' };
    }

    // 2) PIVOTE por ISBN: Fichero local + APIs gratuitas. incluirCdu:false → NO se toca la CDU aquí (cambiarla
    //    movería la carpeta, justo lo que se quiere evitar); si mejora el título se des-sella re-clasificar-cdu
    //    y el Conformador la afina/mueve a reposo. sinIA:!conIA → con IA se permite el enriquecimiento con IA.
    const isbnVar = variantesISBN(isbn);
    let datos = {};
    if (usarApis) {
        datos = await buscarMetadatosExternos(doc.titulo || ext.titulo || '', '', null, {
            incluirSinopsis: true, incluirCdu: false, isbnsArchivo: isbnVar, idioma: doc.idioma || null, sinIA: !conIA,
        }).catch(() => ({}));
    }

    const set = {};
    const nombres = {}; // log legible
    if (isbn && String(doc.isbn || '') !== isbn) { set.isbn = isbn; if (manual) nombres.isbn = isbn; }

    // TÍTULO (cotejo): se sustituye por el de la AUTORIDAD si el actual es DÉBIL o ARTEFACTO, o —al FORZAR— si
    // simplemente DIFIERE; nunca si DEGRADARÍA (el actual ya es más completo). El de la autoridad (Fichero/APIs
    // por ISBN) va primero; el del propio fichero solo es fiable en EPUB/MOBI (en PDF ext.titulo es null).
    const tituloMejor = datos.titulo || ext.titulo || null;
    if (tituloMejor) {
        const actual = String(doc.titulo || '');
        const malActual = tituloDebil(doc) || esTituloArtefacto(actual);
        if ((malActual || forzar) && normLite(actual) !== normLite(tituloMejor) && noDegrada(actual, tituloMejor)) {
            set.titulo = tituloMejor; nombres.titulo = tituloMejor;
        }
    }
    // Autores: si el doc no tiene ninguno, resuélvelos del fichero primero, si no de la autoridad.
    const autoresNom = (ext.autores && ext.autores.length ? ext.autores : datos.autores) || [];
    if (!(doc.autores?.length) && autoresNom.length) { set.autores = await resolverAutores(db, autoresNom); nombres.autores = autoresNom; }
    // Editorial: rellena si falta (del fichero o de la autoridad).
    const editorialNom = ext.editorial || datos.editorial || null;
    if (!doc.editorial && editorialNom) { set.editorial = await resolverEditorial(db, editorialNom); nombres.editorial = editorialNom; }
    // Escalares de hueco (solo si faltan).
    if (datos.sinopsis && !doc.sinopsis) set.sinopsis = datos.sinopsis;
    if (datos.año_edicion && !doc.año_edicion) set.año_edicion = datos.año_edicion;
    if (datos.idioma && !doc.idioma) set.idioma = datos.idioma;
    if (datos.subtitulo && !doc.subtitulo) set.subtitulo = datos.subtitulo;

    if (Object.keys(set).length === 0) return { estado: 'no-hallado', isbn, via, motivo: 'ISBN resuelto pero la autoridad no aportó nada nuevo' };

    const resumen = `isbn=${isbn}${via ? ` (${via})` : ''}`
        + (Object.keys(nombres).length ? ' · ' + Object.entries(nombres).map(([k, v]) => `${k}="${Array.isArray(v) ? v.join(', ') : v}"`).join(' · ') : '');

    if (!aplicar) return { estado: 'identificado', isbn, via, titulo: set.titulo || doc.titulo, resumen, set };

    // Si se corrige el título, des-sellar re-clasificar-cdu para que el Conformador reclasifique y MUEVA la
    // carpeta con el título ya bueno (igual que re-enriquecer-degradados).
    if (set.titulo) { set['mantenimiento.re-clasificar-cdu'] = 0; set.mantenimiento_firma = 'pendiente-reidentificado'; }
    set.fecha_actualizacion = new Date();
    set.alertas_agente = [...(doc.alertas_agente || []), `ISBN ${via === 'manual' ? 'manual' : 'recuperado (' + via + ')'} + cotejo por ISBN (Fichero/APIs${conIA ? ', con IA' : ''}).`];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
    // Índice FTS + sidecars (best-effort: nunca tumban la operación).
    await indexarDoc(db, doc._id).catch(() => {});
    await regenerarSidecarsDoc(db, { ...doc, ...set }, carpeta).catch(() => {});
    return { estado: 'aplicado', isbn, via, titulo: set.titulo || doc.titulo, resumen, set };
}

/**
 * INVESTIGAR / FORZAR LA CDU de un documento a partir de su Dewey/LCC (crosswalk determinista, gratis) y, si se
 * pide `conIA`, por la IA (que distingue la lengua/tradición literaria). Del ISBN se obtiene sin IA muchas veces
 * el Dewey/LCC pero no la CDU; el crosswalk (ampliado + tres bandas) la deriva. Si el doc no trae Dewey/LCC, se
 * toman del Fichero por su ISBN. Aplica con `editarDocumento` (MUEVE la carpeta al árbol nuevo + sidecars + FTS).
 * Conservador: NO toca una CDU fijada a mano (cdu_manual); rellena las vacías/'000' y, solo al `forzar`,
 * reemplaza una CDU existente (no manual).
 * @returns {Promise<{estado, cdu?, de?, motivo?}>} estado ∈ 'cdu-manual'|'cdu-sin-codigos'|'cdu-no-hallada'|
 *   'cdu-ya'|'cdu-igual'|'cdu-identificada'|'cdu-aplicada'
 */
export async function resolverCduDoc(db, doc, { conIA = false, forzar = false, aplicar = true } = {}) {
    if (doc.cdu_manual) return { estado: 'cdu-manual', motivo: 'CDU fijada a mano; no se toca' };
    // Códigos de origen: los del propio doc; si faltan y hay ISBN, los del Fichero local (offline).
    let dewey = doc.dewey || null, lcc = doc.lcc || null;
    if (!dewey && !lcc && doc.isbn) {
        const f = await buscarEnFicheroLocal({ isbns: variantesISBN(doc.isbn) }).catch(() => null);
        if (f) { dewey = f.dewey || dewey; lcc = f.lcc || lcc; }
    }
    if (!dewey && !lcc && !conIA) return { estado: 'cdu-sin-codigos', motivo: 'sin Dewey/LCC (marca «con IA» para investigar por título/autor)' };
    // Nombre del primer autor (ayuda a la IA con la literatura: se clasifica por la tradición del autor).
    let autorNom = null;
    if (doc.autores?.length) { const a = await db.collection('autores').findOne({ _id: doc.autores[0] }, { projection: { nombre: 1 } }).catch(() => null); autorNom = a?.nombre || null; }
    const r = await resolverCDU({ dewey, lcc, titulo: doc.titulo, autor: autorNom, sinopsis: doc.sinopsis, categorias: doc.palabras_clave || [], permitirIA: conIA }).catch(() => null);
    const cdu = r && (typeof r === 'string' ? r : r.cdu);
    if (!cdu || cdu === '000') return { estado: 'cdu-no-hallada', motivo: conIA ? 'ni el crosswalk ni la IA dieron una CDU' : 'el crosswalk determinista no la resuelve (marca «con IA» para investigar)' };
    const actual = String(doc.cdu || '');
    const vacia = !actual || actual === '000' || actual === '0';
    if (!vacia && !forzar) return { estado: 'cdu-ya', cdu: actual, motivo: 'ya tiene CDU (marca «forzar» para reemplazarla)' };
    if (actual === cdu) return { estado: 'cdu-igual', cdu };
    if (!aplicar) return { estado: 'cdu-identificada', cdu, de: actual || '000', motivo: `${actual || '000'} → ${cdu}` };
    // editarDocumento mueve la carpeta al árbol de la nueva CDU + regenera sidecars + reíndice. Marca cdu_manual
    // (es una decisión explícita del usuario, como una edición) → el Conformador no la recalcula luego.
    await editarDocumento(db, String(doc._id), { cdu, ...(dewey ? { dewey } : {}), ...(lcc ? { lcc } : {}) }).catch(() => null);
    return { estado: 'cdu-aplicada', cdu, de: actual || '000' };
}

// ── LOTE en 2º plano (acción de la Búsqueda sobre una selección) ─────────────────────────────────────────
// Mismo patrón que reextraer-imagenes: lanzar / estado / cancelar + sondeo del front-end. Best-effort: nunca
// tumba el servidor. Aplica SIEMPRE (la acción del panel es para arreglar de verdad, no dry-run).
let trabajo = { en_curso: false, total: 0, hechos: 0, recuperados: 0, sin_isbn: 0, sin_fichero: 0, cdu: 0, otros: 0, titulo: '', cancelar: false, ts: null };
export function estadoReidentificacion() { return { ...trabajo }; }
export function cancelarReidentificacion() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

export function lanzarReidentificacion({ ids, forzar = false, isbnManual = null, conIA = false, cdu = false } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una re-identificación en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };
    // El ISBN manual solo tiene sentido para UN documento (si no, se aplicaría el mismo a todos): se ignora en lote.
    const manual = lista.length === 1 ? isbnManual : null;
    trabajo = { en_curso: true, total: lista.length, hechos: 0, recuperados: 0, sin_isbn: 0, sin_fichero: 0, cdu: 0, otros: 0, titulo: '', cancelar: false, ts: new Date().toISOString() };
    (async () => {
        try {
            const db = await conectarDB();
            for (const _id of lista) {
                if (trabajo.cancelar) break;
                let doc = await db.collection('biblioteca').findOne({ _id }).catch(() => null);
                trabajo.titulo = doc?.titulo || '';
                if (doc) {
                    try {
                        const r = await reidentificarDoc(db, doc, { aplicar: true, usarApis: true, forzar, isbnManual: manual, conIA });
                        if (r.estado === 'aplicado') trabajo.recuperados++;
                        else if (r.estado === 'no-hallado') trabajo.sin_isbn++;
                        else if (r.estado === 'sin-fichero') trabajo.sin_fichero++;
                        else trabajo.otros++;   // ya-tiene-isbn / formato-no-soportado
                    } catch { trabajo.otros++; }
                    // INVESTIGAR/FORZAR CDU (opción aparte): re-lee el doc por si el ISBN cambió arriba, y resuelve
                    // la CDU del Dewey/LCC (crosswalk → IA si conIA). Mueve la carpeta (editarDocumento).
                    if (cdu) {
                        try {
                            doc = await db.collection('biblioteca').findOne({ _id }).catch(() => doc);
                            const rc = await resolverCduDoc(db, doc, { conIA, forzar, aplicar: true });
                            if (rc.estado === 'cdu-aplicada') trabajo.cdu++;
                        } catch { /* best-effort */ }
                    }
                } else trabajo.otros++;
                trabajo.hechos++;
            }
        } catch { /* el lote nunca tumba el servidor */ }
        finally { trabajo.en_curso = false; }
    })();
    return { ok: true, total: lista.length };
}
