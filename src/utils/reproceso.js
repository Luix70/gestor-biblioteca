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
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
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

export async function reprocesarDocumento(db, doc) {
    const carpeta = carpetaDeDoc(doc);
    const origen = doc.nombre_archivo ? path.join(carpeta, doc.nombre_archivo) : null;
    if (!origen) return { ok: false, motivo: 'el documento no tiene nombre_archivo: no se puede reprocesar' };

    let tam = -1;
    try { tam = (await fs.stat(origen)).size; } catch { /* no existe */ }
    if (tam <= 0) return { ok: false, motivo: 'no se encuentra el fichero original en su carpeta CDU: no se puede reprocesar' };

    // Copiar el original al Inbox (sin pisar uno ya presente) ANTES de reciclar la carpeta.
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let destino = path.join(DIR_INBOX, doc.nombre_archivo);
    if (await existe(destino)) {
        const ext = path.extname(doc.nombre_archivo);
        const base = path.basename(doc.nombre_archivo, ext);
        destino = path.join(DIR_INBOX, `${base} (reproc ${String(doc._id).slice(-6)})${ext}`);
    }
    await fs.copyFile(origen, destino);

    const reciclada = await desvincularYReciclar(db, doc, 'reprocesado');
    return { ok: true, inbox: path.basename(destino), reciclada };
}

/** Elimina el documento del catálogo: borra el registro y recicla su carpeta CDU (recuperable en Papelera). */
export async function eliminarDocumento(db, doc) {
    const reciclada = await desvincularYReciclar(db, doc, 'eliminado');
    return { ok: true, reciclada };
}
