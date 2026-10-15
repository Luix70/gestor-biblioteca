/**
 * DISOLVER TXtras (15-oct).
 *
 * Por qué: «TXtras» no es una colección, es el nombre de una carpeta de ENTRADA. Se catalogó como árbol preservado
 * (ruta_fija, rama 8/82/82/audiolibros/TXtras): 342 documentos en 49 carpetas, 31 de ellas compartidas por varios
 * libros, todos con CDU «82» o la que tuvieran, pero SIN poder moverse nunca de allí (las tareas de CDU solo cambian
 * la base en un árbol preservado). Decisión del usuario:
 *
 *   · Los 45 documentos «material» (notas .txt/.rtf: LAT01…LAT35 del Wheelock, GROTE, reseñas, Plotino…) pasan a una
 *     colección nueva «Curso de Latín» (árbol preservado propio, CDU 811.124 = lengua latina), conservando su
 *     estructura de carpetas relativa. Su ficha se LIMPIA: la ingesta les pegó el ISBN, el autor, la editorial, la
 *     sinopsis… de otros libros («A companion to Latin literature») y la portada de la Eneida de Fagles. El título
 *     sale del nombre del fichero; LATnn da el nº dentro de la colección. Lo retirado queda en el diario `deshacer`.
 *     Sin portada (no se borra ninguna imagen del disco: la de la Eneida es de su propio libro).
 *   · El resto (PDF, EPUB, DJVU, MOBI, DOC) sale a SU carpeta normal: <árbol CDU>/libros/<isbn|id>, o la de su obra
 *     (<cdu>/obras/<obra>/vol-N, junto a los tomos que ya estén fuera). Sin `ruta_fija`, así que a partir de ahora
 *     las tareas de CDU (Refinar CDU, ubicar-segun-cdu) los moverán cuando corrijan su CDU. Sus colecciones (series
 *     reales: Blackwell companions, Clarendon Aristotle…) se conservan.
 *
 * Cómo se mueve (nunca se pierde nada):
 *   · Una carpeta cuyos documentos van TODOS al mismo destino y que no contiene a otros → se mueve ENTERA
 *     (moverCarpetaConVerificacion: rename o copia verificada).
 *   · Si no (carpeta compartida) → se mueve SOLO el fichero del documento (copia verificada por tamaño, luego se
 *     borra el original) y sus imágenes (las que no use otro documento; esas se copian).
 *   · Un documento cuyo fichero no está en su carpeta no se toca (se lista).
 *   · Lo que quede en TXtras (sidecars viejos, imágenes sin dueño, ficheros sin catalogar) NO se borra: se lista
 *     para que lo revises. El marcador .ruta_fija de TXtras lo sigue protegiendo de Integridad.
 *   · Sidecars (registro.json/MARC) regenerados en la carpeta nueva de cada libro.
 *
 * Solo en el NAS (mueve ficheros).
 *   sudo docker exec -it gestor-biblioteca node scripts/disolver-txtras.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/disolver-txtras.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU, MARCA_RUTA_FIJA, moverCarpetaConVerificacion } from '../src/mantenimiento/util-mantenimiento.js';
import { rutaCatalogo } from '../src/utils/rutas.js';
import { arbolCDU } from '../src/utils/cdu-arbol.js';
import { resolverCabecera } from '../src/utils/colecciones.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const RAIZ_TXTRAS = '/recursos/8/82/82/audiolibros/TXtras';
const NOMBRE_CURSO = 'Curso de Latín';
const CDU_CURSO = '811.124';   // lengua latina

const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · disolver TXtras\n`);

// ── Utilidades de rutas ─────────────────────────────────────────────────────────────────────────────────────
const webAAbs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
const existe = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const corto = (s, n = 50) => String(s || '').slice(0, n);

/** Copia verificada por tamaño; con `mover`, borra el original tras verificar. */
async function copiarVerificado(origen, destino, { mover = false } = {}) {
  await fs.mkdir(path.dirname(destino), { recursive: true });
  await fs.copyFile(origen, destino);
  const [a, b] = await Promise.all([fs.stat(origen), fs.stat(destino)]);
  if (a.size !== b.size) throw new Error(`copia incompleta de ${path.basename(origen)}`);
  if (mover) await fs.unlink(origen);
}

