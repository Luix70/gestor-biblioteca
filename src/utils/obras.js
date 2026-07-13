/**
 * Resuelve una obra multivolumen a un documento de la colección 'obras' (check-then-create).
 * Dedup por ISBN de obra si lo hay; si no, por título. Completa huecos (isbn_obra, editorial,
 * colección, cdu) de una obra ya existente. Devuelve { _id, cdu, titulo, isbn_obra, creada }.
 * `titulo`/`isbn_obra` son los CANÓNICOS de la obra (los del registro): TODOS sus tomos deben usarlos para
 * vivir JUNTOS en /CDU/<cdu>/obras/<isbn_obra | titulo>/ — carpeta por isbn_obra si la obra lo tiene, si no
 * por título (ver servicio-ingesta). Así un tomo añadido después cae SIEMPRE en la misma carpeta.
 *
 * La obra guarda su CDU: TODOS sus tomos comparten ese classmark (así se archivan juntos), igual
 * que una colección de varios volúmenes en una biblioteca física.
 */
export async function resolverObra(db, { titulo, isbn_obra = null, editorialId = null, coleccionId = null, cdu = null, total = null }) {
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
        // total_volumenes: solo sube (nunca degrada un total ya conocido a uno menor).
        if (total && total > (existente.total_volumenes || 0)) set.total_volumenes = total;
        if (Object.keys(set).length) await col.updateOne({ _id: existente._id }, { $set: set });
        return { _id: existente._id, cdu: existente.cdu || cdu || null, titulo: existente.titulo || t, isbn_obra: existente.isbn_obra || isbn_obra || null, creada: false };
    }

    const nueva = { titulo: t, fecha_creacion: new Date() };
    if (isbn_obra)   nueva.isbn_obra = isbn_obra;
    if (editorialId) nueva.editorial = editorialId;
    if (coleccionId) nueva.coleccion = coleccionId;
    if (cdu)         nueva.cdu = cdu;
    if (total)       nueva.total_volumenes = total;
    try {
        const r = await col.insertOne(nueva);
        return { _id: r.insertedId, cdu: cdu || null, titulo: t, isbn_obra: isbn_obra || null, creada: true };
    } catch {
        // Carrera con el índice único de isbn_obra: devolver el existente.
        const ya = isbn_obra ? await col.findOne({ isbn_obra }) : await col.findOne({ titulo: t });
        return ya
            ? { _id: ya._id, cdu: ya.cdu || cdu || null, titulo: ya.titulo || t, isbn_obra: ya.isbn_obra || isbn_obra || null, creada: false }
            : { _id: null, cdu: null, titulo: t, isbn_obra: isbn_obra || null, creada: false };
    }
}

/**
 * Registra (o actualiza) en la obra el tomo `numero` → `docId` del documento de biblioteca, y
 * recalcula su inventario de tomos. Deja `volumenes` como un array 1..total con el _id de cada tomo
 * presente o null si falta, de modo que se vea de un vistazo qué tomos hay y cuáles faltan:
 *   volumenes: [ {numero:1,_id:ObjectId}, {numero:2,_id:null}, {numero:3,_id:ObjectId} ]
 * Idempotente: re-catalogar un tomo solo refresca su _id. Best-effort (no rompe la ingesta).
 */
/**
 * Reconstruye el inventario de tomos de una obra a partir del `volumen_numero` ACTUAL de TODOS sus
 * documentos miembro (los que tienen `obra: obraId`). Se usa tras renumerar tomos a mano desde el panel.
 * Anti-pérdida: un tomo sin número —o que colisiona con otro ya asignado a ese número— va a
 * `volumenes_sin_numero` (nunca se descarta) y marca la obra para revisión.
 *   opts.total: fija explícitamente el total de tomos (acotado por debajo al mayor tomo presente); si no
 *   se da, se conserva el total conocido (nunca se degrada por debajo de lo ya sabido).
 */
export async function reconstruirInventarioObra(db, obraId, { total = null } = {}) {
    const col = db.collection('obras');
    const obra = await col.findOne({ _id: obraId });
    if (!obra) return null;
    const docs = await db.collection('biblioteca')
        .find({ obra: obraId }, { projection: { volumen_numero: 1 } }).toArray();
    const presentes = new Map();   // numero -> _id (el primero que reclama un número lo ocupa)
    const sin = [];
    for (const d of docs) {
        const n = Number.isInteger(d.volumen_numero) ? d.volumen_numero : null;
        if (n != null && n >= 1 && !presentes.has(n)) presentes.set(n, d._id);
        else sin.push(d._id);        // sin número o colisión → no se pierde
    }
    const base = presentes.size ? Math.max(...presentes.keys()) : 0;
    const maxNum = (total != null && total >= base) ? total : Math.max(base, obra.total_volumenes || 0);
    const volumenes = [];
    for (let n = 1; n <= maxNum; n++) volumenes.push({ numero: n, _id: presentes.get(n) || null });
    await col.updateOne({ _id: obraId }, { $set: {
        volumenes, volumenes_sin_numero: sin,
        total_volumenes: maxNum, volumenes_presentes: presentes.size,
        completa: maxNum > 0 && presentes.size === maxNum && sin.length === 0,
        revision_requerida: sin.length > 0,
        fecha_actualizacion: new Date(),
    } });
    return { total_volumenes: maxNum, volumenes_presentes: presentes.size, sin_numero: sin.length };
}

export async function registrarVolumenEnObra(db, obraId, numero, docId, total = null) {
    if (!obraId || !docId) return;
    try {
        const col = db.collection('obras');
        const obra = await col.findOne({ _id: obraId });
        if (!obra) return;

        // Tomo SIN número ("?"): nunca se descarta. Se guarda en una lista aparte (sin_numero) y se
        // marca la obra para revisión — preferible una obra "desordenada" a un tomo perdido.
        if (numero == null) {
            const sin = (obra.volumenes_sin_numero || []).map(String);
            if (!sin.includes(String(docId))) sin.push(String(docId));
            await col.updateOne({ _id: obraId }, { $set: {
                volumenes_sin_numero: [...new Set([...(obra.volumenes_sin_numero || []), docId])],
                revision_requerida: true,
                fecha_actualizacion: new Date(),
            } });
            return;
        }

        const presentes = new Map(
            (obra.volumenes || []).filter(v => v && v._id).map(v => [v.numero, v._id])
        );
        presentes.set(numero, docId);

        const maxNum = Math.max(numero, ...presentes.keys(), total || 0, obra.total_volumenes || 0);
        const volumenes = [];
        for (let n = 1; n <= maxNum; n++) volumenes.push({ numero: n, _id: presentes.get(n) || null });
        const sinNumero = (obra.volumenes_sin_numero || []).length;

        await col.updateOne({ _id: obraId }, { $set: {
            volumenes,
            total_volumenes: maxNum,
            volumenes_presentes: presentes.size,
            // 'completa' solo si están todos los numerados Y no quedan tomos sin numerar pendientes.
            completa: presentes.size === maxNum && sinNumero === 0,
            fecha_actualizacion: new Date(),
        } });
    } catch { /* el inventario de la obra no debe romper la ingesta del tomo */ }
}
