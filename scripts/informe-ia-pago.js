/**
 * INFORME DE LA IA DE PAGO — cuántas llamadas se han hecho a los proveedores de PAGO (Gemini de pago y cualquier
 * otro con tier 'paid'), por día, por origen (quién la pidió) y por clave, con tokens y coste estimado.
 *
 * Fuentes:
 *   · `uso_ia` (utils/uso-ia.js): totales por día, origen y clave desde que existe el contador (27-oct-2026).
 *   · logs/ia-pago-detalle.jsonl: CADA llamada de pago (hora, origen, clave, modelo, tokens, coste, tarea), desde el
 *     26-nov; por máquina (el NAS y el PC tienen el suyo).
 *   · logs/app.log: cuándo se intentó la de pago y si respondió (sin tokens; solo las últimas horas, se rota).
 * Antes del 27-oct no hay registro. El coste es una ESTIMACIÓN con la tarifa
 * pública (config IA_PRECIO_*, o la propia del proveedor); el cargo exacto lo da AI Studio.
 *
 * Proveedores que verás:
 *   · GEMINI_API_KEY_PAID → la rotación de visión/texto (vision.js), que obedece los interruptores del panel.
 *   · gemini-paid         → la vía directa gemini.js·conGemini, que hasta f57399d (26-nov) NO los obedecía.
 *
 * Solo lee. Uso:
 *   node scripts/informe-ia-pago.js                     → todo el registro
 *   node scripts/informe-ia-pago.js --desde 2026-11-01  → desde una fecha
 *   node scripts/informe-ia-pago.js --informe <ruta>    → además lo escribe en un .txt
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { costeEur, DETALLE_PAGO } from '../src/utils/uso-ia.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { progreso } from '../src/utils/progreso-cli.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const DESDE = arg('--desde') || '0000-00-00';
const INFORME = arg('--informe');

const db = await conectarDB();
const dias = await db.collection('uso_ia').find({ _id: { $gte: DESDE } }).sort({ _id: 1 }).toArray();

// ── Acumular ──
const porDia = [];          // { dia, llamadas, entrada, salida, razon, eur, gratis }
const porOrigen = new Map(); // origen → acumulado de pago
const porClave = new Map();  // proveedor/clave → acumulado de pago
const nuevo = () => ({ llamadas: 0, entrada: 0, salida: 0, razon: 0, eur: 0 });
const sumar = (a, p, eur) => { a.llamadas += p.llamadas || 0; a.entrada += p.entrada || 0; a.salida += p.salida || 0; a.razon += p.razon || 0; a.eur += eur; };

const p = progreso(dias.length, 'Días');
for (const d of dias) {
  p.paso(d._id);
  const dia = { dia: d._id, ...nuevo(), gratis: 0 };
  for (const [origen, provs] of Object.entries(d.origen || {})) {
    for (const [clave, uso] of Object.entries(provs || {})) {
      if (uso.tier !== 'paid') { dia.gratis += uso.llamadas || 0; continue; }
      const eur = costeEur(uso);
      sumar(dia, uso, eur);
      if (!porOrigen.has(origen)) porOrigen.set(origen, nuevo());
      sumar(porOrigen.get(origen), uso, eur);
      if (!porClave.has(clave)) porClave.set(clave, nuevo());
      sumar(porClave.get(clave), uso, eur);
    }
  }
  porDia.push(dia);
}
p.fin();

// ── Pintar ──
const n = (x) => Math.round(x).toLocaleString('es-ES');
const e = (x) => x.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const fila = (cols, anchos) => cols.map((c, i) => (i === 0 ? String(c).padEnd(anchos[i]) : String(c).padStart(anchos[i]))).join('  ');
const total = nuevo();
for (const d of porDia) sumar(total, d, d.eur);

const L = [];
L.push(`INFORME DE LA IA DE PAGO — ${dias[0]?._id || '—'} → ${dias.at(-1)?._id || '—'} (${dias.length} días con registro)`);
L.push(`Fuente: colección uso_ia (contador desde el 27-oct-2026). Coste = estimación con la tarifa pública.`);
L.push('');
L.push(`TOTAL: ${n(total.llamadas)} llamadas de pago · ${n(total.entrada)} tokens de entrada · ${n(total.salida)} de salida · ${n(total.razon)} de razonamiento · ≈ ${e(total.eur)}`);
L.push('');
L.push('POR DÍA');
const A1 = [12, 9, 12, 10, 12, 10, 9];
L.push(fila(['día', 'llamadas', 'entrada', 'salida', 'razon.', 'coste', 'gratis'], A1));
for (const d of porDia) L.push(fila([d.dia, n(d.llamadas), n(d.entrada), n(d.salida), n(d.razon), e(d.eur), n(d.gratis)], A1));
L.push('');
const tabla = (titulo, mapa) => {
  L.push(titulo);
  const A = [34, 9, 12, 10, 12, 10, 10];
  L.push(fila(['', 'llamadas', 'entrada', 'salida', 'razon.', 'coste', '€/llamada'], A));
  for (const [k, a] of [...mapa].sort((x, y) => y[1].eur - x[1].eur)) {
    L.push(fila([k.slice(0, 34), n(a.llamadas), n(a.entrada), n(a.salida), n(a.razon), e(a.eur), a.llamadas ? (a.eur / a.llamadas).toFixed(4) : '—'], A));
  }
  L.push('');
};
tabla('POR ORIGEN (quién la pidió)', porOrigen);
tabla('POR CLAVE / VÍA', porClave);
L.push('GEMINI_API_KEY_PAID = rotación de visión/texto (obedece el panel) · gemini-paid = vía directa conGemini (no lo obedecía hasta f57399d).');
L.push('');

// ── Detalle llamada a llamada (logs/ia-pago-detalle.jsonl, desde el 26-nov) ──
let detalle = [];
try {
  detalle = fs.readFileSync(DETALLE_PAGO, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x) => x && x.ts.slice(0, 10) >= DESDE);
} catch { /* aún no hay detalle en esta máquina */ }
L.push(`DETALLE LLAMADA A LLAMADA (${DETALLE_PAGO.replace(/\\/g, '/').split('/').slice(-2).join('/')}) — ${detalle.length} llamadas`);
if (!detalle.length) {
  L.push('   (sin registro todavía: se anota cada llamada de pago desde el despliegue del 26-nov, en la máquina que la hace)');
} else {
  // Resumen por tarea (la primera línea de la instrucción dice qué se pedía).
  const porTarea = new Map();
  for (const x of detalle) {
    const k = `${x.origen} · ${String(x.tarea || '?').slice(0, 70)}`;
    if (!porTarea.has(k)) porTarea.set(k, nuevo());
    sumar(porTarea.get(k), { llamadas: 1, entrada: x.entrada, salida: x.salida, razon: x.razon }, x.eur || 0);
  }
  tabla('POR TAREA (origen · instrucción)', new Map([...porTarea].map(([k, v]) => [k, v])));
  const A = [19, 22, 22, 9, 8, 9, 8];
  L.push(fila(['hora (UTC)', 'origen', 'clave', 'entrada', 'salida', 'razon.', 'coste'], A) + '  tarea');
  for (const x of detalle) {
    L.push(fila([x.ts.slice(0, 19).replace('T', ' '), String(x.origen).slice(0, 22), String(x.proveedor).slice(0, 22),
      n(x.entrada), n(x.salida), n(x.razon), (x.eur || 0).toFixed(4)], A) + '  ' + String(x.tarea || '').slice(0, 80));
  }
}
L.push('');

