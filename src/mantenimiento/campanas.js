/**
 * CAMPAÑAS DE FONDO (backfill autorreparable al reposo).
 *
 * A diferencia del Conformador (`tareas.js`), que corre TODAS sus tareas por-documento con una sola
 * cadencia y se auto-sella por versión, cada CAMPAÑA rellena UN tipo de información incompleta del catálogo
 * con su PROPIO ajuste (activa/lote/cada-N-min) y su PROPIO coste (sin IA / APIs con límite / IA de pago),
 * pensadas para lanzarse cuando el sistema está inactivo y minimizar coste (ver [[minimize-ai-ingestion]]).
 *
 * Modelo de una campaña «por-documento» (la mayoría):
 *   { id, etiqueta, coste, descripcion, version, coleccion, proyeccion,
 *     candidatos(db) -> filtro Mongo de lo que AÚN necesita trabajo (sin el sello),
 *     procesarDoc(db, doc) -> escribe los datos que encuentre y devuelve true si cambió algo }
 * El motor genérico añade el SELLO (`campanas.<id> = version`) al filtro y sella cada documento tras
 * procesarlo (haya encontrado datos o no) → resumible y TERMINABLE (no reintenta eternamente los que no
 * tienen datos). Subir `version` re-sella y vuelve a pasar la campaña por todo.
 *
 * Una campaña «especial» (p. ej. descripciones) no itera documentos: define su propio `pendientes()` y
 * `ejecutarLote({limite})`.
 *
 * SOLO corre donde el mantenimiento puede (contenedor del NAS o MANTENIMIENTO_FORZAR=1): aunque las
 * campañas solo tocan Mongo + APIs (no el árbol de ficheros), dos instancias contra el mismo Atlas
 * duplicarían trabajo. La cadencia y el disparo los gobierna el vigilante (comparte su lock con la ingesta).
 */
import fs from 'node:fs';
import { conectarDB } from '../database.js';
import { buscarMetadatosExternos } from '../utils/proveedor-metadatos.js';
import { resolverPersona } from '../utils/resolver-persona.js';
import { esAutorArtefacto } from '../utils/parsear-nombre.js';
import { variantesISBN } from '../utils/identificadores.js';
import { ROLES_VALIDOS } from '../utils/contribuciones.js';
import { enriquecerAutor, autoresEnriquecibles } from '../utils/enriquecer-autor.js';
import { rellenarDescripcionesFaltantes, contarFaltantes } from './backfill-descripciones.js';
import { enriquecerAFondo } from './enriquecer-a-fondo.js';
import { PLACEHOLDERS_AUTOR } from '../utils/creditos-portada.js';
import path from 'node:path';
import { carpetaDeDoc } from './util-mantenimiento.js';
import { recuperarOriginalesDeFichero } from '../utils/titulo-original.js';
import { indexarDoc } from '../utils/indice-busqueda.js';

const EN_CONTENEDOR = fs.existsSync('/.dockerenv');
export const PUEDE_CAMPANAS = EN_CONTENEDOR || process.env.MANTENIMIENTO_FORZAR === '1';

const PAUSA_MS = Number(process.env.CAMPANAS_PAUSA_MS || 700); // ritmo entre elementos (respeta a las APIs)
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Condición «campo vacío» reutilizable (ausente / null / '' / array vacío).
const VACIO = (f) => ({ $or: [{ [f]: { $exists: false } }, { [f]: null }, { [f]: '' }] });
const CON_ISBN = { isbn: { $exists: true, $nin: [null, ''] } };

// ¿El nombre de un autor es ARTEFACTO (basura del texto/producción: frases, «Creator:…», URLs…) o está
// marcado como sospechoso con el prefijo «[?]_»? → debe descartarse y sustituirse por el de la autoridad.
const esAutorMalo = (nombre) => String(nombre || '').startsWith('[?]_') || esAutorArtefacto(nombre);
// _ids de los autores cuyo NOMBRE es artefacto/[?]_ (para localizar los docs que los referencian).
async function idsAutoresArtefacto(db) {
    const autores = await db.collection('autores').find({}, { projection: { nombre: 1 } }).toArray();
    return autores.filter((a) => esAutorMalo(a.nombre)).map((a) => a._id);
}
// Nombres de los autores actuales de un doc (para decidir si son artefacto y hay que reemplazarlos).
async function nombresAutoresDoc(db, ids) {
    if (!ids?.length) return [];
    const docs = await db.collection('autores').find({ _id: { $in: ids } }, { projection: { nombre: 1 } }).toArray();
    return docs.map((a) => a.nombre);
}

