/**
 * IMPORTAR EL UDC SUMMARY (resumen oficial de la CDU del Consorcio UDC, ~2.430 clases, CC BY-SA 3.0) en español e
 * inglés, como descripciones VERIFICADAS de los códigos CDU. Hasta ahora las escribía la IA y se inventaba cosas
 * («94(430).085 = Geología de la Antártida», «572.4 = Botánica – Fisiología vegetal»); ver docs/tareas-pendientes §4.
 *
 * El servicio oficial (udcdata.info) está fuera de línea mientras el Consorcio lo revisa para la MRF12 (8-oct). Se usan
 * dos réplicas de la versión anterior, que para las ~2.400 clases del resumen (clases, divisiones y tablas de
 * auxiliares) cambia muy poco:
 *   · ESPAÑOL: vocabularyserver.com/udc/es (TemaTres, cargado en 2019 desde udcsummary.info), término a término por su
 *     API: código, nombre y notas (alcance, ejemplos…). ~2.435 términos × 2 peticiones, con pausa entre ellas.
 *   · INGLÉS (y la JERARQUÍA): vocabs.rossio.fcsh.unl.pt (Skosmos), el vocabulario entero en un solo fichero Turtle.
 * Lo descargado se guarda en `logs/udcs/` (caché: si se corta, se relanza y sigue donde iba).
 *
 * Escribe (con --ejecutar):
 *   · `udc_summary`: la tabla completa (código, es/en, notas, ejemplos, padre) — referencia para el diagnóstico de CDU
 *     y para describir los códigos que no estén en el resumen.
 *   · `cdu_descripciones`: la descripción de cada código del resumen, `fuente:'udcs'`, `verificado:true`. La que había
 *     escrito la IA se copia antes en `cdu_descripciones_retiradas`. Las verificadas A MANO no se tocan nunca.
 * Volver a lanzarlo (p. ej. cuando el Consorcio publique su nuevo servicio) solo sustituye lo que tenga `fuente:'udcs'`.
 * Licencia: CC BY-SA 3.0, © UDC Consortium (hay que citarlo donde se muestre).
 *
 *   node scripts/importar-udc-summary.js                    (descarga a la caché y enseña el resumen; no escribe)
 *   node scripts/importar-udc-summary.js --ejecutar         (además lo guarda en la base)
 *   … --pausa 250        milisegundos entre peticiones (por defecto 200)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { sanitizarCDU, arbolCDU } from '../src/utils/cdu-arbol.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const PAUSA_MS = Number(arg('--pausa')) || 200;

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR_CACHE = path.join(RAIZ, 'logs', 'udcs');
const CACHE_ES = path.join(DIR_CACHE, 'es-vocabularyserver.json');
const CACHE_EN = path.join(DIR_CACHE, 'en-rossio.ttl');
const API_ES = 'https://vocabularyserver.com/udc/es/services.php';
const URL_EN = 'https://vocabs.rossio.fcsh.unl.pt/pub/download/udc-summary.ttl';
const FUENTE = {
  es: 'vocabularyserver.com/udc/es (TemaTres, 2019, desde udcsummary.info)',
  en: 'vocabs.rossio.fcsh.unl.pt/pub/udcS (Skosmos)',
  licencia: 'CC BY-SA 3.0 — © UDC Consortium (UDC Summary)',
};

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET con reintentos (3) y un User-Agent de navegador (algunos servidores rechazan los de script). */
async function obtener(url, { intentos = 3 } = {}) {
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (gestor-biblioteca; importación UDC Summary)' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i === intentos) throw e;
      await dormir(2000 * i);
    }
  }
  return null;
}

// ─── Español: TemaTres, término a término ───────────────────────────────────────────────────────────────────
const sinCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
const etiqueta = (xml, nombre) => { const m = String(xml).match(new RegExp(`<${nombre}>([\\s\\S]*?)</${nombre}>`)); return m ? sinCdata(m[1]) : null; };
const bloques = (xml, nombre) => [...String(xml).matchAll(new RegExp(`<${nombre}>([\\s\\S]*?)</${nombre}>`, 'g'))].map((m) => m[1]);

async function terminoES(id) {
  const xt = await obtener(`${API_ES}?task=fetchTerm&arg=${id}`);
  if (!xt || etiqueta(xt, 'cant_result') === '0') return null;
  const termino = bloques(xt, 'term')[0] || '';
  const codigo = etiqueta(termino, 'code') || '';
  const nombre = etiqueta(termino, 'string') || '';
  await dormir(PAUSA_MS);
  const xn = await obtener(`${API_ES}?task=fetchNotes&arg=${id}`);
  const notas = bloques(xn || '', 'term').map((b) => ({ tipo: etiqueta(b, 'note_type'), texto: etiqueta(b, 'note_text') }))
    .filter((n) => n.texto);
  return { id, codigo, nombre, notas };
}

