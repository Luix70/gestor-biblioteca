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
import { esAutorArtefacto, esTituloArtefacto } from '../utils/parsear-nombre.js';
import { variantesISBN } from '../utils/identificadores.js';
import { buscarEnFicheroLocal, corroborarISBNporTitulo } from '../utils/buscador-local.js';
import { buscarNombrePorISSN } from '../utils/buscador-issn-titulo.js';
import { nombreEsPlaceholder, limpiarNombreColeccion, claveCanonica } from '../utils/colecciones.js';
import { ROLES_VALIDOS } from '../utils/contribuciones.js';
import { enriquecerAutor, autoresEnriquecibles } from '../utils/enriquecer-autor.js';
import { rellenarDescripcionesFaltantes, contarFaltantes } from './backfill-descripciones.js';
import { enriquecerAFondo } from './enriquecer-a-fondo.js';
import { PLACEHOLDERS_AUTOR } from '../utils/creditos-portada.js';
import path from 'node:path';
import { carpetaDeDoc } from './util-mantenimiento.js';
import { recuperarOriginalesDeFichero } from '../utils/titulo-original.js';
import { indexarDoc } from '../utils/indice-busqueda.js';
import { regenerarSidecarsDoc, FILTRO_SIDECARS_DESACTUALIZADOS } from '../utils/registro.js';
import { precalentarEquivalencias, contarEquivalenciasPendientes, resolverCDU } from '../clasificador-cdu.js';
import { editarDocumento } from '../utils/editar-doc.js';

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

