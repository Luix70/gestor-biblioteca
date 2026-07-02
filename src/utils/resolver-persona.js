/**
 * Resuelve el NOMBRE de una persona (autor/traductor/ilustrador/…) a su ObjectId en la colección `autores`,
 * con el patrón check-then-create que ya usaba motor-catalogo para los autores. Centralizado aquí para que
 * lo compartan la ingesta (autores + contribuciones) y los scripts de backfill, sin duplicar la lógica:
 *   · normalizarAutor: primer contribuyente del marcador BNE «/**​/» + fechas de vida → nacimiento/fallecimiento.
 *   · latinizarNombre: alfabeto no latino → principal LATINIZADO + grafía original en nombres_alternativos.
 * Empareja por nombre latinizado, nombre limpio o grafía alternativa; si no existe, lo crea. Best-effort:
 * si el nombre queda vacío tras limpiar, devuelve null (no crea basura).
 *
 * @returns {Promise<{_id: import('mongodb').ObjectId, creada: boolean, nombre: string}|null>}
 */
import { normalizarAutor } from './autor-normalizar.js';
import { latinizarNombre } from './transliterar.js';

export async function resolverPersona(db, autorStr) {
    if (autorStr && typeof autorStr === 'object' && autorStr._bsontype === 'ObjectId') {
        return { _id: autorStr, creada: false, nombre: null }; // ya es un ObjectId
    }
    const bio = normalizarAutor(autorStr);
    const limpio = bio.nombre || String(autorStr || '').trim();
    if (!limpio) return null;
    const { nombre, alternativos } = latinizarNombre(limpio);
    const col = db.collection('autores');

    const existente = await col.findOne({ $or: [{ nombre }, { nombre: limpio }, { nombres_alternativos: limpio }] });
    if (existente) {
        const upd = {};
        if (limpio !== existente.nombre) upd.$addToSet = { nombres_alternativos: limpio };
        const setBio = {};
        if (bio.nacimiento && !existente.nacimiento) setBio.nacimiento = bio.nacimiento;
        if (bio.fallecimiento && !existente.fallecimiento) setBio.fallecimiento = bio.fallecimiento;
        if (Object.keys(setBio).length) upd.$set = setBio;
        if (Object.keys(upd).length) await col.updateOne({ _id: existente._id }, upd).catch(() => {});
        return { _id: existente._id, creada: false, nombre: existente.nombre };
    }

    const doc = { nombre };
    if (alternativos.length) doc.nombres_alternativos = alternativos;
    if (bio.nacimiento) doc.nacimiento = bio.nacimiento;
    if (bio.fallecimiento) doc.fallecimiento = bio.fallecimiento;
    const nuevo = await col.insertOne(doc);
    return { _id: nuevo.insertedId, creada: true, nombre };
}
