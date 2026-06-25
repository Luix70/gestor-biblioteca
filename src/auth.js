import crypto from 'node:crypto';

/**
 * Autenticación SIMPLE del panel (sin dependencias): dos usuarios y sesiones en memoria.
 *   - admin  (usuario PANEL_ADMIN_USER, por defecto "Luis"; contraseña PANEL_ADMIN_PASSWORD del .env):
 *            puede TODO (cualquier método).
 *   - guest  (usuario "guest"; contraseña PANEL_GUEST_PASSWORD, por defecto "guest"):
 *            SOLO LECTURA — peticiones GET (estadísticas/estado/búsqueda); cualquier mutación → 403.
 *
 * El login devuelve un token aleatorio; el panel lo envía en `Authorization: Bearer <token>`. Las
 * sesiones viven en memoria (se pierden al reiniciar → re-login); TTL configurable.
 */
const ADMIN_USER = process.env.PANEL_ADMIN_USER || 'Luis';
const ADMIN_PASS = process.env.ADMIN_PWD || process.env.PANEL_ADMIN_PASSWORD || '';
const GUEST_USER = 'guest';
const GUEST_PASS = process.env.GUEST_PWD || process.env.PANEL_GUEST_PASSWORD || 'guest';
const TTL_MS = Number(process.env.PANEL_SESION_MS || 12 * 3600 * 1000); // 12 h

const sesiones = new Map(); // token → { user, role, exp }

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
    const token = crypto.randomBytes(24).toString('hex');
    sesiones.set(token, { user: u.user, role: u.rol, exp: Date.now() + TTL_MS });
    return { token, usuario: u.user, rol: u.rol };
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
    const s = token && sesiones.get(token);
    if (!s) return null;
    if (Date.now() > s.exp) { sesiones.delete(token); return null; }
    return { usuario: s.user, rol: s.role };
}

export function logout(token) { if (token) sesiones.delete(token); }

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