// ── 1. Los documentos de TXtras ─────────────────────────────────────────────────────────────────────────────
const docs = await col.find({ ruta_base: { $regex: `^${escaparRegex(RAIZ_TXTRAS)}(/|$)` } }).toArray();
const materiales = docs.filter((d) => d.naturaleza === 'material');
const libros = docs.filter((d) => d.naturaleza !== 'material');
console.log(`Documentos en TXtras: ${docs.length} · material → «${NOMBRE_CURSO}»: ${materiales.length} · libros a su carpeta: ${libros.length}\n`);

// Cuántos documentos (de TODA la base) apuntan a cada imagen: una imagen que usa otro no se mueve, se copia.
const usosImagen = new Map();
for (const d of docs) {
  const rutas = new Set([d.portada, ...(d.imagenes || []).map((im) => im.ruta)].filter(Boolean));
  for (const r of rutas) usosImagen.set(r, (usosImagen.get(r) || 0) + 1);
}

// ── 2. Destino de cada documento ────────────────────────────────────────────────────────────────────────────
// Raíz de la colección nueva: <árbol 811.124>/transmedia/Curso de Latín (como las transmedia de la ingesta).
const webCurso = '/recursos/' + [...arbolCDU(CDU_CURSO).segmentos, 'transmedia', NOMBRE_CURSO].join('/');

