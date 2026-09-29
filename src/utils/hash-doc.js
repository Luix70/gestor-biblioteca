/**
 * HASH DEL DOCUMENTO — regenerarlo cuando el fichero cambia y detectar cuándo ha quedado desactualizado.
 *
 * El `hash_contenido` (SHA-256 del fichero original) se calcula al ingerir y es la IDENTIDAD de contenido: con él
 * se reconoce una copia exacta que vuelve a entrar por el Inbox. Pero si tú MODIFICAS el fichero (quitas de un
 * PDF una página artefacto, le añades anotaciones…), el hash de la ingesta deja de ser el del fichero.
 *
 * Por eso, con cada hash se guarda la HUELLA DEL FICHERO en ese momento:
 *   · hash_fecha  — cuándo se calculó;
 *   · hash_mtime  — la fecha de modificación del fichero en disco (ms);
 *   · hash_tamano — su tamaño en bytes.
 * Si el fichero cambia, su tamaño o su fecha de modificación ya no coinciden → SOSPECHOSO, detectable con un simple
 * `stat` (sin leer el fichero). Solo al REGENERAR se lee entero para calcular el hash (en streaming: RAM mínima).
 *
 * Los documentos anteriores a esto no tienen huella: para ellos es sospechoso si el fichero se modificó más de
 * MARGEN_H horas después de su ingesta (la copia al árbol CDU se hace al ingerir). Mover carpetas o restaurar de la
 * Papelera también cambia esa fecha: por eso un sospechoso se CONFIRMA recalculando el hash — si coincide, solo se
 * anota la huella (queda al día) y no cambia nada más.
 *
 * ANTI-PÉRDIDA: el hash anterior no se tira — pasa a `hashes_anteriores` (con la fecha hasta la que valió). Así, si
 * el fichero ORIGINAL vuelve a entrar por el Inbox, se sigue reconociendo como este mismo documento.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../mantenimiento/util-mantenimiento.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { indexarDoc } from './indice-busqueda.js';

// Documentos antiguos (sin huella): cuánto después de la ingesta puede estar fechado el fichero sin sospechar
// (la copia de un fichero grande al árbol CDU tarda; más allá, alguien lo tocó).
const MARGEN_MS = Number(process.env.HASH_MARGEN_H || 2) * 3600 * 1000;

/** Proyección mínima que necesitan estas funciones. */
export const PROYECCION_HASH = {
    titulo: 1, ruta_base: 1, nombre_archivo: 1, formatos: 1, hash_contenido: 1, hash_mtime: 1, hash_tamano: 1,
    hash_fecha: 1, fecha_ingreso: 1, paginas: 1, hashes_anteriores: 1, audios: 1,
};

/** El fichero original del documento, o null (sin fichero digital, audiolibros de pistas, o no está). */
export async function ficheroDelDoc(doc) {
    if ((doc.formatos || []).includes('papel')) return null;
    if (!doc.nombre_archivo) return null;   // sin nombre no hay un original inequívoco que hashear
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return null;
    const ruta = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);
    return ruta && path.basename(ruta) === doc.nombre_archivo ? ruta : (ruta || null);
}

/**
 * ¿Está al día el hash? Solo mira el `stat` del fichero (barato, no lo lee).
 * @returns {Promise<{estado:'sin-fichero'|'sin-hash'|'al-dia'|'sospechoso', motivo?, ruta?, stat?}>}
 */
export async function estadoHash(doc) {
    const ruta = await ficheroDelDoc(doc);
    if (!ruta) return { estado: 'sin-fichero' };
    let st;
    try { st = await fs.stat(ruta); } catch { return { estado: 'sin-fichero' }; }
    if (!doc.hash_contenido) return { estado: 'sin-hash', ruta, stat: st };
    if (Number.isFinite(doc.hash_mtime) && Number.isFinite(doc.hash_tamano)) {
        if (st.size !== doc.hash_tamano) return { estado: 'sospechoso', motivo: `el tamaño cambió (${doc.hash_tamano} → ${st.size} bytes)`, ruta, stat: st };
        if (Math.abs(st.mtimeMs - doc.hash_mtime) > 1000) return { estado: 'sospechoso', motivo: `modificado el ${new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ')}, después de calcular su hash`, ruta, stat: st };
        return { estado: 'al-dia', ruta, stat: st };
    }
    // Sin huella (anterior a esto): se compara con la fecha de ingesta.
    const ingreso = doc.fecha_ingreso ? new Date(doc.fecha_ingreso).getTime() : null;
    if (ingreso && st.mtimeMs > ingreso + MARGEN_MS) {
        return { estado: 'sospechoso', motivo: `fichero fechado el ${new Date(st.mtimeMs).toISOString().slice(0, 10)}, después de su ingesta (${new Date(ingreso).toISOString().slice(0, 10)})`, ruta, stat: st };
    }
    return { estado: 'al-dia', ruta, stat: st, sinHuella: true };
}

