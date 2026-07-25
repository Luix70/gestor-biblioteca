/**
 * CLIENTE HTTP ENDURECIDO para las llamadas SALIENTES a fuentes externas (APIs bibliográficas y descarga de
 * portadas). Un único sitio donde aplicar las tres cosas que evitan parecer un bot agresivo y que te baneen la
 * IP (WAF F5/anti-bot, listas de reputación):
 *
 *   1. USER-AGENT descriptivo y con contacto — identificarse (y dar un email por si un servicio prefiere
 *      avisar antes que banear) es buena ciudadanía y muchos WAF penalizan un UA vacío/por defecto.
 *   2. THROTTLE global — separa las peticiones al menos `HTTP_MIN_INTERVALO_MS` entre sí (cola de "turnos"
 *      en serie). No limita la concurrencia real, solo el RITMO de arranque, que es lo que dispara los
 *      anti-bot. El estado (`_proximo`) es de módulo → TODAS las instancias comparten el mismo ritmo.
 *   3. BACKOFF + reintentos — ante 429 (too many) / 502-503-504 / error de red, espera (respetando la
 *      cabecera `Retry-After` del servidor si la manda) y reintenta con backoff exponencial + jitter.
 *
 * NO toca el `axios` global del resto de la app (versión, visión, vigilante): solo los clientes que importen
 * de aquí (`http` o `crearHttp`) quedan endurecidos. Los buscadores ya distinguen «error de red» de
 * «no encontrado», así que si se agotan los reintentos se relanza el error tal cual.
 */
import axios from 'axios';

// Contacto para el User-Agent, del .env (EMAIL). Si no hay, se identifica igualmente sin email.
const CONTACTO = (process.env.EMAIL || '').trim();
export const USER_AGENT =
    'GestorBiblioteca/1.0 (+https://github.com/Luix70/gestor-biblioteca' + (CONTACTO ? '; ' + CONTACTO : '') + ')';

const TIMEOUT = Number(process.env.HTTP_TIMEOUT_MS) || 20000;
const MIN_INTERVALO = Number(process.env.HTTP_MIN_INTERVALO_MS) || 200; // ~5 req/s como tope de ritmo de salida
const REINTENTOS = Number(process.env.HTTP_REINTENTOS) || 3;

// THROTTLE: cada petición pide un "turno"; los turnos se reparten separados MIN_INTERVALO ms. Compartido entre
// todas las instancias creadas aquí (estado de módulo), así el ritmo es GLOBAL, no por instancia.
let _proximo = 0;
function turno() {
    const ahora = Date.now();
    const inicio = Math.max(ahora, _proximo);
    _proximo = inicio + MIN_INTERVALO;
    const espera = inicio - ahora;
    return espera > 0 ? new Promise((r) => setTimeout(r, espera)) : Promise.resolve();
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// ¿Merece la pena reintentar? 429 (ritmo), 502/503/504 (sobrecarga del servidor), o error SIN respuesta
// (red/timeout). Un 4xx normal (400/401/403/404) NO se reintenta: reintentarlo no cambiaría nada.
function reintentable(e) {
    const s = e?.response?.status;
    if (s === 429 || s === 502 || s === 503 || s === 504) return true;
    return !e?.response;
}

// Cuánto esperar: si el servidor manda `Retry-After` (segundos o fecha HTTP) se respeta (acotado a 30 s);
// si no, backoff exponencial (1s, 2s, 4s…, tope 8s) con un pequeño jitter para no sincronizar reintentos.
function esperaMs(e, intento) {
    const ra = e?.response?.headers?.['retry-after'];
    if (ra != null && ra !== '') {
        const seg = Number(ra);
        if (Number.isFinite(seg)) return Math.min(seg * 1000, 30000);
        const t = Date.parse(ra);
        if (!Number.isNaN(t)) return Math.max(0, Math.min(t - Date.now(), 30000));
    }
    return Math.min(1000 * 2 ** intento, 8000) + Math.floor(Math.random() * 300);
}

// Engancha el throttle (petición) y el backoff (respuesta) a una instancia axios.
function aplicarInterceptores(inst) {
    inst.interceptors.request.use(async (config) => {
        await turno();
        return config;
    });
    inst.interceptors.response.use(undefined, async (error) => {
        const cfg = error.config;
        if (!cfg) return Promise.reject(error);
        cfg.__intentos = cfg.__intentos || 0;
        if (cfg.__intentos < REINTENTOS && reintentable(error)) {
            cfg.__intentos++;
            await dormir(esperaMs(error, cfg.__intentos - 1));
            return inst(cfg); // reintenta: vuelve a pasar por el throttle
        }
        return Promise.reject(error);
    });
    return inst;
}

/** Crea una instancia axios endurecida (UA + throttle + backoff). `opts.timeout`/`opts.headers` opcionales. */
export function crearHttp(opts = {}) {
    return aplicarInterceptores(
        axios.create({
            timeout: opts.timeout || TIMEOUT,
            headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
        }),
    );
}

/** Instancia compartida por defecto (la usan la mayoría de los buscadores y la descarga de portadas). */
export const http = crearHttp();
