/**
 * Resuelve una obra multivolumen a un documento de la colección 'obras' (check-then-create).
 * Dedup por ISBN de obra si lo hay; si no, por título. Completa huecos (isbn_obra, editorial,
 * colección, cdu) de una obra ya existente. Devuelve { _id, cdu, creada }.
 *
 * La obra guarda su CDU: TODOS sus tomos comparten ese classmark (así se archivan juntos), igual
 * que una colección de varios volúmenes en una biblioteca física.
 */
export async function resolverObra(db, { titulo, isbn_obra = null, editorialId = null, coleccionId = null, cdu = null }) {
    const col = db.collection('obras');
    const t = titulo ? String(titulo).trim() : null;

    let existente = isbn_obra ? await col.findOne({ isbn_obra }) : null;
    if (!existente && t) existente = await col.findOne({ titulo: t });

    if (existente) {
        const set = {};
        if (isbn_obra && !existente.isbn_obra) set.isbn_obra = isbn_obra;
        if (editorialId && !existente.editorial) set.editorial = editorialId;
        if (coleccionId && !existente.coleccion) set.coleccion = coleccionId;
        if (cdu && !existente.cdu) set.cdu = cdu;
        if (Object.keys(set).length) await col.updateOne({ _id: existente._id }, { $set: set });
        return { _id: existente._id, cdu: existente.cdu || cdu || null, creada: false };
    }

    const nueva = { titulo: t, fecha_creacion: new Date() };
    if (isbn_obra)   nueva.isbn_obra = isbn_obra;
    if (editorialId) nueva.editorial = editorialId;
    if (coleccionId) nueva.coleccion = coleccionId;
    if (cdu)         nueva.cdu = cdu;
    try {
        const r = await col.insertOne(nueva);
        return { _id: r.insertedId, cdu: cdu || null, creada: true };
    } catch {
        // Carrera con el índice único de isbn_obra: devolver el existente.
        const ya = isbn_obra ? await col.findOne({ isbn_obra }) : await col.findOne({ titulo: t });
        return ya ? { _id: ya._id, cdu: ya.cdu || cdu || null, creada: false } : { _id: null, cdu: null, creada: false };
    }
}
