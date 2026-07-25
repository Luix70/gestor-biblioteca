/**
 * REGISTRO DE ACTIVIDAD — traza de qué hace cada usuario: accesos (login), búsquedas (texto y CDU), APERTURAS
 * de fichas/autores/obras/colecciones y DESCARGAS, con la IP desde la que se conecta. Colección
 * `registro_actividad`, con índice TTL (caduca sola; ver setup-mongo · REGISTRO_TTL_DIAS).
 *
 * Es BEST-EFFORT: registrar NUNCA lanza ni bloquea el flujo (una traza perdida no debe romper una descarga ni
 * una búsqueda). Un anti-avalancha en memoria colapsa los re-fetch inmediatos (volver atrás re-pinta la ficha
 * → un solo «abrir» no debe contar diez veces), pero NO pierde aperturas reales separadas en el tiempo.
 */
import { conectarDB } from '../database.js';

const COL = 'registro_actividad';
export const TIPOS = ['acceso', 'acceso_fallido', 'busqueda', 'vista', 'descarga'];
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** IP del cliente. Con `trust proxy` activo, req.ip ya resuelve X-Forwarded-For; se limpia el prefijo IPv4-mapped. */
export function ipDe(req) {
    const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || req.ip || req.socket?.remoteAddress || '';
    return String(ip).replace(/^::ffff:/, '') || null;
}

/**
 * Registra un evento. `evento` = { tipo, usuario, rol, ip, detalle }. Best-effort: cualquier fallo se traga.
 * No se espera (fire-and-forget) desde los endpoints para no añadir latencia.
 */
export async function registrar(evento = {}) {
    try {
        const db = await conectarDB();
        await db.collection(COL).insertOne({
            ts: new Date(),
            tipo: TIPOS.includes(evento.tipo) ? evento.tipo : 'otro',
            usuario: evento.usuario || null,
            rol: evento.rol || null,
            ip: evento.ip || null,
            detalle: evento.detalle || null,
        });
    } catch { /* el registro es accesorio: nunca debe romper la operación */ }
}

// Anti-avalancha: recuerda la última vez (ms) que se vio una clave; devuelve true solo si ha pasado la ventana.
const _visto = new Map();
export function debeRegistrar(clave, ventanaMs = 8000) {
    const ahora = Date.now();
    const ult = _visto.get(clave) || 0;
    if (ahora - ult < ventanaMs) return false;
    _visto.set(clave, ahora);
    if (_visto.size > 2000) for (const [k, v] of _visto) if (ahora - v > 60000) _visto.delete(k); // limpieza ocasional
    return true;
}

/** Atajo para registrar una APERTURA (vista) de una entidad, con anti-avalancha por (usuario, entidad, id). */
export function registrarVista(req, sess, entidad, id, extra = {}) {
    const usuario = sess?.usuario || null;
    if (!debeRegistrar(`v:${usuario || '?'}:${entidad}:${id}`)) return;
    registrar({ tipo: 'vista', usuario, rol: sess?.rol || null, ip: ipDe(req), detalle: { entidad, id: String(id), ...extra } });
}

/** Atajo para registrar una DESCARGA (sin anti-avalancha: cada descarga cuenta). */
export function registrarDescarga(req, sess, id, extra = {}) {
    registrar({ tipo: 'descarga', usuario: sess?.usuario || null, rol: sess?.rol || null, ip: ipDe(req), detalle: { entidad: 'documento', id: String(id), ...extra } });
}

/**
 * Consulta paginada para el visor (admin). Filtros: tipo, usuario (exacto), entidad (detalle.entidad),
 * q (texto en el título/consulta), desde/hasta (ISO). Orden por fecha desc.
 */
export async function listarActividad({ tipo, usuario, entidad, q, desde, hasta, page = 1, porPagina = 50 } = {}) {
    const db = await conectarDB();
    const match = {};
    if (TIPOS.includes(tipo)) match.tipo = tipo;
    if (usuario) match.usuario = usuario;
    if (entidad) match['detalle.entidad'] = entidad;
    if (q) {
        const rx = { $regex: escapeRegex(q), $options: 'i' };
        match.$or = [{ 'detalle.q': rx }, { 'detalle.titulo': rx }, { 'detalle.cdu': rx }];
    }
    if (desde || hasta) {
        match.ts = {};
        if (desde) match.ts.$gte = new Date(desde);
        if (hasta) match.ts.$lte = new Date(hasta);
    }
    const pp = Math.min(200, Math.max(1, Number(porPagina) || 50));
    const pg = Math.max(1, Number(page) || 1);
    const col = db.collection(COL);
    const total = await col.countDocuments(match);
    const items = await col.find(match).sort({ ts: -1 }).skip((pg - 1) * pp).limit(pp).toArray();
    return { total, page: pg, porPagina: pp, items };
}

/** Resumen para las tarjetas del panel: totales por tipo y usuarios más activos en los últimos `dias` días. */
export async function resumenActividad({ dias = 30 } = {}) {
    const db = await conectarDB();
    const desde = new Date(Date.now() - dias * 86400000);
    const col = db.collection(COL);
    const porTipo = await col.aggregate([
        { $match: { ts: { $gte: desde } } },
        { $group: { _id: '$tipo', n: { $sum: 1 } } },
    ]).toArray();
    const topUsuarios = await col.aggregate([
        { $match: { ts: { $gte: desde }, usuario: { $ne: null } } },
        { $group: { _id: '$usuario', n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 10 },
    ]).toArray();
    const total = await col.estimatedDocumentCount();
    return {
        dias,
        total,
        porTipo: Object.fromEntries(porTipo.map((t) => [t._id, t.n])),
        topUsuarios: topUsuarios.map((u) => ({ usuario: u._id, n: u.n })),
    };
}

/** Usuarios distintos que aparecen en el registro (para el selector del visor). */
export async function usuariosDelRegistro() {
    const db = await conectarDB();
    return (await db.collection(COL).distinct('usuario')).filter(Boolean).sort();
}

/** Último acceso (login) por usuario → para mostrarlo en la lista de credenciales. Devuelve { user: Date }. */
export async function ultimoAccesoPorUsuario() {
    const db = await conectarDB();
    const filas = await db.collection(COL).aggregate([
        { $match: { tipo: 'acceso', usuario: { $ne: null } } },
        { $group: { _id: '$usuario', ts: { $max: '$ts' } } },
    ]).toArray();
    return Object.fromEntries(filas.map((f) => [f._id, f.ts]));
}
