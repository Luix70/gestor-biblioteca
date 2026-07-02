import fs from 'node:fs';
import { conectarDB } from '../database.js';
import { TAREAS } from './tareas.js';
import { carpetaDeDoc, carpetaExiste, aplicarCambio } from './util-mantenimiento.js';

// Firma del conjunto de tareas+versiones. Un documento se considera "conforme" cuando su
// mantenimiento_firma coincide con esta. Añadir una tarea o subir una 'version' cambia la
// firma → todos los documentos vuelven a entrar en la cola de mantenimiento.
const FIRMA = TAREAS.map(t => `${t.id}:${t.version}`).join('|');
const LOTE = Number(process.env.MANTENIMIENTO_LOTE || 25);     // documentos por pasada
const PAUSA_MS = Number(process.env.MANTENIMIENTO_PAUSA_MS || 800); // ritmo entre documentos

// El mantenimiento SOLO debe correr donde viven los ficheros: el contenedor del NAS. Fuera de
// Docker (p. ej. un `npm start` local contra el mismo Atlas) "conformaría" en falso documentos
// cuyos ficheros están en el NAS y no aquí. /.dockerenv existe en todo contenedor Docker.
const EN_CONTENEDOR = fs.existsSync('/.dockerenv');
const PUEDE_MANTENER = EN_CONTENEDOR || process.env.MANTENIMIENTO_FORZAR === '1';

/**
 * Una pasada de mantenimiento: toma un lote de documentos aún no conformes a la firma actual,
 * ejecuta sobre cada uno las tareas que le falten (a su versión) y los sella. Cede el turno
 * en cuanto 'debeAbortar()' es true (p. ej. llegó algo al Inbox) — la ingesta tiene prioridad.
 *
 * @returns { revisados, cambios, pendientes, abortado }
 */
export async function ejecutarMantenimiento({ debeAbortar = async () => false } = {}) {
    if (!PUEDE_MANTENER) return { revisados: 0, cambios: 0, pendientes: 0, abortado: false };

    let db;
    try { db = await conectarDB(); } catch { return { revisados: 0, cambios: 0, pendientes: -1, abortado: true }; }
    const col = db.collection('biblioteca');

    // `locked` = fijado por intervención humana → el Conformador NO lo toca (ni lo cuenta como pendiente).
    const docs = await col.find({ mantenimiento_firma: { $ne: FIRMA }, locked: { $ne: true } }).limit(LOTE).toArray();
    if (!docs.length) return { revisados: 0, cambios: 0, pendientes: 0, abortado: false };

    console.log(`🧹 [Mantenimiento] Conformando hasta ${docs.length} documento(s)...`);
    let revisados = 0, cambios = 0;

    for (const doc of docs) {
        if (await debeAbortar()) {
            console.log('🧹 [Mantenimiento] Actividad en el Inbox → cedo el turno (se reanuda al quedar libre).');
            return { revisados, cambios, pendientes: -1, abortado: true };
        }
        cambios += await conformarDocumento(db, doc);
        revisados++;
        await new Promise(r => setTimeout(r, PAUSA_MS));
    }

    const pendientes = await col.countDocuments({ mantenimiento_firma: { $ne: FIRMA }, locked: { $ne: true } });
    console.log(`🧹 [Mantenimiento] Lote: ${revisados} revisados · ${cambios} cambios · ${pendientes} pendientes.`);
    return { revisados, cambios, pendientes, abortado: false };
}

/**
 * Conforma UN documento: ejecuta sobre él las tareas que le falten (a su versión) y lo sella con la
 * firma actual. Devuelve el nº de cambios aplicados. Compartido por la pasada por lotes y por el
 * conformado al ingerir. NO comprueba `locked` ni `debeAbortar` (eso lo deciden los llamantes).
 */