/**
 * RECALCULA el hash del fichero del documento y lo guarda con su huella. Si cambió: el anterior pasa a
 * `hashes_anteriores`, se avisa si otro documento tiene ya el hash nuevo (copia exacta) y, en un PDF, se recuenta
 * el número de páginas (quitar una página lo cambia). Si no cambió: solo se anota la huella (queda al día).
 * @returns {Promise<{ok, cambiado?, antes?, despues?, motivo?, duplicadoDe?, paginas?}>}
 */
export async function regenerarHashDoc(db, doc, { aplicar = true } = {}) {
    const ruta = await ficheroDelDoc(doc);
    if (!ruta) return { ok: false, motivo: 'sin fichero original (papel, audiolibro de pistas o no está en su carpeta)' };
    let st;
    try { st = await fs.stat(ruta); } catch { return { ok: false, motivo: 'el fichero no se puede leer' }; }
    const hash = await calcularHashArchivo(ruta);
    const antes = doc.hash_contenido || null;
    const cambiado = !!antes && antes !== hash;
    const huella = { hash_contenido: hash, hash_fecha: new Date(), hash_mtime: st.mtimeMs, hash_tamano: st.size };
    const res = { ok: true, cambiado, antes, despues: hash, nuevo: !antes };

    const set = { ...huella };
    const update = { $set: set };
    if (cambiado) {
        // El hash anterior se conserva: si el fichero original vuelve a entrar, se reconoce como este documento.
        update.$push = {
            hashes_anteriores: { hash: antes, hasta: new Date() },
            alertas_agente: `Hash regenerado: el fichero cambió (antes ${antes.slice(0, 12)}…, ahora ${hash.slice(0, 12)}…).`,
        };
        set.fecha_actualizacion = new Date();
        // Un PDF al que se le quitan o añaden páginas cambia su número de páginas.
        if (/\.pdf$/i.test(ruta)) {
            const n = await numeroPaginasPdf(ruta).catch(() => 0);
            if (n && n !== doc.paginas) { set.paginas = n; res.paginas = `${doc.paginas || '?'} → ${n}`; }
        }
    }
    if (cambiado || !antes) {
        const otro = await db.collection('biblioteca').findOne({ hash_contenido: hash, _id: { $ne: doc._id } }, { projection: { titulo: 1 } });
        if (otro) {
            res.duplicadoDe = { id: String(otro._id), titulo: otro.titulo };
            (update.$push ||= {}).alertas_agente = `Contenido idéntico (hash) al documento ${otro._id} («${otro.titulo}»): copia exacta — revisar.`;
        }
    }
    if (aplicar) {
        await db.collection('biblioteca').updateOne({ _id: doc._id }, update);
        if (cambiado) await indexarDoc(db, doc._id).catch(() => {});
    }
    return res;
}

// ── LOTE en 2º plano (acción «#️⃣ Regenerar hash» sobre la selección o desde la ficha) ────────────────────────

let trabajo = { en_curso: false, total: 0, hechos: 0, cambiados: 0, iguales: 0, nuevos: 0, fallidos: 0, duplicados: 0, titulo: '', cancelar: false, motivos: [] };
export function estadoRegenerarHash() { return { ...trabajo, motivos: trabajo.motivos.slice(-20) }; }
export function cancelarRegenerarHash() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

export function lanzarRegenerarHash({ ids } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya se están regenerando hashes' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };
    trabajo = { en_curso: true, total: lista.length, hechos: 0, cambiados: 0, iguales: 0, nuevos: 0, fallidos: 0, duplicados: 0, titulo: '', cancelar: false, motivos: [] };
    (async () => {
        try {
            const db = await conectarDB();
            for (const _id of lista) {
                if (trabajo.cancelar) break;
                const doc = await db.collection('biblioteca').findOne({ _id }, { projection: PROYECCION_HASH }).catch(() => null);
                trabajo.titulo = doc?.titulo || '';
                try {
                    const r = doc ? await regenerarHashDoc(db, doc) : { ok: false, motivo: 'documento no encontrado' };
                    if (!r.ok) { trabajo.fallidos++; trabajo.motivos.push(`«${String(doc?.titulo || _id).slice(0, 50)}»: ${r.motivo}`); }
                    else if (r.nuevo) trabajo.nuevos++;
                    else if (r.cambiado) trabajo.cambiados++;
                    else trabajo.iguales++;
                    if (r.duplicadoDe) trabajo.duplicados++;
                } catch (e) { trabajo.fallidos++; trabajo.motivos.push(`«${String(doc?.titulo || _id).slice(0, 50)}»: ${e.message}`); }
                trabajo.hechos++;
            }
        } catch { /* el lote nunca tumba el servidor */ }
        finally { trabajo.en_curso = false; trabajo.titulo = ''; }
    })();
    return { ok: true, total: lista.length };
}
