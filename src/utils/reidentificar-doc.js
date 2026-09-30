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
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../mantenimiento/util-mantenimiento.js';
import { isbnDesdeArchivo, tipoLibro } from './isbn-archivo.js';
import { variantesISBN, validarISBN } from './identificadores.js';
import { esTituloArtefacto, tituloDeNombreDeLote } from './parsear-nombre.js';
import { leerCodigoBarrasPorVision } from './lector-barras.js';
import { leerCIPdeImagenes } from '../agente.js';
import { identificarEdicion, candidatasParaGuardar, mismaEditorial, traductoresDelTitulo } from './identificar-edicion.js';
import { editorialesDeColeccion, anotarEditorialDeColeccion } from './indicios-coleccion.js';
import { esEditorialFalsa, limpiarNombreEditorial } from './editoriales-falsas.js';
import { extraerMetadatosEpub, textoInicialEpub } from './lector-epub.js';
import { huecosDesdeAutoridad } from './huecos-autoridad.js';
import { aplicarCduConPrioridad, puedeSustituirCdu, fuenteCduDoc } from './prioridad-cdu.js';
import { cduDeAutoridadFiable, buscarAutoridadPorISBN } from './autoridad-isbn.js';
import { rasterizarFrontalesPdf } from './ocr-pdf.js';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarEnBNE } from './buscador-bne-sru.js';
import { resolverCDU } from '../clasificador-cdu.js';
import { editarDocumento } from './editar-doc.js';
import { resolverPersona } from './resolver-persona.js';
import { indexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';
import { mismoTituloLibro } from './titulo-libro.js';
import { editorialCoherenteConISBN } from './editorial-por-prefijo.js';
import { datosDeObraDeCandidatas } from './datos-de-obra.js';

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

/**
 * Los datos del documento con los que se puede reconocer su EDICIÓN, ya resueltos a NOMBRES (en la BD, autores
 * y editorial son referencias). Es lo que come `identificarEdicion`.
 */
async function datosDeAutoridad(db, doc) {
    const autores = doc.autores?.length
        ? (await db.collection('autores').find({ _id: { $in: doc.autores } }, { projection: { nombre: 1 } }).toArray()).map((a) => a.nombre)
        : [];
    const ed = doc.editorial ? await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } }) : null;
    // Traductores del documento (del propio fichero en la ingesta): distinguen una traducción de otra.
    const idsTrad = (doc.contribuciones || []).filter((c) => c && c.rol === 'traductor' && c.persona).map((c) => c.persona);
    const traductores = idsTrad.length
        ? (await db.collection('autores').find({ _id: { $in: idsTrad } }, { projection: { nombre: 1 } }).toArray()).map((a) => a.nombre)
        : [];
    return {
        titulo: doc.titulo, autores, editorial: ed?.nombre || null,
        coleccion_nombre: doc.coleccion_nombre || null, coleccion_numero: doc.coleccion_numero || null,
        anio: doc.año_edicion || null, idioma: doc.idioma || null,
        traductores,
        // Editoriales que sugiere su colección (indicios aprendidos de otras identificaciones).
        editoriales_coleccion: await editorialesDeColeccion(db, doc).catch(() => []),
    };
}

/** Traductores declarados en un EPUB: el OPF y, si no, la línea «Traducción: …» de los créditos. Nunca lanza. */
async function traductoresDeEpub(ruta) {
    const m = await extraerMetadatosEpub(ruta).catch(() => null);
    const delOpf = (m?.contribuciones_nombres || []).filter((c) => c && c.rol === 'traductor').map((c) => c.nombre);
    if (delOpf.length) return delOpf;
    const texto = await textoInicialEpub(ruta, { maxDocs: 6 }).catch(() => '');
    const t = /Traducci[óo]n\s*(?:de|del [a-zé]+)?\s*[:,]\s*(.{3,160}?)(?=\s+(?:Dise[ñn]o|Editor|Ilustraci|Revisi|Correcci|Cubierta|ePub|$))/i.exec(texto);
    return t ? [t[1].trim()] : [];
}

