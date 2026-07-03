/**
 * Acciones de un documento desde la ficha del panel que retiran su carpeta del árbol CDU:
 *   · reprocesarDocumento — lo DEVUELVE al Inbox para re-catalogarlo de cero.
 *   · eliminarDocumento   — lo BORRA del catálogo (sin re-ingestar).
 *
 * Ambas: borran el documento de Mongo, lo desvinculan del inventario de su cabecera/colección y de su
 * obra, y RECICLAN su carpeta CDU entera (sidecars, imágenes, registro.json/.marc.xml y el original) a la
 * Papelera — "nunca borrar": es recuperable. reprocesar copia ANTES el original al Inbox (y el Vigilante,
 * si está ACTIVO, lo vuelve a catalogar; si no, espera ahí).
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import { carpetaDeDoc, EXT_DOC } from '../mantenimiento/util-mantenimiento.js';
import { reciclarCarpeta } from './papelera.js';
import { desindexarDoc } from './indice-busqueda.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Borra el doc, lo saca del inventario de su colección y de su obra, y recicla su carpeta CDU. */
async function desvincularYReciclar(db, doc, etiqueta) {
    const carpeta = carpetaDeDoc(doc);
    await db.collection('biblioteca').deleteOne({ _id: doc._id });
    await desindexarDoc(doc._id);   // quitar del índice de búsqueda (re-ingesta lo re-añade)

    // Quitar de la cabecera/colección (números) y recalcular su recuento.
    if (doc.coleccion) {
        const col = db.collection('colecciones');
        await col.updateOne({ _id: doc.coleccion }, { $pull: { numeros: { _id: doc._id }, numeros_sin_fecha: doc._id } });
        const cab = await col.findOne({ _id: doc.coleccion });
        if (cab) await col.updateOne({ _id: doc.coleccion }, { $set: {
            numeros_presentes: (cab.numeros || []).length,
            revision_requerida: (cab.numeros_sin_fecha || []).length > 0,
        } });
    }

    // Quitar de la obra multivolumen: el hueco del tomo queda como "falta" (_id:null); recalcular.
    if (doc.obra) {
        const col = db.collection('obras');
        const obra = await col.findOne({ _id: doc.obra });
        if (obra) {
            const volumenes = (obra.volumenes || []).map(v => (v && String(v._id) === String(doc._id)) ? { ...v, _id: null } : v);
            const sin = (obra.volumenes_sin_numero || []).filter(id => String(id) !== String(doc._id));
            const presentes = volumenes.filter(v => v && v._id).length;
            const maxNum = obra.total_volumenes || volumenes.length;
            await col.updateOne({ _id: doc.obra }, { $set: {
                volumenes, volumenes_sin_numero: sin, volumenes_presentes: presentes,
                completa: presentes === maxNum && sin.length === 0, fecha_actualizacion: new Date(),
            } });
        }
    }

    const reciclada = await reciclarCarpeta(carpeta, etiqueta, path.basename(path.dirname(carpeta)));
    return !!reciclada;
}

// ¿El `origen` de una imagen es una EXTRACCIÓN DEL SISTEMA (no un dato del usuario)? Las páginas de un PDF
// rasterizado, portadas embebidas de EPUB o descargadas de la web son derivadas → se re-generan al re-
// ingerir (con las mejoras de extracción/número actuales). Los ESCANEOS del usuario ('escaneo', 'covers',
// 'subida'…) son el DATO ORIGINAL → hay que conservarlos.
const ORIGEN_SISTEMA = /^(pdf:|rasteriz|embebida|openlibrary|apple|fichero_local|remot|isbn-web)/i;
const esImagenUsuario = (origen) => !ORIGEN_SISTEMA.test(String(origen || ''));
// Nombre de fichero seguro a partir del título (para el zip/imagen que se suelta en el Inbox).
const nombreSeguro = (s) => (String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'escaneo');

