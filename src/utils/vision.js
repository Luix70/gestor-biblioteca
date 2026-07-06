/**
 * VISIÓN multi-proveedor con ROTACIÓN (imagen + instrucción → texto/JSON). Reemplaza la dependencia de un
 * solo Gemini: prueba varios proveedores GRATIS primero y de PAGO como último recurso, con preferencia
 * "pegajosa" al último que funcionó (si era gratis) y enfriamiento por clave al recibir 429.
 *
 * SECRETOS: las claves viven SOLO en .env, con la convención NUMERADA `<PREFIJO>[_N]` (p. ej.
 * GROQ_API_KEY_1, _2). Se auto-descubren. El panel gestiona enable/disable/estado/probar (en Mongo,
 * `ajustes_vision`) SIN exponer ni almacenar los secretos. Para añadir/cambiar una clave: editar .env.
 *
 * Algoritmo: orden base = [free… (orden de config), paid…]. Si el último OK fue una clave FREE y no está
 * en cooldown → va primero (pegajoso). Si el último OK fue de PAGO → NO se fija (se vuelve a free-first).
 * Las que están en cooldown van al final (se intentan solo si todo lo demás falla).
 */
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { conectarDB } from '../database.js';

// Cooldown por-clave tras un 429, PROPORCIONAL a la cuota: corto para límite por-minuto (RPM/TPM, se recupera
// en ~1 min), largo solo para la cuota diaria (RPD). Antes era fijo 5 min → tras un pico las 3 gratis quedaban
// enfriando 5 min a la vez y la visión caía a la de PAGO. Con 70s vuelven enseguida y el pago casi no se toca.
const COOLDOWN_MIN_MS = Number(process.env.VISION_COOLDOWN_MIN_MS) || 70 * 1000;
const COOLDOWN_DIA_MS = Number(process.env.VISION_COOLDOWN_DIA_MS) || 30 * 60 * 1000;
const cooldownPorCuota = (e) => /per\s*day|\bdaily\b/i.test(String(e?.message || '') + ' ' + String(e?.response?.data?.error?.message || '')) ? COOLDOWN_DIA_MS : COOLDOWN_MIN_MS;
const TIMEOUT_MS = Number(process.env.VISION_TIMEOUT_MS) || Number(process.env.HTTP_TIMEOUT_MS) || 30000;
const limpia = (k) => (k && String(k).trim()) || null;

// Catálogo de proveedores. `claves()` descubre en .env; `modelo`/`baseURL` admiten override por env.
// `maxImg` = nº MÁXIMO de imágenes por petición que admite el modelo (Groq llama-4 = 5; Gemini, muchas).
// Si se superan, conVision recorta a las primeras (max-1) + la última (evita "too many images"). Override
// por env: GEMINI_MAX_IMG / GROQ_MAX_IMG / OPENROUTER_MAX_IMG.
const PROVEEDORES = [
    { id: 'gemini-free', etiqueta: 'Gemini (free)', tipo: 'gemini', tier: 'free', maxImg: Number(process.env.GEMINI_MAX_IMG) || 16,
        modelo: () => process.env.GEMINI_MODELO || 'gemini-2.5-flash',
        prefijos: ['GEMINI_API_FREE_KEY'] },
    { id: 'groq', etiqueta: 'Groq · Llama Vision', tipo: 'openai', tier: 'free', maxImg: Number(process.env.GROQ_MAX_IMG) || 5,
        baseURL: () => process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
        modelo: () => process.env.GROQ_MODELO || 'meta-llama/llama-4-scout-17b-16e-instruct',
        prefijos: ['GROQ_API_KEY'] },
    { id: 'openrouter', etiqueta: 'OpenRouter (free)', tipo: 'openai', tier: 'free', maxImg: Number(process.env.OPENROUTER_MAX_IMG) || 5,
        baseURL: () => process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
        modelo: () => process.env.OPENROUTER_MODELO || 'meta-llama/llama-3.2-11b-vision-instruct:free',
        prefijos: ['OPENROUTER_API_KEY'] },
    { id: 'gemini-paid', etiqueta: 'Gemini (pago)', tipo: 'gemini', tier: 'paid', maxImg: Number(process.env.GEMINI_MAX_IMG) || 16,
        modelo: () => process.env.GEMINI_MODELO || 'gemini-2.5-flash',
        prefijos: ['GEMINI_API_KEY_PAID'] },
];