// Lee las imágenes YA extraídas del documento (portada + páginas de catalogación) como buffers, para la visión.
async function imagenesDeDocParaVision(doc, max = 6) {
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return [];
    const out = [];
    for (const im of (doc.imagenes || []).slice(0, max)) {
        try { out.push({ data: await fs.readFile(path.join(carpeta, path.basename(im.ruta))), mimeType: 'image/jpeg' }); } catch { /* falta el fichero */ }
    }
    return out;
}
// Del JSON del CIP-por-visión saca el ISBN del VOLUMEN (este ejemplar) y el de la OBRA/SET (si es multivolumen).
// El ISBN impreso en la página de créditos es TEXTO en un escaneo → el código de barras no lo ve; por eso este
// paso complementa a leerCodigoBarrasPorVision. Distingue por el rol que la visión etiqueta (volumen/obra/tapa_*).
function isbnsDeCIP(cip) {
    if (!cip) return { volumen: null, obra: null };
    let volumen = validarISBN(cip.isbn) || null;
    let obra = validarISBN(cip.isbn_obra) || null;
    for (const e of (Array.isArray(cip.isbns) ? cip.isbns : [])) {
        const v = validarISBN(e && (e.numero || e.isbn));
        if (!v) continue;
        const rol = String((e && e.rol) || '').toLowerCase();
        if (!obra && rol === 'obra') obra = v;
        else if (!volumen && ['volumen', 'tapa_dura', 'tapa_blanda', 'desconocido'].includes(rol)) volumen = v;
    }
    // Si no se pudo etiquetar el volumen pero hay algún ISBN suelto, se coge el primero que no sea el de la obra.
    if (!volumen) for (const e of (Array.isArray(cip.isbns) ? cip.isbns : [])) { const v = validarISBN(e && (e.numero || e.isbn)); if (v && v !== obra) { volumen = v; break; } }
    if (obra && obra === volumen) obra = null;
    return { volumen, obra };
}
// ISBN(s) por CIP: lee el CIP en las imágenes YA extraídas y, si es un PDF y no salió nada, RASTERIZA las
// primeras páginas (la página de créditos vive al principio) y reintenta. Best-effort.
async function isbnPorCIP(doc, abs) {
    let cip = await leerCIPdeImagenes(await imagenesDeDocParaVision(doc)).catch(() => ({}));
    let r = isbnsDeCIP(cip);
    if ((r.volumen || r.obra) || !abs || tipoLibro(abs) !== 'pdf') return r;
    const nPag = doc.paginas || (await numeroPaginasPdf(abs).catch(() => 0)) || 8;
    const renders = await rasterizarFrontalesPdf(abs, nPag).catch(() => []);
    if (renders.length) { cip = await leerCIPdeImagenes(renders.map((x) => ({ data: x.buffer, mimeType: 'image/jpeg' }))).catch(() => ({})); r = isbnsDeCIP(cip); }
    return r;
}
async function resolverEditorial(db, nombre) {
    const t = limpiarNombreEditorial(String(nombre || ''));
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
 * ¿El título nuevo es el ACTUAL con una coletilla de catálogo? «The Enemy» → «Oxford Bookworms 6. The Enemy CD
 * Pack»; «Recycling» → «Recycling, Level 3»; «Volver a empezar» → «Volver a empezar/ Replay (Spanish Edition)»
 * (todos del log del 30-sep). Lo que sobra es la serie, el nivel, el formato o la edición: datos de la ficha de la
 * librería, no del título. Un título actual que ya es bueno (no un artefacto, no «Vol. 2») se queda como está.
 */
export function soloAnadeColetilla(actual, nuevo) {
    const a = normLite(actual), n = normLite(nuevo);
    if (a.length < 4 || esTituloArtefacto(actual)) return false;
    if (/^(vol|volumen|volume|tomo|parte?|n)\s*[ivxlcdm\d]+$/.test(a)) return false;   // «Vol. I»: eso sí se sustituye
    if (n.length <= a.length || !(` ${n} `).includes(` ${a} `)) return false;
    // Lo que sobra tiene que PARECER de catálogo: un paréntesis, una barra o una palabra de serie/nivel/formato.
    // «The Gale Encyclopedia of Mental Health» frente a «Encyclopedia of Mental Health» no lo es (ese sí es el título
    // completo), ni «Cinema 1: The Movement-Image» frente a «Cinema» (el número y el subtítulo son del libro).
    const sobra = (` ${n} `).replace(` ${a} `, ' ');
    return /[(\[/]/.test(String(nuevo))
        || /\b(level|stage|nivel|pack|pk|mp3|cd|edition|edicion|series|serie|library|biblioteca|collection|coleccion|classics|bookworms|factfiles|headwords|readers?)\b/.test(sobra);
}

/**
 * ¿El título que da la AUTORIDAD para un ISBN es el de este documento? Se mira contra su título y contra el nombre
 * de su fichero (el título del documento puede ser un artefacto: «Anthology.The.Mammoth.Book.of.Cover.Ups…»): casi
 * todas las palabras con cuerpo del título de la autoridad tienen que aparecer. «Encyclopedia of Modern Asia» no
 * confirma a «Vol.1_-_Abacus_-_China»; «The Mammoth Book of Cover-Ups» sí a ese nombre de fichero.
 */
function tituloConfirmaDoc(tituloAutoridad, doc) {
    if (!tituloAutoridad) return false;
    if (mismoTituloLibro(tituloAutoridad, doc.titulo)) return true;
    const palabras = normLite(tituloAutoridad).split(' ').filter((w) => w.length > 3);
    if (palabras.length < 2) return false;
    const texto = ` ${normLite(`${doc.titulo || ''} ${doc.nombre_archivo || ''}`)} `;
    const presentes = palabras.filter((w) => texto.includes(` ${w} `)).length;
    return presentes / palabras.length >= 0.8;
}

/** ¿El documento ya guarda ese mismo ISBN (en su forma de 10 o de 13)? */
const mismoISBNGuardado = (guardado, isbn) => !!guardado && variantesISBN(isbn).includes(String(guardado));

/**
 * Guarda en el documento las EDICIONES CANDIDATAS de una identificación ambigua (máx. 8), con lo justo para
 * reconocerlas: ISBN, título, editorial, año, idioma, colección, de dónde salen y qué casó.
 */
/**
 * Identificación AMBIGUA: guarda las candidatas (ordenadas, la más probable primero), la más probable aparte como
 * `isbn_probable`, y completa los datos de la OBRA con todas ellas (datos-de-obra.js: sinopsis, lengua original,
 * materias y la CDU si coinciden — nunca editorial, año, páginas ni colaboradores). Con diario para deshacer.
 * @returns {Promise<{ resumen: string }>}  texto para el informe (« · probable 978… · obra: sinopsis, CDU …»)
 */
async function completarConCandidatas(db, doc, ambiguo, { aplicar, usarApis, carpeta }) {
    const probable = ambiguo.probable?.isbn || null;
    const obra = await datosDeObraDeCandidatas(doc, ambiguo.candidatos, { enLinea: usarApis }).catch(() => ({ set: {}, cambios: [], cdu: null }));
    const trozos = [];
    if (probable) trozos.push(`probable ${probable}`);
    if (obra.cambios.length) trozos.push(`obra: ${obra.cambios.map((c) => c.campo).join(', ')}`);
    if (obra.cdu && obra.cdu !== doc.cdu) trozos.push(`CDU de consenso ${obra.cdu}`);
    const resumen = trozos.length ? ` · ${trozos.join(' · ')}` : '';
    if (!aplicar) return { resumen };

    const set = {
        ...obra.set,
        ediciones_candidatas: candidatasParaGuardar(ambiguo.candidatos),
        ediciones_candidatas_fecha: new Date(),
    };
    if (probable) set.isbn_probable = probable;
    const cambiaDatos = obra.cambios.length > 0;
    if (cambiaDatos) {
        set.fecha_actualizacion = new Date();
        set.alertas_agente = [...(doc.alertas_agente || []),
            `Edición sin decidir: datos de la OBRA completados con las ${ambiguo.candidatos.length} ediciones candidatas (${obra.cambios.map((c) => c.campo).join(', ')}).`];
    }
    const antes = {};
    for (const k of Object.keys(obra.set).concat(probable ? ['isbn_probable'] : [])) antes[k] = doc[k] === undefined ? null : doc[k];
    const entrada = { fecha: new Date(), origen: 'candidatas', antes };
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set, $push: { deshacer: entrada } });
    if (cambiaDatos) {
        await indexarDoc(db, doc._id).catch(() => {});
        await regenerarSidecarsDoc(db, { ...doc, ...set }, carpeta).catch(() => {});
    }
    // CDU de CONSENSO (todas las candidatas con CDU de la BNE dicen la misma): es de la obra; se aplica por
    // prioridad, como la de la BNE (mueve la carpeta; no pisa una manual ni una impresa).
    if (obra.cdu) {
        const actualizado = await db.collection('biblioteca').findOne({ _id: doc._id });
        const rc = actualizado ? await aplicarCduConPrioridad(db, actualizado, obra.cdu, 'bne').catch(() => null) : null;
        if (rc?.aplicada) {
            await db.collection('biblioteca').updateOne(
                { _id: doc._id, 'deshacer.fecha': entrada.fecha },
                { $set: { 'deshacer.$.antes.cdu': doc.cdu ?? null, 'deshacer.$.antes.cdu_fuente': doc.cdu_fuente ?? null, 'deshacer.$.antes.ruta_base': doc.ruta_base ?? null } },
            ).catch(() => {});
        }
    }
    return { resumen };
}

async function guardarCandidatas(db, doc, candidatos) {
    const lista = candidatasParaGuardar(candidatos);
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { ediciones_candidatas: lista, ediciones_candidatas_fecha: new Date() } });
}

