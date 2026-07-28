import crypto from 'node:crypto';
import { autenticarEnBD, verificarPasswordAdminBD } from './utils/usuarios-db.js';

/**
 * Autenticación del panel. Dos roles: 'admin' (puede TODO) y 'guest' (invitado, SOLO LECTURA — GET; cualquier
 * mutación → 403). Las credenciales viven ahora en la BD (colección `usuarios`, gestionadas desde el panel);
 * el .env se conserva solo como BOOTSTRAP anti-bloqueo (el admin «Luis» y PANEL_USERS). El acceso genérico
 * compartido «guest» del .env queda DESACTIVADO: cada invitado tiene su propia credencial con nombre (para
 * poder atribuirle el registro de actividad).
 *
 * El login devuelve un token FIRMADO (HMAC) y SIN ESTADO: lleva {usuario, rol, expiración} y se valida
 * recomputando la firma → SOBREVIVE a los reinicios del contenedor (ya no hay que re-loguear tras cada
 * deploy) y dura TTL_MS (por defecto 2 días). El panel lo guarda en localStorage y lo manda en
 * `Authorization: Bearer <token>`. logout es best-effort (revoca en memoria; tras un reinicio el token
 * sigue válido hasta expirar, pero el cliente lo descarta igualmente).
 */
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'Luis';
const ADMIN_PASS = process.env.ADMIN_PWD || process.env.PANEL_ADMIN_PASSWORD || '';
// GUEST_PASS ya NO crea un login «guest» (desactivado): se conserva SOLO para derivar el SECRET igual que
// antes, de modo que los tokens de sesión y sobre todo los ENLACES DE COMPARTIR (QR) firmados con el secreto
// anterior SIGAN válidos tras el despliegue. Cambiar el secreto invalidaría todos los QR ya repartidos.
const GUEST_PASS = process.env.GUEST_PWD || process.env.PANEL_GUEST_PASSWORD || 'guest';
const TTL_MS = Number(process.env.PANEL_SESION_MS || 2 * 24 * 3600 * 1000); // 2 días
// Secreto para firmar los tokens. ESTABLE entre reinicios (de PANEL_TOKEN_SECRET, o derivado de las
// contraseñas) → los tokens siguen válidos tras un deploy. Cambiar una contraseña invalida los tokens.
const SECRET = process.env.PANEL_TOKEN_SECRET
    || crypto.createHash('sha256').update('gestor-panel|' + ADMIN_USER + '|' + ADMIN_PASS + '|' + GUEST_PASS).digest('hex');
const revocados = new Set(); // logout best-effort (se pierde al reiniciar)

function firmarSesion(user, role) {
    const payload = Buffer.from(JSON.stringify({ u: user, r: role, exp: Date.now() + TTL_MS })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
}

// Usuarios de ARRANQUE (bootstrap): el admin del .env + PANEL_USERS (JSON [{user,rol,pwd}]). Son el salvavidas
// anti-bloqueo (funcionan aunque la BD falle o esté vacía); el grueso de las credenciales vive en la BD y se
// gestiona desde el panel. El «guest» genérico ya NO se crea (desactivado).
function cargarUsuarios() {
    const lista = [];
    if (ADMIN_PASS) lista.push({ user: ADMIN_USER, rol: 'admin', pwd: ADMIN_PASS });
    try {
        const extra = JSON.parse(process.env.PANEL_USERS || '');
        if (Array.isArray(extra)) for (const u of extra) {
            if (!u || !u.user || !u.pwd) continue;
            const rol = u.rol === 'admin' ? 'admin' : 'guest';
            const i = lista.findIndex(x => x.user === u.user);
            if (i >= 0) lista[i] = { user: u.user, rol, pwd: String(u.pwd) };
            else lista.push({ user: u.user, rol, pwd: String(u.pwd) });
        }
    } catch { /* PANEL_USERS mal formado → se ignora */ }
    return lista;
}
const USUARIOS = cargarUsuarios();

/** ¿Hay al menos un admin de ARRANQUE (.env)? Sirve para no dejar el sistema sin ningún admin al editar la BD. */
export function hayAdminBootstrap() {
    return USUARIOS.some((u) => u.rol === 'admin' && u.pwd);
}

/** Comparación en tiempo constante (evita fugas por temporización en la contraseña). */
function igual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export async function login(usuario, password) {
    // 1) Credenciales de la BD (lo normal: invitados y admins creados desde el panel).
    const bd = await autenticarEnBD(usuario, password).catch(() => null);
    if (bd) return { token: firmarSesion(bd.user, bd.rol), usuario: bd.user, rol: bd.rol };
    // 2) Bootstrap del .env (salvavidas: funciona aunque la BD falle o esté vacía).
    const u = USUARIOS.find((x) => x.user === usuario);
    if (u && u.pwd && igual(password, u.pwd)) return { token: firmarSesion(u.user, u.rol), usuario: u.user, rol: u.rol };
    return null;
}

/**
 * Lista de usuarios para el desplegable PÚBLICO del login (SIN contraseñas). Solo los de ARRANQUE (.env): los
 * de la BD NO se exponen aquí a propósito —enumerar todos los nombres de usuario en un endpoint público es un
 * regalo para un atacante— así que los invitados con credencial en BD TECLEAN su nombre.
 */
export function listarUsuarios() {
    return USUARIOS.map((u) => ({ user: u.user, rol: u.rol }));
}

/** Auto-login por credenciales en la URL (https://user:pwd@host): valida la cabecera Basic → sesión. */
export async function loginBasic(authHeader) {
    if (!authHeader || !authHeader.startsWith('Basic ')) return null;
    let dec; try { dec = Buffer.from(authHeader.slice(6), 'base64').toString('utf8'); } catch { return null; }
    const i = dec.indexOf(':');
    return i < 0 ? null : login(dec.slice(0, i), dec.slice(i + 1));
}

export function validar(token) {
    if (!token || typeof token !== 'string' || revocados.has(token)) return null;
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i), sig = token.slice(i + 1);
    const esperado = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;   // firma inválida
    let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || !data.u || !data.exp || Date.now() > data.exp) return null;   // expirado / corrupto
    return { usuario: data.u, rol: data.r };
}

