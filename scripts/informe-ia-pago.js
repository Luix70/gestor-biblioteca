/**
 * INFORME DE LA IA DE PAGO — qué llamadas se han hecho a los proveedores de PAGO (Gemini de pago y cualquier otro con
 * tier 'paid'), con su RESULTADO, y cuánto han costado. Junta TODAS las fuentes que tienen constancia de ellas:
 *
 *   · `uso_ia` (utils/uso-ia.js): totales por día, origen y clave (llamadas que RESPONDIERON, tokens) desde el
 *     27-oct-2026. No dice qué llamada fue cuál: sirve para la estadística por día y para contar lo que no tiene detalle.
 *   · logs/ia-pago-detalle.jsonl: CADA llamada de pago, con hora, origen, clave, modelo y resultado — si respondió,
 *     tokens, coste y la RESPUESTA devuelta; si falló, la CAUSA (402 sin saldo, 429 cuota…). Desde el 27-nov (los
 *     éxitos sin respuesta ni fallos, desde el 26-nov); uno por máquina.
 *   · logs/app.log y logs/scripts/*.log: las líneas «✓ Visión[clave] (paid · modelo) respondió…» / «↻ … falló (causa)»
 *     / «❌ [Error Visión IA] … 402». Sin tokens ni respuesta, pero con hora y causa. app.log solo guarda las últimas
 *     horas (se rota).
 *   · --log <fichero> (repetible): cualquier otro volcado, p. ej. el de Docker, que puede ir más atrás que app.log:
 *         sudo docker logs gestor-biblioteca > logs/docker.log 2>&1
 *
 * El coste es una ESTIMACIÓN con la tarifa pública (config IA_PRECIO_*, o la propia del proveedor); el cargo exacto lo
 * da AI Studio. Antes del 27-oct no hay registro.
 *
 * Claves que verás: GEMINI_API_KEY_PAID = la rotación de visión/texto (vision.js, obedece el panel) · gemini-paid = la
 * vía directa gemini.js·conGemini (no obedecía el panel hasta f57399d, 26-nov).
 *
 * Solo lee. Uso:
 *   node scripts/informe-ia-pago.js                                  → resumen + listado de llamadas (respuestas abreviadas)
 *   node scripts/informe-ia-pago.js --desde 2026-11-20               → desde una fecha
 *   node scripts/informe-ia-pago.js --respuestas                     → el listado con la respuesta ENTERA de cada una
 *   node scripts/informe-ia-pago.js --log logs/docker.log            → añade otro volcado de log
 *   node scripts/informe-ia-pago.js --informe logs/ia-pago.txt       → lo escribe en un .txt (en pantalla, solo el resumen)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { costeEur, DETALLE_PAGO } from '../src/utils/uso-ia.js';
import { progreso } from '../src/utils/progreso-cli.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const args = (n) => process.argv.flatMap((a, i) => (a === n && process.argv[i + 1] ? [process.argv[i + 1]] : []));
const DESDE = arg('--desde') || '0000-00-00';
const INFORME = arg('--informe');
const RESPUESTAS_ENTERAS = process.argv.includes('--respuestas');
const LOGS_EXTRA = args('--log');

// ── Formato ──
const n = (x) => Math.round(x || 0).toLocaleString('es-ES');
const eur = (x) => (x || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fila = (cols, anchos) => cols.map((c, i) => (i === 0 ? String(c).padEnd(anchos[i]) : String(c).padStart(anchos[i]))).join('  ');
const nuevo = () => ({ llamadas: 0, entrada: 0, salida: 0, razon: 0, eur: 0 });
const sumar = (a, p, coste) => { a.llamadas += p.llamadas || 0; a.entrada += p.entrada || 0; a.salida += p.salida || 0; a.razon += p.razon || 0; a.eur += coste; };
/** Fecha local «AAAA-MM-DD HH:MM:SS» (la de los logs) de un instante. */
const local = (d) => {
  const z = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`;
};

const L = [];        // el informe completo (al .txt)
const R = [];        // el resumen (a pantalla)
const ambos = (s = '') => { L.push(s); R.push(s); };

// ═══ 1. Estadística por día (uso_ia) ═══════════════════════════════════════════════════════════════════════
const db = await conectarDB();
const dias = await db.collection('uso_ia').find({ _id: { $gte: DESDE } }).sort({ _id: 1 }).toArray();
const porDia = [];
const porOrigen = new Map();
const porClave = new Map();
const pd = progreso(dias.length, 'Días (uso_ia)');
for (const d of dias) {
  pd.paso(d._id);
  const dia = { dia: d._id, ...nuevo(), gratis: 0 };
  for (const [origen, provs] of Object.entries(d.origen || {})) {
    for (const [clave, uso] of Object.entries(provs || {})) {
      if (uso.tier !== 'paid') { dia.gratis += uso.llamadas || 0; continue; }
      const coste = costeEur(uso);
      sumar(dia, uso, coste);
      if (!porOrigen.has(origen)) porOrigen.set(origen, nuevo());
      sumar(porOrigen.get(origen), uso, coste);
      if (!porClave.has(clave)) porClave.set(clave, nuevo());
      sumar(porClave.get(clave), uso, coste);
    }
  }
  porDia.push(dia);
}
pd.fin();
const total = nuevo();
for (const d of porDia) sumar(total, d, d.eur);

ambos(`INFORME DE LA IA DE PAGO — ${dias[0]?._id || '—'} → ${dias.at(-1)?._id || '—'}`);
ambos('Coste = estimación con la tarifa pública; el cargo exacto lo da AI Studio. Antes del 27-oct no hay registro.');
ambos();
ambos(`TOTAL (uso_ia, llamadas que respondieron): ${n(total.llamadas)} llamadas · ${n(total.entrada)} tokens de entrada · `
  + `${n(total.salida)} de salida · ${n(total.razon)} de razonamiento · ≈ ${eur(total.eur)}`);
ambos();
ambos('POR DÍA (uso_ia)');
const A1 = [12, 9, 12, 10, 12, 10, 9];
ambos(fila(['día (UTC)', 'llamadas', 'entrada', 'salida', 'razon.', 'coste', 'gratis'], A1));
for (const d of porDia) ambos(fila([d.dia, n(d.llamadas), n(d.entrada), n(d.salida), n(d.razon), eur(d.eur), n(d.gratis)], A1));
ambos();
const tabla = (titulo, mapa) => {
  ambos(titulo);
  const A = [40, 9, 12, 10, 12, 10, 10];
  ambos(fila(['', 'llamadas', 'entrada', 'salida', 'razon.', 'coste', '€/llamada'], A));
  for (const [k, a] of [...mapa].sort((x, y) => y[1].eur - x[1].eur || y[1].llamadas - x[1].llamadas)) {
    ambos(fila([k.slice(0, 40), n(a.llamadas), n(a.entrada), n(a.salida), n(a.razon), eur(a.eur),
      a.llamadas && a.eur ? (a.eur / a.llamadas).toFixed(4) : '—'], A));
  }
  ambos();
};
tabla('POR ORIGEN (quién la pidió)', porOrigen);
tabla('POR CLAVE / VÍA', porClave);

// ═══ 2. Las llamadas, una a una, de todas las fuentes ═══════════════════════════════════════════════════════
// Cada llamada: { cuando (local, como los logs), fuente, clave, modelo, ok, causa, origen, tarea, tokens, coste, respuesta }
const llamadas = [];

// 2a. El detalle (logs/ia-pago-detalle.jsonl): lo más completo.
let detalle = [];
try {
  detalle = fs.readFileSync(DETALLE_PAGO, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
} catch { /* aún no hay detalle en esta máquina */ }
for (const x of detalle) {
  llamadas.push({
    cuando: local(new Date(x.ts)), fuente: 'detalle', clave: x.proveedor, modelo: x.modelo,
    ok: x.ok !== false, causa: x.error || null, origen: x.origen, tarea: x.tarea,
    entrada: x.entrada, salida: x.salida, razon: x.razon, eur: x.eur, respuesta: x.respuesta ?? null,
  });
}
// Lo que el detalle ya cubre no se repite desde los logs (las mismas llamadas salen en los dos sitios).
const detalleDesde = llamadas.length ? llamadas.map((x) => x.cuando).sort()[0] : '9999';

// 2b. Los logs: app.log, los de los scripts y los que se pasen con --log.
const esPago = (id) => /PAID|DEEPSEEK|DASHSCOPE|^paid$/i.test(id);
// app.log y sus copias rotadas (app.log.1 … app.log.N, desde el 27-nov: antes el tope las tiraba).
// --log admite un fichero o una CARPETA (todos sus .log y app.log*).
const ficherosLog = [path.join(RAIZ, 'logs', 'app.log')];
for (const f of LOGS_EXTRA.map((x) => path.resolve(x))) {
  try {
    if (fs.statSync(f).isDirectory()) {
      for (const g of fs.readdirSync(f)) if (/\.log$|^app\.log(\.\d+)?$/.test(g)) ficherosLog.push(path.join(f, g));
    } else ficherosLog.push(f);
  } catch { console.warn(`   ⚠ --log ${f}: no existe`); }
}
for (let i = 1; i <= 20; i++) {
  const rotado = path.join(RAIZ, 'logs', `app.log.${i}`);
  if (fs.existsSync(rotado)) ficherosLog.push(rotado);
}
try {
  const dirScripts = path.join(RAIZ, 'logs', 'scripts');
  for (const f of fs.readdirSync(dirScripts)) if (f.endsWith('.log')) ficherosLog.push(path.join(dirScripts, f));
} catch { /* sin logs de scripts */ }

const RE_EXITO = /✓ (Visión|IA-texto)\[([^\]]+)\] \((\w+) · ([^)]+)\) respondió en (\d+) ms/gu;
const RE_FALLO = /↻ (Visión|IA-texto|Gemini)\[([^\]]+)\] falló \((.*?)\); (?:siguiente|probando)/gu;
const RE_DIRECTA = /❌ \[Error Visión IA\]: (.*)$/u;
// La misma llamada en app.log y en un volcado de Docker cuenta una vez, pero dos llamadas iguales en el mismo segundo
// DENTRO de un fichero son dos: de cada «hora|clave|resultado» se toma el máximo de veces que sale en un fichero.
const vistas = new Map();
const cobertura = [];       // qué tramo cubre cada log, para decir hasta dónde llega lo que se sabe
const pl = progreso(ficherosLog.length, 'Logs');
for (const f of ficherosLog) {
  pl.paso(path.basename(f));
  let texto;
  try { texto = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lineas = texto.split('\n');
  const conHora = lineas.filter((l) => /^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\]/.test(l));
  let deEste = 0;
  const enEste = new Map();
  let ultimaHora = null;   // en los logs de scripts, «✓ IA-texto[…]» va en su propia línea SIN hora (tras la de progreso)
  for (const l of lineas) {
    const propia = l.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\]/);
    if (propia) ultimaHora = propia[1];
    const h = propia || (ultimaHora ? [null, ultimaHora] : null);
    if (!h || h[1].slice(0, 10) < DESDE || h[1] >= detalleDesde) continue;
    const anotar = (x) => {
      const clave = `${h[1]}|${x.clave}|${x.ok}|${x.causa || ''}`;
      const veces = (enEste.get(clave) || 0) + 1;
      enEste.set(clave, veces);
      if (veces <= (vistas.get(clave) || 0)) return;   // ya contada desde otro fichero
      vistas.set(clave, veces);
      llamadas.push({ cuando: h[1], fuente: path.basename(f), ...x });
      deEste++;
    };
    for (const m of l.matchAll(RE_EXITO)) {
      if (m[3] !== 'paid') continue;
      anotar({ clave: m[2], modelo: m[4], ok: true, tarea: m[1] === 'Visión' ? 'visión' : 'texto', ms: Number(m[5]) });
    }
    for (const m of l.matchAll(RE_FALLO)) {
      if (!esPago(m[2])) continue;
      anotar({ clave: m[2] === 'paid' ? 'gemini-paid' : m[2], ok: false, causa: m[3], tarea: m[1] === 'IA-texto' ? 'texto' : 'visión' });
    }
    // La vía directa, cuando fallaba con la ÚLTIMA clave, solo dejaba esta línea; un 402 solo lo da la de pago.
    const d = l.match(RE_DIRECTA);
    if (d && /\b402\b|prepayment|credits are depleted/i.test(d[1])) {
      anotar({ clave: 'gemini-paid (vía directa)', ok: false, causa: d[1].replace(/\s+/g, ' ').slice(0, 300), tarea: 'portada (proveedor-metadatos)' });
    }
  }
  if (deEste && conHora.length) cobertura.push({ f: path.basename(f), desde: conHora[0].slice(1, 20), hasta: conHora.at(-1).slice(1, 20), n: deEste });
}
pl.fin();

llamadas.sort((a, b) => a.cuando.localeCompare(b.cuando));
const filtradas = llamadas.filter((x) => x.cuando.slice(0, 10) >= DESDE);

// 2c. Resumen del listado
const ok = filtradas.filter((x) => x.ok);
const fallos = filtradas.filter((x) => !x.ok);
const porCausa = new Map();
for (const x of fallos) {
  const c = /402|SIN SALDO|prepayment|credits are depleted/i.test(x.causa || '') ? '402 sin saldo (créditos de prepago agotados)'
    : /429|cuota|quota|rate.?limit/i.test(x.causa || '') ? '429 cuota / límite de peticiones'
    : /timeout|ETIMEDOUT|ECONNRESET|socket/i.test(x.causa || '') ? 'red / tiempo de espera'
    : String(x.causa || '?').slice(0, 60);
  porCausa.set(c, (porCausa.get(c) || 0) + 1);
}
ambos('LLAMADAS UNA A UNA (de todas las fuentes que tienen constancia)');
ambos(`   ${filtradas.length} llamadas de pago: ${ok.length} respondieron · ${fallos.length} fallaron`);
for (const [c, k] of [...porCausa].sort((a, b) => b[1] - a[1])) ambos(`      fallo: ${String(k).padStart(5)} × ${c}`);
ambos(`   Con detalle completo (tokens, coste, respuesta o causa): ${filtradas.filter((x) => x.fuente === 'detalle').length}`
  + (detalle.length ? ` — desde ${detalleDesde}` : ' — aún ninguna (empieza con el despliegue del 27-nov)'));
ambos('   Fuentes de log y el tramo que cubren:');
for (const c of cobertura) ambos(`      ${c.f.padEnd(52)} ${c.desde} → ${c.hasta} · ${c.n} llamadas`);
// uso_ia empieza el 27-oct: lo de antes que aparezca en los logs es constancia EXTRA, no se compara con él.
const inicioUso = dias[0]?._id || '9999';
const okAntes = ok.filter((x) => x.cuando.slice(0, 10) < inicioUso).length;
const okDurante = ok.length - okAntes;
if (okAntes) ambos(`   ${n(okAntes)} de las que respondieron son ANTERIORES al contador uso_ia (${inicioUso}): solo constan en los logs.`);
const sinDetalle = total.llamadas - okDurante;
if (sinDetalle > 0) {
  ambos(`   ⚠ Desde el ${inicioUso}, uso_ia cuenta ${n(total.llamadas)} que respondieron y los logs dan ${n(okDurante)}: las otras ${n(sinDetalle)}`);
  ambos('     ocurrieron en tramos que ningún log conserva (el tope de app.log las tiraba): de ellas solo queda la estadística por día.');
}
ambos();

// 2d. El listado (solo al .txt si hay --informe; si no, también a pantalla)
const corta = (s, m) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > m ? t.slice(0, m - 1) + '…' : t; };
L.push('─'.repeat(120));
L.push('LISTADO (hora local del contenedor)');
L.push('─'.repeat(120));
for (const x of filtradas) {
  const tokens = x.fuente === 'detalle' && x.ok
    ? ` · ${n(x.entrada)} ent / ${n(x.salida)} sal / ${n(x.razon)} raz · ${(x.eur || 0).toFixed(4)} €` : '';
  L.push(`${x.cuando}  ${x.ok ? '✓ OK   ' : '✗ FALLO'}  ${x.clave}${x.modelo ? ' · ' + x.modelo : ''}${x.origen ? ' · ' + x.origen : ''}${tokens}`
    + (x.ms ? ` · ${x.ms} ms` : '') + `  [${x.fuente}]`);
  if (x.tarea) L.push(`      tarea:     ${corta(x.tarea, 110)}`);
  if (!x.ok) L.push(`      causa:     ${corta(x.causa, RESPUESTAS_ENTERAS ? 600 : 160)}`);
  if (x.ok && x.respuesta != null) {
    if (RESPUESTAS_ENTERAS) { L.push('      respuesta:'); for (const r of String(x.respuesta).split('\n')) L.push('         ' + r); }
    else L.push(`      respuesta: ${corta(x.respuesta, 160)}`);
  } else if (x.ok) L.push('      respuesta: (no consta: los logs no guardan la respuesta; solo el detalle, desde el 27-nov)');
}

if (INFORME) {
  fs.writeFileSync(INFORME, L.join('\n') + '\n', 'utf8');
  console.log('\n' + R.join('\n'));
  console.log(`\n📄 Informe completo, con el listado de las ${filtradas.length} llamadas, en ${INFORME}`);
} else {
  console.log('\n' + L.join('\n') + '\n');
}
process.exit(0);
