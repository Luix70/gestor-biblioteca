/**
 * CONTADOR DE USO DE IA (27-oct): cuántas llamadas hace cada parte del sistema, a qué proveedor, cuántos TOKENS
 * gasta y cuánto CUESTA la de pago — para poder prever el gasto, que hasta ahora solo se estimaba a ojo cruzando el
 * saldo de AI Studio (que se actualiza con retraso) con el log (que no recoge todo: «⏩ Completar» no escribía en él).
 *
 * Cada llamada que responde (vision.js·llamar, el único sitio por donde pasa toda la IA de texto y visión) anota sus
 * tokens REALES: los que devuelve el proveedor (Gemini: usageMetadata, con los de razonamiento aparte; OpenAI/Groq/
 * OpenRouter: usage). Se acumula en memoria y se vuelca cada minuto en la colección `uso_ia`, un documento por día
 * con el desglose por ORIGEN (quién la pidió) y proveedor. Al salir de un script, lo pendiente va a
 * logs/uso-ia-pendiente.jsonl y lo sube el siguiente volcado de esa máquina (como el contador de tráfico).
 *
 * ORIGEN: lo fija quien trabaja, con conOrigenIA(origen, fn) — «campaña:refinar-cdu», «conformador», «ingesta» —; si
 * no, el script que se ejecuta («script:refinar-cdu») o «app» (acciones del panel). Va por AsyncLocalStorage: dos
 * trabajos a la vez no se mezclan.
 *
 * COSTE: solo el de la de PAGO, con la tarifa de config (precio por millón de tokens, en dólares; los de
 * razonamiento se cobran como salida). Es una estimación con la tarifa pública; el cargo exacto lo dice AI Studio.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PENDIENTE = path.join(RAIZ, 'logs', 'uso-ia-pendiente.jsonl');
const VOLCAR_CADA_MS = 60_000;

// Tarifa de la IA de pago (Gemini 2.5 Flash), en dólares por millón de tokens. Se puede ajustar en config/.env.
const PRECIO_ENTRADA_USD_M = () => Number(process.env.IA_PRECIO_ENTRADA_USD_M) || 0.30;
const PRECIO_SALIDA_USD_M = () => Number(process.env.IA_PRECIO_SALIDA_USD_M) || 2.50;
const USD_A_EUR = () => Number(process.env.IA_USD_A_EUR) || 0.92;

// Origen por defecto del proceso: el script que se ejecuta, o la aplicación.
const ORIGEN_PROCESO = (() => {
  const s = path.basename(process.argv[1] || '').replace(/\.(m?js|cjs)$/, '');
  return !s || s === 'app' || s === 'index' ? 'app' : `script:${s}`;
})();
const contexto = new AsyncLocalStorage();

/** Ejecuta `fn` anotando su IA a nombre de `origen` («campaña:refinar-cdu», «conformador», «ingesta»…). */
export function conOrigenIA(origen, fn) {
  return contexto.run({ origen }, fn);
}
const origenActual = () => contexto.getStore()?.origen || ORIGEN_PROCESO;

const dia = (fecha = new Date()) => fecha.toISOString().slice(0, 10);
const limpiaClave = (s) => String(s || '?').replace(/[.$]/g, '_');

let pendiente = new Map();   // «origen|proveedor» → { origen, proveedor, tier, llamadas, entrada, salida, razon }
let temporizador = null;

/**
 * Anota UNA llamada que respondió. `uso` = { entrada, salida, razon } en tokens (lo que devuelva el proveedor; si no
 * dice nada, se cuenta la llamada con 0 tokens). Nunca lanza.
 */
export function anotarUsoIA({ proveedor, tier, uso = {} }) {
  try {
    const origen = origenActual();
    const k = `${origen}|${proveedor}`;
    const a = pendiente.get(k) || { origen, proveedor, tier, llamadas: 0, entrada: 0, salida: 0, razon: 0 };
    a.llamadas++;
    a.entrada += Number(uso.entrada) || 0;
    a.salida += Number(uso.salida) || 0;
    a.razon += Number(uso.razon) || 0;
    pendiente.set(k, a);
    if (!temporizador) {
      temporizador = setInterval(() => volcarUsoIA().catch(() => {}), VOLCAR_CADA_MS);
      temporizador.unref();
    }
  } catch { /* contar nunca rompe una llamada */ }
}

/** Coste en euros de unos tokens de la IA de pago (los de razonamiento, como salida). */
export function costeEur({ entrada = 0, salida = 0, razon = 0 }) {
  const usd = (entrada * PRECIO_ENTRADA_USD_M() + (salida + razon) * PRECIO_SALIDA_USD_M()) / 1e6;
  return usd * USD_A_EUR();
}