// Recorta a `max` imágenes conservando las primeras (max-1) + la ÚLTIMA (suele llevar ISBN/créditos).
function recortarImagenes(imgs, max) {
    if (!max || !imgs || imgs.length <= max) return imgs || [];
    return [...imgs.slice(0, max - 1), imgs[imgs.length - 1]];
}

function descubrir(prefijos) {
    const out = [];
    for (const p of prefijos) {
        const re = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(_\\d+)?$');
        for (const [k, v] of Object.entries(process.env)) { const val = limpia(v); if (val && re.test(k)) out.push({ env: k, valor: val }); }
    }
    const vistos = new Set(), u = [];
    for (const c of out.sort((a, b) => a.env.localeCompare(b.env, undefined, { numeric: true }))) if (!vistos.has(c.valor)) { vistos.add(c.valor); u.push(c); }
    return u;
}
const mask = (s) => s.length <= 10 ? '••••' : `${s.slice(0, 4)}…${s.slice(-4)}`;

/** Lista de CANDIDATOS (una entrada por clave) en orden base de config (free→paid). id = nombre de la env. */
function candidatos() {
    const out = [];
    for (const prov of PROVEEDORES) {
        for (const cl of descubrir(prov.prefijos)) {
            out.push({ id: cl.env, env: cl.env, key: cl.valor, prov, tier: prov.tier, etiqueta: prov.etiqueta,
                modelo: prov.modelo(), baseURL: prov.baseURL ? prov.baseURL() : null, masked: mask(cl.valor) });
        }
    }
    return out;
}

// ── Estado en memoria ──
const cooldownHasta = {};     // id → ts
const errores = {};           // id → { n, ultimo, ts }
let ultimoOk = null;          // id de la última clave que funcionó

// ── Ajustes persistidos (enable/disable), SIN secretos ──
let ajustesCache = null, ajustesTs = 0;
async function ajustes() {
    if (ajustesCache && Date.now() - ajustesTs < 15000) return ajustesCache;
    try {
        const db = await conectarDB();
        const docs = await db.collection('ajustes_vision').find({}).toArray();
        ajustesCache = new Map(docs.map(d => [d._id, d]));
    } catch { ajustesCache = new Map(); }
    ajustesTs = Date.now();
    return ajustesCache;
}
async function habilitado(id) { return (await ajustes()).get(id)?.enabled !== false; } // por defecto activo

// "Demasiadas imágenes" NO es cuota: es un error de PETICIÓN (el modelo limita el nº de imágenes). No debe
// enfriar la clave ni contarse como 429 (con el recorte por maxImg ya no debería ocurrir; esto es la red).
const esTantasImagenes = (e) => {
    const m = String(e?.message || '') + ' ' + String(e?.response?.data?.error?.message || '');
    return /too.?many.?images|supports up to \d+ image|number of images|image.?(count|limit)/i.test(m);
};
const esCuota = (e) => {
    if (esTantasImagenes(e)) return false;
    const s = e?.status || e?.response?.status;
    const m = String(e?.message || '') + ' ' + String(e?.response?.data?.error?.message || '');
    return s === 429 || /\b429\b|quota|rate.?limit|resource.?exhausted|exhausted|too.?many.?request/i.test(m);
};
const motivo = (e) => esCuota(e) ? `429 cuota — ${(e?.response?.data?.error?.message || e?.message || '').replace(/\s+/g, ' ').slice(0, 160)}`
    : (e?.response?.status || e?.status || (e?.message || '').slice(0, 120));

