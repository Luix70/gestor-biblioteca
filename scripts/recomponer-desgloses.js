/**
 * RECOMPONER LIBROS DESGLOSADOS (1-nov).
 *
 * Por qué: en la ingesta del 31-oct/1-nov, 29 libros partidos en capítulos no se pudieron coser (qpdf agotó sus 5 min,
 * o había partes .doc) y el vigilante siguió con las reglas normales: cada capítulo acabó como UN documento, en su
 * propia carpeta, dentro de una colección con el nombre del libro, y con ISBN y CDU de otros libros (1.085 documentos).
 * Además, varios libros que sí se cosieron llevan el libro ENTERO cosido dentro con sus propios capítulos.
 *
 * Qué hace: devolver cada libro al Inbox tal como llegó, para que lo cataloge la ingesta ya corregida. Así no hay
 * lógica de reparación aparte: este script solo DESHACE, y decide el mismo código que decidirá con cualquier libro
 * nuevo (vigilante · materializarDesgloseGuiado).
 *
 *   1. CAPÍTULOS SUELTOS. Para cada carpeta del Inbox con guía `desglose`, su colección homónima: los miembros de esta
 *      ingesta (--desde) se COPIAN a su sitio en la carpeta del Inbox (copia verificada), se retiran del catálogo y su
 *      carpeta va a la Papelera (reproceso · eliminarDocumento). Las partes que acabaron en Cuarentena/no-identificados
 *      vuelven también. La guía queda con el orden recalculado y, si está entre las partes, el libro entero.
 *   2. COSIDOS CON EL LIBRO ENTERO DENTRO. Los originales están en «Desglose/»: se copian a una carpeta nueva del Inbox
 *      con guía, y el documento cosido se retira. Los cosidos correctos se quedan; solo pierden «(recompuesto)» del título.
 *   3. SUELTOS: lo que se cosió sin ser un libro (SEPARAR) vuelve al Inbox para catalogarse pieza a pieza.
 *
 * Lo que no se toca: un documento con trabajo humano (cdu_manual, valoración, NFC, ficha de lectura) se lista y se queda.
 * Las partes en Cuarentena/ilegibles están dañadas y se quedan allí. Una colección solo se borra si queda vacía y nació
 * en esta ingesta. Nada se borra de verdad: lo retirado pasa por la Papelera.
 *
 * ⚠ Con el VIGILANTE EN PAUSA (si no, cogería las carpetas a medio restaurar) y DESPUÉS de desplegar la ingesta
 * corregida. Copia antes: D:\Bibliobak\CopiaBase.ps1 en el PC.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/recomponer-desgloses.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/recomponer-desgloses.js --ejecutar
 *   Opciones: --solo <texto del nombre> · --desde <fecha ISO> · --coleccion "<nombre>" (repetible)
 *
 * --coleccion trata como libro desglosado una colección sin guía de desglose en el Inbox («Student Solutions Manual»):
 * sus miembros vuelven a una carpeta nueva con guía. Comprueba antes que lo es: «Facility Management» parecía otro
 * caso igual y es una obra con audio, que no hay que tocar.
 *
 * Después, en el PC: scripts/convertir-partes-word.ps1 convierte a PDF las partes .doc de los libros que hay que coser.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { eliminarDocumento } from '../src/utils/reproceso.js';
import { reciclarCarpeta } from '../src/utils/papelera.js';
import { escribirGuia } from '../src/utils/guia-ingesta.js';
import { libroEnteroEntrePartes, ordenarPartesLibro, planCosido, sinCopiasParalelas } from '../src/utils/libro-desglosado.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SOLO = (opcion('--solo') || '').toLowerCase();
const COLECCIONES = args.filter((a, i) => args[i - 1] === '--coleccion');
const DESDE = new Date(opcion('--desde') || '2026-10-31T20:00:00Z');   // inicio de la ingesta de World Tracker Library

const RAIZ = path.resolve(process.cwd());
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
// Los cosidos ya no tienen carpeta en el Inbox: vuelven aquí. Ya inspeccionada, y con guía propia cada libro.
const ENTRADA_COSIDOS = path.join(DIR_INBOX, 'World Tracker Library', 'College Books');
// Cosido por error: no es un libro sino una carpeta de artículos sueltos.
const SEPARAR = new Set(['Dominique Spring 2008 Articles']);
const SUFIJO = ' (recompuesto)';
// El texto completo viene en estos PDF; las demás partes (.doc de los mismos capítulos) viajan a «Desglose/».
const SOLO_ESTOS = {
  'Sociology A Down to Earth Approach': ['Sociology A Down To Earth Approach Chap 1-10.pdf', 'Sociology A Down To Earth Approach Chap 11-22.pdf'],
};

const webAAbs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
const existe = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const tamano = async (p) => { try { return (await fs.stat(p)).size; } catch { return -1; } };
const absDe = (dir, rel) => path.join(dir, ...rel.split('/'));
const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;

const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 SECO'} · recomponer libros desglosados (desde ${DESDE.toISOString()})\n`);
if (EJECUTAR) console.log('⚠ El Vigilante debe estar en pausa durante toda la ejecución.\n');

/** Copia verificada por tamaño. Si el destino ya existe con el mismo tamaño, vale; con otro, es un conflicto. */
async function copiarVerificado(origen, destino) {
  const previo = await tamano(destino), bytes = await tamano(origen);
  if (previo === bytes) return;
  if (previo >= 0) throw new Error(`ya hay otro fichero distinto en ${destino}`);
  await fs.mkdir(path.dirname(destino), { recursive: true });
  await fs.copyFile(origen, destino);
  if ((await tamano(destino)) !== bytes) { await fs.rm(destino, { force: true }); throw new Error(`copia incompleta de ${path.basename(origen)}`); }
}

