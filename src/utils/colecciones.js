/**
 * 'colecciones' = colección PADRE abstracta (sin fichero propio) que agrupa documentos de 'biblioteca':
 *   · tipo:'revista' → CABECERA de un periódico (pivote ISSN). Sus miembros son los NÚMEROS, en un
 *     inventario CRONOLÓGICO `numeros[]`; cada número se identifica por (coleccion, clave_numero).
 *   · tipo:'libro' (o ausente = legado) → SERIE/colección editorial de libros (p. ej. «Graduate Texts
 *     in Physics», con ISSN de serie); cada libro conserva su PROPIO ISBN.
 * El ISSN es la AUTORIDAD del grupo (análogo a obras.isbn_obra para una obra multivolumen).
 */

/**
 * Resuelve una cabecera/serie a un documento de 'colecciones' (check-then-create), keyed por ISSN
 * (autoridad) y, en su defecto, por nombre. Completa huecos (issn, tipo, editorial, cdu, descripcion)
 * de una ya existente. Devuelve { _id, cdu, creada }. Análogo a resolverObra() para obras multivolumen.
 *
 * @param {import('mongodb').Db} db
 * @param {{nombre?:string|null, issn?:string|null, tipo?:'revista'|'libro'|null,
 *          editorialId?:import('mongodb').ObjectId|null, cdu?:string|null, descripcion?:string|null}} datos
 */
export async function resolverCabecera(db, { nombre, issn = null, tipo = null, editorialId = null, cdu = null, descripcion = null }) {
    const col = db.collection('colecciones');
    // nombre es obligatorio y único; si solo tenemos ISSN, usamos el ISSN como nombre provisional
    // (el Conformador/autoridad lo renombra luego con el título real de la cabecera/serie).
    const n = (nombre && String(nombre).trim()) || issn || null;

    let existente = issn ? await col.findOne({ issn }) : null;
    // Nombre case-insensitive (collation): evita crear duplicados por mayúsculas/minúsculas
    // («Direction Italie» vs «direction Italie»). El índice único de nombre es case-sensitive.
    if (!existente && n) existente = await col.findOne({ nombre: n }, { collation: { locale: 'es', strength: 2 } });

    if (existente) {
        const set = {};
        if (issn && !existente.issn) set.issn = issn;
        if (tipo && !existente.tipo) set.tipo = tipo;
        if (editorialId && !existente.editorial) set.editorial = editorialId;
        if (cdu && !existente.cdu) set.cdu = cdu;
        if (descripcion && !existente.descripcion) set.descripcion = descripcion;
        if (Object.keys(set).length) {
            set.fecha_actualizacion = new Date();
            await col.updateOne({ _id: existente._id }, { $set: set });
        }
        return { _id: existente._id, cdu: existente.cdu || cdu || null, creada: false };
    }

    const nueva = { nombre: n, fecha_creacion: new Date() };
    if (issn)        nueva.issn = issn;
    if (tipo)        nueva.tipo = tipo;
    if (editorialId) nueva.editorial = editorialId;
    if (cdu)         nueva.cdu = cdu;
    if (descripcion) nueva.descripcion = descripcion;
    try {
        const r = await col.insertOne(nueva);
        return { _id: r.insertedId, cdu: cdu || null, creada: true };
    } catch {
        // Carrera con el índice único (issn o nombre): devolver el existente.
        const ya = issn ? await col.findOne({ issn })
            : (n ? await col.findOne({ nombre: n }, { collation: { locale: 'es', strength: 2 } }) : null);
        return ya ? { _id: ya._id, cdu: ya.cdu || cdu || null, creada: false } : { _id: null, cdu: null, creada: false };
    }
}

/**
 * Resuelve el nombre de una colección/serie editorial de LIBROS (patrón check-then-create, como
 * autores/editoriales). Atajo sobre resolverCabecera con tipo:'libro'. Enlaza la editorial si se
 * conoce. Devuelve { _id, creada } (compatibilidad con los llamantes previos).
 *
 * @param {import('mongodb').Db} db
 * @param {string} nombre
 * @param {import('mongodb').ObjectId|null} editorialId
 */
export async function resolverColeccion(db, nombre, editorialId = null) {
    const { _id, creada } = await resolverCabecera(db, { nombre, tipo: 'libro', editorialId });
    return { _id, creada };
}

/**
 * Registra (o actualiza) en la CABECERA (colección tipo:'revista') el número `docId`, manteniendo
 * `numeros` como una lista CRONOLÓGICA [{clave, año, mes, numero_issue, _id}] — adecuada para una
 * publicación periódica (no el array contiguo 1..N de las obras multivolumen). Un número sin clave
 * (sin fecha/nº) va a `numeros_sin_fecha` y marca la cabecera para revisión. Idempotente y
 * best-effort (nunca rompe la ingesta del número).
 */
export async function registrarNumeroEnColeccion(db, coleccionId, num, docId) {
    if (!coleccionId || !docId) return;
    try {
        const col = db.collection('colecciones');
        const cab = await col.findOne({ _id: coleccionId });
        if (!cab) return;

        const clave = num?.clave || null;
        // Quita cualquier entrada previa de ESTE doc (por _id) y, si trae clave, la de su misma clave.
        const numeros = (cab.numeros || [])
            .filter(x => x && String(x._id) !== String(docId) && (!clave || x.clave !== clave));
        let sinFecha = (cab.numeros_sin_fecha || []).filter(id => String(id) !== String(docId));

        if (clave) {
            numeros.push({ clave, 'año': num.año ?? null, mes: num.mes ?? null, numero_issue: num.numero_issue ?? null, _id: docId });
            numeros.sort((a, b) => String(a.clave).localeCompare(String(b.clave), undefined, { numeric: true }));
        } else {
            sinFecha = [...sinFecha, docId];
        }

        await col.updateOne({ _id: coleccionId }, { $set: {
            numeros,
            numeros_presentes: numeros.length,
            numeros_sin_fecha: sinFecha,
            revision_requerida: sinFecha.length > 0,
            fecha_actualizacion: new Date(),
        } });
    } catch { /* el inventario de la cabecera no debe romper la ingesta del número */ }
}
