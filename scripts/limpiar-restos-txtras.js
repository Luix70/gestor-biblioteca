/**
 * LIMPIAR LOS RESTOS DE TXtras (16-oct), después de disolver-txtras.js.
 *
 * Por qué: la ingesta transmedia copió TXtras ÍNTEGRA al árbol CDU. Al sacar los 342 documentos a su sitio quedaron
 * 1.670 ficheros que no son de ningún documento. Decisión del usuario («hazlo así»):
 *
 *   1. COPIAS: PDF/EPUB idénticos BYTE A BYTE (SHA-256) al fichero de un documento ya catalogado en su carpeta
 *      (28, de la ingesta del 3-sep) → Papelera.
 *   2. AL INBOX, para que entren como documentos nuevos:
 *        · los PDF sin documento o con un documento del mismo nombre pero OTRO contenido (otra versión);
 *        · los escaneos: «Latina Christiana Book 1» (Student y Teacher, TIF) y «Latin Road» (JPG, con sus
 *          subcarpetas: texto, guía del profesor, ejercicios… — la inspección de carpetas decide cómo se reparte).
 *   3. A «Curso de Latín» (ficheros sueltos dentro de su árbol preservado, no documentos): las tablas de
 *      terminaciones («Ending Charts»), los textos de Tomás de Aquino (.htm), las notas .rtf/.rtfd y los .torrent.
 *   4. A LA CARPETA DE SU OBRA (subcarpeta «Material»): el HTML, los mapas y la portada GIF de Gibbon; la nota
 *      .rtf de la Cambridge Ancient History. La obra es la de los tomos que salieron de esa misma carpeta de TXtras.
 *   5. Lo que queda son restos de la ingesta (portadas/páginas extraídas, .portadas, registro.json/MARC viejos,
 *      _contenido.txt, una descarga a medias .part, la portada/opf de Calibre de dos libros ya catalogados): la
 *      carpeta TXtras ENTERA va a la Papelera (copia verificada + manifiesto, restaurable) — SOLO si ningún documento
 *      apunta a algo de dentro y no queda nada que no sea un resto reconocido. Si no, se lista y no se toca.
 *
 * Todo movimiento es copia verificada (nº de ficheros y bytes) antes de borrar el origen. Nada se borra sin pasar por
 * la Papelera.
 *
 * Solo en el NAS.
 *   sudo docker exec -it gestor-biblioteca node scripts/limpiar-restos-txtras.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/limpiar-restos-txtras.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { DIR_CDU, MARCA_RUTA_FIJA } from '../src/mantenimiento/util-mantenimiento.js';
import { reciclar, reciclarCarpeta } from '../src/utils/papelera.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const WEB_TXTRAS = '/recursos/8/82/82/audiolibros/TXtras';
const NOMBRE_CURSO = 'Curso de Latín';

// El Inbox, resuelto como lo hace el vigilante (sin importarlo: arrancaría su maquinaria).
const RAIZ_APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INBOX = path.isAbsolute(process.env.PATH_INBOX || '') ? process.env.PATH_INBOX : path.resolve(RAIZ_APP, process.env.PATH_INBOX || 'Inbox');

const webAAbs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
const TX = webAAbs(WEB_TXTRAS);
const existe = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · restos de TXtras (${TX})\n`);
if (!(await existe(TX))) { console.log('TXtras ya no existe: nada que hacer.'); process.exit(0); }

// ── Utilidades ──────────────────────────────────────────────────────────────────────────────────────────────
async function sha256(p) {
  return new Promise((ok, mal) => {
    const h = crypto.createHash('sha256');
    createReadStream(p).on('data', (b) => h.update(b)).on('end', () => ok(h.digest('hex'))).on('error', mal);
  });
}

/** Nº de ficheros y bytes de un fichero o árbol (para verificar una copia). */
async function resumen(p) {
  const st = await fs.stat(p);
  if (!st.isDirectory()) return { n: 1, bytes: st.size };
  let n = 0, bytes = 0;
  for (const e of await fs.readdir(p, { withFileTypes: true })) {
    const r = await resumen(path.join(p, e.name));
    n += r.n; bytes += r.bytes;
  }
  return { n, bytes };
}

