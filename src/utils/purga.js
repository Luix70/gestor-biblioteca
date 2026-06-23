import fs from 'fs/promises';
import path from 'path';
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { reciclar } from './papelera.js';

/**
 * Purga una OBRA multivolumen mal catalogada para re-ingerirla limpia: elimina la obra y TODOS sus
 * tomos de `biblioteca`, y MUEVE sus carpetas CDU a la Papelera (política "nunca borrar"). Reutilizable
 * desde el script `scripts/purgar-multipart.js` y desde el panel (POST /api/obras/purgar).
 *
 * @param clave   isbn_obra o título de la obra
 * @param ejecutar  false = SIMULACIÓN (no toca nada); true = aplica
 * @returns { ok, simulacion, obra, tomos|eliminados, motivo? }
 */
export async function purgarObra(db, clave, { ejecutar = false } = {}) {
    const obras = db.collection('obras');
    const bib = db.collection('biblioteca');
    const obra = await obras.findOne({ $or: [{ isbn_obra: clave }, { titulo: clave }] });
    if (!obra) return { ok: false, motivo: `No hay obra con isbn_obra/título "${clave}".` };

    const tomos = await bib.find({ obra: obra._id }).toArray();
    const detalle = tomos.map(t => ({ _id: String(t._id), vol: t.volumen_numero ?? null, isbn: t.isbn || null, titulo: t.titulo }));
    const cabecera = { titulo: obra.titulo, isbn_obra: obra.isbn_obra || null };

    if (!ejecutar) return { ok: true, simulacion: true, obra: cabecera, tomos: detalle };

    for (const t of tomos) {
        const carpeta = carpetaDeDoc(t);
        const ents = await fs.readdir(carpeta).catch(() => []);
        if (ents.length) {
            await reciclar(ents.map(n => path.join(carpeta, n)), `purga-${obra.isbn_obra || obra._id}`);
            await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
        }
    }
    const r = await bib.deleteMany({ obra: obra._id });
    await obras.deleteOne({ _id: obra._id });
    return { ok: true, simulacion: false, obra: cabecera, eliminados: r.deletedCount };
}