// Resuelve un nombre de editorial a su ObjectId (check-then-create), como en la ingesta.
async function resolverEditorialRef(db, nombre) {
    const ex = await db.collection('editoriales').findOne({ nombre });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

// Convierte [{nombre,rol}] (de la mención) en [{persona,rol}] resueltos y deduplicados (sin el rol 'autor').
async function resolverContribuciones(db, nombres) {
    const out = [];
    const vistos = new Set();
    for (const c of nombres || []) {
        if (!c || !c.nombre || !ROLES_VALIDOS.includes(c.rol) || c.rol === 'autor') continue;
        const persona = await resolverPersona(db, c.nombre);
        if (!persona) continue;
        const clave = `${String(persona._id)}|${c.rol}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        out.push({ persona: persona._id, rol: c.rol });
    }
    return out;
}

// ── REGISTRO DE CAMPAÑAS ────────────────────────────────────────────────────────────────────
// coste: 'gratis' = sin IA (local/Fichero) · 'apis' = APIs gratuitas con LÍMITE de llamadas ·
//        'ia' = consume IA de pago (Gemini).

export const CAMPANAS = [
    {
        id: 'roles',
        etiqueta: 'Roles e idioma original',
        coste: 'gratis',
        descripcion: 'Traductor/ilustrador/prologuista… e idioma original de los libros con ISBN, desde la mención de la BNE (Fichero) y OpenLibrary. SIN IA.',
        version: 1,
        loteDefecto: 100,
        cadenciaDefecto: 10,
        activaDefecto: false,
        coleccion: 'biblioteca',
        proyeccion: { isbn: 1, idioma_original: 1, contribuciones: 1 },
        // Con ISBN y sin contribuciones O sin idioma_original (una misma consulta rellena ambos).
        candidatos: () => ({ ...CON_ISBN, $or: [{ contribuciones: { $exists: false } }, { idioma_original: { $exists: false } }] }),
        async procesarDoc(db, doc) {
            const ext = await buscarMetadatosExternos(null, null, null, {
                isbnsArchivo: variantesISBN(doc.isbn), incluirCdu: false, incluirSinopsis: false,
            }).catch(() => null);
            if (!ext) return false;
            const set = {};
            if (!doc.contribuciones) {
                const contribs = await resolverContribuciones(db, ext.contribuciones_nombres);
                if (contribs.length) set.contribuciones = contribs;
            }
            // idioma_original solo si es DISTINTO del idioma del documento (no aporta si coinciden).
            if (!doc.idioma_original && ext.idioma_original && ext.idioma_original !== doc.idioma) set.idioma_original = ext.idioma_original;
            if (!Object.keys(set).length) return false;
            set.fecha_actualizacion = new Date();
            await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
            return true;
        },
    },

    {
        id: 'original',
        etiqueta: 'Título e idioma original (del fichero)',
        coste: 'gratis',
        descripcion: 'Lee la PÁGINA DE CRÉDITOS/copyright del EPUB/PDF y recupera el «Título original» (y, en antologías, todos) más un indicio de idioma original. SIN IA. Solo se guardan si DIFIEREN del título/idioma del propio documento. Complementa a «Roles e idioma original» (que va por APIs): aquí la fuente es el propio fichero.',
        version: 1,
        loteDefecto: 60,
        cadenciaDefecto: 12,
        activaDefecto: false,
        coleccion: 'biblioteca',
        proyeccion: { titulo: 1, idioma: 1, idioma_original: 1, nombre_archivo: 1, ruta_base: 1, cdu: 1, formatos: 1, isbn: 1, issn: 1, 'año_edicion': 1, mes_publicacion: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1 },
        // Libros digitales (epub/pdf) que aún no tienen título original. El sello evita reprocesar los que no lo traen.
        candidatos: () => ({ tipo_recurso: 'libro', formatos: { $in: ['epub', 'pdf'] }, titulo_original: { $exists: false } }),
        async procesarDoc(db, doc) {
            if (!doc.nombre_archivo) return false;
            const ruta = path.join(carpetaDeDoc(doc), doc.nombre_archivo);
            if (!fs.existsSync(ruta)) return false;                       // fichero fuera del NAS → se sella igual
            const res = await recuperarOriginalesDeFichero(ruta, doc.titulo).catch(() => null);
            if (!res || !res.titulo_original) return false;
            const set = { titulo_original: res.titulo_original };          // el parser ya lo garantiza ≠ título
            if (res.titulos_originales.length) set.titulos_originales = res.titulos_originales;
            if (res.idioma_original && res.idioma_original !== doc.idioma && !doc.idioma_original) set.idioma_original = res.idioma_original;
            set.fecha_actualizacion = new Date();
            await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
            return true;
        },
    },

    {
        id: 'enriquecer',
        etiqueta: 'Huecos de metadatos',
        coste: 'apis',
        descripcion: 'Rellena por ISBN los huecos de sinopsis, año, editorial, autores, palabras clave e Dewey/LCC desde OpenLibrary / Google Books / DNB. APIs gratuitas. Conservador: nunca pisa lo bueno, PERO descarta y sustituye los autores-ARTEFACTO (basura del texto / marcados [?]_) por el de la autoridad.',
        version: 2, // v2: además reemplaza autores-artefacto (re-evalúa los docs ya sellados)
        loteDefecto: 50,
        cadenciaDefecto: 15,
        activaDefecto: false,
        coleccion: 'biblioteca',
        proyeccion: { isbn: 1, sinopsis: 1, año_edicion: 1, editorial: 1, autores: 1, palabras_clave: 1, dewey: 1, lcc: 1, idioma: 1, titulo: 1 },
        // Con ISBN y con AL MENOS un hueco de los que esta campaña rellena, O con un autor ARTEFACTO/[?]_.
        async candidatos(db) {
            const artefactoIds = await idsAutoresArtefacto(db);
            return {
                ...CON_ISBN,
                $or: [
                    VACIO('sinopsis'), VACIO('año_edicion'), VACIO('editorial'), VACIO('idioma'),
                    { autores: { $exists: false } }, { autores: null }, { autores: [] },
                    { palabras_clave: { $exists: false } }, { palabras_clave: null }, { palabras_clave: [] },
                    { $and: [VACIO('dewey'), VACIO('lcc')] },
                    ...(artefactoIds.length ? [{ autores: { $in: artefactoIds } }] : []), // autor artefacto/[?]_ → sustituir
                ],
            };
        },
        async procesarDoc(db, doc) {
            const ext = await buscarMetadatosExternos(doc.titulo || '', '', null, {
                isbnsArchivo: variantesISBN(doc.isbn), incluirCdu: false, incluirSinopsis: true, idioma: doc.idioma || null,
            }).catch(() => null);
            if (!ext) return false;
            const set = {};
            // Escalares/arrays: solo se rellena lo que falte (conservador).
            if (ext.sinopsis && !doc.sinopsis) set.sinopsis = ext.sinopsis;
            if (ext.año_edicion && !doc.año_edicion) set.año_edicion = ext.año_edicion;
            if (ext.idioma && !doc.idioma) set.idioma = ext.idioma;
            if (ext.categorias?.length && !(doc.palabras_clave?.length)) set.palabras_clave = ext.categorias;
            if (ext.dewey && !doc.dewey) set.dewey = String(ext.dewey).trim();
            if (ext.lcc && !doc.lcc) set.lcc = String(ext.lcc).trim();
            // Editorial: solo si falta por completo.
            if (ext.editorial && !doc.editorial) set.editorial = await resolverEditorialRef(db, ext.editorial);
            // Autores: rellenar si FALTAN, o REEMPLAZAR si el actual es un ARTEFACTO ([?]_ / basura del texto).
            const nombresActuales = await nombresAutoresDoc(db, doc.autores);
            const autorArtefacto = nombresActuales.length > 0 && nombresActuales.every(esAutorMalo);
            if (ext.autores?.length && (!(doc.autores?.length) || autorArtefacto)) {
                const refs = [];
                for (const nombre of ext.autores) {
                    const p = await resolverPersona(db, nombre);
                    if (p) refs.push(p._id);
                }
                if (refs.length) set.autores = refs;
            }
            if (!Object.keys(set).length) return false;
            set.fecha_actualizacion = new Date();
            await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
            return true;
        },
    },

    {
        id: 'autor_web',
        etiqueta: 'Fotos y biografías de autor',
        coste: 'apis',
        descripcion: 'Foto, biografía, seudónimos y fechas de los autores con libros, desde OpenLibrary + Wikidata + Wikipedia. APIs web (con límite): lote pequeño y cadencia holgada.',
        version: 1,
        loteDefecto: 25,
        cadenciaDefecto: 30,
        activaDefecto: false,
        coleccion: 'autores',
        proyeccion: { nombre: 1 },
        // Autores CON libros a los que falta biografía o foto (el conjunto lo calcula autoresEnriquecibles,
        // aquí lo traducimos a un filtro por _id para que el motor genérico le pueda añadir el sello).
        async candidatos(db) {
            const ids = (await autoresEnriquecibles(db)).map((a) => a._id);
            return { _id: { $in: ids.length ? ids : [null] } };
        },
        async procesarDoc(db, doc) {
            const r = await enriquecerAutor(db, doc._id, { sobrescribir: false }).catch(() => null);
            return !!(r && r.ok && r.cambios && r.cambios.length);
        },
    },

    {
        id: 'completar_a_fondo',
        etiqueta: 'Completar a fondo (leer el libro)',
        coste: 'ia',
        descripcion: 'Lee las PÁGINAS del propio fichero (portadilla/contraportada/créditos) con la visión y una plantilla rica, y completa autores/roles reales, sinopsis e identificadores que las APIs no tienen. Se centra en libros con el AUTOR puesto a la editorial (DK, VV.AA.) o sin autor. Solo aplica si la extracción MERECE LA PENA. CONSUME IA (visión) de pago como último recurso.',
        version: 1,
        loteDefecto: 5,          // la visión es lenta/costosa → lotes pequeños
        cadenciaDefecto: 30,
        activaDefecto: false,
        coleccion: 'biblioteca',
        // Candidatos: documentos CON imágenes que leer y cuyo autor es placeholder (editorial colada) o falta.
        async candidatos(db) {
            const re = new RegExp('^(' + PLACEHOLDERS_AUTOR.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')$', 'i');
            const ph = await db.collection('autores').find({ nombre: re }, { projection: { _id: 1 } }).toArray();
            const ids = ph.map((a) => a._id);
            return {
                'imagenes.0': { $exists: true },
                $or: [
                    { autores: { $in: ids.length ? ids : [null] } },
                    { autores: { $size: 0 } },
                    { autores: { $exists: false } },
                ],
            };
        },
        async procesarDoc(db, doc) {
            const r = await enriquecerAFondo(db, doc, { aplicar: true });
            return !!r.aplicado;
        },
    },

    {
        id: 'descripciones',
        etiqueta: 'Descripciones CDU/Dewey/LCC',
        coste: 'ia',
        descripcion: 'Genera con IA (Gemini) la descripción de cada código de clasificación que usan los libros y aún no la tiene. CONSUME IA DE PAGO: 1 llamada por código. Se cachea (una vez descrito, no se vuelve a pedir).',
        version: 1,
        loteDefecto: 25,
        cadenciaDefecto: 10,
        activaDefecto: false,
        especial: true, // no itera documentos: cuenta/gasta por códigos faltantes
        async pendientes(db) {
            return (await contarFaltantes(db)).total;
        },
        async ejecutarLote(db, { limite, onProgreso }) {
            const r = await rellenarDescripcionesFaltantes({ limite, db, onProgreso });
            return { procesados: r.generadas + r.fallos, cambios: r.generadas, pendientes: r.pendientes };
        },
    },
];

const PORID = new Map(CAMPANAS.map((c) => [c.id, c]));

// ── AJUSTES (persistidos en Mongo, editables desde el panel) ────────────────────────────────
// Documento único `ajustes/_id:'campanas'` con overrides por campaña. Lo que no esté, cae al defecto.

const AJUSTES_ID = 'campanas';

/** Lee la config efectiva por campaña = defecto del registro fusionado con el override guardado. */
export async function leerAjustesCampanas(db) {
    const guardado = await db.collection('ajustes').findOne({ _id: AJUSTES_ID }).catch(() => null);
    const overrides = (guardado && guardado.campanas) || {};
    const out = {};
    for (const c of CAMPANAS) {
        const o = overrides[c.id] || {};
        out[c.id] = {
            activa: typeof o.activa === 'boolean' ? o.activa : c.activaDefecto,
            lote: Number.isFinite(o.lote) && o.lote > 0 ? Math.min(2000, o.lote) : c.loteDefecto,
            cadenciaMin: Number.isFinite(o.cadenciaMin) && o.cadenciaMin > 0 ? o.cadenciaMin : c.cadenciaDefecto,
        };
    }
    return out;
}

/** Guarda el ajuste de UNA campaña (activa/lote/cadenciaMin). Solo campos válidos. */
export async function guardarAjusteCampana(db, id, cambios = {}) {
    if (!PORID.has(id)) return { ok: false, motivo: 'campaña desconocida' };
    const set = {};
    if (typeof cambios.activa === 'boolean') set[`campanas.${id}.activa`] = cambios.activa;
    if (Number.isFinite(Number(cambios.lote))) set[`campanas.${id}.lote`] = Math.max(1, Math.min(2000, Number(cambios.lote)));
    if (Number.isFinite(Number(cambios.cadenciaMin))) set[`campanas.${id}.cadenciaMin`] = Math.max(1, Number(cambios.cadenciaMin));
    if (!Object.keys(set).length) return { ok: false, motivo: 'nada que guardar' };
    await db.collection('ajustes').updateOne({ _id: AJUSTES_ID }, { $set: set }, { upsert: true });
    return { ok: true };
}

// ── CONTEO DE PENDIENTES ────────────────────────────────────────────────────────────────────

/** Filtro completo (candidatos + NO sellados a la versión actual) de una campaña por-documento. */
function filtroConSello(camp, base) {
    return { $and: [base, { $or: [{ [`campanas.${camp.id}`]: { $exists: false } }, { [`campanas.${camp.id}`]: { $ne: camp.version } }] }] };
}

/** Nº de elementos que le quedan por procesar a una campaña (para el contador del panel). */
export async function pendientesCampana(db, camp) {
    if (camp.especial) return camp.pendientes(db);
    const base = await camp.candidatos(db);
    return db.collection(camp.coleccion).countDocuments(filtroConSello(camp, base));
}

/** Nombre legible de una campaña (para logs, «ocupado» y el panel). */
export function etiquetaCampana(id) {
    const c = PORID.get(id);
    return c ? c.etiqueta : id;
}

/** ¿Hay alguna campaña ejecutándose una tanda ahora mismo? */
export function campanaEnCurso() {
    for (const p of progreso.values()) if (p.enCurso) return true;
    return false;
}

/** Estado + config + pendientes + PROGRESO de TODAS las campañas (para GET /api/campanas). */
export async function listarCampanas(db) {
    const cfg = await leerAjustesCampanas(db);
    const out = [];
    for (const c of CAMPANAS) {
        let pendientes = null;
        try { pendientes = await pendientesCampana(db, c); } catch { pendientes = null; }
        out.push({
            id: c.id, etiqueta: c.etiqueta, coste: c.coste, descripcion: c.descripcion,
            version: c.version, ...cfg[c.id], pendientes,
            ultimaEjecucion: ultimaEjecucion.get(c.id) || null,
            progreso: progreso.get(c.id) || null,   // { enCurso, procesados, objetivo, cambios } de la tanda en curso/última
        });
    }
    return out;
}

// ── EJECUCIÓN ───────────────────────────────────────────────────────────────────────────────

const ultimaEjecucion = new Map(); // id → ms epoch de la última tanda (para la cadencia y el panel)
const progreso = new Map();        // id → { enCurso, procesados, objetivo, cambios, inicio, fin } de la tanda

/**
 * Ejecuta UNA tanda (hasta `limite`) de una campaña. Cede el turno si `debeAbortar()` (llegó ingesta).
 * Publica su avance en `progreso` (lo lee el panel para pintar una barra).
 * @returns {Promise<{procesados, cambios, pendientes, abortado}>}
 */
export async function ejecutarCampana(db, id, { limite, debeAbortar = async () => false } = {}) {
    const camp = PORID.get(id);
    if (!camp) return { procesados: 0, cambios: 0, pendientes: 0, abortado: false };
    ultimaEjecucion.set(id, Date.now());
    const prog = { enCurso: true, procesados: 0, objetivo: limite, cambios: 0, inicio: Date.now(), fin: null };
    progreso.set(id, prog);

    try {
        if (camp.especial) {
            // Campaña sin iteración de documentos (descripciones): avanza por su propio callback.
            const r = await camp.ejecutarLote(db, {
                limite,
                onProgreso: (hechos, total) => { prog.procesados = hechos; if (total) prog.objetivo = total; },
            });
            prog.cambios = r.cambios || 0;
            prog.procesados = r.procesados ?? prog.procesados;
            return { ...r, abortado: false };
        }

        const base = await camp.candidatos(db);
        const col = db.collection(camp.coleccion);
        const docs = await col.find(filtroConSello(camp, base), { projection: camp.proyeccion || {} }).limit(limite).toArray();
        prog.objetivo = docs.length;

        let procesados = 0, cambios = 0;
        for (const doc of docs) {
            if (await debeAbortar()) {
                const pendientes = await col.countDocuments(filtroConSello(camp, base));
                return { procesados, cambios, pendientes, abortado: true };
            }
            try {
                if (await camp.procesarDoc(db, doc)) {
                    cambios++;
                    // Refresca el índice de búsqueda de ESE doc (una campaña puede cambiar título/título
                    // original/autores/editorial, que son buscables). Best-effort: nunca rompe la campaña.
                    if (camp.coleccion === 'biblioteca') await indexarDoc(db, doc._id).catch(() => {});
                }
            } catch (e) {
                console.warn(`   ⚠️ campaña ${id} falló en ${doc._id}: ${e.message}`);
            }
            // Sella el documento (procesado, con o sin datos) para no reintentarlo mientras no suba la versión.
            await col.updateOne({ _id: doc._id }, { $set: { [`campanas.${camp.id}`]: camp.version } });
            procesados++;
            prog.procesados = procesados;
            prog.cambios = cambios;
            await espera(PAUSA_MS);
        }
        const pendientes = await col.countDocuments(filtroConSello(camp, base));
        return { procesados, cambios, pendientes, abortado: false };
    } finally {
        prog.enCurso = false;
        prog.fin = Date.now();
    }
}

/**
 * Pasada del PLANIFICADOR: ejecuta una tanda de cada campaña ACTIVA cuya cadencia ya venció. La llama el
 * vigilante al reposo (bajo su lock, cediendo a la ingesta). No corre fuera del contenedor.
 * `alEmpezar(id)` se invoca antes de cada campaña (el vigilante lo usa para la etiqueta de actividad).
 * @returns {Promise<{lanzadas:number, cambios:number}>}
 */
export async function ejecutarCampanasDebidas({ debeAbortar = async () => false, alEmpezar = () => {} } = {}) {
    if (!PUEDE_CAMPANAS) return { lanzadas: 0, cambios: 0 };
    let db;
    try { db = await conectarDB(); } catch { return { lanzadas: 0, cambios: 0 }; }
    const cfg = await leerAjustesCampanas(db);
    let lanzadas = 0, cambios = 0;
    for (const camp of CAMPANAS) {
        const c = cfg[camp.id];
        if (!c.activa) continue;
        const ultima = ultimaEjecucion.get(camp.id) || 0;
        if (Date.now() - ultima < c.cadenciaMin * 60000) continue; // aún no toca
        if (await debeAbortar()) break;                             // cede a la ingesta
        alEmpezar(camp.id);
        const r = await ejecutarCampana(db, camp.id, { limite: c.lote, debeAbortar });
        lanzadas++;
        cambios += r.cambios;
        if (r.procesados || r.cambios)
            console.log(`🎯 [Campaña ${camp.id}] ${r.procesados} procesados · ${r.cambios} cambios · ${r.pendientes} pendientes.`);
        if (r.abortado) break;
    }
    return { lanzadas, cambios };
}
