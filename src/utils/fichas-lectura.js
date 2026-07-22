/**
 * FICHAS DE LECTURA — registros de lectura PRIVADOS del administrador, enlazados a un documento, una obra o
 * una colección. Una misma entidad puede tener VARIAS (relecturas, varios lectores). Viven en su propia
 * colección `fichas_lectura` (no en `biblioteca`) para no ensuciar el pipeline ni el $jsonSchema: son datos
 * del propietario, no de catalogación.
 *
 * Identidad del enlace: (`ambito`, `ref`) — `ambito` ∈ {documento, obra, coleccion}, `ref` = _id de la
 * entidad en su colección. Índice `idx_ambito_ref` (scripts/setup-mongo.js).
 *
 * El texto rico (`notas_html`) se SANEA siempre al guardar (defensa en profundidad; ver utils/sanear-html.js):
 * se almacena y se re-inyecta en la página, así que un `<script>` guardado sería un XSS persistente.
 */
import { ObjectId } from 'mongodb';
import { sanearHtml } from './sanear-html.js';

// Colección Mongo de la entidad enlazada, por ámbito. Sirve además para VALIDAR que la entidad existe.
export const COL_POR_AMBITO = { documento: 'biblioteca', obra: 'obras', coleccion: 'colecciones' };
const ESTADOS = new Set(['por_leer', 'leyendo', 'leido', 'abandonado']);

// 'YYYY-MM-DD' (o ISO) → Date; vacío/ inválido → null.
function parseFecha(v) {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Convierte el `body` de entrada en {$set, $unset} aplicando solo los campos PRESENTES (para no pisar los que
 * no se envían) y validándolos. Un campo de fecha presente pero vacío → $unset (permite «borrar» una fecha).
 */
export function camposFicha(body = {}) {
    const set = {}, unset = {};
    if ('titulo_ficha' in body) set.titulo_ficha = String(body.titulo_ficha || '').slice(0, 200).trim();
    if ('lector' in body) set.lector = String(body.lector || '').slice(0, 120).trim();
    if ('estado' in body && ESTADOS.has(body.estado)) set.estado = body.estado;
    if ('valoracion' in body) {
        const v = Math.round(Number(body.valoracion));
        set.valoracion = v >= 0 && v <= 5 ? v : 0;
    }
    if ('fecha_inicio' in body) { const f = parseFecha(body.fecha_inicio); if (f) set.fecha_inicio = f; else unset.fecha_inicio = ''; }
    if ('fecha_fin' in body) { const f = parseFecha(body.fecha_fin); if (f) set.fecha_fin = f; else unset.fecha_fin = ''; }
    if ('notas_html' in body) set.notas_html = sanearHtml(String(body.notas_html || ''));
    return { set, unset };
}

/** ¿Existe la entidad (documento/obra/colección) a la que se quiere enlazar la ficha? */
export async function entidadExiste(db, ambito, ref) {
    const col = COL_POR_AMBITO[ambito];
    if (!col || !ObjectId.isValid(ref)) return false;
    const e = await db.collection(col).findOne({ _id: new ObjectId(ref) }, { projection: { _id: 1 } });
    return !!e;
}

/** Fichas de una entidad, más nuevas primero (por fecha de actualización). */
export async function listarFichas(db, ambito, ref) {
    if (!COL_POR_AMBITO[ambito] || !ObjectId.isValid(ref)) return [];
    return db.collection('fichas_lectura')
        .find({ ambito, ref: new ObjectId(ref) })
        .sort({ fecha_actualizacion: -1 })
        .toArray();
}

/** Crea una ficha (borrador) enlazada a una entidad ya validada. Devuelve el doc insertado. */
export async function crearFicha(db, { ambito, ref, ...resto }) {
    const { set } = camposFicha(resto);
    const ahora = new Date();
    const ficha = {
        ambito,
        ref: new ObjectId(ref),
        titulo_ficha: set.titulo_ficha || '',
        lector: set.lector || '',
        estado: set.estado || 'por_leer',
        valoracion: set.valoracion ?? 0,
        notas_html: set.notas_html || '',
        ...(set.fecha_inicio ? { fecha_inicio: set.fecha_inicio } : {}),
        ...(set.fecha_fin ? { fecha_fin: set.fecha_fin } : {}),
        fecha_creacion: ahora,
        fecha_actualizacion: ahora,
    };
    const r = await db.collection('fichas_lectura').insertOne(ficha);
    return { ...ficha, _id: r.insertedId };
}

/** Actualiza los campos presentes de una ficha. Devuelve la ficha resultante o null si no existe. */
export async function actualizarFicha(db, id, body) {
    if (!ObjectId.isValid(id)) return null;
    const { set, unset } = camposFicha(body);
    set.fecha_actualizacion = new Date();
    const upd = { $set: set };
    if (Object.keys(unset).length) upd.$unset = unset;
    const r = await db.collection('fichas_lectura').findOneAndUpdate(
        { _id: new ObjectId(id) }, upd, { returnDocument: 'after' });
    // Driver v6 devuelve el DOCUMENTO directamente (o null); v4/5 lo envolvían en {value}. `r?.value ?? r`
    // cubre ambos SIN petar cuando no se encuentra (r === null → devuelve null).
    return r?.value ?? r ?? null;
}

/** Borra una ficha. Devuelve la ficha borrada (para reciclar sus imágenes) o null. */
export async function borrarFicha(db, id) {
    if (!ObjectId.isValid(id)) return null;
    const r = await db.collection('fichas_lectura').findOneAndDelete({ _id: new ObjectId(id) });
    return r?.value ?? r ?? null; // v6 → documento (o null); v4/5 → {value}
}
