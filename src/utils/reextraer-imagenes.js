/**
 * RE-EXTRAER las imágenes de catalogación de un documento desde su PROPIO fichero (acción de la Búsqueda sobre
 * la selección). Vuelve al fichero original y regenera la PORTADA y —si se pide— las imágenes de catalogación
 * (5 páginas frontales + contraportada, con salto de páginas en blanco), REEMPLAZANDO las actuales (equivocadas
 * o compartidas). Reutiliza toda la extracción de la ingesta (rasterizarFrontalesPdf, cubierta EPUB, muestra
 * DjVu, páginas de cómic). ANTI-PÉRDIDA: conserva las imágenes AÑADIDAS/EDITADAS A MANO (origen 'manual'), y los
 * ficheros de imagen viejos quedan en disco (no se borran; escribirImagen crea ficheros nuevos).
 *
 * Trabajo en 2º plano con progreso + cancelación (mismo patrón que el borrado en lote).
 */
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, webDeDoc, archivoOriginal, numeroPaginasPdf, escribirImagen } from '../mantenimiento/util-mantenimiento.js';
import { detectarTipo } from '../orquestador.js';
import { rasterizarFrontalesPdf } from './ocr-pdf.js';
import { extraerMetadatosEpub } from './lector-epub.js';
import { paginasMuestraDjvu } from './djvu.js';
import { leerPaginaComic } from './comic-paginas.js';
import { indexarDoc } from './indice-busqueda.js';

/**
 * Re-extrae las imágenes de UN documento. `solo5mas1=true` → portada + páginas de catalogación (5+1); false →
 * solo la portada. Devuelve { ok, n } o { ok:false, motivo }. Best-effort (nunca lanza al llamador del lote).
 */
export async function reextraerImagenesDoc(db, doc, { solo5mas1 = true } = {}) {
    const carpeta = carpetaDeDoc(doc);
    // Se pasa el nombre_archivo del propio documento: si la carpeta la comparten varios libros (colección mal
    // clasificada), sin esto se sacaría la portada del fichero equivocado. (Ver archivoOriginal.)
    const original = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);
    if (!original) return { ok: false, motivo: 'sin fichero original en su carpeta' };
    const tipo = detectarTipo(original);

    let buffers = [];
    try {
        if (tipo === 'pdf') {
            const nPag = doc.paginas || (await numeroPaginasPdf(original).catch(() => 0)) || 2;
            const renders = await rasterizarFrontalesPdf(original, nPag);   // portada + frontales + contraportada (salta blancos)
            buffers = solo5mas1 ? renders.map((r) => r.buffer) : renders.slice(0, 1).map((r) => r.buffer);
        } else if (tipo === 'djvu') {
            const m = await paginasMuestraDjvu(original).catch(() => null);
            const b64 = solo5mas1 ? (m?.muestra || []).map((x) => x.base64) : [m?.cubierta_base64];
            buffers = b64.filter(Boolean).map((s) => Buffer.from(s, 'base64'));
        } else if (tipo === 'epub') {
            const cub = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64;
            if (cub) buffers = [Buffer.from(cub, 'base64')];
        } else if (tipo === 'comic') {
            const n = solo5mas1 ? 5 : 1;
            for (let i = 0; i < n; i++) { const p = await leerPaginaComic(original, i).catch(() => null); if (p?.buffer) buffers.push(p.buffer); else break; }
        }
    } catch (e) { return { ok: false, motivo: e.message }; }

    buffers = buffers.filter((b) => Buffer.isBuffer(b) && b.length);
    if (!buffers.length) return { ok: false, motivo: `no se pudo extraer ninguna imagen (${tipo})` };

    // Conserva las imágenes MANUALES (añadidas/editadas por el usuario): no se pierden. Las AUTO se reemplazan
    // por las recién extraídas (sus ficheros viejos quedan en disco, sin referenciar → nunca se borra nada aquí).
    const manuales = (doc.imagenes || []).filter((im) => im && im.origen === 'manual');
    const nuevas = [];
    for (const [i, buf] of buffers.entries()) {
        const { web } = await escribirImagen(carpeta, webDeDoc(doc), buf, i === 0 ? 'portada' : 'pagina');
        nuevas.push({ ruta: web, tipo: i === 0 ? 'portada' : 'otra', origen: 'reextraccion' });
    }
    const imagenes = [...nuevas, ...manuales.map((im) => ({ ...im, tipo: 'otra' }))];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { imagenes, portada: nuevas[0].ruta, fecha_actualizacion: new Date() } });
    await indexarDoc(db, doc._id).catch(() => {});
    return { ok: true, n: nuevas.length };
}

// ── LOTE en 2º plano (para la acción de la Búsqueda sobre la selección) ──────────────────────────────────
const PROY = { titulo: 1, imagenes: 1, portada: 1, ruta_base: 1, paginas: 1, formatos: 1, nombre_archivo: 1, cdu: 1, isbn: 1 };
let trabajo = { en_curso: false, total: 0, hechos: 0, ok: 0, fallidos: 0, titulo: '', cancelar: false, ts: null };
export function estadoReextraccion() { return { ...trabajo }; }
export function cancelarReextraccion() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

export function lanzarReextraccion({ ids, solo5mas1 = true } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una re-extracción en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };
    trabajo = { en_curso: true, total: lista.length, hechos: 0, ok: 0, fallidos: 0, titulo: '', cancelar: false, ts: new Date().toISOString() };
    (async () => {
        try {
            const db = await conectarDB();
            for (const _id of lista) {
                if (trabajo.cancelar) break;
                const doc = await db.collection('biblioteca').findOne({ _id }, { projection: PROY }).catch(() => null);
                trabajo.titulo = doc?.titulo || '';
                if (doc) {
                    try { const r = await reextraerImagenesDoc(db, doc, { solo5mas1 }); if (r.ok) trabajo.ok++; else trabajo.fallidos++; }
                    catch { trabajo.fallidos++; }
                } else trabajo.fallidos++;
                trabajo.hechos++;
            }
        } catch { /* el lote nunca tumba el servidor */ }
        finally { trabajo.en_curso = false; }
    })();
    return { ok: true, total: lista.length };
}
