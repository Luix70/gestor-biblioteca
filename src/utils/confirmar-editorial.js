/**
 * CONFIRMAR LA EDITORIAL de unos documentos: el usuario (o una prueba que la avala) da por buena la editorial que
 * tienen. Se marca `editorial_confirmada: true` y salen de las selecciones de revisión de editoriales
 * («Editorial sin confirmar…», «Editorial a revisar…»), que así encogen a medida que se revisan.
 *
 * La marca la respetan los scripts que corrigen editoriales en lote (editoriales-por-prefijo,
 * editorial-de-colecciones): un documento confirmado no se vuelve a tocar.
 *
 * No toca `fecha_actualizacion`: la marca no cambia los sidecars (registro.json / MARC), y moverla los daría por
 * desactualizados sin motivo.
 *
 * Consumidores: la acción «✅ Confirmar editorial» del panel (selección y ficha) y
 * scripts/triar-editoriales-sin-confirmar.js.
 */
import { ObjectId } from 'mongodb';

/** Las selecciones de revisión de editoriales (las crean reparar-tras-reidentificacion y editoriales-por-prefijo). */
export const RE_SELECCIONES_EDITORIAL = /^Editorial (sin confirmar|a revisar)/;

/**
 * @param {import('mongodb').Db} db
 * @param {Array<string|ObjectId>} ids
 * @param {{ quitar?: boolean, motivo?: string }} [opciones]
 *        quitar=true deshace la confirmación (no devuelve los documentos a las selecciones).
 *        motivo: texto para la alerta del documento (quién o qué la confirma).
 * @returns {Promise<{ ok: boolean, n: number, fuera: number, motivo?: string }>}
 *          n = documentos marcados; fuera = pertenencias quitadas de las selecciones de revisión.
 */
export async function confirmarEditorial(db, ids, { quitar = false, motivo = null } = {}) {
    const oids = [...new Set((ids || []).map(String))]
        .filter((x) => ObjectId.isValid(x))
        .map((x) => new ObjectId(x));
    if (!oids.length) return { ok: false, n: 0, fuera: 0, motivo: 'no se recibió ningún documento' };

    const col = db.collection('biblioteca');
    if (quitar) {
        const r = await col.updateMany({ _id: { $in: oids } }, { $unset: { editorial_confirmada: '', editorial_confirmada_fecha: '' } });
        return { ok: true, n: r.modifiedCount, fuera: 0 };
    }

    const set = { editorial_confirmada: true, editorial_confirmada_fecha: new Date() };
    const upd = { $set: set };
    if (motivo) upd.$push = { alertas_agente: `Editorial confirmada: ${motivo}` };
    const r = await col.updateMany({ _id: { $in: oids }, editorial_confirmada: { $ne: true } }, upd);

    // Fuera de las selecciones de revisión: lo confirmado ya no está pendiente.
    let fuera = 0;
    const selecciones = await db.collection('selecciones')
        .find({ nombre: RE_SELECCIONES_EDITORIAL, docs: { $in: oids } }, { projection: { docs: 1 } })
        .toArray();
    const confirmados = new Set(oids.map(String));
    for (const s of selecciones) {
        fuera += (s.docs || []).filter((d) => confirmados.has(String(d))).length;
        await db.collection('selecciones').updateOne(
            { _id: s._id },
            { $pull: { docs: { $in: oids } }, $set: { fecha_actualizacion: new Date() } },
        );
    }
    return { ok: true, n: r.modifiedCount, fuera };
}