// ── Lo que dice app.log (solo las últimas horas: se rota) ──
// Éxitos «✓ Visión[clave] (paid · modelo) respondió en N ms» y fallos «↻ Visión[clave] falló (motivo)», más los de la
// vía directa «↻ Gemini[paid] falló». No lleva tokens: sirve para ver CUÁNDO se intentó la de pago y si respondió.
const LOG = path.join(RAIZ, 'logs', 'app.log');
const esPago = (id) => /PAID|DEEPSEEK|DASHSCOPE|^paid$/i.test(id);
try {
  const lineas = fs.readFileSync(LOG, 'utf8').split('\n');
  const desdeLog = (lineas.find((l) => /^\[\d{4}-/.test(l)) || '').slice(1, 20);
  const porHora = new Map();   // «AAAA-MM-DD HH · clave» → { ok, fallos, motivos }
  for (const l of lineas) {
    // La vía directa (proveedor-metadatos·analizarImagenConIA, hasta f57399d), cuando fallaba con la ÚLTIMA clave, solo
    // dejaba «❌ [Error Visión IA]: … 402 Payment Required …»: se cuenta como fallo de gemini-paid.
    const directa = l.match(/^\[(\d{4}-\d\d-\d\d \d\d)[^\]]*\]\s+❌ \[Error Visión IA\]:.*?\b(402|429)\b/u);
    if (directa) {
      const k = `${directa[1]}h · gemini-paid (vía directa)`;
      const a = porHora.get(k) || { ok: 0, fallos: 0, motivos: new Map() };
      a.fallos++;
      a.motivos.set(directa[2] === '402' ? '402 sin saldo' : '429 cuota', (a.motivos.get(directa[2] === '402' ? '402 sin saldo' : '429 cuota') || 0) + 1);
      porHora.set(k, a);
      continue;
    }
    const m = l.match(/^\[(\d{4}-\d\d-\d\d \d\d)[^\]]*\]\s+([✓↻])\s+(?:Visión|IA-texto|Gemini)\[([^\]]+)\]\s*(.*)$/u);
    if (!m || !esPago(m[3])) continue;
    if (m[2] === '✓' && !/\bpaid\b/.test(m[4])) continue;
    const k = `${m[1]}h · ${m[3]}`;
    const a = porHora.get(k) || { ok: 0, fallos: 0, motivos: new Map() };
    if (m[2] === '✓') a.ok++;
    else {
      a.fallos++;
      const motivo = (m[4].match(/falló \((.{0,40})/) || [])[1] || '?';
      a.motivos.set(motivo, (a.motivos.get(motivo) || 0) + 1);
    }
    porHora.set(k, a);
  }
  L.push(`APP.LOG (desde ${desdeLog || '?'}, hora del contenedor) — intentos de IA de pago por hora`);
  if (!porHora.size) L.push('   (ninguno)');
  for (const [k, a] of porHora) {
    const motivos = [...a.motivos].map(([mo, c]) => `${c}× ${mo}`).join('; ');
    L.push(`   ${k.padEnd(40)} respondieron ${String(a.ok).padStart(4)} · fallaron ${String(a.fallos).padStart(4)}${motivos ? '  (' + motivos + ')' : ''}`);
  }
} catch { L.push('APP.LOG: no se pudo leer.'); }

const texto = L.join('\n');
console.log('\n' + texto + '\n');
if (INFORME) { fs.writeFileSync(INFORME, texto + '\n', 'utf8'); console.log(`📄 Informe escrito en ${INFORME}`); }
process.exit(0);