async function conformarDocumento(db, doc) {
    const col = db.collection('biblioteca');
    const carpeta = carpetaDeDoc(doc);
    const existe = await carpetaExiste(carpeta);
    const sello = { ...(doc.mantenimiento || {}) };
    let cambios = 0;

    if (existe) {
        for (const tarea of TAREAS) {
            if (sello[tarea.id] === tarea.version) continue; // ya hecha a esta versión
            try {
                if (tarea.aplica(doc)) {
                    const cambio = await tarea.ejecutar(doc, { db });
                    if (cambio) {
                        // re-clasificar-cdu mueve la carpeta: registro.json va al nuevo destino
                        const carpetaEfectiva = cambio.carpetaNueva || carpeta;
                        await aplicarCambio(col, doc, carpetaEfectiva, cambio);
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
    } else {
        // Huérfano: el documento existe en Atlas pero su carpeta CDU no (ficheros borrados).
        // No hay nada que conformar; se sella IGUAL para no revisitarlo en cada pasada.
        console.warn(`   🗁  ${doc.titulo || doc._id}: sin carpeta CDU (huérfano); se sella sin acción.`);
    }

    await col.updateOne({ _id: doc._id }, { $set: { mantenimiento: sello, mantenimiento_firma: FIRMA } });
    return cambios;
}

/**
 * SALUD de un documento (para la ficha 🩺): por cada tarea de mantenimiento indica si está HECHA a su
 * versión actual, si le APLICA a este documento, y qué versión tiene sellada. Más la firma global y los
 * flags que afectan al Conformador (locked, cdu_manual). Solo lectura; no toca nada.
 */
export function saludDocumento(doc) {
    const sello = doc.mantenimiento || {};
    const tareas = TAREAS.map((t) => ({
        id: t.id,
        descripcion: t.descripcion,
        version: t.version,
        version_doc: sello[t.id] ?? null,
        hecha: sello[t.id] === t.version,
        aplica: (() => { try { return !!t.aplica(doc); } catch { return false; } })(),
    }));
    return {
        firma_actual: FIRMA,
        firma_doc: doc.mantenimiento_firma || null,
        conforme: doc.mantenimiento_firma === FIRMA,
        locked: !!doc.locked,
        cdu_manual: !!doc.cdu_manual,
        tareas,
    };
}

/**
 * Des-sella tareas concretas de un documento (checkboxes desmarcados en la ficha): quita su marca de
 * `mantenimiento` para que el Conformador VUELVA a ejecutarlas. `ids` vacío = des-sella TODAS. Además pone
 * `mantenimiento_firma` a null para que el documento se considere no-conforme y se revisite.
 */
export async function dessellarTareas(db, docId, ids = []) {
    const doc = await db.collection('biblioteca').findOne({ _id: docId }, { projection: { mantenimiento: 1 } });
    if (!doc) return { ok: false, motivo: 'sin-doc' };
    const sello = { ...(doc.mantenimiento || {}) };
    const aQuitar = Array.isArray(ids) && ids.length ? ids : Object.keys(sello);
    let dessellada = 0;
    for (const id of aQuitar) { if (id in sello) { delete sello[id]; dessellada++; } }
    await db.collection('biblioteca').updateOne(
        { _id: docId },
        { $set: { mantenimiento: sello, mantenimiento_firma: null } },
    );
    return { ok: true, dessellada };
}

/**
 * Conforma AL VUELO el documento recién catalogado (por _id) — para "acertar desde el principio" en
 * ingestas sueltas/manuales (toggle CONFORMAR_AL_INGERIR u opción por petición). Respeta `locked` y
 * solo actúa donde el Conformador puede (contenedor del NAS, junto a los ficheros). Best-effort.
 */
export async function conformarAlIngerir(docId) {
    if (!PUEDE_MANTENER) return { ok: false, motivo: 'fuera-de-contenedor' };
    let db;
    try { db = await conectarDB(); } catch { return { ok: false, motivo: 'sin-bd' }; }
    const doc = await db.collection('biblioteca').findOne({ _id: docId });
    if (!doc) return { ok: false, motivo: 'sin-doc' };
    if (doc.locked) return { ok: false, motivo: 'locked' };
    const cambios = await conformarDocumento(db, doc);
    return { ok: true, cambios };
}