async function llamar(c, { prompt, imagenes, json, maxTokens }) {
    const imgs = recortarImagenes(imagenes, c.prov.maxImg);   // respeta el límite de imágenes del modelo
    if (c.prov.tipo === 'gemini') {
        const generationConfig = json ? { responseMimeType: 'application/json' } : {};
        if (maxTokens) generationConfig.maxOutputTokens = maxTokens;
        const model = new GoogleGenerativeAI(c.key).getGenerativeModel({ model: c.modelo, generationConfig });
        const parts = [prompt, ...imgs.map(im => ({ inlineData: { data: im.base64, mimeType: im.mimeType || 'image/jpeg' } }))];
        const res = await model.generateContent(parts);
        return res.response.text();
    }
    // OpenAI-compatible (Groq, OpenRouter, …): no forzamos response_format (algunos modelos lo rechazan);
    // el prompt ya pide JSON y extraerJSON() lo limpia.
    const content = [{ type: 'text', text: prompt }, ...imgs.map(im => ({ type: 'image_url', image_url: { url: `data:${im.mimeType || 'image/jpeg'};base64,${im.base64}` } }))];
    const headers = { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' };
    if (c.prov.id === 'openrouter') { headers['HTTP-Referer'] = 'https://gestor-biblioteca.local'; headers['X-Title'] = 'Gestor Biblioteca'; }
    const res = await axios.post(`${c.baseURL}/chat/completions`,
        { model: c.modelo, messages: [{ role: 'user', content }], temperature: 0, max_tokens: maxTokens || 1500 },
        { headers, timeout: TIMEOUT_MS });
    return res.data?.choices?.[0]?.message?.content || '';
}

/** Orden de intento: enabled, free→paid (config), pegajoso al último-OK FREE; cooldown al final. */
async function ordenIntento(filtro = null) {
    const aj = await ajustes();
    let base = candidatos().filter(c => aj.get(c.id)?.enabled !== false);
    if (filtro) base = base.filter(filtro);
    const ahora = Date.now();
    if (ultimoOk) {
        const lc = base.find(c => c.id === ultimoOk);
        if (lc && lc.tier === 'free' && (cooldownHasta[lc.id] || 0) <= ahora) base = [lc, ...base.filter(c => c.id !== ultimoOk)];
    }
    const activos = base.filter(c => (cooldownHasta[c.id] || 0) <= ahora);
    const enfriando = base.filter(c => (cooldownHasta[c.id] || 0) > ahora);
    return [...activos, ...enfriando];
}

/**
 * Llama a la visión con rotación. Devuelve el TEXTO de la respuesta (usa extraerJSON para parsear).
 * @param {{prompt:string, imagenes?:Array<{base64:string,mimeType?:string}>, json?:boolean}} opts
 */
export async function conVision({ prompt, imagenes = [], json = true, soloGemini = false } = {}) {
    // soloGemini: para tareas que exigen leer DÍGITOS con exactitud (códigos de barras) → solo Gemini
    // (free→paid), que es el preciso. Así un 429 cae a Gemini de PAGO en vez de pararse en una lectura
    // ERRÓNEA de Groq/OpenRouter (que "responden" con dígitos mal y cortan la rotación).
    const orden = await ordenIntento(soloGemini ? (c => c.prov.tipo === 'gemini') : null);
    if (!orden.length) throw new Error(soloGemini
        ? 'No hay proveedor Gemini disponible/activo para leer el código de barras con precisión.'
        : 'No hay proveedores de visión configurados/activos (revisa las claves en .env y los Ajustes).');
    let ultimo;
    for (const c of orden) {
        const t0 = Date.now();
        try {
            const txt = await llamar(c, { prompt, imagenes, json });
            ultimoOk = c.id;
            // Éxito (verbose): QUIÉN resolvió la visión — clave/proveedor, tier (free/paid), modelo y ms.
            console.log(`   ✓ Visión[${c.id}] (${c.tier} · ${c.modelo}) respondió en ${Date.now() - t0} ms.`);
            return txt;
        } catch (e) {
            ultimo = e;
            if (esCuota(e)) cooldownHasta[c.id] = Date.now() + cooldownPorCuota(e);
            errores[c.id] = { n: (errores[c.id]?.n || 0) + 1, ultimo: String(motivo(e)), ts: Date.now() };
            console.warn(`   ↻ Visión[${c.id}] falló (${motivo(e)}); siguiente proveedor.`);
        }
    }
    throw ultimo || new Error('Todos los proveedores de visión fallaron.');
}

/**
 * IA de TEXTO con la MISMA rotación multi-proveedor (Gemini free → Groq/OpenRouter free → Gemini pago):
 * sin imágenes. Para tareas de texto puro (clasificación CDU, descripciones…), así el texto también
 * aprovecha los tiers gratis de otros proveedores antes de gastar la de pago. Devuelve el TEXTO (usa
 * extraerJSON para parsear). `maxTokens` sube el límite de salida (p. ej. descripciones por lote).
 * @param {{prompt:string, json?:boolean, maxTokens?:number}} opts
 */
export async function conTexto({ prompt, json = true, maxTokens } = {}) {
    const orden = await ordenIntento();
    if (!orden.length) throw new Error('No hay proveedores de IA configurados/activos (revisa las claves en .env y los Ajustes).');
    let ultimo;
    for (const c of orden) {
        const t0 = Date.now();
        try {
            const txt = await llamar(c, { prompt, imagenes: [], json, maxTokens });
            ultimoOk = c.id;
            console.log(`   ✓ IA-texto[${c.id}] (${c.tier} · ${c.modelo}) respondió en ${Date.now() - t0} ms.`);
            return txt;
        } catch (e) {
            ultimo = e;
            if (esCuota(e)) cooldownHasta[c.id] = Date.now() + cooldownPorCuota(e);
            errores[c.id] = { n: (errores[c.id]?.n || 0) + 1, ultimo: String(motivo(e)), ts: Date.now() };
            console.warn(`   ↻ IA-texto[${c.id}] falló (${motivo(e)}); siguiente proveedor.`);
        }
    }
    throw ultimo || new Error('Todos los proveedores de IA de texto fallaron.');
}

/** Limpia y parsea JSON de una respuesta de modelo (tolera fences ```json y texto alrededor). */
export function extraerJSON(txt) {
    if (!txt) return null;
    let s = String(txt).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    try { return JSON.parse(s); } catch { /* intentar recortar al primer objeto */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* */ } }
    return null;
}

