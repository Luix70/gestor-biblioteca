import fs from 'fs/promises';
import path from 'path';
import { aMARCXML } from '../marc21.js';

/**
 * Construye la versión LEGIBLE de un documento para los sidecars (registro.json / .marc.xml):
 * autores y editorial van por NOMBRE (no ObjectId), igual que en la ingesta. Se descartan los
 * campos internos y los valores nulos.
 *
 * @param doc            documento de MongoDB (autores/editorial como ObjectId)
 * @param autores        array de nombres ya resueltos
 * @param editorial      nombre de la editorial ya resuelto (o null)
 * @param contribuciones array [{nombre, rol}] ya resueltos (traductor/ilustrador/…)
 */
export function aRegistroLegible(doc, { autores = [], editorial = null, contribuciones = [] } = {}) {
    const legible = { ...doc };
    legible._id = String(doc._id);
    legible.autores = autores;
    if (editorial) legible.editorial = editorial; else delete legible.editorial;
    // Contribuciones por NOMBRE (no ObjectId). Fuera el campo de trabajo y el crudo con persona-ObjectId.
    delete legible.contribuciones_nombres;
    if (Array.isArray(contribuciones) && contribuciones.length) legible.contribuciones = contribuciones;
    else delete legible.contribuciones;
    // La colección se muestra por su nombre denormalizado (coleccion_nombre); fuera el ObjectId.
    delete legible.coleccion;
    // Campos internos que no van al sidecar.
    delete legible.mantenimiento;
    delete legible.mantenimiento_firma;
    delete legible._portadas_remotas;
    delete legible.sidecars_fecha; // marca interna de «sidecars al día» (no es dato bibliográfico)
    for (const k of Object.keys(legible)) {
        const v = legible[k];
        if (v === undefined || v === null || v === '') delete legible[k];
    }
    return legible;
}

/** Escribe registro.json y registro.marc.xml en la carpeta a partir del objeto legible. */
export async function escribirSidecars(carpeta, legible) {
    await fs.writeFile(path.join(carpeta, 'registro.json'), JSON.stringify(legible, null, 2), 'utf8');
    await fs.writeFile(path.join(carpeta, 'registro.marc.xml'), aMARCXML(legible), 'utf8');
}

/**
 * Regenera los DOS sidecars (registro.json + registro.marc.xml) de un documento desde la BD (fuente de verdad),
 * con los nombres RESUELTOS (autores/editorial/contribuciones), y marca en el doc `sidecars_fecha` = su
 * `fecha_actualizacion` — SIN bumpear `fecha_actualizacion` (si no, el doc parecería «modificado tras el sidecar»
 * para siempre y se regeneraría en bucle).
 *
 * `carpeta` = carpeta ABSOLUTA del documento. Si es null o no existe en disco, NO hay dónde escribir: se marca
 * `sidecars_fecha` igualmente (para que la cola de la campaña DRENE y no reintente eternamente) y se devuelve
 * `{ ok:false, sinCarpeta:true }`. Devuelve `{ ok:true }` si se escribieron.
 *
 * Detección de «pendiente» (ver FILTRO_SIDECARS_DESACTUALIZADOS): un doc se regenera CADA vez que se
 * modifica tras su último sidecar (2, 3, … veces).
 */
export async function regenerarSidecarsDoc(db, doc, carpeta) {
    const marca = doc.fecha_actualizacion || new Date();
    const sellar = () => db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { sidecars_fecha: marca } });
    let existe = false;
    if (carpeta) { try { await fs.access(carpeta); existe = true; } catch { existe = false; } }
    if (!existe) { await sellar(); return { ok: false, sinCarpeta: true }; }
    const { autores, editorial, contribuciones } = await resolverNombres(db, doc);
    const legible = aRegistroLegible(doc, { autores, editorial, contribuciones });
    await escribirSidecars(carpeta, legible);
    await sellar();
    return { ok: true };
}

/**
 * Filtro Mongo de documentos con sidecars DESACTUALIZADOS = MODIFICADOS después de escribir su último sidecar.
 * Línea BASE = cuándo se escribió el sidecar por última vez: `sidecars_fecha` si ya lo regeneramos, y si no
 * `fecha_ingreso` (el sidecar se escribe al INGERIR). Pendiente ⇔ `fecha_actualizacion > base`.
 *
 * Consecuencias (bien): un doc NUNCA modificado (sin `fecha_actualizacion`) no es pendiente —su sidecar de la
 * ingesta ya es correcto, no se regenera de balde—; en cambio, `fecha_actualizacion` SOLO se pone al modificar,
 * así que capta exactamente los cambios (CDU/autores/edición…). Tras regenerar se sella `sidecars_fecha =
 * fecha_actualizacion`, de modo que solo una NUEVA modificación lo vuelve a marcar (no en bucle, aunque
 * `fecha_actualizacion > fecha_ingreso` siga siendo cierto). En Mongo, `$gt` con un lado nulo es falso salvo
 * (fecha > null)=verdadero: un doc con `fecha_actualizacion` pero sin base (raro) también se marca.
 */
export const FILTRO_SIDECARS_DESACTUALIZADOS = {
    $expr: { $gt: ['$fecha_actualizacion', { $ifNull: ['$sidecars_fecha', '$fecha_ingreso'] }] },
};

/** Resuelve los nombres de autores/editorial/contribuciones de un documento (consultas puntuales a la BD). */
export async function resolverNombres(db, doc) {
    const autorIds = (doc.autores || []).filter(Boolean);
    const contribIds = (doc.contribuciones || []).map(c => c && c.persona).filter(Boolean);
    const todos = [...autorIds, ...contribIds];
    const personaDocs = todos.length
        ? await db.collection('autores').find({ _id: { $in: todos } }, { projection: { nombre: 1 } }).toArray()
        : [];
    const amap = new Map(personaDocs.map(a => [String(a._id), a.nombre]));
    const autores = autorIds.map(id => amap.get(String(id)) || String(id));
    const autores_ids = autorIds.map(String); // alineado con `autores` (para enlazar a la ficha del autor)
    // Contribuciones (traductor/ilustrador/…) con el nombre Y el id de persona resueltos (drillables). Si la
    // persona NO existe (p. ej. se borró), se MUESTRA el ObjectId marcado como no resuelto (`desconocido`):
    // «mejor saber lo que no sabes» — así se ve que falta un dato, en vez de ocultarlo en silencio.
    const contribuciones = (doc.contribuciones || [])
        .filter(c => c && c.persona)
        .map(c => {
            const nombre = amap.get(String(c.persona));
            return nombre
                ? { rol: c.rol, nombre, persona: String(c.persona) }
                : { rol: c.rol, nombre: `⚠ ${String(c.persona)}`, persona: String(c.persona), desconocido: true };
        });

    let editorial = null;
    if (doc.editorial) {
        const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
        editorial = e ? e.nombre : null;
    }
    return { autores, autores_ids, editorial, contribuciones };
}
