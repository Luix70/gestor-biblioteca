import crypto from 'node:crypto';

/**
 * Autenticación SIMPLE del panel (sin dependencias): dos usuarios y sesiones en memoria.
 *   - admin  (usuario PANEL_ADMIN_USER, por defecto "Luis"; contraseña PANEL_ADMIN_PASSWORD del .env):
 *            puede TODO (cualquier método).
 *   - guest  (usuario "guest"; contraseña PANEL_GUEST_PASSWORD, por defecto "guest"):
 *            SOLO LECTURA — peticiones GET (estadísticas/estado/búsqueda); cualquier mutación → 403.
 *
 * El login devuelve un token FIRMADO (HMAC) y SIN ESTADO: lleva {usuario, rol, expiración} y se valida
 * recomputando la firma → SOBREVIVE a los reinicios del contenedor (ya no hay que re-loguear tras cada
 * deploy) y dura TTL_MS (por defecto 2 días). El panel lo guarda en localStorage y lo manda en
 * `Authorization: Bearer <token>`. logout es best-effort (revoca en memoria; tras un reinicio el token
 * sigue válido hasta expirar, pero el cliente lo descarta igualmente).
 */
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'Luis';
const ADMIN_PASS = process.env.ADMIN_PWD || process.env.PANEL_ADMIN_PASSWORD || '';
const GUEST_USER = 'guest';
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

// Usuarios: legacy (admin "Luis" + "guest") + PANEL_USERS del .env (JSON [{user,rol,pwd}]). NO hay
// alta/recuperación por UI: se editan en el .env (pocos usuarios, admin o guest). PANEL_USERS sobrescribe
// por nombre, así que se puede redefinir "Luis"/"guest" o añadir nuevos.
function cargarUsuarios() {
    const lista = [];
    if (ADMIN_PASS) lista.push({ user: ADMIN_USER, rol: 'admin', pwd: ADMIN_PASS });
    lista.push({ user: GUEST_USER, rol: 'guest', pwd: GUEST_PASS });
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

/** Comparación en tiempo constante (evita fugas por temporización en la contraseña). */
function igual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function login(usuario, password) {
    const u = USUARIOS.find(x => x.user === usuario);
    if (!u || !u.pwd || !igual(password, u.pwd)) return null;
    return { token: firmarSesion(u.user, u.rol), usuario: u.user, rol: u.rol };
}

/** Lista de usuarios para el desplegable del login (SIN contraseñas). */
export function listarUsuarios() {
    return USUARIOS.map(u => ({ user: u.user, rol: u.rol }));
}

/** Auto-login por credenciales en la URL (https://user:pwd@host): valida la cabecera Basic → sesión. */
export function loginBasic(authHeader) {
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
export function firmarCompartir(id, opciones = {}) {
    const payload = Buffer.from(JSON.stringify({ c: 1, d: String(id), dl: !!opciones.descarga, t: opciones.tipo || 'doc' })).toString('base64url');
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
    return { docId: data.d, descarga: !!data.dl, tipo: ['coleccion', 'obra'].includes(data.t) ? data.t : 'doc' };
}

/** Verifica una contraseña contra la de CUALQUIER admin (re-confirmación de acciones destructivas). */
export function verificarPasswordAdmin(password) {
    return USUARIOS.some(u => u.rol === 'admin' && u.pwd && igual(password, u.pwd));
}

function tokenDe(req) {
    const a = req.headers.authorization || '';
    return a.startsWith('Bearer ') ? a.slice(7) : (req.query.token || '');
}

/** Middleware: exige sesión válida; las mutaciones (método != GET) exigen rol admin. */
export function autenticar(req, res, next) {
    if (req.path === '/login') return next(); // público
    const sess = validar(tokenDe(req));
    if (!sess) return res.status(401).json({ ok: false, motivo: 'no autenticado' });
    if (req.method !== 'GET' && sess.rol !== 'admin')
        return res.status(403).json({ ok: false, motivo: 'permiso denegado: solo el administrador puede hacer cambios' });
    req.usuario = sess;
    next();
}

export { tokenDe };
