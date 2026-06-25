/**
 * Revistas: la CABECERA (p. ej. "Historia de Iberia Vieja", ISSN 1699-7913) se modela como una
 * OBRA — reutilizamos la colección 'obras' con tipo:'revista' e issn_obra como AUTORIDAD — y cada
 * NÚMERO (oct 2015, feb 2020…) es un documento de 'biblioteca' miembro de esa cabecera, identificado
 * por una CLAVE estable dentro de ella. El ISSN es el pivote (igual que el ISBN para los libros): así
 * el vínculo título↔número no se fragmenta por el ruido de fechas/números en el título de cada uno.
 */
import { MES_NUM } from './parsear-nombre.js';

/**
 * Clave estable de un número dentro de su cabecera, en orden de fiabilidad:
 *   AAAA-MM  (año + mes)  →  n<nº de issue>  →  AAAA (solo año)  →  null (sin fecha/nº).
 * Un número con cabecera (ISSN) pero clave null se cuelga como miembro "sin fecha" (nunca se fusiona).
 */
export function claveNumero({ año_edicion, mes_publicacion, numero_issue } = {}) {
    const a = parseInt(año_edicion, 10);
    let m = parseInt(mes_publicacion, 10);
    if (!(m >= 1 && m <= 12) && mes_publicacion) m = MES_NUM[String(mes_publicacion).toLowerCase()] ?? NaN;
    if (a && m >= 1 && m <= 12) return `${a}-${String(m).padStart(2, '0')}`;
    const ni = numero_issue != null ? String(numero_issue).trim() : '';
    if (ni) return `n${ni}`;
    if (a) return String(a);
    return null;
}

/**
 * Título de la CABECERA a partir del título de un número: le quita la coletilla de fecha/número
 * ("Historia de Iberia Vieja nº145 – oct 2015" → "Historia de Iberia Vieja"). Heurístico y prudente:
 * si el recorte dejara algo demasiado corto, devuelve el título original sin tocar.
 */
export function tituloCabecera(titulo) {
    if (!titulo) return null;
    const orig = String(titulo).trim();
    const meses = Object.keys(MES_NUM).join('|');
    let t = orig;
    // nº / número / issue / # + dígitos … hasta el final
    t = t.replace(/[\s\-–—,;:|]*\b(?:n[.º°o]?|n[úu]m(?:ero)?\.?|issue|#)\s*\d+\b.*$/i, '');
    // mes(es) por nombre [+ rango] + año  ("octubre 2015", "jul-ago 2020", "oct. 2015")
    t = t.replace(new RegExp(`[\\s\\-–—,;:|]*\\b(?:${meses})\\b(?:[\\s\\-/]+(?:${meses})\\b)?[\\s.,–-]*(?:19|20)\\d{2}.*$`, 'i'), '');
    // un año suelto al final
    t = t.replace(/[\s\-–—,;:|]*\b(?:19|20)\d{2}\b\s*$/, '');
    t = t.replace(/[\s\-–—,;:|]+$/, '').trim();
    return t.length >= 2 ? t : orig;
}

/**
 * Resuelve la cabecera de una revista a un documento de 'obras' (check-then-create), keyed por ISSN
 * (issn_obra) y, en su defecto, por título. Completa huecos (issn_obra, editorial, colección, cdu) de
 * una cabecera ya existente. Devuelve { _id, cdu, creada }. Análogo a resolverObra() para libros.
 */
export async function resolverCabecera(db, { titulo, issn = null, editorialId = null, coleccionId = null, cdu = null }) {
    const col = db.collection('obras');
    const t = titulo ? String(titulo).trim() : null;

    let existente = issn ? await col.findOne({ issn_obra: issn }) : null;
    if (!existente && t) existente = await col.findOne({ titulo: t, tipo: 'revista' });

    if (existente) {
        const set = {};
        if (issn && !existente.issn_obra) set.issn_obra = issn;
        if (!existente.tipo) set.tipo = 'revista';
        if (editorialId && !existente.editorial) set.editorial = editorialId;
        if (coleccionId && !existente.coleccion) set.coleccion = coleccionId;
        if (cdu && !existente.cdu) set.cdu = cdu;
        if (Object.keys(set).length) await col.updateOne({ _id: existente._id }, { $set: set });
        return { _id: existente._id, cdu: existente.cdu || cdu || null, creada: false };
    }

    const nueva = { titulo: t, tipo: 'revista', fecha_creacion: new Date() };
    if (issn)        nueva.issn_obra = issn;
    if (editorialId) nueva.editorial = editorialId;
    if (coleccionId) nueva.coleccion = coleccionId;
    if (cdu)         nueva.cdu = cdu;
    try {
        const r = await col.insertOne(nueva);
        return { _id: r.insertedId, cdu: cdu || null, creada: true };
    } catch {
        // Carrera con el índice único de issn_obra: devolver el existente.
        const ya = issn ? await col.findOne({ issn_obra: issn }) : (t ? await col.findOne({ titulo: t, tipo: 'revista' }) : null);
        return ya ? { _id: ya._id, cdu: ya.cdu || cdu || null, creada: false } : { _id: null, cdu: null, creada: false };
    }
}

/**
 * Registra (o actualiza) en la cabecera el número `docId`, manteniendo `numeros` como una lista
 * CRONOLÓGICA [{clave, año, mes, numero_issue, _id}] — adecuada para una publicación periódica (no el
 * array contiguo 1..N de los libros). Un número sin clave (sin fecha/nº) va a `numeros_sin_fecha` y
 * marca la cabecera para revisión. Idempotente y best-effort (nunca rompe la ingesta del número).
 */
export async function registrarNumeroEnCabecera(db, obraId, num, docId) {
    if (!obraId || !docId) return;
    try {
        const col = db.collection('obras');
        const obra = await col.findOne({ _id: obraId });
        if (!obra) return;

        const clave = num?.clave || null;
        // Quita cualquier entrada previa de ESTE doc (por _id) y, si trae clave, la de su misma clave.
        const numeros = (obra.numeros || [])
            .filter(n => n && String(n._id) !== String(docId) && (!clave || n.clave !== clave));
        let sinFecha = (obra.numeros_sin_fecha || []).filter(id => String(id) !== String(docId));

        if (clave) {
            numeros.push({ clave, 'año': num.año ?? null, mes: num.mes ?? null, numero_issue: num.numero_issue ?? null, _id: docId });
            numeros.sort((a, b) => String(a.clave).localeCompare(String(b.clave), undefined, { numeric: true }));
        } else {
            sinFecha = [...sinFecha, docId];
        }

        await col.updateOne({ _id: obraId }, { $set: {
            numeros,
            numeros_presentes: numeros.length,
            numeros_sin_fecha: sinFecha,
            revision_requerida: sinFecha.length > 0,
            fecha_actualizacion: new Date(),
        } });
    } catch { /* el inventario de la cabecera no debe romper la ingesta del número */ }
}