export function logout(token) { if (token) revocados.add(token); }

/**
 * ENLACE DE COMPARTIR (QR): token FIRMADO acotado a UN documento, SIN caducidad (permanente hasta que
 * cambie el secreto/contraseñas). No es una sesión: no autentica ni da acceso al resto de la app; solo
 * autoriza a ver ESA ficha (y, si `descarga`, a descargar el fichero, para medios digitales). El marcador
 * `c:1` lo distingue de un token de sesión (que lleva `u`), así que uno no vale como el otro.
 */
// Firma un token de compartir. `opciones.tipo` = 'doc' (por defecto) | 'coleccion' | 'obra' — así el MISMO
// token/vista pública sirve para compartir un documento suelto o un GRUPO (colección/obra) con sus miembros.
// `opciones.adjuntos` (por defecto NO) = el enlace permite además bajar el MATERIAL ADJUNTO del documento. Por
// defecto un enlace compartido solo da el LIBRO: el material puede ser privado y, sobre todo, el ZIP de la
// carpeta entera arrastraría el sidecar `registro.json`, que es una copia del documento (con progreso de
// lectura, ubicación física y hasta el inventario de los adjuntos «solo admin»). Va FIRMADO en el token para
// que la decisión no dependa de la URL que le llegue al destinatario.
export function firmarCompartir(id, opciones = {}) {
    const payload = Buffer.from(JSON.stringify({
        c: 1, d: String(id), dl: !!opciones.descarga, t: opciones.tipo || 'doc', adj: !!opciones.adjuntos,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    return payload + '.' + sig;
}

/** Valida un token de compartir → { docId, descarga, tipo } o null. (tipo='doc' si el token es antiguo.) */
export function validarCompartir(token) {
    if (!token || typeof token !== 'string') return null;
    const i = token.lastIndexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i), sig = token.slice(i + 1);
    const esperado = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(esperado);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data; try { data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    if (!data || data.c !== 1 || !data.d) return null;   // no es un token de compartir
    return {
        docId: data.d, descarga: !!data.dl, adjuntos: !!data.adj,
        tipo: ['coleccion', 'obra', 'seleccion'].includes(data.t) ? data.t : 'doc',
    };
}

/** Verifica una contraseña contra la de CUALQUIER admin (arranque .env o BD): re-confirma acciones destructivas. */
export async function verificarPasswordAdmin(password) {
    if (USUARIOS.some((u) => u.rol === 'admin' && u.pwd && igual(password, u.pwd))) return true;
    return verificarPasswordAdminBD(password).catch(() => false);
}

function tokenDe(req) {
    const a = req.headers.authorization || '';
    return a.startsWith('Bearer ') ? a.slice(7) : (req.query.token || '');
}

// POST de SOLO LECTURA (no mutan nada): se permiten a invitados pese a la puerta de mutaciones. `/catalogo` es
// POST (no GET) porque una selección grande manda miles de `ids` en el body (la URL del GET daría un 414).
const POST_LECTURA = new Set(['/catalogo']);

/** Middleware: exige sesión válida; las mutaciones (método != GET) exigen rol admin, salvo POST de solo lectura. */
export function autenticar(req, res, next) {
    if (req.path === '/login') return next(); // público
    const sess = validar(tokenDe(req));
    if (!sess) return res.status(401).json({ ok: false, motivo: 'no autenticado' });
    if (req.method !== 'GET' && sess.rol !== 'admin' && !(req.method === 'POST' && POST_LECTURA.has(req.path)))
        return res.status(403).json({ ok: false, motivo: 'permiso denegado: solo el administrador puede hacer cambios' });
    req.usuario = sess;
    next();
}

export { tokenDe };
