/**
 * USUARIOS EN BASE DE DATOS — credenciales gestionadas desde el panel (además del admin de arranque del .env,
 * que se conserva como SALVAVIDAS anti-bloqueo). Solo dos roles: 'admin' (puede todo) y 'guest' (invitado,
 * solo lectura). El acceso genérico compartido «guest» del .env queda DESACTIVADO: cada invitado tiene su
 * propia credencial con nombre, para poder atribuir el registro de actividad a una persona.
 *
 * Contraseñas: NUNCA en claro. Hash con scrypt (Node nativo, sin dependencias) + salt por usuario, y
 * comparación en tiempo constante. La colección `usuarios` tiene índice único (insensible a mayúsculas/acentos)
 * sobre `user` para no duplicar «Maria»/«maría».
 */
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';

const COL = 'usuarios';
const COLLATION = { locale: 'es', strength: 1 }; // insensible a mayúsculas/acentos

/** Hash scrypt de una contraseña (con salt nuevo si no se pasa). Devuelve {salt, hash} en hex. */
export function hashPassword(pwd, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(String(pwd), salt, 64).toString('hex');
    return { salt, hash };
}

/** Verifica una contraseña contra su {salt, hash} en tiempo constante. */
export function verifyPassword(pwd, salt, hash) {
    if (!salt || !hash) return false;
    let h;
    try { h = crypto.scryptSync(String(pwd), salt, 64).toString('hex'); } catch { return false; }
    const a = Buffer.from(h, 'hex'), b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const norm = (rol) => (rol === 'admin' ? 'admin' : 'guest');

/** Busca un usuario por nombre (insensible a mayúsculas/acentos). */
export async function buscarUsuario(user) {
    const db = await conectarDB();
    return db.collection(COL).findOne({ user: String(user || '').trim() }, { collation: COLLATION });
}

/** Comprueba credenciales contra la BD. Devuelve {user, rol} o null (rechaza los desactivados). */
export async function autenticarEnBD(user, password) {
    const u = await buscarUsuario(user);
    if (!u || u.activo === false) return null;
    if (!verifyPassword(password, u.pwd_salt, u.pwd_hash)) return null;
    return { user: u.user, rol: norm(u.rol) };
}

/** ¿La contraseña coincide con la de ALGÚN admin ACTIVO de la BD? (re-confirmación de acciones destructivas). */
export async function verificarPasswordAdminBD(password) {
    if (!password) return false;
    const db = await conectarDB();
    const admins = await db.collection(COL)
        .find({ rol: 'admin', activo: { $ne: false } }, { projection: { pwd_salt: 1, pwd_hash: 1 } }).toArray();
    return admins.some((a) => verifyPassword(password, a.pwd_salt, a.pwd_hash));
}

/** Lista de usuarios de la BD SIN los campos de contraseña (para el panel de administración). */
export async function listarUsuariosBD() {
    const db = await conectarDB();
    return db.collection(COL)
        .find({}, { projection: { pwd_salt: 0, pwd_hash: 0 } })
        .collation(COLLATION).sort({ user: 1 }).toArray();
}

/** Nº de administradores ACTIVOS en la BD (para no dejar el sistema sin admin al editar/borrar). */
export async function contarAdminsActivosBD() {
    const db = await conectarDB();
    return db.collection(COL).countDocuments({ rol: 'admin', activo: { $ne: false } });
}

/** Crea una credencial. Valida nombre único (insensible a may/acentos) y longitud mínima de contraseña. */
export async function crearUsuario({ user, password, rol, nota } = {}) {
    const nombre = String(user || '').trim();
    if (!nombre) return { ok: false, motivo: 'indica un nombre de usuario' };
    if (!password || String(password).length < 4) return { ok: false, motivo: 'la contraseña debe tener al menos 4 caracteres' };
    if (await buscarUsuario(nombre)) return { ok: false, motivo: 'ya existe un usuario con ese nombre' };
    const db = await conectarDB();
    const { salt, hash } = hashPassword(password);
    const r = await db.collection(COL).insertOne({
        user: nombre, rol: norm(rol), pwd_salt: salt, pwd_hash: hash,
        activo: true, nota: String(nota || '').trim(), creado: new Date(), actualizado: new Date(),
    });
    return { ok: true, id: String(r.insertedId) };
}

/**
 * Edita una credencial. Cambios admitidos: user (renombra, comprueba duplicado), password (re-hashea),
 * rol, activo, nota. Devuelve {ok} o {ok:false, motivo}. La protección de «último admin» la aplica el
 * endpoint (que conoce también los admin de arranque del .env).
 */
export async function editarUsuario(id, cambios = {}) {
    if (!ObjectId.isValid(id)) return { ok: false, motivo: 'id inválido' };
    const db = await conectarDB();
    const _id = new ObjectId(id);
    const actual = await db.collection(COL).findOne({ _id });
    if (!actual) return { ok: false, motivo: 'usuario no encontrado' };
    const set = { actualizado: new Date() };
    if (cambios.user != null) {
        const nuevo = String(cambios.user).trim();
        if (!nuevo) return { ok: false, motivo: 'el nombre no puede quedar vacío' };
        const otro = await buscarUsuario(nuevo);
        if (otro && String(otro._id) !== id) return { ok: false, motivo: 'ya existe otro usuario con ese nombre' };
        set.user = nuevo;
    }
    if (cambios.password != null && cambios.password !== '') {
        if (String(cambios.password).length < 4) return { ok: false, motivo: 'la contraseña debe tener al menos 4 caracteres' };
        const { salt, hash } = hashPassword(cambios.password);
        set.pwd_salt = salt; set.pwd_hash = hash;
    }
    if (cambios.rol != null) set.rol = norm(cambios.rol);
    if (typeof cambios.activo === 'boolean') set.activo = cambios.activo;
    if (cambios.nota != null) set.nota = String(cambios.nota).trim();
    await db.collection(COL).updateOne({ _id }, { $set: set });
    return { ok: true };
}

/** Borra una credencial por id. (La protección de «último admin» la aplica el endpoint.) */
export async function borrarUsuario(id) {
    if (!ObjectId.isValid(id)) return { ok: false, motivo: 'id inválido' };
    const db = await conectarDB();
    const r = await db.collection(COL).deleteOne({ _id: new ObjectId(id) });
    return r.deletedCount ? { ok: true } : { ok: false, motivo: 'usuario no encontrado' };
}
