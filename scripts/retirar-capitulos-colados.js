/**
 * RETIRAR CAPÍTULOS COLADOS (3-nov).
 *
 * Por qué: PreProceso pasó al Inbox dos libros por capítulos sin coser (Strunk: STRUcp01…, STRUbkfm, STRUglos… en .doc
 * y .pdf; Coaching for Character: CliffordCh2, CliffordFM… en .rtf y .pdf), porque ningún detector los reconoció, y
 * cada capítulo se catalogó como un documento. Es ruido. La ingesta ya está corregida (libro-desglosado ·
 * senalesDeCapitulos y el filtro de PreProceso · motivoParaRetener).
 *
 * Qué hace: devuelve los ficheros de esos capítulos a PreProceso, a una carpeta por libro, para que se cosan allí, y
 * retira sus documentos del catálogo (su carpeta va a la Papelera: nada se borra de verdad). Igual que
 * recomponer-desgloses: este script solo DESHACE; decide el mismo código que con cualquier libro nuevo.
 *
 * Lo que no se toca: un documento con trabajo humano (CDU manual, valoración, NFC, ficha de lectura) se lista y se queda.
 * Si el fichero no está en su carpeta, el documento tampoco se toca (se lista).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-capitulos-colados.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-capitulos-colados.js --ejecutar
 *   Opciones: --libro "<carpeta>" --patron "<regex del nombre de fichero>" (en pareja, repetibles; por defecto Strunk
 *   y Coaching for Character) · --desde <fecha ISO> (por defecto 3-nov) · --destino <carpeta> (por defecto
 *   PreProceso/College Books)
 *
 * Copia antes: D:\Bibliobak\CopiaBase.ps1 en el PC. Después, PreProceso cose los libros (si falta una parte en PDF, la
 * convierte con LibreOffice) y los pasa al Inbox.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { eliminarDocumento } from '../src/utils/reproceso.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const DESDE = new Date(opcion('--desde') || '2026-11-03T00:00:00Z');

const RAIZ = path.resolve(process.cwd());
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const DESTINO = opcion('--destino') ? resolver(opcion('--destino')) : path.join(DIR_PRE, 'College Books');

// Libros a recomponer: --libro/--patron en pareja; sin ellos, los dos medidos el 3-nov.
const libros = args.map((a, i) => (a === '--libro' ? { libro: args[i + 1], patron: null } : null)).filter(Boolean);
const patrones = args.filter((a, i) => args[i - 1] === '--patron');
libros.forEach((l, i) => { l.patron = patrones[i] || null; });
const LIBROS = libros.length && libros.every((l) => l.patron) ? libros : [
  { libro: 'Strunk', patron: '^STRU' },
  { libro: 'Coaching for Character', patron: '^Clifford' },
];

const webAAbs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
const tamano = async (p) => { try { return (await fs.stat(p)).size; } catch { return -1; } };

const db = await conectarDB();
const col = db.collection('biblioteca');

/** ¿Tiene trabajo humano que no se debe perder? Devuelve el motivo o null. */
async function trabajoHumano(d) {
  if (d.cdu_manual) return 'CDU manual';
  if (d.valoracion) return 'valoración';
  if (d.nfc) return 'NFC';
  if (await db.collection('fichas_lectura').findOne({ ambito: 'documento', ref: d._id }, { projection: { _id: 1 } })) return 'ficha de lectura';
  return null;
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 SECO (no cambia nada)'} · desde ${DESDE.toISOString()} · destino ${DESTINO}\n`);
const plan = [];
for (const { libro, patron } of LIBROS) {
  const docs = await col.find({ nombre_archivo: { $regex: patron, $options: 'i' }, fecha_ingreso: { $gte: DESDE } })
    .project({ titulo: 1, nombre_archivo: 1, ruta_base: 1, portada: 1, imagenes: 1, coleccion: 1, obra: 1, cdu_manual: 1, valoracion: 1, nfc: 1 })
    .toArray();
  const p = progreso(docs.length, `Revisando «${libro}»`);
  const retirar = [], respetados = [], sinFichero = [];
  for (const d of docs) {
    p.paso(d.nombre_archivo);
    const motivo = await trabajoHumano(d);
    if (motivo) { respetados.push(`${d.nombre_archivo} (${motivo})`); continue; }
    const fichero = path.join(webAAbs(d.ruta_base), d.nombre_archivo);
    if ((await tamano(fichero)) < 0) { sinFichero.push(d.nombre_archivo); continue; }
    retirar.push({ doc: d, fichero });
  }
  p.fin();
  plan.push({ libro, patron, retirar, respetados, sinFichero });
  console.log(`📚 «${libro}» (/${patron}/): ${docs.length} documento(s) desde esa fecha`);
  console.log(`   → vuelven a PreProceso y se retiran: ${retirar.length}`);
  for (const r of retirar.slice(0, 40)) console.log(`      · ${r.doc.nombre_archivo}  «${r.doc.titulo}»`);
  if (respetados.length) console.log(`   ✋ con trabajo humano (se quedan): ${respetados.join(', ')}`);
  if (sinFichero.length) console.log(`   ⚠️  sin fichero en su carpeta (no se tocan): ${sinFichero.join(', ')}`);
}

const total = plan.reduce((n, p) => n + p.retirar.length, 0);
if (!EJECUTAR) {
  console.log(`\nSECO: ${total} documento(s) volverían a PreProceso. Para hacerlo: --ejecutar (tras la copia de la base).`);
  process.exit(0);
}

// ── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────────
// La guía de la colección viaja con la carpeta: al pasar al Inbox, los libros vuelven a «College Books».
const guiaDestino = path.join(DESTINO, '_guia.json');
const guiaInbox = path.join(DIR_INBOX, path.basename(DESTINO), '_guia.json');
await fs.mkdir(DESTINO, { recursive: true });
if ((await tamano(guiaDestino)) < 0 && (await tamano(guiaInbox)) >= 0) await fs.copyFile(guiaInbox, guiaDestino);

const cuenta = { copiados: 0, retirados: 0, fallos: 0 };
const pEj = progreso(total, 'Devolviendo capítulos');
for (const p of plan) {
  const dirLibro = path.join(DESTINO, p.libro);
  await fs.mkdir(dirLibro, { recursive: true });
  for (const r of p.retirar) {
    pEj.paso(r.doc.nombre_archivo);
    try {
      // Copia verificada por tamaño; solo entonces se retira el documento.
      const dst = path.join(dirLibro, r.doc.nombre_archivo);
      const t = await tamano(r.fichero);
      if ((await tamano(dst)) !== t) await fs.copyFile(r.fichero, dst);
      if ((await tamano(dst)) !== t) throw new Error('la copia no cuadra en tamaño');
      cuenta.copiados++;
      await db.collection('selecciones').updateMany({ docs: r.doc._id }, { $pull: { docs: r.doc._id } });
      await eliminarDocumento(db, r.doc);
      cuenta.retirados++;
    } catch (e) {
      cuenta.fallos++;
      pEj.nota(`⛔ ${r.doc.nombre_archivo}: ${e.message}`);
    }
  }
}
pEj.fin();
console.log(`\n✅ ${cuenta.copiados} fichero(s) devueltos a ${DESTINO}, ${cuenta.retirados} documento(s) retirados (carpetas a la Papelera), ${cuenta.fallos} fallo(s).`);
const quedan = [];
for (const p of plan) quedan.push(...await col.find({ nombre_archivo: { $regex: p.patron, $options: 'i' }, fecha_ingreso: { $gte: DESDE } }).project({ nombre_archivo: 1 }).toArray());
console.log(`Verificación: quedan ${quedan.length} documento(s) de esos patrones en el catálogo${quedan.length ? ` (${quedan.map((d) => d.nombre_archivo).join(', ')})` : ''}.`);
process.exit(0);