async function descargarES() {
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(CACHE_ES, 'utf8')); } catch { /* primera vez */ }
  const datos = await obtener(`${API_ES}?task=fetchVocabularyData`);
  const total = Number(etiqueta(datos || '', 'cant_terms')) || 2435;
  console.log(`Español: ${total} términos en vocabularyserver.com · ya en caché: ${Object.keys(cache).length}`);
  const p = progreso(total + 40, 'Descargando (es)');
  let vacios = 0;
  for (let id = 1; vacios < 40; id++) {
    p.paso(`término ${id}`);
    if (cache[id] !== undefined) { vacios = cache[id] ? 0 : vacios + 1; continue; }
    const t = await terminoES(id).catch((e) => { p.nota(`   ⚠ término ${id}: ${e.message} (se reintentará en otra pasada)`); return undefined; });
    if (t === undefined) continue;
    cache[id] = t;                                   // null = no existe (se cuenta para saber dónde acaba)
    vacios = t ? 0 : vacios + 1;
    if (id % 50 === 0) await fs.writeFile(CACHE_ES, JSON.stringify(cache));
    await dormir(PAUSA_MS);
  }
  await fs.writeFile(CACHE_ES, JSON.stringify(cache));
  p.fin();
  return Object.values(cache).filter(Boolean);
}

// ─── Inglés + jerarquía: Rossio, el vocabulario entero en Turtle ─────────────────────────────────────────────
async function descargarEN() {
  let ttl = null;
  try { ttl = await fs.readFile(CACHE_EN, 'utf8'); } catch { /* primera vez */ }
  if (!ttl) {
    console.log('Inglés: descargando el vocabulario de Rossio…');
    ttl = await obtener(URL_EN);
    if (!ttl) throw new Error('Rossio no devolvió el vocabulario');
    await fs.writeFile(CACHE_EN, ttl);
  }
  // Un bloque por concepto: «<http://udcdata.info/NNN> a skos:Concept; … .»
  const LIT = '"((?:[^"\\\\]|\\\\.)*)"';
  const des = (s) => s.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  const conceptos = new Map();
  for (const b of ttl.split(/\n(?=<http:\/\/udcdata\.info\/)/)) {
    const iri = (b.match(/^<(http:\/\/udcdata\.info\/[^>]+)>/) || [])[1];
    const notacion = (b.match(new RegExp(`skos:notation ${LIT}`)) || [])[1];
    if (!iri || notacion == null) continue;
    const enIdioma = (pred, lang) => {
      const m = b.match(new RegExp(`skos:${pred}\\s+((?:${LIT}@[a-z-]+\\s*,?\\s*)+)`));
      if (!m) return [];
      return [...m[1].matchAll(new RegExp(`${LIT}@([a-z-]+)`, 'g'))].filter((x) => x[2] === lang).map((x) => des(x[1]));
    };
    conceptos.set(iri, {
      iri, codigo: des(notacion),
      titulo: enIdioma('prefLabel', 'en')[0] || null,
      titulo_pt: enIdioma('prefLabel', 'pt')[0] || null,
      notas: [
        ...enIdioma('scopeNote', 'en').map((texto) => ({ tipo: 'alcance', texto })),
        ...enIdioma('note', 'en').map((texto) => ({ tipo: 'nota', texto })),
        ...enIdioma('example', 'en').map((texto) => ({ tipo: 'ejemplo', texto })),
      ],
      padreIri: (b.match(/skos:broader <([^>]+)>/) || [])[1] || null,
    });
  }
  for (const c of conceptos.values()) c.padre = c.padreIri ? conceptos.get(c.padreIri)?.codigo || null : null;
  console.log(`Inglés: ${conceptos.size} conceptos (con su jerarquía)`);
  return [...conceptos.values()];
}

// ─── Unir y guardar ──────────────────────────────────────────────────────────────────────────────────────────
/** «MATEMÁTICAS. CIENCIAS NATURALES» → «Matemáticas. Ciencias naturales» (solo si va todo en mayúsculas). */
function sinMayusculas(t) {
  const s = String(t || '').trim();
  if (!s || /\p{Ll}/u.test(s)) return s;
  return s.toLowerCase().replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
}
// Tipos de nota de TemaTres: NA alcance, IN «incluye» («Árabe, maltés»), EX ejemplos; las privadas no se enseñan.
const TIPOS_ES = { NA: 'alcance', IN: 'incluye', EX: 'ejemplo', NH: 'historia', NB: 'bibliográfica', NP: 'privada', NC: 'catalogador' };
const ROTULOS = { es: { incluye: 'Incluye', ejemplo: 'Ejemplos' }, en: { incluye: 'Includes', ejemplo: 'Examples' } };
/** La descripción legible: el nombre, sus notas de alcance, lo que incluye y, al final, los ejemplos. */
function descripcion(titulo, notas, idioma) {
  const de = (tipo) => notas.filter((n) => n.tipo === tipo).map((n) => n.texto);
  const texto = notas.filter((n) => !['ejemplo', 'incluye', 'privada'].includes(n.tipo)).map((n) => n.texto);
  const rotulado = (tipo) => (de(tipo).length ? `${ROTULOS[idioma][tipo]}: ${de(tipo).join(' · ')}` : '');
  const cabeza = titulo ? (/[.!?]$/.test(titulo) ? titulo : `${titulo}.`) : '';
  return [cabeza, ...texto, rotulado('incluye'), rotulado('ejemplo')].filter(Boolean).join('\n\n') || null;
}

