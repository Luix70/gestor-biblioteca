/**
 * INFORME DE LA IA DE PAGO — cuántas llamadas se han hecho a los proveedores de PAGO (Gemini de pago y cualquier
 * otro con tier 'paid'), por día, por origen (quién la pidió) y por clave, con tokens y coste estimado.
 *
 * Fuente: la colección `uso_ia` (utils/uso-ia.js), un documento por día desde que existe el contador (27-oct-2026).
 * Antes de esa fecha no hay registro por llamada (el log de la app se rota). El coste es una ESTIMACIÓN con la tarifa
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
import { conectarDB } from '../src/database.js';
import { costeEur } from '../src/utils/uso-ia.js';
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

const texto = L.join('\n');
console.log('\n' + texto + '\n');
if (INFORME) { fs.writeFileSync(INFORME, texto + '\n', 'utf8'); console.log(`📄 Informe escrito en ${INFORME}`); }
process.exit(0);