/** Sube lo acumulado (y lo que dejó apuntado al salir otro proceso de esta máquina). Nunca lanza. */
export async function volcarUsoIA() {
  const lotes = [...pendiente.values()].map((a) => ({ dia: dia(), ...a }));
  pendiente = new Map();
  try {
    if (fs.existsSync(PENDIENTE)) {
      const lineas = fs.readFileSync(PENDIENTE, 'utf8').split('\n').filter(Boolean);
      fs.unlinkSync(PENDIENTE);
      for (const l of lineas) { try { lotes.push(JSON.parse(l)); } catch { /* línea rota */ } }
    }
  } catch { /* se reintentará */ }
  if (!lotes.length) return;
  let db;
  try { db = await (await import('../database.js')).conectarDB(); } catch { db = null; }
  for (const l of lotes) {
    const base = `origen.${limpiaClave(l.origen)}.${limpiaClave(l.proveedor)}`;
    const ok = db && await db.collection('uso_ia').updateOne({ _id: l.dia }, {
      $inc: {
        [`${base}.llamadas`]: l.llamadas, [`${base}.entrada`]: l.entrada,
        [`${base}.salida`]: l.salida, [`${base}.razon`]: l.razon,
      },
      $set: { [`${base}.tier`]: l.tier },
    }, { upsert: true }).then(() => true, () => false);
    if (!ok) {   // sin conexión: al pendiente otra vez
      const k = `${l.origen}|${l.proveedor}`;
      const a = pendiente.get(k) || { origen: l.origen, proveedor: l.proveedor, tier: l.tier, llamadas: 0, entrada: 0, salida: 0, razon: 0 };
      a.llamadas += l.llamadas; a.entrada += l.entrada; a.salida += l.salida; a.razon += l.razon;
      pendiente.set(k, a);
    }
  }
}

// Al salir (process.exit no deja escribir en Atlas): lo pendiente, al fichero local.
process.on('exit', () => {
  if (!pendiente.size) return;
  try {
    fs.mkdirSync(path.dirname(PENDIENTE), { recursive: true });
    for (const a of pendiente.values()) fs.appendFileSync(PENDIENTE, JSON.stringify({ dia: dia(), ...a }) + '\n');
  } catch { /* nada que hacer */ }
});

/**
 * Resumen de los últimos `dias` días: por día y por origen, llamadas gratis y de pago, tokens y coste de la de pago.
 * Incluye el coste medio por llamada de pago de cada origen, que es lo que sirve para prever.
 */
export async function resumenUsoIA(db, { dias = 30 } = {}) {
  await volcarUsoIA().catch(() => {});
  const desde = dia(new Date(Date.now() - (dias - 1) * 86400_000));
  const docs = await db.collection('uso_ia').find({ _id: { $gte: desde } }).sort({ _id: 1 }).toArray();
  const porDia = [];
  const porOrigen = {};
  for (const d of docs) {
    let pagoDia = 0, gratisDia = 0, eurDia = 0;
    for (const [origen, provs] of Object.entries(d.origen || {})) {
      const o = (porOrigen[origen] ||= { origen, llamadas_pago: 0, llamadas_gratis: 0, entrada: 0, salida: 0, razon: 0, eur: 0 });
      for (const p of Object.values(provs)) {
        if (p.tier === 'paid') {
          const eur = costeEur(p);
          o.llamadas_pago += p.llamadas; o.entrada += p.entrada; o.salida += p.salida; o.razon += p.razon; o.eur += eur;
          pagoDia += p.llamadas; eurDia += eur;
        } else {
          o.llamadas_gratis += p.llamadas; gratisDia += p.llamadas;
        }
      }
    }
    porDia.push({ dia: d._id, llamadas_pago: pagoDia, llamadas_gratis: gratisDia, eur: eurDia });
  }
  const origenes = Object.values(porOrigen)
    .map((o) => ({ ...o, eur_por_llamada: o.llamadas_pago ? o.eur / o.llamadas_pago : 0 }))
    .sort((a, b) => b.eur - a.eur || (b.llamadas_pago + b.llamadas_gratis) - (a.llamadas_pago + a.llamadas_gratis));
  return {
    desde, dias: porDia, origenes,
    total_eur: porDia.reduce((s, d) => s + d.eur, 0),
    tarifa: { entrada_usd_m: PRECIO_ENTRADA_USD_M(), salida_usd_m: PRECIO_SALIDA_USD_M(), usd_a_eur: USD_A_EUR() },
  };
}
