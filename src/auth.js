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

/** Comparación en tiempo constante (evita fugas por temporización en la contraseña). */
function igual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function login(usuario, password) {
    let role = null;
    if (ADMIN_PASS && usuario === ADMIN_USER && igual(password, ADMIN_PASS)) role = 'admin';
    else if (usuario === GUEST_USER && igual(password, GUEST_PASS)) role = 'guest';
    if (!role) return null;
    const token = crypto.randomBytes(24).toString('hex');
    sesiones.set(token, { user: usuario, role, exp: Date.now() + TTL_MS });
    return { token, usuario, rol: role };
}

export function validar(token) {
    const s = token && sesiones.get(token);
    if (!s) return null;
    if (Date.now() > s.exp) { sesiones.delete(token); return null; }
    return { usuario: s.user, rol: s.role };
}

export function logout(token) { if (token) sesiones.delete(token); }

/** Verifica una contraseña contra la del administrador (re-confirmación para acciones destructivas). */
export function verificarPasswordAdmin(password) {
    return !!ADMIN_PASS && igual(password, ADMIN_PASS);
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
