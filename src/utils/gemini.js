/**
 * Cliente Gemini con FALLBACK de clave: usa primero la clave GRATIS (free tier) y, si se agota su
 * cuota (429 / RESOURCE_EXHAUSTED) o falla, reintenta con la de PAGO (Tier 1). Centraliza la
 * construcción del cliente para los 5 puntos que llamaban a `new GoogleGenerativeAI(GEMINI_API_KEY)`.
 *
 *   GEMINI_API_FREE_KEY  → preferente (free tier)
 *   GEMINI_API_KEY       → respaldo  (Tier 1 · postpago).  Si falta la free, se usa esta directamente.
 *
 * Cuando la free devuelve cuota agotada, se marca en COOLDOWN (no se reintenta durante unos minutos)
 * para no malgastar una llamada fallida en cada petición mientras la cuota está agotada.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';

const COOLDOWN_MS = Number(process.env.GEMINI_FREE_COOLDOWN_MS) || 5 * 60 * 1000; // 5 min por defecto
let freeAgotadaHasta = 0; // timestamp hasta el que se omite la clave free

const limpia = (k) => (k && String(k).trim()) || null;
const esCuota = (e) => {
    const s = e?.status;
    const m = String(e?.message || '');
    return s === 429 || /\b429\b|quota|rate.?limit|resource.?exhausted|exhausted/i.test(m);
};

// Descubre TODAS las claves de un prefijo en .env: admite la forma escueta y la NUMERADA
// (GEMINI_API_FREE_KEY, GEMINI_API_FREE_KEY_1, _2…). Sin duplicados, en orden natural.
function descubrirEnv(prefijos) {
    const out = [];
    for (const p of prefijos) {
        const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(_\\d+)?$');
        for (const [k, v] of Object.entries(process.env)) {
            const val = limpia(v);
            if (val && re.test(k)) out.push(val);
        }
    }
    return [...new Set(out)];
}

/** Orden de claves Gemini a intentar: TODAS las free primero (si no en cooldown), luego las de pago. */
function clavesOrdenadas() {
    const free = descubrirEnv(['GEMINI_API_FREE_KEY']);                       // *_FREE_KEY[_N]
    const paid = descubrirEnv(['GEMINI_API_KEY_PAID', 'GEMINI_API_KEY']).filter(k => !free.includes(k)); // _PAID + legado
    const orden = [];
    if (Date.now() >= freeAgotadaHasta) for (const k of free) orden.push(['free', k]);
    for (const k of paid) orden.push(['paid', k]);
    if (!orden.length) for (const k of free) orden.push(['free', k]); // free en cooldown pero sin alternativa
    return orden;
}

/**
 * Ejecuta una llamada Gemini con fallback de clave. `fn` recibe un modelo ya construido con
 * `opcionesModelo` (las mismas que getGenerativeModel: { model, generationConfig, systemInstruction… }).
 *
 * @template T
 * @param {object} opcionesModelo  p. ej. { model: 'gemini-2.5-flash', generationConfig: {...} }
 * @param {(model: import('@google/generative-ai').GenerativeModel) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function conGemini(opcionesModelo, fn) {
    const orden = clavesOrdenadas();
    if (!orden.length) throw new Error('No hay claves Gemini configuradas (GEMINI_API_FREE_KEY / GEMINI_API_KEY).');

    let ultimo;
    for (let i = 0; i < orden.length; i++) {
        const [etiqueta, key] = orden[i];
        try {
            const model = new GoogleGenerativeAI(key).getGenerativeModel(opcionesModelo);
            return await fn(model);
        } catch (e) {
            ultimo = e;
            if (etiqueta === 'free' && esCuota(e)) freeAgotadaHasta = Date.now() + COOLDOWN_MS;
            if (i < orden.length - 1) {
                // En un 429 se vuelca el mensaje COMPLETO: nombra la cuota agotada (…PerDay = RPD diaria,
                // …PerMinute = RPM, …InputTokensPerMinute = TPM por tokens). Así sabemos si reducir el
                // payload (TPM) ayudaría o si es simple agotamiento de peticiones (RPD/RPM).
                const motivo = esCuota(e)
                    ? `429 cuota — ${(e?.message || '').replace(/\s+/g, ' ').slice(0, 220)}`
                    : (e?.status || (e?.message || '').slice(0, 80));
                console.warn(`   ↻ Gemini[${etiqueta}] falló (${motivo}); probando la siguiente clave.`);
                continue;
            }
            throw e;
        }
    }
    throw ultimo;
}