/** Mueve un fichero o carpeta: rename; entre volúmenes (EXDEV), copia + verificación + borrado del origen. */
async function moverVerificado(origen, destino) {
  if (await existe(destino)) throw new Error(`el destino ya existe: ${destino}`);
  await fs.mkdir(path.dirname(destino), { recursive: true });
  try { await fs.rename(origen, destino); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  await fs.cp(origen, destino, { recursive: true });
  const [a, b] = await Promise.all([resumen(origen), resumen(destino)]);
  if (a.n !== b.n || a.bytes !== b.bytes) {
    await fs.rm(destino, { recursive: true, force: true });
    throw new Error(`copia incompleta de ${path.basename(origen)} (${a.n}/${a.bytes} ≠ ${b.n}/${b.bytes}); origen conservado`);
  }
  await fs.rm(origen, { recursive: true, force: true });
}

/** Todos los ficheros de un árbol (rutas absolutas). */
async function ficheros(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await ficheros(p)));
    else out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(TX, p).split(path.sep).join('/');
const esLibroSuelto = (p) => /\.(pdf|epub|mobi|azw3?|djvu|doc|docx)$/i.test(p);

// ── 1. Copias y libros sueltos ──────────────────────────────────────────────────────────────────────────────
const todos = await ficheros(TX);
const libros = todos.filter(esLibroSuelto);
const copias = [], alInbox = [];
const pH = progreso(libros.length, 'Comparando PDF/EPUB con los catalogados');
for (const p of libros) {
  pH.paso(path.basename(p));
  const candidatos = await col.find({ nombre_archivo: path.basename(p) }, { projection: { ruta_base: 1, nombre_archivo: 1, titulo: 1 } }).toArray();
  const hash = await sha256(p);
  let gemelo = null;
  for (const d of candidatos) {
    const suyo = path.join(webAAbs(d.ruta_base), d.nombre_archivo);
    if (path.resolve(suyo) === path.resolve(p) || !(await existe(suyo))) continue;
    if ((await fs.stat(suyo)).size === (await fs.stat(p)).size && await sha256(suyo) === hash) { gemelo = d; break; }
  }
  if (gemelo) copias.push({ p, d: gemelo });
  else alInbox.push({ p, motivo: candidatos.length ? 'otra versión (mismo nombre, distinto contenido)' : 'sin documento' });
}
pH.fin();

// ── 2. Escaneos al Inbox (carpetas enteras) ─────────────────────────────────────────────────────────────────
const ESCANEOS = [
  'Latin/Latin Textbooks/Latina Christiana/Latina Christiana Book 1 (Student)',
  'Latin/Latin Textbooks/Latina Christiana/Latina Christiana Book 1 (Teacher)',
  'Latin/Latin Textbooks/Latin Road',
];

// ── 3. Al «Curso de Latín» (ficheros sueltos en su árbol) ───────────────────────────────────────────────────
const curso = await db.collection('colecciones').findOne({ nombre: NOMBRE_CURSO }, { projection: { raiz_web: 1 } });
if (!curso?.raiz_web) { console.log(`⛔ No encuentro la colección «${NOMBRE_CURSO}» (¿se ejecutó disolver-txtras.js?).`); process.exit(1); }
const AL_CURSO = [
  ['Latin/Latin Textbooks/Ending Charts', 'Latin Textbooks/Ending Charts'],
  ['Latin/Thomae Aquinatis', 'Thomae Aquinatis'],
  [' Found In Translation.rtf', 'Resources/Found In Translation.rtf'],
  ['Internet Text Resources.rtf', 'Resources/Internet Text Resources.rtf'],
  [' The Loeb Classical Library and a missed marketing chance.rtfd', 'Resources/The Loeb Classical Library and a missed marketing chance.rtfd'],
  ['Latin/ TORRENTS', 'Resources/Torrents'],
];
// Los .htm de Tomás de Aquino conviven con imágenes de la ingesta (pagina-N.jpg): solo se llevan los .htm.
const SOLO_HTM = new Set(['Latin/Thomae Aquinatis']);

