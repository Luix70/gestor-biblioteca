import { conectarDB } from '../database.js';
import { TAREAS } from './tareas.js';
import { carpetaDeDoc, carpetaExiste, aplicarCambio } from './util-mantenimiento.js';

// Firma del conjunto de tareas+versiones. Un documento se considera "conforme" cuando su
// mantenimiento_firma coincide con esta. Añadir una tarea o subir una 'version' cambia la
// firma → todos los documentos vuelven a entrar en la cola de mantenimiento.
const FIRMA = TAREAS.map(t => `${t.id}:${t.version}`).join('|');
const LOTE = Number(process.env.MANTENIMIENTO_LOTE || 25);     // documentos por pasada
const PAUSA_MS = Number(process.env.MANTENIMIENTO_PAUSA_MS || 800); // ritmo entre documentos

/**
 * Una pasada de mantenimiento: toma un lote de documentos aún no conformes a la firma actual,
 * ejecuta sobre cada uno las tareas que le falten (a su versión) y los sella. Cede el turno
 * en cuanto 'debeAbortar()' es true (p. ej. llegó algo al Inbox) — la ingesta tiene prioridad.
 *
 * @returns { revisados, cambios, pendientes, abortado }
 */
export async function ejecutarMantenimiento({ debeAbortar = async () => false } = {}) {
    let db;
    try { db = await conectarDB(); } catch { return { revisados: 0, cambios: 0, pendientes: -1, abortado: true }; }
    const col = db.collection('biblioteca');

    const docs = await col.find({ mantenimiento_firma: { $ne: FIRMA } }).limit(LOTE).toArray();
    if (!docs.length) return { revisados: 0, cambios: 0, pendientes: 0, abortado: false };

    console.log(`🧹 [Mantenimiento] Conformando hasta ${docs.length} documento(s)...`);
    let revisados = 0, cambios = 0;

    for (const doc of docs) {
        if (await debeAbortar()) {
            console.log('🧹 [Mantenimiento] Actividad en el Inbox → cedo el turno (se reanuda al quedar libre).');
            return { revisados, cambios, pendientes: -1, abortado: true };
        }

        const carpeta = carpetaDeDoc(doc);
        // Si la carpeta no está en esta máquina, NO sellar: lo hará la que tenga los ficheros
        // (el NAS). Evita que un arranque local "conforme" en falso documentos del NAS.
        if (!(await carpetaExiste(carpeta))) continue;

        const sello = { ...(doc.mantenimiento || {}) };

        for (const tarea of TAREAS) {
            if (sello[tarea.id] === tarea.version) continue; // ya hecha a esta versión
            try {
                if (tarea.aplica(doc)) {
                    const cambio = await tarea.ejecutar(doc, { db });
                    if (cambio) {
                        await aplicarCambio(col, doc, carpeta, cambio);
                        Object.assign(doc, cambio.set || {});                 // reflejar para tareas posteriores
                        if (cambio.imagenesNuevas) doc.imagenes = [...(doc.imagenes || []), ...cambio.imagenesNuevas];
                        cambios++;
                        console.log(`   ✔ ${tarea.id} · ${doc.titulo || doc._id}`);
                    }
                }
            } catch (e) {
                console.warn(`   ⚠️ ${tarea.id} falló en "${doc.titulo || doc._id}": ${e.message}`);
            }
            sello[tarea.id] = tarea.version; // se sella aunque no aplicara/fallara (sin bucles)
        }

        await col.updateOne({ _id: doc._id }, { $set: { mantenimiento: sello, mantenimiento_firma: FIRMA } });
        revisados++;
        await new Promise(r => setTimeout(r, PAUSA_MS));
    }

    const pendientes = await col.countDocuments({ mantenimiento_firma: { $ne: FIRMA } });
    console.log(`🧹 [Mantenimiento] Lote: ${revisados} revisados · ${cambios} cambios · ${pendientes} pendientes.`);
    return { revisados, cambios, pendientes, abortado: false };
}
