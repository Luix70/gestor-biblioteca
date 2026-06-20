/**
 * Resuelve el nombre de una colección/serie editorial a un documento de la colección
 * 'colecciones' (patrón check-then-create, como autores/editoriales). Enlaza la editorial
 * (ObjectId) si se conoce; si la colección ya existía sin editorial, la completa.
 *
 * @param {import('mongodb').Db} db
 * @param {string} nombre       Nombre de la colección (p. ej. "Letras Universales").
 * @param {import('mongodb').ObjectId|null} editorialId  ObjectId de la editorial, si se conoce.
 * @returns {Promise<{ _id: import('mongodb').ObjectId, creada: boolean }>}
 */
export async function resolverColeccion(db, nombre, editorialId = null) {
    const col = db.collection('colecciones');
    const limpio = String(nombre).trim();

    const existente = await col.findOne({ nombre: limpio });
    if (existente) {
        if (!existente.editorial && editorialId) {
            await col.updateOne({ _id: existente._id }, { $set: { editorial: editorialId } });
        }
        return { _id: existente._id, creada: false };
    }

    const nueva = { nombre: limpio, fecha_creacion: new Date() };
    if (editorialId) nueva.editorial = editorialId;
    const r = await col.insertOne(nueva);
    return { _id: r.insertedId, creada: true };
}