// Título normalizado para comparar IGUALDAD (minúsculas, sin acentos ni puntuación, espacios colapsados).
const _RE_DIACR = new RegExp('[\\u0300-\\u036f]', 'g');
const normTitulo = (s) => String(s || '').toLowerCase().normalize('NFD').replace(_RE_DIACR, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const sinExtension = (n) => String(n || '').replace(/\.[^.]+$/, '');

/**
 * COTEJO SEGURO por ISBN (SIN IA, solo Fichero local). Regla del usuario: el ISBN-autoridad PRIMA sobre el
 * título de los metadatos del fichero (no todo el mundo escanea con cuidado; casos reales: el título quedó con
 * el nombre de la SERIE, o un artefacto). PERO con salvaguarda contra el ISBN EQUIVOCADO (p. ej. una guía de
 * Venecia cuyo CIP mal-leído da un ISBN de «Philosophy of Plato»): solo se sustituye si el ISBN se CORROBORA
 * por el NOMBRE DE ARCHIVO (el indicio humano fiable) contra el título del Fichero. Si difiere pero NO
 * corrobora → a revisión (no se toca el título). Devuelve:
 *   { accion:'aplicar', titulo, subtitulo } · { accion:'revisar', tituloFichero } · null (nada que hacer).
 */
export async function cotejarPorISBN(doc) {
    const isbns = variantesISBN(doc.isbn);
    if (!isbns.length) return null;
    const fich = await buscarEnFicheroLocal({ isbns }).catch(() => null);
    const tAut = fich && fich.titulo ? String(fich.titulo).trim() : '';
    if (!tAut) return null;                                        // el ISBN no está en el Fichero → nada que hacer
    if (normTitulo(doc.titulo) === normTitulo(tAut)) return null;  // el título ya coincide con la autoridad
    // ¿El ISBN es REALMENTE de este libro? Se corrobora SOLO por el nombre de archivo (el título actual puede
    // ser el genérico de la serie o un artefacto → mal referente). Sin nombre de archivo → no se puede confirmar.
    const ref = sinExtension(doc.nombre_archivo);
    const corrobora = ref ? await corroborarISBNporTitulo({ candidatos: isbns, titulo: ref }).catch(() => null) : null;
    if (corrobora) return { accion: 'aplicar', titulo: tAut, subtitulo: fich.subtitulo ? String(fich.subtitulo).trim() : null };
    return { accion: 'revisar', tituloFichero: tAut };            // difiere y el ISBN no se corrobora → posible ISBN erróneo
}

/**
 * CDU que aporta el Fichero para un registro: su CDU directa (BNE, específica) o, si no, la del Dewey/LC por el
 * CROSSWALK DETERMINISTA (resolverCDU sin IA). Devuelve { cdu, via } o null. Sin IA ni APIs.
 */
export async function cduDelFichero(f) {
    if (!f) return null;
    if (f.cdu) return { cdu: String(f.cdu).trim(), via: 'cdu-BNE' };
    if (f.dewey || f.lcc) {
        try {
            const r = await resolverCDU({ dewey: f.dewey, lcc: f.lcc, permitirIA: false });
            const c = typeof r === 'string' ? r : (r && r.cdu);
            if (c && c !== '000') return { cdu: String(c).trim(), via: 'crosswalk' };
        } catch { /* el crosswalk defiere a IA en los casos divergentes → aquí, sin dato */ }
    }
    return null;
}

/**
 * NOMBRE DE SERIE/CABECERA por ISSN. Una colección cuyo nombre es un PLACEHOLDER (su propio ISSN, un ISSN
 * suelto, vacío o un artefacto) recibe su nombre AUTORITATIVO resuelto por el ISSN (Wikidata → ISSN Portal),
 * SIN IA. Además de renombrar la colección, refresca el `coleccion_nombre` DENORMALIZADO de sus miembros (lo
 * usan catálogo/búsqueda/MARC 490) y los reindexa. NO FUNDE: si el nombre destino ya existe en otra colección,
 * lo deja para el saneo manual (script sanear-nombres-serie-issn, que sí funde). Devuelve true si renombró.
 */
export async function resolverNombreSeriePorISSN(db, coleccion) {
    const issn = coleccion && coleccion.issn;
    if (!issn || !nombreEsPlaceholder(coleccion.nombre, issn)) return false; // ya tiene un nombre real
    const r = await buscarNombrePorISSN(issn).catch(() => null);
    if (!r || !r.nombre) return false;                                       // no hay nombre autoritativo
    const nuevo = limpiarNombreColeccion(r.nombre);
    if (!nuevo || nombreEsPlaceholder(nuevo, issn)) return false;            // el resuelto no vale (no mejora)
    const col = db.collection('colecciones');
    // No se funde aquí: si otra colección ya tiene ese nombre, se deja para el saneo manual (evita el índice
    // único de nombre y decisiones de fusión, que son cosa del script).
    const choca = await col.findOne({ nombre: nuevo, _id: { $ne: coleccion._id } }, { collation: { locale: 'es', strength: 1 } });
    if (choca) return false;
    const set = { nombre: nuevo, fecha_actualizacion: new Date() };
    const cc = claveCanonica(nuevo);
    if (cc) set.clave_canonica = cc;
    await col.updateOne({ _id: coleccion._id }, { $set: set });
    // Refresca el nombre denormalizado en los miembros (catálogo/búsqueda/MARC) y reindexa cada uno.
    const bib = db.collection('biblioteca');
    const miembros = await bib.find({ coleccion: coleccion._id, coleccion_nombre: { $ne: nuevo } }, { projection: { _id: 1 } }).toArray();
    for (const m of miembros) {
        await bib.updateOne({ _id: m._id }, { $set: { coleccion_nombre: nuevo, fecha_actualizacion: new Date() } });
        await indexarDoc(db, m._id).catch(() => {});
    }
    return true;
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
        id: 'cotejo',
        etiqueta: 'Cotejar título por ISBN',
        coste: 'gratis',
        descripcion: 'El ISBN-autoridad PRIMA sobre el título de los metadatos del fichero (escaneos descuidados). Para libros con ISBN, si el título del Fichero local (OL+BNE) DIFIERE del actual y el ISBN se CORROBORA por el nombre de archivo, sustituye el título (y el subtítulo si falta) — AUTO, SIN IA, offline. Casos reales: el título quedó con el nombre de la SERIE/editorial, truncado o un artefacto. SOLO aplica el caso corroborado (100% seguro); si difiere pero el ISBN NO se corrobora (posible ISBN equivocado o compartido) NO toca nada — esos sospechosos se ven con «node scripts/cotejar-por-isbn.js» (que de paso es un cazador de ISBN erróneos).',
        version: 1,
        loteDefecto: 120,
        cadenciaDefecto: 10,
        activaDefecto: true,   // gratis (solo Fichero, offline) → conviene que corra solo
        coleccion: 'biblioteca',
        proyeccion: { titulo: 1, subtitulo: 1, isbn: 1, nombre_archivo: 1 },
        candidatos: () => ({ ...CON_ISBN }),   // todos los libros con ISBN (la resolución al Fichero es local y barata)
        async procesarDoc(db, doc) {
            const r = await cotejarPorISBN(doc);
            if (!r || r.accion !== 'aplicar') return false;   // solo el caso corroborado; el resto se sella sin tocar ni marcar
            const set = { titulo: r.titulo, fecha_actualizacion: new Date() };
            if (r.subtitulo && !doc.subtitulo) set.subtitulo = r.subtitulo;
            await db.collection('biblioteca').updateOne({ _id: doc._id }, {
                $set: set,
                $push: { alertas_agente: `Título "${String(doc.titulo).slice(0, 45)}" sustituido por el del Fichero por ISBN (corroborado por el nombre): "${r.titulo.slice(0, 45)}" (campaña cotejo, sin IA).` },
            });
            return true;
        },
    },

    {
        id: 'cotejo-cdu',
        etiqueta: 'Clasificación por ISBN (rellena CDU 000)',
        coste: 'gratis',
        descripcion: 'RELLENA la CDU de los libros SIN clasificar (cdu ausente o «000») con la del Fichero local por ISBN: su CDU directa (BNE) o la del Dewey/LC por el crosswalk determinista (SIN IA, offline). Mueve la carpeta al árbol nuevo (editarDocumento). SALVAGUARDA: solo si el ISBN se CORROBORA por el nombre de archivo (no clasificar por un ISBN equivocado). NO toca los libros que YA tienen CDU aunque el Fichero difiera (el crosswalk es grueso y la CDU catalogada suele ser mejor); esas divergencias se ven con «node scripts/cotejar-por-isbn.js --clasificacion». INACTIVA por defecto: actívala con su switch cuando quieras (mueve carpetas).',
        version: 1,
        loteDefecto: 40,        // mueve carpetas → lotes pequeños
        cadenciaDefecto: 20,
        activaDefecto: false,   // a voluntad (switch en el panel)
        coleccion: 'biblioteca',
        proyeccion: { isbn: 1, nombre_archivo: 1 },
        // Libros con ISBN y SIN CDU (ausente/null/''/'000'). El sello evita reprocesar los que el Fichero no clasifica.
        candidatos: () => ({ ...CON_ISBN, $or: [{ cdu: { $exists: false } }, { cdu: null }, { cdu: '' }, { cdu: '000' }] }),
        async procesarDoc(db, doc) {
            const isbns = variantesISBN(doc.isbn);
            const f = await buscarEnFicheroLocal({ isbns }).catch(() => null);
            const cf = await cduDelFichero(f);
            if (!cf) return false;                                 // el Fichero no aporta clasificación → nada
            const ref = sinExtension(doc.nombre_archivo);
            const ok = ref ? await corroborarISBNporTitulo({ candidatos: isbns, titulo: ref }).catch(() => null) : null;
            if (!ok) return false;                                 // ISBN no corroborado → no clasificar (posible ISBN erróneo)
            const r = await editarDocumento(db, String(doc._id), { cdu: cf.cdu }).catch(() => null); // mueve la carpeta
            return !!(r && r.ok);
        },
    },

    {
        id: 'nombres-serie',
        etiqueta: 'Nombre de serie por ISSN',
        coste: 'apis',
        descripcion: 'Colecciones cuyo NOMBRE es un placeholder —su propio ISSN, un ISSN suelto o vacío— reciben su nombre AUTORITATIVO resuelto por el ISSN (Wikidata → ISSN Portal, sin IA): p. ej. una serie con ISSN 2192-4333 pasa a llamarse «Springer Texts in Business and Economics». Renombra la colección y refresca el coleccion_nombre de sus miembros (catálogo/búsqueda/MARC). NO funde: si el nombre ya lo tiene otra colección, lo deja para el saneo manual. APIs web con límite: lote pequeño y cadencia holgada.',
        version: 1,
        loteDefecto: 20,
        cadenciaDefecto: 30,
        activaDefecto: true,     // APIs libres (Wikidata/ISSN Portal), sin IA, y arregla un defecto visible → activa
        coleccion: 'colecciones',
        proyeccion: { nombre: 1, issn: 1 },
        // Colecciones CON ISSN cuyo nombre es el propio ISSN / un ISSN suelto / vacío (el placeholder fino lo
        // vuelve a comprobar procesarDoc con nombreEsPlaceholder, que además pilla DOIs/URLs artefacto).
        candidatos: () => ({
            issn: { $type: 'string', $ne: '' },
            $or: [
                { nombre: { $in: [null, ''] } },
                { nombre: { $exists: false } },
                { nombre: { $regex: '^\\s*\\d{4}-\\d{3}[\\dxX]\\s*$' } }, // el nombre ES un ISSN
                { $expr: { $eq: ['$nombre', '$issn'] } },                // el nombre ES su propio ISSN
            ],
        }),
        async procesarDoc(db, doc) {
            return await resolverNombreSeriePorISSN(db, doc);
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

    {
        id: 'sidecars',
        etiqueta: 'Sidecars registro.json/.marc.xml',
        coste: 'gratis',
        descripcion: 'Regenera los sidecars registro.json y registro.marc.xml de los documentos MODIFICADOS después de su último sidecar (cambios de CDU, autores, editorial, edición manual, re-enriquecimiento…), para que la COPIA EN DISCO —desde la que se puede reconstruir la base de datos ante una catástrofe— refleje el estado real de Mongo. Sin IA ni APIs (solo disco + BD). Un documento se regenera CADA vez que se vuelve a modificar.',
        version: 1,
        loteDefecto: 200,
        cadenciaDefecto: 10,
        activaDefecto: true, // barato (local) → conviene que corra solo para no dejar sidecars viejos
        especial: true,      // no se sella por versión: la candidatura es «fecha_actualizacion > sidecars_fecha»
        async pendientes(db) {
            return db.collection('biblioteca').countDocuments(FILTRO_SIDECARS_DESACTUALIZADOS);
        },
        async ejecutarLote(db, { limite, onProgreso }) {
            const docs = await db.collection('biblioteca').find(FILTRO_SIDECARS_DESACTUALIZADOS).limit(limite).toArray();
            let procesados = 0, cambios = 0;
            for (const doc of docs) {
                try {
                    const r = await regenerarSidecarsDoc(db, doc, carpetaDeDoc(doc));
                    if (r.ok) cambios++;   // (sinCarpeta también se sella, para que la cola drene)
                } catch { /* omitir este doc; se reintentará en la próxima pasada */ }
                procesados++;
                if (onProgreso) onProgreso(procesados, docs.length);
            }
            const pendientes = await db.collection('biblioteca').countDocuments(FILTRO_SIDECARS_DESACTUALIZADOS);
            return { procesados, cambios, pendientes };
        },
    },

    {
        id: 'equivalencias-cdu',
        etiqueta: 'Equivalencias CDU (por lote)',
        coste: 'ia',
        descripcion: 'Deduce con IA la CDU de los códigos Dewey/LCC NUEVOS que usan los libros con CDU pobre (000) y que aún no están en caché ni en el crosswalk determinista — MUCHOS códigos por LLAMADA (batch → menos coste/llamadas). Los aprende en equivalencias_cdu; luego «re-clasificar-cdu» resuelve cada libro GRATIS desde caché y mueve su carpeta. Pensada para después de un lote grande ingerido con INGESTA_CDU_SIN_IA=1 (la CDU quedó en 000).',
        version: 1,
        loteDefecto: 60,        // códigos por tanda (no documentos)
        cadenciaDefecto: 10,
        activaDefecto: false,   // consume IA → opt-in
        especial: true,         // no itera documentos: cuenta/gasta por CÓDIGOS distintos
        async pendientes(db) {
            return contarEquivalenciasPendientes(db);
        },
        async ejecutarLote(db, { limite, onProgreso }) {
            const r = await precalentarEquivalencias(db, { limite, onProgreso });
            return { procesados: r.procesados, cambios: r.cambios, pendientes: r.pendientes };
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