// ── Para el panel (sin secretos) ──
export async function estadoVision() {
    const aj = await ajustes();
    const ahora = Date.now();
    return candidatos().map(c => ({
        id: c.id, etiqueta: c.etiqueta, tier: c.tier, modelo: c.modelo, masked: c.masked,
        enabled: aj.get(c.id)?.enabled !== false,
        cooldown: (cooldownHasta[c.id] || 0) > ahora ? new Date(cooldownHasta[c.id]).toISOString() : null,
        errores: errores[c.id]?.n || 0, ultimoError: errores[c.id]?.ultimo || null,
        ultimoOk: ultimoOk === c.id,
    }));
}
export async function configurarProveedor(id, { enabled } = {}) {
    if (!candidatos().some(c => c.id === id)) return { ok: false, motivo: 'proveedor desconocido' };
    const db = await conectarDB();
    await db.collection('ajustes_vision').updateOne({ _id: id }, { $set: { enabled: !!enabled } }, { upsert: true });
    ajustesCache = null;
    return { ok: true, id, enabled: !!enabled };
}
/** Proba UNA clave (sonda de texto): valida clave+modelo+conexión sin gastar visión. */
export async function probarProveedor(id) {
    const c = candidatos().find(x => x.id === id);
    if (!c) return { ok: false, motivo: 'proveedor desconocido' };
    const t0 = Date.now();
    try {
        const txt = await llamar(c, { prompt: 'Responde solo con la palabra: OK', imagenes: [], json: false });
        delete cooldownHasta[c.id];
        return { ok: true, ms: Date.now() - t0, respuesta: String(txt || '').trim().slice(0, 40) };
    } catch (e) {
        if (esCuota(e)) cooldownHasta[c.id] = Date.now() + cooldownPorCuota(e);
        return { ok: false, ms: Date.now() - t0, motivo: String(motivo(e)) };
    }
}