await fs.mkdir(DIR_CACHE, { recursive: true });
const es = await descargarES();
const en = await descargarEN();

// Por código (la notación tal cual). Los «metatérminos» del español sin código (cabeceras de tabla) se quedan fuera.
const porCodigo = new Map();
for (const t of es) {
  if (!t.codigo) continue;
  const notas = t.notas.map((n) => ({ tipo: TIPOS_ES[n.tipo] || String(n.tipo || 'nota').toLowerCase(), texto: n.texto }));
  porCodigo.set(t.codigo, { codigo: t.codigo, es: { titulo: sinMayusculas(t.nombre), notas } });
}
for (const c of en) {
  const x = porCodigo.get(c.codigo) || { codigo: c.codigo };
  x.en = { titulo: sinMayusculas(c.titulo), notas: c.notas };
  if (c.titulo_pt) x.pt = { titulo: c.titulo_pt };
  if (c.padre) x.padre = c.padre;
  porCodigo.set(c.codigo, x);
}
const filas = [...porCodigo.values()];
const conAmbos = filas.filter((f) => f.es && f.en).length;
console.log(`\nCódigos: ${filas.length} · con español: ${filas.filter((f) => f.es).length} · con inglés: ${filas.filter((f) => f.en).length} · con los dos: ${conAmbos}`);
for (const c of ['5', '57', '572', '58', '581.1', '94', '(430)', '(99)', '821.134.2', '=111']) {
  const f = porCodigo.get(c);
  console.log(`   ${c.padEnd(10)} es «${f?.es?.titulo || '—'}» · en «${f?.en?.titulo || '—'}»${f?.padre ? ` · padre ${f.padre}` : ''}`);
}

// Contra la base: en seco solo se LEE (qué se sustituiría y una muestra antes → después); con --ejecutar se escribe.
let escritas = 0, retiradas = 0, respetadas = 0, nuevas = 0;
const muestra = [];
const db = await conectarDB();
const colU = db.collection('udc_summary');
const colD = db.collection('cdu_descripciones');
if (EJECUTAR) await colU.createIndex({ clave: 1 }).catch(() => {});
const p = progreso(filas.length, EJECUTAR ? 'Guardando' : 'Comparando');
for (const f of filas) {
  p.paso(f.codigo);
  const clave = sanitizarCDU(f.codigo);
  if (EJECUTAR) await colU.updateOne({ _id: f.codigo }, { $set: { ...f, clave, fuente: FUENTE, fecha: new Date() } }, { upsert: true });
  // Solo los códigos que pueden ser la CDU de un libro (empiezan por cifra).
  // (Los auxiliares sueltos —«(430)», «=111»— y los patrones «=...`04» se quedan solo en udc_summary.)
  if (!clave || !/^[0-9]/.test(clave) || f.codigo.includes('...') || f.codigo.includes('`')) continue;
  const ya = await colD.findOne({ codigo: clave });
  if (ya?.verificado && ya.fuente !== 'udcs') { respetadas++; continue; }   // verificada a mano: no se toca
  const titulo_es = f.es?.titulo || f.en?.titulo || null;
  if (!ya) nuevas++;
  else if (ya.fuente !== 'udcs') {
    retiradas++;
    if (muestra.length < 30 && ya.titulo_es !== titulo_es) {
      muestra.push(`   ${clave.padEnd(14)} «${String(ya.titulo_es || '').slice(0, 55)}» → «${String(titulo_es).slice(0, 55)}»`);
    }
  }
  if (!EJECUTAR) continue;
  if (ya && ya.fuente !== 'udcs') {
    const { _id, ...copia } = ya;
    await db.collection('cdu_descripciones_retiradas').insertOne({ ...copia, _id_original: _id, retirada: { fecha: new Date(), motivo: 'sustituida por el UDC Summary oficial' } });
  }
  const { clase, division } = arbolCDU(f.codigo);
  await colD.updateOne({ codigo: clave }, {
    $set: {
      codigo: clave, clase, division,
      titulo_es,
      descripcion_es: f.es ? descripcion(f.es.titulo, f.es.notas, 'es') : null,
      titulo_en: f.en?.titulo || null,
      descripcion_en: f.en ? descripcion(f.en.titulo, f.en.notas, 'en') : null,
      fuente: 'udcs', verificado: true, licencia: FUENTE.licencia, fecha: new Date(),
    },
  }, { upsert: true });
  escritas++;
}
p.fin();

if (muestra.length) console.log(`\nMuestra de descripciones de IA que cambian:\n${muestra.join('\n')}`);
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${filas.length} códigos en el UDC Summary · descripciones: ${nuevas} nuevas, ${retiradas} de IA ${EJECUTAR ? 'retiradas (copia en cdu_descripciones_retiradas)' : 'se sustituirían'}, ${respetadas} verificadas a mano respetadas${EJECUTAR ? ` · ${escritas} escritas` : ''} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar para guardarlo (no descarga otra vez: usa la caché de logs/udcs/).');
process.exit(0);