/**
 * ELEGIR LA EDICIÓN desde la ficha, entre las candidatas de una identificación ambigua.
 *   · { isbn }      → se aplica como ISBN MANUAL (autoritativo: lo has elegido tú) con el pivote habitual
 *                     (Fichero → BNE/APIs, solo rellena huecos) y se quitan las candidatas.
 *   · { ninguna }   → se quitan las candidatas y se marca `edicion_descartada` para no volver a proponerlas.
 * Solo se admite un ISBN que esté entre las candidatas (la ficha no es un editor de ISBN; para eso, «🔎 Extraer
 * ISBN» con ISBN manual).
 */
export async function elegirEdicion(db, id, { isbn = null, ninguna = false } = {}) {
    const _id = typeof id === 'string' ? new ObjectId(id) : id;
    const doc = await db.collection('biblioteca').findOne({ _id });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if (ninguna) {
        await db.collection('biblioteca').updateOne({ _id }, {
            $unset: { ediciones_candidatas: '', ediciones_candidatas_fecha: '', isbn_probable: '' },
            $set: { edicion_descartada: true },
            $push: { alertas_agente: 'Ediciones candidatas descartadas a mano: ninguna era la de este ejemplar.' },
        });
        return { ok: true, descartadas: true };
    }
    const elegido = validarISBN(isbn);
    const esCandidata = (doc.ediciones_candidatas || []).some((c) => variantesISBN(c.isbn).includes(elegido));
    if (!elegido || !esCandidata) return { ok: false, motivo: 'ese ISBN no está entre las ediciones candidatas' };
    const r = await reidentificarDoc(db, doc, { aplicar: true, usarApis: true, isbnManual: elegido });
    if (r.estado !== 'aplicado') return { ok: false, motivo: r.motivo || `no se pudo aplicar (${r.estado})` };
    // (reidentificarDoc ya quitó las candidatas al aplicar.)
    return { ok: true, isbn: elegido, resumen: r.resumen };
}

/**
 * MARCA «ya revisado» que comparten la campaña «Recuperar ISBN que faltan» y scripts/reidentificar-sin-isbn.js:
 * un libro sin ISBN que ya se miró (se encontrara o no) no vuelve a la cola — sin ella, cada pasada repetía
 * todos los que no se encontraron y la cola no bajaba nunca. Subir la VERSIÓN (cuando el motor mejore) vuelve a
 * poner en cola a todos los no encontrados; el script lo fuerza con --reintentar.
 */
export const VERSION_RECUPERAR_ISBN = 1;
export const CAMPO_MARCA_RECUPERAR_ISBN = 'campanas.recuperar-isbn';
// Intentos «con esperanza» (alguna fuente no respondió, error, tope de tiempo): se anotan y el libro vuelve a
// la cola pasadas unas horas. Tras MAX_INTENTOS ya no se espera más y se marca (un fichero que siempre falla no
// puede ocupar la cola para siempre).
export const CAMPO_INTENTOS_RECUPERAR_ISBN = 'recuperar_isbn_intentos';
export const CAMPO_ULTIMO_INTENTO_RECUPERAR_ISBN = 'recuperar_isbn_ultimo_intento';
const MAX_INTENTOS_RECUPERAR_ISBN = Number(process.env.RECUPERAR_ISBN_MAX_INTENTOS || 5);

/**
 * Anota el resultado de mirar un libro sin ISBN. Solo se MARCA como revisado (fuera de la cola) cuando no queda
 * esperanza: se identificó, quedó ambiguo (esperan tu elección) o TODAS las fuentes respondieron y ninguna lo
 * tiene. Si alguna no respondió (r.reintentable) o hubo error/tope (r == null), se anota el intento y vuelve.
 * @returns {Promise<'marcado'|'reintentar'>}
 */
