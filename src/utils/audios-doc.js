/**
 * Reordenación MANUAL de las pistas (playlist) de un documento con audio, desde su ficha. Espejo de
 * `reordenarImagenes`: `orden` es la lista de rutas en el nuevo orden; las no listadas quedan al final. Se
 * reescribe el campo `orden` (1..N) de cada pista, que es por el que el reproductor las presenta.
 */
import { ObjectId } from 'mongodb';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

export async function reordenarAudios(db, id, orden = []) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const doc = await db.collection('biblioteca').findOne({ _id }, { projection: { audios: 1 } });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const actuales = doc.audios || [];
    if (!actuales.length) return { ok: false, motivo: 'el documento no tiene pistas' };

    const porRuta = new Map(actuales.map((a) => [a.ruta, a]));
    const nuevas = [];
    for (const r of orden) { const a = porRuta.get(r); if (a && !nuevas.includes(a)) nuevas.push(a); }
    for (const a of actuales) if (!nuevas.includes(a)) nuevas.push(a); // las no listadas, al final (no se pierden)
    nuevas.forEach((a, i) => { a.orden = i + 1; });

    await db.collection('biblioteca').updateOne({ _id }, { $set: { audios: nuevas, fecha_actualizacion: new Date() } });
    return { ok: true, audios: nuevas };
}