/**
 * Devuelve el documento al Inbox para re-catalogarlo:
 *   · Si tiene un FICHERO original (pdf/epub/mobi/…) → se envía ese fichero; sus imágenes son extracciones
 *     del sistema y se descartan (se re-extraen al re-ingerir).
 *   · Si es un ESCANEO (imágenes suministradas por el usuario, sin fichero-documento) → se envían TODAS sus
 *     imágenes de contenido: una sola tal cual, o VARIAS empaquetadas en un ZIP (el Vigilante lo expande a
 *     una carpeta-drop y las re-cataloga como un único libro escaneado). Así no se pierde ninguna.
 */
export async function reprocesarDocumento(db, doc) {
    const carpeta = carpetaDeDoc(doc);
    const nombre = doc.nombre_archivo || '';
    const tieneDocOriginal = nombre && EXT_DOC.includes(path.extname(nombre).toLowerCase());
    const id6 = String(doc._id).slice(-6);
    await fs.mkdir(DIR_INBOX, { recursive: true });

    // ── Documento con fichero original (pdf/epub/…): enviar el fichero; descartar sidecars del sistema. ──
    if (tieneDocOriginal) {
        const origen = path.join(carpeta, nombre);
        let tam = -1;
        try { tam = (await fs.stat(origen)).size; } catch { /* no existe */ }
        if (tam <= 0) return { ok: false, motivo: 'no se encuentra el fichero original en su carpeta CDU: no se puede reprocesar' };
        let destino = path.join(DIR_INBOX, nombre);
        if (await existe(destino)) {
            const ext = path.extname(nombre);
            destino = path.join(DIR_INBOX, `${path.basename(nombre, ext)} (reproc ${id6})${ext}`);
        }
        await fs.copyFile(origen, destino);
        const reciclada = await desvincularYReciclar(db, doc, 'reprocesado');
        return { ok: true, inbox: path.basename(destino), reciclada };
    }

    // ── Escaneo (imágenes = dato del usuario): reunir TODAS las imágenes de contenido y enviarlas. ──
    const imgs = [];
    for (const im of (doc.imagenes || [])) {
        if (!esImagenUsuario(im.origen)) continue;   // saltar extracciones del sistema
        const p = path.join(carpeta, path.basename(im.ruta || ''));
        if (await existe(p)) imgs.push(p);
    }
    // Fallback: si el filtro dejó 0 pero nombre_archivo es una imagen que existe, usarla.
    if (!imgs.length && nombre) { const p = path.join(carpeta, nombre); if (await existe(p)) imgs.push(p); }
    if (!imgs.length) return { ok: false, motivo: 'no se encontraron las imágenes del escaneo en su carpeta CDU: no se puede reprocesar' };

    const base = nombreSeguro(doc.titulo);
    let inbox;
    if (imgs.length === 1) {
        // Una sola imagen → enviarla tal cual.
        let destino = path.join(DIR_INBOX, path.basename(imgs[0]));
        if (await existe(destino)) destino = path.join(DIR_INBOX, `${base} (reproc ${id6})${path.extname(imgs[0]) || '.jpg'}`);
        await fs.copyFile(imgs[0], destino);
        inbox = path.basename(destino);
    } else {
        // Varias imágenes → ZIP (el Vigilante lo expande y re-cataloga como un único libro escaneado).
        const zip = new AdmZip();
        for (const p of imgs) zip.addLocalFile(p);
        let destino = path.join(DIR_INBOX, `${base} (reproc ${id6}).zip`);
        if (await existe(destino)) destino = path.join(DIR_INBOX, `${base} (reproc ${id6}-${Date.now().toString().slice(-4)}).zip`);
        zip.writeZip(destino);
        inbox = path.basename(destino);
    }

    const reciclada = await desvincularYReciclar(db, doc, 'reprocesado');
    return { ok: true, inbox, imagenes: imgs.length, reciclada };
}

/** Elimina el documento del catálogo: borra el registro y recicla su carpeta CDU (recuperable en Papelera). */
export async function eliminarDocumento(db, doc) {
    const reciclada = await desvincularYReciclar(db, doc, 'eliminado');
    return { ok: true, reciclada };
}
