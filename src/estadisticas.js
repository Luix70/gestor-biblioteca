import { conectarDB } from './database.js';
import { sanitizarCDU } from './utils/cdu-arbol.js';

/**
 * Estadísticas del catálogo para el endpoint GET /api/estadisticas.
 *   - total y reparto libros/revistas
 *   - revistas: cabeceras únicas con su nº de números (issues)
 *   - CDU: cada código con su descripción (ES/EN) y nº de documentos
 *   - defectos: libros sin ISBN, sin hash, sin portada, CDU genérica, pendientes…
 *
 * @param {object} opciones { detalle = true }  — detalle=false omite las listas largas (resumen).
 */
export async function obtenerEstadisticas({ detalle = true } = {}) {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // ── Totales por tipo ──────────────────────────────────────────────────────
    const porTipo = await col.aggregate([{ $group: { _id: '$tipo_recurso', n: { $sum: 1 } } }]).toArray();
    const tipos = Object.fromEntries(porTipo.map(t => [t._id || 'sin_tipo', t.n]));
    const total = porTipo.reduce((s, t) => s + t.n, 0);

    // ── Revistas: cabeceras únicas (por ISSN, o título si no hay) con nº de números ──
    const revistasAgg = await col.aggregate([
        { $match: { tipo_recurso: 'revista' } },
        { $group: { _id: { $ifNull: ['$issn', '$titulo'] }, titulo: { $first: '$titulo' }, issn: { $first: '$issn' }, numeros: { $sum: 1 } } },
        { $sort: { numeros: -1, titulo: 1 } },
    ]).toArray();
    const revistas = {
        cabeceras: revistasAgg.length,
        total_numeros: revistasAgg.reduce((s, r) => s + r.numeros, 0),
        ...(detalle ? { detalle: revistasAgg.map(r => ({ titulo: r.titulo, issn: r.issn || null, numeros: r.numeros })) } : {}),
    };

    // ── CDU: código → descripción + nº de documentos ──────────────────────────
    const cduAgg = await col.aggregate([
        { $group: { _id: { $ifNull: ['$cdu', 'sin_cdu'] }, n: { $sum: 1 } } },
        { $sort: { n: -1 } },
    ]).toArray();
    const descs = await db.collection('cdu_descripciones')
        .find({}, { projection: { codigo: 1, titulo_es: 1, titulo_en: 1 } }).toArray();
    const descMap = new Map(descs.map(d => [d.codigo, d]));
    const cduDetalle = cduAgg.map(g => {
        const d = descMap.get(sanitizarCDU(g._id));
        return { cdu: g._id, titulo_es: d?.titulo_es || null, titulo_en: d?.titulo_en || null, documentos: g.n };
    });

    // ── Defectos (faltas a vigilar) ───────────────────────────────────────────
    const ausente = (campo) => ({ $or: [{ [campo]: { $exists: false } }, { [campo]: null }, { [campo]: '' }] });
    const defectos = {
        libros_sin_isbn:  await col.countDocuments({ tipo_recurso: 'libro', ...ausente('isbn') }),
        sin_hash:         await col.countDocuments(ausente('hash_contenido')),
        sin_portada:      await col.countDocuments(ausente('portada')),
        cdu_generica:     await col.countDocuments({ cdu: { $in: ['00', '0', '000'] } }),
        pendientes:       await col.countDocuments({ estado_verificacion: 'pendiente' }),
        sin_coleccion:    await col.countDocuments(ausente('coleccion')),
    };

    // ── Anomalías de obras multivolumen (a vigilar en ejecuciones desatendidas) ──
    // "obras incompletas" es esperable (hay obras que llegan a medias); pero revision_requerida y
    // los tomos sin número señalan que algo se guardó "desordenado" para NO perderlo → revisar.
    const obrasCol = db.collection('obras');
    const obrasRevision = await obrasCol.find(
        { revision_requerida: true },
        { projection: { titulo: 1, isbn_obra: 1, total_volumenes: 1, volumenes_presentes: 1 } }
    ).toArray();
    const anomalias = {
        obras_total:          await obrasCol.countDocuments(),
        obras_incompletas:    await obrasCol.countDocuments({ completa: false }),
        obras_revision:       obrasRevision.length,
        tomos_sin_numero:     await obrasCol.countDocuments({ 'volumenes_sin_numero.0': { $exists: true } }),
        docs_revision:        await col.countDocuments({ revision_requerida: true }),
        ...(detalle ? { obras_revision_detalle: obrasRevision.map(o => ({
            titulo: o.titulo, isbn_obra: o.isbn_obra || null,
            tomos: `${o.volumenes_presentes || 0}/${o.total_volumenes || '?'}`,
        })) } : {}),
    };

    return {
        generado: new Date().toISOString(),
        total,
        libros: tipos.libro || 0,
        revistas_total: tipos.revista || 0,
        revistas,
        cdu: { distintos: cduDetalle.length, ...(detalle ? { detalle: cduDetalle } : {}) },
        colecciones: await db.collection('colecciones').countDocuments(),
        defectos,
        anomalias,
    };
}