/** Material: conserva su carpeta relativa, quitando el primer nivel de TXtras («Latin/…», «Philosophy/…»). */
function destinoMaterial(d) {
  const rel = d.ruta_base.slice(RAIZ_TXTRAS.length).replace(/^\//, '').split('/').slice(1);
  // Las carpetas «<_id>» que creó la ingesta no dicen nada: el fichero va a la raíz del curso.
  const utiles = rel.filter((s) => !/^[0-9a-f]{24}$/.test(s));
  return [webCurso, ...utiles].join('/');
}

/** Título limpio desde el fichero: «TXT.rtf» dentro de «X.rtfd» → «X»; «LAT07.TXT» → «LAT07». */
function tituloMaterial(d) {
  const tallo = String(d.nombre_archivo || d.titulo).replace(/\.[^.]+$/, '');
  if (/^txt$/i.test(tallo)) {
    const bundle = d.ruta_base.split('/').pop().replace(/\.rtfd$/i, '');
    if (bundle && !/^[0-9a-f]{24}$/.test(bundle)) return bundle;
  }
  return tallo;
}

// Carpetas ya ocupadas (en la base) para no caer en la de otro documento.
const ocupadas = new Set();
const reservadas = new Set();
async function libre(web) {
  if (reservadas.has(web)) return false;
  if (!ocupadas.has(web)) {
    const otro = await col.findOne({ ruta_base: web }, { projection: { _id: 1 } });
    if (otro) ocupadas.add(web);
  }
  if (ocupadas.has(web)) return false;
  return !(await existe(webAAbs(web)));
}

// La carpeta de cada obra fuera de TXtras (si ya hay tomos fuera): «…/obras/<obra>».
const obraIds = [...new Set(libros.filter((d) => d.obra).map((d) => String(d.obra)))];
const baseObra = new Map();
for (const id of obraIds) {
  const fuera = await col.findOne(
    { obra: libros.find((d) => String(d.obra) === id).obra, ruta_base: { $regex: '/obras/', $not: new RegExp(escaparRegex(RAIZ_TXTRAS)) } },
    { projection: { ruta_base: 1 } });
  const m = fuera && String(fuera.ruta_base).match(/^(.*\/obras\/[^/]+)\//);
  if (m) baseObra.set(id, m[1]);
}

async function destinoLibro(d) {
  const args = {
    cdu: d.cdu, tipo_recurso: d.tipo_recurso, isbn: d.isbn, issn: d.issn, id: d._id,
    año_edicion: d.año_edicion, mes_publicacion: d.mes_publicacion, titulo: d.titulo,
    obra: d.obra ? (d.isbn_obra || d.obra_titulo || String(d.obra)) : null,
    volumen_numero: d.volumen_numero,
  };
  let web = rutaCatalogo(args).web;
  // Tomo de una obra que ya tiene tomos fuera: a la carpeta de esa obra, no a una nueva por su propia CDU.
  if (d.obra && baseObra.has(String(d.obra))) web = `${baseObra.get(String(d.obra))}/${web.split('/').pop()}`;
  if (await libre(web)) return web;
  // Colisión: carpeta propia con el sufijo del _id (1 documento ↔ 1 carpeta), como la ingesta.
  const conSufijo = `${web}-${String(d._id).slice(-6)}`;
  return conSufijo;
}

const plan = [];   // { d, destino, material }
for (const d of materiales) plan.push({ d, destino: destinoMaterial(d), material: true });
const pDest = progreso(libros.length, 'Calculando destinos');
for (const d of libros) {
  pDest.paso(d.titulo);
  const destino = await destinoLibro(d);
  reservadas.add(destino);
  plan.push({ d, destino, material: false });
}
pDest.fin();

// ── 3. Agrupar por carpeta de origen: ¿se mueve entera o fichero a fichero? ────────────────────────────────
const porOrigen = new Map();
for (const p of plan) porOrigen.set(p.d.ruta_base, [...(porOrigen.get(p.d.ruta_base) || []), p]);
const operaciones = [];   // { tipo:'carpeta'|'ficheros', origen, destino?, items }
for (const [origen, items] of porOrigen) {
  const destinos = new Set(items.map((p) => p.destino));
  const enBase = await col.countDocuments({ ruta_base: origen });
  const anidados = await col.countDocuments({ ruta_base: { $regex: `^${escaparRegex(origen)}/` } });
  const entera = destinos.size === 1 && enBase === items.length && anidados === 0;
  operaciones.push(entera
    ? { tipo: 'carpeta', origen, destino: [...destinos][0], items }
    : { tipo: 'ficheros', origen, items });
}
// Las carpetas enteras, de la más profunda a la menos (una no contiene a otra con docs, pero por si acaso).
operaciones.sort((a, b) => b.origen.split('/').length - a.origen.split('/').length);

// ── 4. Informe del plan ─────────────────────────────────────────────────────────────────────────────────────
const enteras = operaciones.filter((o) => o.tipo === 'carpeta');
const sueltos = operaciones.filter((o) => o.tipo === 'ficheros').flatMap((o) => o.items);
console.log(`\nCarpetas que se mueven enteras: ${enteras.length} · documentos que salen fichero a fichero: ${sueltos.length}\n`);
console.log(`── «${NOMBRE_CURSO}» (${webCurso}) ──`);
for (const p of plan.filter((x) => x.material).sort((a, b) => tituloMaterial(a.d).localeCompare(tituloMaterial(b.d)))) {
  console.log(`   «${corto(p.d.titulo, 35)}» → «${tituloMaterial(p.d)}»  ${p.destino.slice(webCurso.length) || '/'}`);
}
console.log('\n── Libros a su carpeta ──');
const cdus = {};
for (const p of plan.filter((x) => !x.material)) cdus[p.d.cdu] = (cdus[p.d.cdu] || 0) + 1;
console.log('   Por CDU:', Object.entries(cdus).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join(' · '));
for (const p of plan.filter((x) => !x.material).slice(0, 400)) {
  console.log(`   ${String(p.d.cdu).padEnd(12)} «${corto(p.d.titulo, 45)}»${p.d.obra ? ' (tomo)' : ''}\n        → ${p.destino}`);
}

if (!EJECUTAR) {
  console.log('\nDRY-RUN: no se ha tocado nada. Repite con --ejecutar.\n');
  process.exit(0);
}

// ── 5. Ejecución ────────────────────────────────────────────────────────────────────────────────────────────
// La colección (puerta única: resolverCabecera) y su raíz preservada.
const { _id: colId } = await resolverCabecera(db, {
  nombre: NOMBRE_CURSO, tipo: 'transmedia', cdu: CDU_CURSO,
  descripcion: 'Curso de latín (lecciones del Wheelock y notas), reunido de la carpeta de entrada TXtras.',
});
await db.collection('colecciones').updateOne({ _id: colId }, { $set: { raiz_web: webCurso, ruta_fija: true } });
await fs.mkdir(webAAbs(webCurso), { recursive: true });
await fs.writeFile(path.join(webAAbs(webCurso), MARCA_RUTA_FIJA), `transmedia: ${NOMBRE_CURSO}\n`).catch(() => {});

// Campos que la ingesta les pegó a las notas desde OTROS libros: se retiran (quedan en `deshacer`).
const CAMPOS_AJENOS = ['isbn', 'autores', 'editorial', 'sinopsis', 'palabras_clave', 'dewey', 'lcc', 'contribuciones',
  'paginas', 'dimensiones', 'año_edicion', 'isbn_sospechoso', 'titulo_original', 'coleccion_fuente', 'cdu_manual',
  'portada', 'imagenes', 'coleccion_numero'];

/** Mueve las imágenes de un documento a su carpeta nueva (copia las que usa otro). Devuelve {portada, imagenes}. */
async function moverImagenes(d, origenWeb, destinoWeb) {
  const nuevo = (r) => `${destinoWeb}/${path.posix.basename(r)}`;
  const set = {};
  const hechas = new Map();
  for (const r of new Set([d.portada, ...(d.imagenes || []).map((im) => im.ruta)].filter(Boolean))) {
    if (path.posix.dirname(r) !== origenWeb) continue;   // imagen que no vive en su carpeta: se deja como está
    const o = webAAbs(r), n = webAAbs(nuevo(r));
    if (!(await existe(o))) continue;
    if (!(await existe(n))) await copiarVerificado(o, n, { mover: (usosImagen.get(r) || 0) <= 1 });
    hechas.set(r, nuevo(r));
  }
  if (d.portada) set.portada = hechas.get(d.portada) || d.portada;
  if (d.imagenes?.length) set.imagenes = d.imagenes.map((im) => ({ ...im, ruta: hechas.get(im.ruta) || im.ruta }));
  return set;
}

const cuenta = { carpetas: 0, ficheros: 0, sinFichero: [], fallos: 0 };
const movidos = new Map();   // _id → ruta_base nueva
const p = progreso(operaciones.length, 'Moviendo');
for (const op of operaciones) {
  p.paso(op.origen.slice(RAIZ_TXTRAS.length) || '/');
  try {
    if (op.tipo === 'carpeta') {
      const destino = op.destino;
      if (await existe(webAAbs(destino))) {
        // El destino ya existe (otra carpeta del curso al mismo nivel): fichero a fichero.
        op.tipo = 'ficheros';
      } else {
        await moverCarpetaConVerificacion(webAAbs(op.origen), webAAbs(destino), []);
        for (const { d } of op.items) {
          const remap = (r) => (r && r.startsWith(op.origen + '/') ? destino + r.slice(op.origen.length) : r);
          const set = { ruta_base: destino };
          if (d.portada) set.portada = remap(d.portada);
          if (d.imagenes?.length) set.imagenes = d.imagenes.map((im) => ({ ...im, ruta: remap(im.ruta) }));
          movidos.set(String(d._id), set);
        }
        cuenta.carpetas++;
      }
    }
    if (op.tipo === 'ficheros') {
      for (const { d, destino, material } of op.items) {
        const fichero = d.nombre_archivo ? path.join(webAAbs(op.origen), d.nombre_archivo) : null;
        if (!fichero || !(await existe(fichero))) { cuenta.sinFichero.push(d); continue; }
        await copiarVerificado(fichero, path.join(webAAbs(destino), d.nombre_archivo), { mover: true });
        // Las notas se quedan sin portada (era la de la Eneida): sus imágenes no se llevan.
        const set = { ruta_base: destino, ...(material ? {} : await moverImagenes(d, op.origen, destino)) };
        movidos.set(String(d._id), set);
        cuenta.ficheros++;
      }
    }
  } catch (e) {
    cuenta.fallos++;
    p.nota(`⛔ ${op.origen}: ${e.message}`);
  }
}
p.fin();

// ── 6. Fichas ───────────────────────────────────────────────────────────────────────────────────────────────
const pF = progreso(movidos.size, 'Actualizando fichas');
for (const { d, material } of plan) {
  const mov = movidos.get(String(d._id));
  if (!mov) continue;
  pF.paso(d.titulo);
  if (material) {
    const antes = {};
    for (const k of [...CAMPOS_AJENOS, 'titulo', 'cdu', 'coleccion', 'coleccion_nombre']) if (d[k] !== undefined) antes[k] = d[k];
    const titulo = tituloMaterial(d);
    const numero = /^LAT(\d+)$/i.exec(titulo);
    const set = {
      ruta_base: mov.ruta_base, titulo, cdu: CDU_CURSO, coleccion: colId, coleccion_nombre: NOMBRE_CURSO,
      ruta_fija: true, fecha_actualizacion: new Date(),
    };
    if (numero) set.coleccion_numero = Number(numero[1]);
    const unset = Object.fromEntries(CAMPOS_AJENOS.filter((k) => d[k] !== undefined && !(k in set)).map((k) => [k, '']));
    await col.updateOne({ _id: d._id }, {
      $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $push: {
        alertas_agente: `TXtras disuelta: nota del «${NOMBRE_CURSO}». Se le retiraron el ISBN, autores, editorial, sinopsis y portada de otros libros que le había puesto la ingesta (en «deshacer»).`,
        deshacer: { fecha: new Date(), origen: 'disolver-txtras', antes },
      },
    });
  } else {
    await col.updateOne({ _id: d._id }, {
      $set: { ...mov, fecha_actualizacion: new Date() },
      $unset: { ruta_fija: '' },
      $push: { alertas_agente: `TXtras disuelta: sale de «${d.ruta_base}» a su carpeta «${mov.ruta_base}».` },
    });
    const actual = await col.findOne({ _id: d._id });
    await regenerarSidecarsDoc(db, actual, webAAbs(actual.ruta_base)).catch(() => {});
  }
  await indexarDoc(db, d._id).catch(() => {});
}
pF.fin();

// ── 7. Lo que queda en TXtras (no se borra nada) ────────────────────────────────────────────────────────────
const restos = [];
async function recorrer(dir) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory()) await recorrer(ruta);
    else if (e.name !== MARCA_RUTA_FIJA) restos.push(path.relative(webAAbs(RAIZ_TXTRAS), ruta));
  }
}
await recorrer(webAAbs(RAIZ_TXTRAS));
const quedan = await col.countDocuments({ ruta_base: { $regex: `^${escaparRegex(RAIZ_TXTRAS)}(/|$)` } });