/** ¿Tiene el documento trabajo humano? Devuelve el motivo o null. */
async function trabajoHumano(d) {
  if (d.cdu_manual) return 'CDU manual';
  if (d.valoracion) return 'valoración';
  if (d.nfc) return 'NFC';
  if (await db.collection('fichas_lectura').findOne({ ambito: 'documento', ref: d._id }, { projection: { _id: 1 } })) return 'ficha de lectura';
  return null;
}

/** Retira un documento: lo saca de las selecciones y borra su ficha; su carpeta va a la Papelera. */
async function retirar(d) {
  await db.collection('selecciones').updateMany({ docs: d._id }, { $pull: { docs: d._id } });
  await eliminarDocumento(db, d);
}

// ── 0. Índices del disco ────────────────────────────────────────────────────────────────────────────────────
/** Carpetas del Inbox con guía `desglose`. */
async function guiasDesglose() {
  const out = [];
  const andar = async (dir) => {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (ents.some((e) => e.isFile() && e.name === '_guia.json')) {
      try {
        const g = JSON.parse(await fs.readFile(path.join(dir, '_guia.json'), 'utf8'));
        if (g.accion === 'desglose') out.push({ dir, nombre: path.basename(dir), guia: g });
      } catch { console.warn(`⚠️  guía ilegible en ${dir}`); }
    }
    for (const e of ents) if (e.isDirectory() && !/^[.@#]/.test(e.name)) await andar(path.join(dir, e.name));
  };
  await andar(DIR_INBOX);
  return out;
}

/** Depósitos de Cuarentena (salvo ilegibles): nombre de fichero → su carpeta. */
async function depositosCuarentena() {
  const m = new Map();
  let cats;
  try { cats = await fs.readdir(DIR_CUARENTENA, { withFileTypes: true }); } catch { return m; }
  for (const c of cats) {
    if (!c.isDirectory() || c.name === 'ilegibles') continue;
    const dirCat = path.join(DIR_CUARENTENA, c.name);
    for (const dep of await fs.readdir(dirCat, { withFileTypes: true }).catch(() => [])) {
      if (!dep.isDirectory()) continue;
      for (const f of await fs.readdir(path.join(dirCat, dep.name)).catch(() => [])) {
        if (f !== 'estado.json' && !m.has(f)) m.set(f, path.join(dirCat, dep.name));
      }
    }
  }
  return m;
}

// ── 1. Plan: capítulos sueltos ──────────────────────────────────────────────────────────────────────────────
console.log('Buscando guías de desglose en el Inbox…');
const guias = (await guiasDesglose()).filter((g) => !SOLO || g.nombre.toLowerCase().includes(SOLO));
for (const nombre of COLECCIONES) {
  guias.push({ dir: path.join(ENTRADA_COSIDOS, nombre), nombre, guia: { accion: 'desglose', perfil: { origen: 'panel' }, desglose: { orden: [] } } });
}
const depositos = await depositosCuarentena();
console.log(`  ${guias.length} carpetas con guía · ${depositos.size} ficheros en Cuarentena\n`);

const planes = [], sinNada = [];
const pPlan = progreso(guias.length, 'Analizando');
for (const g of guias) {
  pPlan.paso(g.nombre);
  const d = g.guia.desglose || {};
  const nombresGuia = [...(d.orden || []), ...(d.principal ? [d.principal] : [])];
  const relDe = new Map();      // nombre de fichero → ruta relativa en la carpeta de libro
  const repetidos = [];
  for (const rel of nombresGuia) {
    const base = rel.split('/').pop();
    if (relDe.has(base)) repetidos.push(rel); else relDe.set(base, rel);
  }

  const coleccion = await db.collection('colecciones').findOne({ nombre: g.nombre });
  const miembros = coleccion ? await col.find({ coleccion: coleccion._id }).toArray() : [];
  const deEstaIngesta = miembros.filter((x) => x.fecha_ingreso >= DESDE && x.nombre_archivo);
  // Un PDF de la colección catalogado ANTES de esta ingesta (el libro entero de «Making America»: su copia del Inbox
  // era idéntica y la ingesta la retiró, quedando el documento antiguo con otro nombre). Se queda en el catálogo y su
  // fichero se copia al Inbox: al reingerirlo es un duplicado exacto y los capítulos se adjuntan a ese documento.
  const anteriores = [];
  for (const x of miembros) {
    if (x.fecha_ingreso >= DESDE || !/\.pdf$/i.test(x.nombre_archivo || '')) continue;
    const fichero = path.join(webAAbs(x.ruta_base), x.nombre_archivo);
    if (await existe(fichero)) anteriores.push({ rel: relDe.get(x.nombre_archivo) || x.nombre_archivo, fichero });
  }

  const retirar_ = [], respetados = [], sinFichero = [];
  for (const x of deEstaIngesta) {
    const motivo = await trabajoHumano(x);
    if (motivo) { respetados.push(`«${x.titulo}» (${motivo})`); continue; }
    const fichero = path.join(webAAbs(x.ruta_base), x.nombre_archivo);
    if (!(await existe(fichero))) { sinFichero.push(x.nombre_archivo); continue; }
    retirar_.push({ doc: x, fichero, rel: relDe.get(x.nombre_archivo) || x.nombre_archivo, enGuia: relDe.has(x.nombre_archivo) });
  }

  // Partes de la guía que ni están en el Inbox ni son documento: ¿en Cuarentena?
  const deCuarentena = [];
  const yaCubiertas = new Set(retirar_.map((r) => r.doc.nombre_archivo));
  for (const [base, rel] of relDe) {
    if (yaCubiertas.has(base) || await existe(absDe(g.dir, rel)) || !depositos.has(base)) continue;
    deCuarentena.push({ rel, deposito: depositos.get(base), fichero: path.join(depositos.get(base), base) });
  }
  if (!retirar_.length && !deCuarentena.length) { sinNada.push(g); continue; }
  const copias = [...retirar_, ...anteriores, ...deCuarentena];

  // Cómo quedará la carpeta: lo que ya está en ella más lo que vuelve.
  const fuera = new Map(copias.map((c) => [c.rel, c.fichero]));
  const enCarpeta = [];
  for (const rel of nombresGuia) if (!fuera.has(rel) && await existe(absDe(g.dir, rel))) enCarpeta.push(rel);
  const partes = [...new Set([...enCarpeta, ...fuera.keys()])];
  const entero = await libroEnteroEntrePartes(g.dir, partes, { rutaDe: (n) => fuera.get(n) || absDe(g.dir, n) });
  // Un orden con títulos viene de la IA con el sumario delante y se respeta; el demás se recalcula (se ha afinado).
  const hayTitulos = Object.keys(d.titulos || {}).length > 0;
  const restantes = partes.filter((n) => n !== entero);
  const paraCoser = SOLO_ESTOS[g.nombre] || sinCopiasParalelas(restantes);
  const soloOrden = paraCoser.length < restantes.length;
  const orden = soloOrden ? ordenarPartesLibro(paraCoser)
    : hayTitulos ? (d.orden || []).filter((n) => restantes.includes(n)) : ordenarPartesLibro(restantes);
  const cosido = planCosido(paraCoser, orden, d.titulos || {});
  const bytes = (await Promise.all(retirar_.map((r) => tamano(r.fichero)))).reduce((a, b) => a + b, 0);

  planes.push({ ...g, coleccion, nMiembros: miembros.length, retirar: retirar_, deCuarentena, anteriores, copias, respetados, sinFichero, repetidos,
    entero, orden, soloOrden, sinPdf: cosido.sinPdf, partes, bytes, titulos: d.titulos });
}
pPlan.fin();

// ── 2. Plan: lo ya cosido ───────────────────────────────────────────────────────────────────────────────────
const cosidos = await col.find({ nombre_archivo: /\(recompuesto\)\.pdf$/, ...(SOLO ? { nombre_archivo: new RegExp(SOLO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*\\(recompuesto\\)\\.pdf$', 'i') } : {}) }).toArray();
const aRehacer = [], aSeparar = [], aRetitular = [], cosidosRespetados = [];

/** Ficheros de «Desglose/», con ruta relativa a ella. */
async function ficherosDesglose(dir, pre = '') {
  const out = [];
  for (const e of await fs.readdir(path.join(dir, ...pre.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.push(...await ficherosDesglose(dir, `${pre}${e.name}/`));
    else out.push(`${pre}${e.name}`);
  }
  return out;
}

const pCos = progreso(cosidos.length, 'Revisando cosidos');
for (const d of cosidos) {
  pCos.paso(d.titulo);
  const nombreLibro = d.nombre_archivo.replace(/ \(recompuesto\)\.pdf$/, '');
  const dirDesglose = path.join(webAAbs(d.ruta_base), 'Desglose');
  const partes = await ficherosDesglose(dirDesglose);
  const motivo = await trabajoHumano(d);
  const entero = partes.length ? await libroEnteroEntrePartes(dirDesglose, partes) : null;
  const item = { doc: d, nombreLibro, dirDesglose, partes, entero };
  if (motivo && (entero || SEPARAR.has(nombreLibro))) cosidosRespetados.push(`«${d.titulo}» (${motivo})`);
  else if (SEPARAR.has(nombreLibro) && partes.length) aSeparar.push(item);
  else if (entero) aRehacer.push(item);
  if (String(d.titulo).includes(SUFIJO) && !aRehacer.includes(item) && !aSeparar.includes(item)) aRetitular.push(d);
}
pCos.fin();

// ── 3. Informe ──────────────────────────────────────────────────────────────────────────────────────────────
const conEntero = planes.filter((p) => p.entero);
const aCoser = planes.filter((p) => !p.entero && !p.sinPdf.length);
const aConvertir = planes.filter((p) => !p.entero && p.sinPdf.length);
const titulares = (t, xs) => console.log(`\n── ${t}: ${xs.length} ──`);

titulares('Libro entero presente (se cataloga él, los capítulos van adjuntos)', conEntero);
for (const p of conEntero) console.log(`   ${p.nombre}: «${p.entero}» + ${p.partes.length - 1} partes · retira ${p.retirar.length} docs (${mb(p.bytes)})`);
titulares('Solo PDF (se cosen)', aCoser);
for (const p of aCoser) console.log(`   ${p.nombre}: ${p.orden.length} partes${p.soloOrden ? ` (+${p.partes.length - p.orden.length} copias que no se cosen)` : ''} · retira ${p.retirar.length} docs · ${p.orden[0]} … ${p.orden[p.orden.length - 1]}`);
titulares('Con partes sin PDF (convertir con Word en el PC y luego se cosen)', aConvertir);
for (const p of aConvertir) console.log(`   ${p.nombre}: ${p.sinPdf.length} sin PDF de ${p.partes.length} · retira ${p.retirar.length} docs · ${p.orden[0]} … ${p.orden[p.orden.length - 1]}`);

titulares('Cosidos con el libro entero dentro (se rehacen)', aRehacer);
for (const c of aRehacer) console.log(`   ${c.nombreLibro}: «${c.entero}» + ${c.partes.length - 1} partes`);
titulares('Cosidos que no son un libro (vuelven pieza a pieza)', aSeparar);
for (const c of aSeparar) console.log(`   ${c.nombreLibro}: ${c.partes.length} piezas`);
titulares('Cosidos correctos que solo pierden «(recompuesto)» del título', aRetitular);
for (const d of aRetitular) console.log(`   «${d.titulo}»`);

const avisos = [];
for (const p of planes) {
  if (p.respetados.length) avisos.push(`${p.nombre}: se quedan por trabajo humano → ${p.respetados.join(' · ')}`);
  if (p.sinFichero.length) avisos.push(`${p.nombre}: ${p.sinFichero.length} documentos sin su fichero, no se tocan → ${p.sinFichero.slice(0, 5).join(', ')}`);
  if (p.repetidos.length) avisos.push(`${p.nombre}: ${p.repetidos.length} nombres repetidos en la guía → ${p.repetidos.slice(0, 5).join(', ')}`);
  const fuera = p.retirar.filter((r) => !r.enGuia);
  if (fuera.length) avisos.push(`${p.nombre}: ${fuera.length} documentos que la guía no nombra, vuelven a la raíz de la carpeta → ${fuera.slice(0, 5).map((r) => r.rel).join(', ')}`);
  if (p.anteriores.length) avisos.push(`${p.nombre}: catalogado antes de esta ingesta, se queda y recibe los capítulos → ${p.anteriores.map((a) => a.rel).join(', ')}`);
  const otros = p.nMiembros - p.retirar.length - p.anteriores.length - p.respetados.length - p.sinFichero.length;
  if (otros) avisos.push(`${p.nombre}: ${otros} miembro(s) anteriores a esta ingesta siguen en la colección`);
}
for (const c of cosidosRespetados) avisos.push(`Cosido respetado por trabajo humano: ${c}`);
if (avisos.length) { console.log(`\n── Avisos: ${avisos.length} ──`); for (const a of avisos) console.log(`   ⚠ ${a}`); }
if (sinNada.length) {
  console.log(`\n── Sin nada que retirar (ya están en el Inbox): ${sinNada.length} ──`);
  for (const g of sinNada) console.log(`   ${g.nombre}`);
}

const nDocs = planes.reduce((s, p) => s + p.retirar.length, 0);
const nCuar = planes.reduce((s, p) => s + p.deCuarentena.length, 0);
console.log(`\nTotal: ${planes.length} libros · ${nDocs} documentos de capítulo a retirar · ${nCuar} ficheros de Cuarentena · ${aRehacer.length + aSeparar.length} cosidos a rehacer · ${aRetitular.length} títulos`);

if (!EJECUTAR) {
  console.log('\nSECO: no se ha tocado nada. Repite con --ejecutar (copia antes y con el Vigilante en pausa).\n');
  process.exit(0);
}

// ── 4. Ejecución ────────────────────────────────────────────────────────────────────────────────────────────
const cuenta = { retirados: 0, cuarentena: 0, colecciones: 0, rehechos: 0, retitulados: 0, fallos: 0 };
const pEj = progreso(planes.length, 'Devolviendo libros al Inbox');
for (const p of planes) {
  pEj.paso(p.nombre);
  // Primero TODO el contenido, luego el catálogo: si una copia falla, ese libro se queda como estaba.
  try {
    for (const c of p.copias) await copiarVerificado(c.fichero, absDe(p.dir, c.rel));
  } catch (e) {
    cuenta.fallos++;
    pEj.nota(`⛔ ${p.nombre}: ${e.message} — no se retira ningún documento de este libro`);
    continue;
  }
  await escribirGuia(p.dir, {
    ...p.guia,
    desglose: {
      ...(p.entero ? { principal: p.entero } : {}), orden: p.orden,
      ...(p.soloOrden && !p.entero ? { solo_orden: true } : {}), ...(p.titulos ? { titulos: p.titulos } : {}),
    },
  });
  for (const r of p.retirar) {
    try { await retirar(r.doc); cuenta.retirados++; }
    catch (e) { cuenta.fallos++; pEj.nota(`⛔ ${r.doc.nombre_archivo}: ${e.message}`); }
  }
  for (const c of p.deCuarentena) {
    if (await reciclarCarpeta(c.deposito, 'recomponer-desgloses', 'cuarentena')) cuenta.cuarentena++;
  }
  // La colección era solo el nombre de la carpeta del libro: si queda vacía y nació ahora, sobra.
  if (p.coleccion && p.coleccion.fecha_creacion >= DESDE && !(await col.countDocuments({ coleccion: p.coleccion._id }))) {
    await db.collection('colecciones').deleteOne({ _id: p.coleccion._id });
    cuenta.colecciones++;
  }
}
pEj.fin();

/** Devuelve un cosido al Inbox: copia sus originales, escribe la guía y retira el documento. */
async function devolverCosido(c, guia) {
  const dir = path.join(ENTRADA_COSIDOS, c.nombreLibro);
  for (const rel of c.partes) await copiarVerificado(absDe(c.dirDesglose, rel), absDe(dir, rel));
  await escribirGuia(dir, guia);
  await retirar(c.doc);
}

const pCo = progreso(aRehacer.length + aSeparar.length, 'Rehaciendo cosidos');
for (const c of aRehacer) {
  pCo.paso(c.nombreLibro);
  try {
    await devolverCosido(c, {
      accion: 'desglose',
      perfil: { origen: 'panel' },
      desglose: { principal: c.entero, orden: ordenarPartesLibro(c.partes.filter((n) => n !== c.entero)) },
    });
    cuenta.rehechos++;
  } catch (e) { cuenta.fallos++; pCo.nota(`⛔ ${c.nombreLibro}: ${e.message}`); }
}
for (const c of aSeparar) {
  pCo.paso(c.nombreLibro);
  try {
    await devolverCosido(c, { accion: 'normal', perfil: { origen: 'panel', coleccion: c.nombreLibro } });
    cuenta.rehechos++;
  } catch (e) { cuenta.fallos++; pCo.nota(`⛔ ${c.nombreLibro}: ${e.message}`); }
}
pCo.fin();

for (const d of aRetitular) {
  await col.updateOne({ _id: d._id }, {
    $set: { titulo: d.titulo.replace(SUFIJO, ''), fecha_actualizacion: new Date() },
    $push: { alertas_agente: 'Título: retirado el sufijo «(recompuesto)» que dejó el cosido.' },
  });
  await indexarDoc(db, d._id).catch(() => {});
  cuenta.retitulados++;
}

// ── 5. Comprobación ─────────────────────────────────────────────────────────────────────────────────────────
let quedan = 0;
for (const p of planes) quedan += await col.countDocuments({ _id: { $in: p.retirar.map((r) => r.doc._id) } });
let enInbox = 0, faltan = 0;
for (const p of planes) for (const rel of p.partes) { if (await existe(absDe(p.dir, rel))) enInbox++; else faltan++; }
console.log(`\n=== HECHO · ${JSON.stringify(cuenta)} ===`);
console.log(`Documentos de capítulo que siguen en el catálogo: ${quedan} (debe ser ${cuenta.fallos ? 'lo que falló' : 0})`);
console.log(`Partes en sus carpetas del Inbox: ${enInbox}; ausentes: ${faltan} (debe ser 0)`);
process.exit(cuenta.fallos || faltan ? 1 : 0);