// ── 4. A la carpeta de su obra ──────────────────────────────────────────────────────────────────────────────
/** La carpeta «…/obras/<obra>» de los tomos que salieron de esa carpeta de TXtras (la más frecuente). */
async function obraDeOrigen(carpetaTx) {
  const ds = await col.find(
    { obra: { $exists: true }, alertas_agente: { $regex: `^TXtras disuelta: sale de «${escaparRegex(`${WEB_TXTRAS}/${carpetaTx}`)}` } },
    { projection: { ruta_base: 1 } }).toArray();
  const cuenta = {};
  for (const d of ds) { const m = String(d.ruta_base).match(/^(.*\/obras\/[^/]+)\//); if (m) cuenta[m[1]] = (cuenta[m[1]] || 0) + 1; }
  return Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
const GIBBON = "Gibbons' History of the Decline and Fall of the Roman Empire 1776-1788";
const CAH = 'The Cambridge Ancient History 1923-2000';
const obraGibbon = await obraDeOrigen(GIBBON);
const obraCah = await obraDeOrigen(CAH);
const A_OBRA = [
  [`${GIBBON}/HTML`, obraGibbon && `${obraGibbon}/Material/HTML`],
  [`${GIBBON}/E-books/Map plates`, obraGibbon && `${obraGibbon}/Material/Map plates`],
  [`${GIBBON}/E-books/PDF/gibbonshistoryof00whit.gif`, obraGibbon && `${obraGibbon}/Material/gibbonshistoryof00whit.gif`],
  [`${CAH}/ The Cambridge Ancient History.rtf`, obraCah && `${obraCah}/Material/The Cambridge Ancient History.rtf`],
];

// ── 5. Restos reconocidos (lo único que puede quedar para reciclar TXtras entera) ──────────────────────────
const RESTO = [
  /(^|\/)(portada|pagina|otra)(-\d+)?\.(jpe?g|png)$/i,    // imágenes extraídas por la ingesta
  /(^|\/)[0-9a-f]{24}(-\d+)?\.(jpe?g|png)$/i,             // portadas por _id (.portadas/)
  /(^|\/)otra-\d+\.(jpe?g|png)$/i,
  /(^|\/)registro\.(json|marc\.xml)$/i,                   // sidecars viejos
  /(^|\/)_contenido\.txt$/i,                              // manifiesto de la ingesta transmedia
  /\.part$/i,                                             // descarga a medias
  /(^|\/)(cover\.jpg|metadata\.opf)$/i,                   // restos de Calibre
  /^Portable Roman Reader \[ed\. Davenport\]\/.*\.jpg$/i,  // portada de Calibre del libro ya catalogado
  new RegExp(`^${escaparRegex(MARCA_RUTA_FIJA)}$`),
];

// ── Informe ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n1. Copias idénticas → Papelera: ${copias.length}`);
for (const { p, d } of copias) console.log(`   ${rel(p)}\n        = ${d.ruta_base}`);
console.log(`\n2. Al Inbox (${INBOX}):`);
for (const { p, motivo } of alInbox) console.log(`   ${path.basename(p)}  (${motivo})`);
for (const r of ESCANEOS) {
  const n = (await ficheros(path.join(TX, r))).length;
  console.log(`   ${path.basename(r)}/  (escaneo, ${n} ficheros)`);
}
console.log(`\n3. A «${NOMBRE_CURSO}» (${curso.raiz_web}):`);
for (const [o, d] of AL_CURSO) console.log(`   ${o.trim()}  →  ${d}${SOLO_HTM.has(o) ? '  (solo los .htm)' : ''}`);
console.log('\n4. A la carpeta de su obra:');
for (const [o, d] of A_OBRA) console.log(`   ${o}  →  ${d || '⚠️ obra no encontrada: se queda'}`);

if (!EJECUTAR) {
  // Qué quedaría tras 1-4: ¿todo restos reconocidos?
  // Se van: las copias, los libros al Inbox, las carpetas/ficheros movidos enteros y los .htm de SOLO_HTM.
  const movidos = new Set([...copias.map((x) => x.p), ...alInbox.map((x) => x.p)]);
  const enteros = [...ESCANEOS, ...AL_CURSO.map(([o]) => o), ...A_OBRA.filter(([, d]) => d).map(([o]) => o)]
    .filter((o) => !SOLO_HTM.has(o))
    .map((o) => path.join(TX, o));
  const seVa = (f) => movidos.has(f)
    || enteros.some((e) => f === e || f.startsWith(e + path.sep))
    || ([...SOLO_HTM].some((o) => f.startsWith(path.join(TX, o) + path.sep)) && /\.htm$/i.test(f));
  const quedaria = todos.filter((f) => !seVa(f));
  const extrano = quedaria.filter((f) => !RESTO.some((re) => re.test(rel(f))));
  console.log(`\n5. Quedarían ${quedaria.length} ficheros; restos reconocidos: ${quedaria.length - extrano.length} · NO reconocidos: ${extrano.length}`);
  for (const p of extrano.slice(0, 40)) console.log(`   ? ${rel(p)}`);
  console.log(extrano.length
    ? '   → con algo no reconocido, TXtras NO se reciclará: se listará para que lo mires.'
    : '   → TXtras entera irá a la Papelera (restaurable).');
  console.log('\nDRY-RUN: no se ha tocado nada. Repite con --ejecutar.\n');
  process.exit(0);
}

// ── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────────
let fallos = 0;
const total = 1 + alInbox.length + ESCANEOS.length + AL_CURSO.length + A_OBRA.length + 1;
const p = progreso(total, 'Limpiando');

p.paso('copias → Papelera');
if (copias.length) {
  const r = await reciclar(copias.map((x) => x.p), 'txtras-copias');
  if (!r) { fallos++; p.nota('⛔ no se pudieron reciclar las copias'); }
}

await fs.mkdir(INBOX, { recursive: true });
for (const { p: f } of alInbox) {
  p.paso(path.basename(f));
  try { await moverVerificado(f, path.join(INBOX, path.basename(f))); } catch (e) { fallos++; p.nota(`⛔ ${path.basename(f)}: ${e.message}`); }
}
for (const r of ESCANEOS) {
  p.paso(path.basename(r));
  try { await moverVerificado(path.join(TX, r), path.join(INBOX, path.basename(r))); } catch (e) { fallos++; p.nota(`⛔ ${r}: ${e.message}`); }
}

const raizCurso = webAAbs(curso.raiz_web);
for (const [o, d] of AL_CURSO) {
  p.paso(o.trim());
  try {
    if (SOLO_HTM.has(o)) {
      for (const f of (await ficheros(path.join(TX, o))).filter((x) => /\.htm$/i.test(x))) await moverVerificado(f, path.join(raizCurso, d, path.basename(f)));
    } else {
      await moverVerificado(path.join(TX, o), path.join(raizCurso, d));
    }
  } catch (e) { fallos++; p.nota(`⛔ ${o}: ${e.message}`); }
}

for (const [o, d] of A_OBRA) {
  p.paso(o);
  if (!d) continue;
  try { await moverVerificado(path.join(TX, o), webAAbs(d)); } catch (e) { fallos++; p.nota(`⛔ ${o}: ${e.message}`); }
}

// TXtras entera a la Papelera, solo si lo que queda son restos y nadie apunta dentro.
p.paso('TXtras → Papelera');
const quedan = await ficheros(TX);
const extrano = quedan.filter((f) => !RESTO.some((re) => re.test(rel(f))));
const referencias = await col.countDocuments({ $or: [
  { ruta_base: { $regex: `^${escaparRegex(WEB_TXTRAS)}(/|$)` } },
  { portada: { $regex: `^${escaparRegex(WEB_TXTRAS)}/` } },
  { 'imagenes.ruta': { $regex: `^${escaparRegex(WEB_TXTRAS)}/` } },
] });
let reciclada = false;
if (!extrano.length && !referencias && !fallos) {
  reciclada = !!(await reciclarCarpeta(TX, 'txtras-restos'));
  if (!reciclada) fallos++;
}
p.fin();

console.log(`\n=== HECHO · copias a la Papelera: ${copias.length} · al Inbox: ${alInbox.length} libros + ${ESCANEOS.length} escaneos · fallos: ${fallos} ===`);
if (reciclada) console.log('TXtras (solo restos de la ingesta) → Papelera, restaurable desde el panel.');
else {
  console.log(`TXtras NO se ha reciclado: ${extrano.length} fichero(s) no reconocidos · ${referencias} documento(s) apuntan dentro · ${fallos} fallo(s).`);
  for (const f of extrano.slice(0, 60)) console.log(`   ? ${rel(f)}`);
}
console.log('\nActiva el Vigilante en el panel para catalogar lo que ha ido al Inbox.');
process.exit(fallos ? 1 : 0);