console.log(`\n=== HECHO · carpetas movidas enteras: ${cuenta.carpetas} · documentos movidos fichero a fichero: ${cuenta.ficheros} · fallos: ${cuenta.fallos} ===`);
if (cuenta.sinFichero.length) {
  console.log(`\nSin su fichero en su carpeta (NO se han tocado): ${cuenta.sinFichero.length}`);
  for (const d of cuenta.sinFichero) console.log(`   ${d._id} «${corto(d.titulo)}» (${d.nombre_archivo || '—'}) en ${d.ruta_base}`);
}
console.log(`\nDocumentos que siguen en TXtras: ${quedan}`);
console.log(`Ficheros que quedan en TXtras (no se ha borrado nada; revísalos): ${restos.length}`);
const porExt = {};
for (const r of restos) { const x = path.extname(r).toLowerCase() || '(sin ext)'; porExt[x] = (porExt[x] || 0) + 1; }
console.log('   Por tipo:', Object.entries(porExt).sort((a, b) => b[1] - a[1]).map(([x, n]) => `${x}×${n}`).join(' · '));
for (const r of restos.filter((x) => !/\.(jpe?g|png|json|xml)$/i.test(x)).slice(0, 80)) console.log(`   ${r}`);
process.exit(cuenta.fallos ? 1 : 0);
