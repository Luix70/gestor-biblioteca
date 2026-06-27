/**
 * Reproceso de UN documento desde la ficha del panel: lo DEVUELVE al Inbox para re-catalogarlo de cero.
 *
 *   1. copia el fichero original (de su carpeta CDU) al Inbox,
 *   2. borra el documento de Mongo (así el atajo-por-hash NO lo deduplica al re-ingerir),
 *   3. lo quita del inventario de su cabecera/colección,
 *   4. RECICLA su carpeta CDU entera (sidecars, imágenes, registro.json/.marc.xml y la copia original)
 *      a la Papelera — "nunca borrar": es recuperable.
 *
 * El Vigilante re-cataloga el fichero del Inbox (si está ACTIVO; si no, espera ahí). Política anti-pérdida:
 * el original viaja al Inbox Y queda una copia en la Papelera.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { reciclarCarpeta } from './papelera.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

export async function reprocesarDocumento(db, doc) {
    const bib = db.collection('biblioteca');
    const carpeta = carpetaDeDoc(doc);
    const origen = doc.nombre_archivo ? path.join(carpeta, doc.nombre_archivo) : null;
    if (!origen) return { ok: false, motivo: 'el documento no tiene nombre_archivo: no se puede reprocesar' };

    let tam = -1;
    try { tam = (await fs.stat(origen)).size; } catch { /* no existe */ }
    if (tam <= 0) return { ok: false, motivo: 'no se encuentra el fichero original en su carpeta CDU: no se puede reprocesar' };

    // 1. Copiar el original al Inbox (sin pisar uno ya presente).
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let destino = path.join(DIR_INBOX, doc.nombre_archivo);
    if (await existe(destino)) {
        const ext = path.extname(doc.nombre_archivo);
        const base = path.basename(doc.nombre_archivo, ext);
        destino = path.join(DIR_INBOX, `${base} (reproc ${String(doc._id).slice(-6)})${ext}`);
    }
    await fs.copyFile(origen, destino);

    // 2. Borrar el documento (para que el re-ingreso NO se deduplique por hash contra sí mismo).
    await bib.deleteOne({ _id: doc._id });

    // 3. Sacarlo del inventario de su cabecera/colección y recalcular su recuento.
    if (doc.coleccion) {
        const col = db.collection('colecciones');
        await col.updateOne({ _id: doc.coleccion }, { $pull: { numeros: { _id: doc._id }, numeros_sin_fecha: doc._id } });
        const cab = await col.findOne({ _id: doc.coleccion });
        if (cab) await col.updateOne({ _id: doc.coleccion }, { $set: {
            numeros_presentes: (cab.numeros || []).length,
            revision_requerida: (cab.numeros_sin_fecha || []).length > 0,
        } });
    }

    // 4. Reciclar la carpeta CDU entera a la Papelera (recuperable).
    const reciclada = await reciclarCarpeta(carpeta, 'reprocesado', path.basename(path.dirname(carpeta)));
    return { ok: true, inbox: path.basename(destino), reciclada: !!reciclada };
}
