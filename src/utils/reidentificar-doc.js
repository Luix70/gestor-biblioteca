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
import { carpetaDeDoc, archivoOriginal } from '../mantenimiento/util-mantenimiento.js';
import { isbnDesdeArchivo, tipoLibro } from './isbn-archivo.js';
import { variantesISBN } from './identificadores.js';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
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

/**
 * Re-identifica UN documento sin ISBN: extrae el ISBN de su fichero y rellena huecos por el Fichero/APIs.
 * @param {object} opts { aplicar=false, usarApis=true }  · aplicar=false → dry-run (calcula pero no escribe).
 * @returns {Promise<{estado, isbn?, titulo?, resumen?, motivo?, set?}>}
 *   estado ∈ 'ya-tiene-isbn' | 'sin-fichero' | 'formato-no-soportado' | 'no-hallado' | 'identificado' | 'aplicado'
 */
export async function reidentificarDoc(db, doc, { aplicar = false, usarApis = true } = {}) {
    if (doc.isbn) return { estado: 'ya-tiene-isbn' };
    const carpeta = carpetaDeDoc(doc);
    const abs = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);
    if (!abs) return { estado: 'sin-fichero', motivo: 'no se encontró el fichero del documento en su carpeta' };
    if (!tipoLibro(abs)) return { estado: 'formato-no-soportado', motivo: `${path.extname(abs)} no da un ISBN de texto` };

    const ext = await isbnDesdeArchivo(abs, { nombre: doc.nombre_archivo, tituloRef: doc.titulo });
    if (!ext.isbn) return { estado: 'no-hallado', motivo: 'el fichero no declara ISBN (ni corrobora un candidato del cuerpo)' };

    // Pivote por ISBN: Fichero local + APIs gratuitas (sin IA por defecto). incluirCdu:false → no se toca la CDU
    // aquí (el miembro vive en la carpeta de la colección; si mejora el título, el Conformador re-clasifica y
    // MUEVE la carpeta al des-sellar re-clasificar-cdu).
    const isbnVar = variantesISBN(ext.isbn);
    let datos = {};
    if (usarApis) {
        datos = await buscarMetadatosExternos(doc.titulo || ext.titulo || '', '', null, {
            incluirSinopsis: true, incluirCdu: false, isbnsArchivo: isbnVar, idioma: doc.idioma || null, sinIA: true,
        }).catch(() => ({}));
    }

    const debil = tituloDebil(doc);
    const set = { isbn: ext.isbn };
    const nombres = {}; // log legible

    // Título: si el actual es débil, prefiere el de la AUTORIDAD (Fichero/APIs por ISBN, limpio y normalizado) y,
    // si no la hay, el del propio fichero (fiable solo en EPUB/MOBI; en PDF ext.titulo es null a propósito).
    const tituloMejor = datos.titulo || ext.titulo || null;
    if (debil && tituloMejor) { set.titulo = tituloMejor; nombres.titulo = tituloMejor; }
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

    const resumen = Object.keys(nombres).length
        ? `isbn=${ext.isbn} · ` + Object.entries(nombres).map(([k, v]) => `${k}="${Array.isArray(v) ? v.join(', ') : v}"`).join(' · ')
        : `isbn=${ext.isbn}`;

    if (!aplicar) return { estado: 'identificado', isbn: ext.isbn, titulo: set.titulo || doc.titulo, resumen, set };

    // Si se corrige el título, des-sellar re-clasificar-cdu para que el Conformador reclasifique y MUEVA la
    // carpeta con el título ya bueno (igual que re-enriquecer-degradados).
    if (set.titulo) { set['mantenimiento.re-clasificar-cdu'] = 0; set.mantenimiento_firma = 'pendiente-reidentificado'; }
    set.fecha_actualizacion = new Date();
    set.alertas_agente = [...(doc.alertas_agente || []), 'ISBN recuperado del fichero + pivote al Fichero/APIs (re-identificación).'];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
    // Índice FTS + sidecars (best-effort: nunca tumban la operación).
    await indexarDoc(db, doc._id).catch(() => {});
    await regenerarSidecarsDoc(db, { ...doc, ...set }, carpeta).catch(() => {});
    return { estado: 'aplicado', isbn: ext.isbn, titulo: set.titulo || doc.titulo, resumen, set };
}

// ── LOTE en 2º plano (acción de la Búsqueda sobre una selección) ─────────────────────────────────────────
// Mismo patrón que reextraer-imagenes: lanzar / estado / cancelar + sondeo del front-end. Best-effort: nunca
// tumba el servidor. Aplica SIEMPRE (la acción del panel es para arreglar de verdad, no dry-run).
let trabajo = { en_curso: false, total: 0, hechos: 0, recuperados: 0, sin_isbn: 0, sin_fichero: 0, otros: 0, titulo: '', cancelar: false, ts: null };
export function estadoReidentificacion() { return { ...trabajo }; }
export function cancelarReidentificacion() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

export function lanzarReidentificacion({ ids } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una re-identificación en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };
    trabajo = { en_curso: true, total: lista.length, hechos: 0, recuperados: 0, sin_isbn: 0, sin_fichero: 0, otros: 0, titulo: '', cancelar: false, ts: new Date().toISOString() };
    (async () => {
        try {
            const db = await conectarDB();
            for (const _id of lista) {
                if (trabajo.cancelar) break;
                const doc = await db.collection('biblioteca').findOne({ _id }).catch(() => null);
                trabajo.titulo = doc?.titulo || '';
                if (doc) {
                    try {
                        const r = await reidentificarDoc(db, doc, { aplicar: true, usarApis: true });
                        if (r.estado === 'aplicado') trabajo.recuperados++;
                        else if (r.estado === 'no-hallado') trabajo.sin_isbn++;
                        else if (r.estado === 'sin-fichero') trabajo.sin_fichero++;
                        else trabajo.otros++;   // ya-tiene-isbn / formato-no-soportado
                    } catch { trabajo.otros++; }
                } else trabajo.otros++;
                trabajo.hechos++;
            }
        } catch { /* el lote nunca tumba el servidor */ }
        finally { trabajo.en_curso = false; }
    })();
    return { ok: true, total: lista.length };
}