export async function anotarRevisionIsbn(db, id, r) {
    const col = db.collection('biblioteca');
    const marcar = () => col.updateOne({ _id: id }, {
        $set: { [CAMPO_MARCA_RECUPERAR_ISBN]: VERSION_RECUPERAR_ISBN },
        $unset: { [CAMPO_INTENTOS_RECUPERAR_ISBN]: '', [CAMPO_ULTIMO_INTENTO_RECUPERAR_ISBN]: '' },
    });
    if (r && !r.reintentable) { await marcar(); return 'marcado'; }
    const act = await col.findOneAndUpdate({ _id: id },
        { $inc: { [CAMPO_INTENTOS_RECUPERAR_ISBN]: 1 }, $set: { [CAMPO_ULTIMO_INTENTO_RECUPERAR_ISBN]: new Date() } },
        { returnDocument: 'after', projection: { [CAMPO_INTENTOS_RECUPERAR_ISBN]: 1 } });
    const intentos = (act?.value ?? act)?.[CAMPO_INTENTOS_RECUPERAR_ISBN] || 0;
    if (intentos >= MAX_INTENTOS_RECUPERAR_ISBN) { await marcar(); return 'marcado'; }
    return 'reintentar';
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
 *   estado ∈ 'ya-tiene-isbn' | 'sin-fichero' | 'formato-no-soportado' | 'no-hallado' | 'ambiguo' | 'identificado' | 'aplicado'
 */
export async function reidentificarDoc(db, doc, { aplicar = false, usarApis = true, forzar = false, isbnManual = null, conIA = false } = {}) {
    const manual = isbnManual ? validarISBN(isbnManual) : null;
    // Por defecto (sin forzar ni ISBN manual) solo se actúa sobre los que NO tienen ISBN (ingesta/backfill/lote).
    if (doc.isbn && !forzar && !manual) return { estado: 'ya-tiene-isbn' };

    const carpeta = carpetaDeDoc(doc);
    const abs = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);

    // 1) RESOLVER EL ISBN según la fuente. Prioridad: manual > texto del fichero > barras/visión (con IA) >
    //    el que ya tiene (al forzar). Así «datos existentes», «reextraer páginas» y «manual» son elegibles.
    let isbn = null, via = '', isbnObra = null, ext = { isbn: null, titulo: null, autores: [], editorial: null };
    if (manual) { isbn = manual; via = 'manual'; }
    else {
        if (abs && tipoLibro(abs)) {
            // Con el número de tomo: la página de créditos de una obra lista el ISBN de cada tomo y el del conjunto.
            ext = await isbnDesdeArchivo(abs, { nombre: doc.nombre_archivo, tituloRef: doc.titulo, volumen: doc.volumen_numero ?? null });
            if (ext.isbn) { isbn = ext.isbn; via = 'fichero'; }
            if (ext.isbn_obra) isbnObra = ext.isbn_obra;   // el del conjunto va aparte: nunca es el ISBN del libro
        }
        if (!isbn && conIA) {
            // (a) EAN de cubierta/contracubierta: zxing local sin coste y, si falla, VISIÓN. Solo PDF con fichero.
            if (abs && tipoLibro(abs) === 'pdf') {
                const numPag = doc.paginas || (await numeroPaginasPdf(abs).catch(() => 0)) || 3;
                const bc = await leerCodigoBarrasPorVision(abs, numPag).catch(() => null);
                const v = bc?.isbn ? validarISBN(bc.isbn) : null;
                if (v) { isbn = v; via = 'barras/visión'; }
            }
            // (b) ISBN IMPRESO del CIP (página de créditos) por VISIÓN, en las imágenes YA extraídas (y, si es
            //     PDF y no salió, en las primeras páginas rasterizadas). En un escaneo el ISBN es TEXTO, no un
            //     código de barras → este paso lo capta. Distingue el ISBN del VOLUMEN (este ejemplar, p. ej. la
            //     tapa dura) del de la OBRA/SET (→ isbn_obra). Era el hueco: ni el texto ni el EAN lo veían.
            if (!isbn) {
                const cip = await isbnPorCIP(doc, abs);
                if (cip.volumen) { isbn = cip.volumen; via = 'cip/visión'; }
                if (cip.obra) isbnObra = cip.obra;
            }
        }
        if (!isbn && forzar && doc.isbn) { isbn = validarISBN(doc.isbn) || doc.isbn; via = 'existente'; }
    }

    // (c) EL FICHERO NO LO TRAE (el ripeo se lo quitó): identificar la EDICIÓN por autoridad, con lo que sí
    //     sabemos —título, autor, editorial, colección, año, idioma—. Estricto: solo se acepta una edición que
    //     case título + autor Y confirme editorial/idioma/año; si hay varias posibles no se elige ninguna.
    let ambiguo = null;
    let provisional = null;   // varias ediciones de la misma editorial: se asigna una, marcada como provisional
    let dudoso = null;        // una sola edición posible que nada confirma: se asigna, marcada como dudosa
    let editorialActual = null;   // nombre de la editorial que tenía el documento
    let edicion = null;       // la edición elegida por autoridad (para aprender la editorial de su colección)
    // ¿QUEDA ESPERANZA si no se encuentra? Sí, si alguna fuente no respondió, si la identificación falló por un
    // error, o si no se consultaron las fuentes en línea (--sin-apis): otro día puede salir.
    let caidas = usarApis ? [] : ['apis (no consultadas)'];
    // Si ya se te propusieron ediciones y dijiste «ninguna», no se vuelve a proponer (salvo forzando).
    // Identificar la EDICIÓN por autoridad es solo para LIBROS: una revista, un cómic, un audiolibro o un programa
    // no tienen «edición» en los catálogos de libros (medido: números de revista recibieron ISBN de libros).
    let identificable = doc.tipo_recurso === 'libro' && !['comic', 'audiolibro', 'software'].includes(doc.naturaleza);
    // Varios documentos con el MISMO TÍTULO en la MISMA carpeta («Ghost Stories [1].pdf», «[2].pdf», «[3].pdf» de
    // una colección transmedia: el libro, sus actividades, sus tests…): no se sabe cuál es el libro, así que
    // ninguno recibe su ISBN por autoridad (medido el 29-sep con Oxford Bookworms Library).
    if (identificable && doc.ruta_base) {
        const hermano = await db.collection('biblioteca').findOne(
            { ruta_base: doc.ruta_base, titulo: doc.titulo, _id: { $ne: doc._id } }, { projection: { _id: 1 } });
        if (hermano) identificable = false;
    }
    if (!isbn && identificable && (!doc.edicion_descartada || forzar)) {
        const pruebas = await datosDeAutoridad(db, doc);
        editorialActual = pruebas.editorial;
        // Si el documento no guardó sus traductores (ingestas antiguas), se leen del PROPIO fichero: el OPF del
        // EPUB (dc:contributor opf:role="trl") o, si no, la página de créditos («Traducción: …», ePubLibre).
        if (!pruebas.traductores.length && abs && /\.epub$/i.test(abs)) pruebas.traductores = await traductoresDeEpub(abs);
        if (!pruebas.traductores.length) pruebas.traductores = traductoresDelTitulo(doc.titulo);   // «(trad. Ángeles Caso)»
        const r = await identificarEdicion(pruebas, { online: usarApis, conIA }).catch(() => null);
        if (!r) caidas.push('error en la identificación');
        else caidas.push(...(r.fuentesCaidas || []));
        if (r?.estado === 'unico') { isbn = r.isbn; via = `autoridad/${r.via}`; edicion = r.elegido; }
        else if (r?.estado === 'provisional') {
            isbn = r.isbn; via = `autoridad/${r.via}, PROVISIONAL`; provisional = r;
            // Sin pruebas (la más probable «a ciegas») la edición no está confirmada: no impone su editorial.
            if (r.confirmada !== false) edicion = r.elegido;
        }
        else if (r?.estado === 'dudoso') { isbn = r.isbn; via = `autoridad/${r.via}, DUDOSO`; dudoso = r; }
        else if (r?.estado === 'ambiguo') ambiguo = r;
    }
    // ¿Ese ISBN ya lo tiene OTRO documento con OTRO título? (los 4 tomos de «Una danza para la música del tiempo»
    // —Primavera, Verano…— recibían el ISBN del primero). Entonces no se asigna: quedan las candidatas para elegir.
    // (Mismo título = otra versión o formato del mismo libro: eso sí vale; lo reúne la fusión de versiones.)
    if (isbn && via.startsWith('autoridad/')) {
        const otro = await db.collection('biblioteca').findOne(
            { isbn: { $in: variantesISBN(isbn) }, _id: { $ne: doc._id } }, { projection: { titulo: 1 } });
        if (otro && !mismoTituloLibro(otro.titulo, doc.titulo)) {
            const candidatos = (provisional?.candidatos || (edicion ? [edicion] : []));
            ambiguo = { motivo: `el ISBN ${isbn} ya es de «${otro.titulo}» (${otro._id}), otro título: no se asigna`, candidatos, colision: true };
            isbn = null; via = ''; provisional = null; dudoso = null; edicion = null;
        }
    }
    const reintentable = caidas.length > 0;
    const porQue = reintentable ? ` (no respondió: ${caidas.join(', ')} → se reintentará)` : '';

    if (!isbn) {
        // Sin ISBN propio pero con el del CONJUNTO (los créditos de un tomo lo declaran): se anota como isbn_obra,
        // que es lo que reúne los tomos. No es el ISBN del libro.
        if (isbnObra && !doc.isbn_obra && aplicar) {
            await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { isbn_obra: isbnObra } }).catch(() => {});
        }
        if (ambiguo) {
            // Varias ediciones posibles: NO se elige ninguna. Se guardan como candidatas para que elijas tú en la
            // ficha («¿Cuál es tu edición?»). No se toca nada más del documento (ni fecha_actualizacion: no hay
            // cambio de datos, así que no hace falta regenerar sus sidecars).
            // Además (regla del usuario, 30-sep): la MÁS PROBABLE queda aparte como `isbn_probable` (no es el ISBN
            // del documento: no se usa como pivote hasta que se confirme) y las candidatas aportan los datos de la
            // OBRA que falten (sinopsis, lengua original, materias, CDU si coinciden). Nada de la edición.
            // (En una COLISIÓN —el ISBN era de otro libro, p. ej. otro tomo— las candidatas son ediciones de ESE otro
            // libro: sus datos no valen aquí. Solo se guardan para elegir.)
            let obra = { resumen: '' };
            if (ambiguo.candidatos?.length && ambiguo.colision) {
                if (aplicar) await guardarCandidatas(db, doc, ambiguo.candidatos);
            } else if (ambiguo.candidatos?.length) {
                obra = await completarConCandidatas(db, doc, ambiguo, { aplicar, usarApis, carpeta });
            }
            return { estado: 'ambiguo', reintentable, motivo: ambiguo.motivo + obra.resumen + porQue, candidatos: ambiguo.candidatos };
        }
        if (!abs && !manual) return { estado: 'sin-fichero', reintentable, motivo: 'no se encontró el fichero del documento en su carpeta' + porQue };
        if (abs && !tipoLibro(abs) && !conIA) return { estado: 'formato-no-soportado', reintentable, motivo: `${path.extname(abs)} no da un ISBN de texto (marca «con IA» para intentar el código de barras)` + porQue };
        return { estado: 'no-hallado', reintentable, motivo: 'no se pudo obtener un ISBN (ni del texto, ni por barras/visión, ni por autoridad)' + porQue };
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

    // ¿El ISBN que declara el FICHERO ya lo tiene otro documento con OTRO título, y la autoridad tampoco dice que
    // sea el de este? Es el de un conjunto o una serie que los créditos no etiquetan (medido el 30-sep: 196
    // documentos —tomos de enciclopedias, títulos de «Routledge Library Editions»— compartiendo ISBN). No se asigna.
    // Si la autoridad SÍ confirma el título, el equivocado es el otro documento: se asigna y sigue.
    if (!manual && via === 'fichero' && !mismoISBNGuardado(doc.isbn, isbn)) {
        const otros = await db.collection('biblioteca').find(
            { $or: [{ isbn: { $in: isbnVar } }, { isbn_obra: { $in: isbnVar } }], _id: { $ne: doc._id } },
            { projection: { titulo: 1, isbn: 1, obra: 1, volumen_numero: 1 } }).limit(20).toArray();
        // (a) Lo tiene OTRO TOMO de la misma obra (como ISBN o como ISBN de la obra): es el del conjunto. Un tomo se
        //     identifica por su obra y su número (misma regla que la ingesta); el del conjunto va a isbn_obra.
        const otroTomo = doc.obra && otros.find((o) => String(o.obra || '') === String(doc.obra)
            && (o.volumen_numero !== doc.volumen_numero || !mismoTituloLibro(o.titulo, doc.titulo)));
        // (b) Lo tiene un documento de otro título, y la autoridad no dice que sea el de este.
        const deOtroTitulo = otros.find((o) => o.isbn && !mismoTituloLibro(o.titulo, doc.titulo));
        const confirmado = tituloConfirmaDoc(datos.titulo, doc);
        if (otroTomo || (deOtroTitulo && !confirmado)) {
            if (aplicar && otroTomo && !doc.isbn_obra) {
                await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { isbn_obra: isbnObra || isbn } }).catch(() => {});
            }
            const quien = otroTomo || deOtroTitulo;
            return {
                estado: 'ambiguo', reintentable: false, candidatos: [],
                motivo: otroTomo
                    ? `el ISBN ${isbn} que trae el fichero es el del conjunto (lo tiene otro tomo de la obra: «${quien.titulo}»); queda como ISBN de la obra, no del tomo`
                    : `el ISBN ${isbn} que trae el fichero ya es de «${quien.titulo}» (${quien._id}), otro título, y ninguna autoridad lo confirma para este: parece el de un conjunto o una serie; no se asigna`,
            };
        }
    }

    const set = {};
    const nombres = {}; // log legible
    if (isbn && String(doc.isbn || '') !== isbn) { set.isbn = isbn; if (manual) nombres.isbn = isbn; }
    // ISBN de la OBRA/SET (multivolumen): captado del CIP; pivote para agrupar los tomos (obras.isbn_obra). Solo
    // si falta y es distinto del del volumen. No crea la obra aquí (eso lo hace el flujo de obras/Conformador).
    if (isbnObra && isbnObra !== isbn && !doc.isbn_obra) { set.isbn_obra = isbnObra; nombres.isbn_obra = isbnObra; }

    // TÍTULO (cotejo): se sustituye por el de la AUTORIDAD si el actual es DÉBIL o ARTEFACTO, o —al FORZAR— si
    // simplemente DIFIERE; nunca si DEGRADARÍA (el actual ya es más completo). El de la autoridad (Fichero/APIs
    // por ISBN) va primero; el del propio fichero solo es fiable en EPUB/MOBI (en PDF ext.titulo es null).
    // Último recurso para un título-artefacto que ninguna autoridad resuelve: el tramo del título de un nombre de
    // fichero de lote editorial («<ISBN>.<Editorial>.<Título>.<Autor>.<fecha>»).
    const tituloMejor = datos.titulo || ext.titulo
        || (esTituloArtefacto(doc.titulo) ? tituloDeNombreDeLote(doc.nombre_archivo || doc.titulo) : null);
    if (tituloMejor) {
        const actual = String(doc.titulo || '');
        const malActual = tituloDebil(doc) || esTituloArtefacto(actual);
        if ((malActual || forzar) && normLite(actual) !== normLite(tituloMejor) && noDegrada(actual, tituloMejor)
            && !soloAnadeColetilla(actual, tituloMejor)) {
            set.titulo = tituloMejor; nombres.titulo = tituloMejor;
        }
    }
    // Autores: si el doc no tiene ninguno, resuélvelos del fichero primero, si no de la autoridad.
    const autoresNom = (ext.autores && ext.autores.length ? ext.autores : datos.autores) || [];
    // En SECO no se resuelven nombres a referencias: resolverlos CREA autores/editoriales en la base, y una
    // prueba no debe dejar rastro. Se anota el nombre para el informe; se resuelve solo al aplicar.
    if (!(doc.autores?.length) && autoresNom.length) { set.autores = aplicar ? await resolverAutores(db, autoresNom) : autoresNom; nombres.autores = autoresNom; }
    // Editorial: rellena si falta (del fichero o de la autoridad).
    // Editorial para un hueco: la primera REAL (nunca un maquetador como «ePubLibre», que el OPF del EPUB declara
    // como dc:publisher: medido, se colaba en libros sin editorial).
    let editorialNom = [ext.editorial, datos.editorial, edicion?.editorial].find((e) => e && !esEditorialFalsa(e)) || null;
    // Contrastada con el PREFIJO del ISBN: si la biblioteca ya sabe de quién es (84-7702 = Valdemar), manda eso
    // sobre lo que diga una API («Rama Publishing Company»), y rellena el hueco aunque ninguna fuente lo diga.
    if (!doc.editorial && isbn) {
        const coherente = await editorialCoherenteConISBN(db, isbn, editorialNom, mismaEditorial, { excluirId: doc._id });
        editorialNom = coherente.nombre;
    }
    if (!doc.editorial && editorialNom) { set.editorial = aplicar ? await resolverEditorial(db, editorialNom) : editorialNom; nombres.editorial = editorialNom; }
    // EDICIÓN CONFIRMADA — la que ELEGISTE en la ficha (ISBN manual) o la única/provisional por autoridad —: su
    // editorial manda. El ISBN ES esa edición, y un registro con el ISBN de La Factoría y la editorial «Gamon» o
    // «Salamandra» sería incoherente (el campo editorial pudo llegar de una API y estar mal). Se sustituye y se anota
    // la anterior. En una DUDOSA no: ahí lo dudoso es el ISBN, y la editorial del registro puede ser la buena.
    const candidataElegida = manual ? (doc.ediciones_candidatas || []).find((c) => variantesISBN(c.isbn).includes(manual)) : null;
    let edEdicionConfirmada = [
        (edicion && !dudoso) ? edicion.editorial : null,
        manual ? datos.editorial : null,          // la autoridad por ESE ISBN
        candidataElegida?.editorial,              // o la de la candidata que elegiste
    ].find((e) => e && !esEditorialFalsa(e)) || null;
    // Tampoco se impone una editorial que contradiga el prefijo del ISBN (Distribooks sobre Hodder, 30-sep).
    if (doc.editorial && edEdicionConfirmada && isbn) {
        const coherente = await editorialCoherenteConISBN(db, isbn, edEdicionConfirmada, mismaEditorial, { excluirId: doc._id });
        edEdicionConfirmada = coherente.nombre;
    }
    if (doc.editorial && edEdicionConfirmada && editorialActual === null) {
        const ed = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } }).catch(() => null);
        editorialActual = ed?.nombre || '';
    }
    if (doc.editorial && edEdicionConfirmada && editorialActual
        && !mismaEditorial(editorialActual, edEdicionConfirmada)) {
        set.editorial = aplicar ? await resolverEditorial(db, edEdicionConfirmada) : edEdicionConfirmada;
        nombres.editorial = `${edEdicionConfirmada} (antes «${editorialActual}»)`;
    }
    // HUECOS: TODO lo que la autoridad aporte y no tengamos (fecha, páginas, medidas, Dewey/LCC, traductor,
    // materias, lengua original, CDU de autoridad…), con la función común. Nunca sobrescribe.
    // Los COLABORADORES (traductor, ilustrador…) son de la EDICIÓN: con una provisional o dudosa no se dan por buenos
    // (regla del usuario, 30-sep). Llegarán cuando la edición se confirme (la eliges tú en la ficha).
    const huecos = await huecosDesdeAutoridad(db, doc, datos, { aplicar, conContribuciones: !provisional && !dudoso });
    Object.assign(set, huecos.set);
    for (const c of huecos.cambios) if (c.campo === 'contribuciones' || c.campo === 'cdu_autoridad') nombres[c.campo] = c.a;
    // Colección de la edición («Colección gótica», nº 112): solo como dato si el doc no está ya en una. No se
    // crea ni se asigna la colección aquí (eso reorganiza el catálogo); queda anotada para verla y agruparla.
    if (datos.coleccion_nombre && !doc.coleccion && !doc.coleccion_nombre) {
        set.coleccion_nombre = datos.coleccion_nombre;
        if (datos.coleccion_numero && !doc.coleccion_numero) set.coleccion_numero = String(datos.coleccion_numero);
    }

    if (Object.keys(set).length === 0) return { estado: 'no-hallado', isbn, via, motivo: 'ISBN resuelto pero la autoridad no aportó nada nuevo' };

    const resumen = `isbn=${isbn}${via ? ` (${via})` : ''}`
        + (Object.keys(nombres).length ? ' · ' + Object.entries(nombres).map(([k, v]) => `${k}="${Array.isArray(v) ? v.join(', ') : v}"`).join(' · ') : '');

    if (!aplicar) return { estado: 'identificado', provisional: !!provisional, dudoso: !!dudoso, isbn, via, titulo: set.titulo || doc.titulo, resumen, set };

    // Si se corrige el título, des-sellar re-clasificar-cdu para que el Conformador reclasifique y MUEVA la
    // carpeta con el título ya bueno (igual que re-enriquecer-degradados).
    if (set.titulo) { set['mantenimiento.re-clasificar-cdu'] = 0; set.mantenimiento_firma = 'pendiente-reidentificado'; }
    set.fecha_actualizacion = new Date();
    set.alertas_agente = [...(doc.alertas_agente || []), provisional
        ? `ISBN PROVISIONAL ${isbn}: ${provisional.motivo}. Registro completado con él; si tu ejemplar es otra de las ediciones, elígela en la ficha.`
        : dudoso ? `ISBN DUDOSO ${isbn}: ${dudoso.motivo}. Registro completado con él; si no es tu edición, corrige el ISBN en la ficha.`
        : `ISBN ${via === 'manual' ? 'manual' : 'recuperado (' + via + ')'} + cotejo por ISBN (Fichero/APIs${conIA ? ', con IA' : ''}).`];
    // PROVISIONAL: se conservan las candidatas (la ficha ofrece confirmar o cambiar). Si no, sobran: el ISBN ya
    // está resuelto (y si era provisional, deja de serlo).
    let quitar = {};
    if (dudoso) set.isbn_dudoso = true;
    if (provisional) {
        set.isbn_provisional = true;
        set.ediciones_candidatas = candidatasParaGuardar(provisional.candidatos);
        set.ediciones_candidatas_fecha = new Date();
    } else if (doc.ediciones_candidatas || doc.isbn_provisional || (doc.isbn_dudoso && !dudoso)) {
        quitar = { $unset: { ediciones_candidatas: '', ediciones_candidatas_fecha: '', isbn_provisional: '', ...(dudoso ? {} : { isbn_dudoso: '' }) } };
    }
    // Con el ISBN resuelto, el «probable» sobra.
    if (doc.isbn_probable) quitar = { $unset: { ...(quitar.$unset || {}), isbn_probable: '' } };
    // DIARIO PARA DESHACER: el valor ANTERIOR de todo lo que se va a cambiar (null = el campo estaba vacío). Con él,
    // scripts/deshacer-reidentificacion.js devuelve el documento a como estaba (incluida la CDU y la carpeta, abajo).
    const INTERNOS = new Set(['alertas_agente', 'fecha_actualizacion', 'mantenimiento_firma', 'mantenimiento.re-clasificar-cdu']);
    const antes = {};
    for (const k of [...Object.keys(set), ...Object.keys(quitar.$unset || {})]) {
        if (INTERNOS.has(k)) continue;
        antes[k] = doc[k] === undefined ? null : doc[k];
    }
    const entradaDiario = { fecha: new Date(), origen: 'reidentificar', isbn, via, antes };
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set, ...quitar, $push: { deshacer: entradaDiario } });
    // Índice FTS + sidecars (best-effort: nunca tumban la operación).
    await indexarDoc(db, doc._id).catch(() => {});
    await regenerarSidecarsDoc(db, { ...doc, ...set }, carpeta).catch(() => {});
    // APRENDER: la editorial de esta edición queda como INDICIO en la colección del libro («Solaris ficción» →
    // La Factoría de Ideas), para las siguientes identificaciones de libros de la misma colección.
    // Solo con la edición SEGURA (ISBN del propio fichero, elegido por ti, o identificado con pruebas): una
    // provisional «a ciegas» o una dudosa ensuciarían los indicios.
    const edicionSegura = !dudoso && (!provisional || edicion) && (via === 'fichero' || manual || edicion);
    const edEdicion = [datos.editorial, edicion?.editorial].find((e) => e && !esEditorialFalsa(e));
    if (edicionSegura && edEdicion && (doc.coleccion || doc.coleccion_nombre)) await anotarEditorialDeColeccion(db, doc, edEdicion);
    // CDU de la BNE para esta edición: se APLICA si tiene prioridad sobre la actual (la deducida por equivalencia o
    // IA), MOVIENDO la carpeta. No toca una CDU manual ni una impresa en el libro, ni tomos de obra.
    let cduAplicada = null;
    if (datos.cdu && datos.cdu_fuente === 'bne' && cduDeAutoridadFiable({ ...doc, ...set }, datos)) {
        const actualizado = await db.collection('biblioteca').findOne({ _id: doc._id });
        const rc = actualizado ? await aplicarCduConPrioridad(db, actualizado, datos.cdu, 'bne').catch(() => null) : null;
        if (rc?.aplicada) {
            cduAplicada = `${rc.de || '∅'} → ${rc.a}`;
            // Al diario: la CDU y la carpeta de ANTES (deshacer las devuelve, moviendo la carpeta).
            await db.collection('biblioteca').updateOne(
                { _id: doc._id, 'deshacer.fecha': entradaDiario.fecha },
                { $set: { 'deshacer.$.antes.cdu': doc.cdu ?? null, 'deshacer.$.antes.cdu_fuente': doc.cdu_fuente ?? null, 'deshacer.$.antes.ruta_base': doc.ruta_base ?? null } },
            ).catch(() => {});
        }
    }
    return { estado: 'aplicado', provisional: !!provisional, dudoso: !!dudoso, isbn, via, titulo: set.titulo || doc.titulo, resumen: resumen + (cduAplicada ? ` · CDU ${cduAplicada} (BNE)` : ''), set };
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
    // 0) CDU de AUTORIDAD: la BNE cataloga directamente en CDU, así que es la mejor fuente — ni crosswalk ni IA.
    //    La guardada por «Extraer ISBN» (cdu_autoridad), la del Fichero (volcado BNE) o la del catálogo en línea.
    let dewey = doc.dewey || null, lcc = doc.lcc || null;
    let cduAutoridad = null;
    if (doc.isbn) {
        // El registro de la BNE para este ISBN (Fichero → catálogo en línea): su CDU, y su título para comprobar
        // que el ISBN es de ESTE libro — si no casa, el ISBN es probablemente de otro y su CDU no vale aquí.
        const reg = await buscarAutoridadPorISBN(variantesISBN(doc.isbn)).catch(() => null);
        if (reg) {
            dewey = dewey || reg.dewey || null;
            lcc = lcc || reg.lcc || null;
            if (reg.cdu && cduDeAutoridadFiable(doc, reg)) cduAutoridad = reg.cdu;
        }
    } else if (doc.cdu_autoridad) {
        cduAutoridad = doc.cdu_autoridad;   // sin ISBN que contrastar: la guardada al identificar la edición
    }
    let cdu = cduAutoridad;
    if (!cdu) {
        if (!dewey && !lcc && !conIA) return { estado: 'cdu-sin-codigos', motivo: 'sin Dewey/LCC ni CDU de autoridad (marca «con IA» para investigar por título/autor)' };
        // Nombre del primer autor (ayuda a la IA con la literatura: se clasifica por la tradición del autor).
        let autorNom = null;
        if (doc.autores?.length) { const a = await db.collection('autores').findOne({ _id: doc.autores[0] }, { projection: { nombre: 1 } }).catch(() => null); autorNom = a?.nombre || null; }
        const r = await resolverCDU({ dewey, lcc, titulo: doc.titulo, autor: autorNom, sinopsis: doc.sinopsis, categorias: doc.palabras_clave || [], permitirIA: conIA }).catch(() => null);
        cdu = r && (typeof r === 'string' ? r : r.cdu);
    }
    if (!cdu || cdu === '000') return { estado: 'cdu-no-hallada', motivo: conIA ? 'ni el crosswalk ni la IA dieron una CDU' : 'el crosswalk determinista no la resuelve (marca «con IA» para investigar)' };
    const actual = String(doc.cdu || '');
    const vacia = !actual || actual === '000' || actual === '0';
    // La de la BNE se aplica por PRIORIDAD (sustituye a la del clasificador aunque no esté vacía); la deducida
    // (equivalencia o IA), solo sobre una vacía o forzando — y nunca sobre una de más rango (prioridad-cdu.js).
    const fuenteNueva = cduAutoridad ? 'bne' : 'clasificador';
    if (!vacia && !forzar && fuenteNueva !== 'bne') return { estado: 'cdu-ya', cdu: actual, motivo: 'ya tiene CDU (marca «forzar» para reemplazarla)' };
    if (actual === cdu) return { estado: 'cdu-igual', cdu };
    if (!puedeSustituirCdu(doc, cdu, fuenteNueva)) return { estado: 'cdu-ya', cdu: actual, motivo: `la CDU actual (${fuenteCduDoc(doc)}) tiene prioridad sobre ${cdu} (${fuenteNueva})` };
    if (!aplicar) return { estado: 'cdu-identificada', cdu, de: actual || '000', motivo: `${actual || '000'} → ${cdu} (${fuenteNueva})` };
    // Mueve la carpeta al árbol de la nueva CDU + sidecars + índice, SIN marcarla manual: queda con su fuente, y
    // una de más rango (impresa en el libro, la que pongas tú) podrá sustituirla después.
    const r = await aplicarCduConPrioridad(db, doc, cdu, fuenteNueva);
    if (r.aplicada) {
        const extra = {};
        if (dewey && !doc.dewey) extra.dewey = dewey;
        if (lcc && !doc.lcc) extra.lcc = lcc;
        if (cduAutoridad) extra.cdu_autoridad = cduAutoridad;
        if (Object.keys(extra).length) await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: extra });
    }
    return r.aplicada ? { estado: 'cdu-aplicada', cdu, de: actual || '000' } : { estado: 'cdu-ya', cdu: actual, motivo: r.motivo };
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
    trabajo = { en_curso: true, total: lista.length, hechos: 0, recuperados: 0, sin_isbn: 0, sin_fichero: 0, ambiguos: 0, cdu: 0, otros: 0, titulo: '', cancelar: false, ts: new Date().toISOString() };
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
                        else if (r.estado === 'ambiguo') trabajo.ambiguos++;   // varias ediciones: decide una persona
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
