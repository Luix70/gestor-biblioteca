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

/** Orden de claves a intentar: free primero (si no está en cooldown), luego pago; sin duplicados. */
function clavesOrdenadas() {
    const free = limpia(process.env.GEMINI_API_FREE_KEY);
    const paid = limpia(process.env.GEMINI_API_KEY);
    const orden = [];
    if (free && Date.now() >= freeAgotadaHasta) orden.push(['free', free]);
    if (paid && paid !== free) orden.push(['paid', paid]);
    // Si la free está en cooldown pero no hay otra distinta, intentarla igualmente (mejor que nada).
    if (!orden.length && free) orden.push(['free', free]);
    if (!orden.length && paid) orden.push(['paid', paid]);
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
                console.warn(`   ↻ Gemini[${etiqueta}] falló (${e?.status || (e?.message || '').slice(0, 70)}); probando la siguiente clave.`);
                continue;
            }
            throw e;
        }
    }
    throw ultimo;
}
