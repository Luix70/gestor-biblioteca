/**
 * SANEAR LOS ISBN DE RELLENO (1-nov).
 *
 * Por qué: números que pasan el dígito de control sin ser de ningún libro (9876543210, 0102030402, 1213141513…) entraban
 * como ISBN: desde el cuerpo del texto, o desde lo que leía la visión. OpenLibrary tiene basura registrada justo en
 * esos números, así que el documento recibía título, autores, editorial, sinopsis, Dewey, portada y CDU de otro libro:
 * «Brock Biology of Microorganisms» acabó como «Ungifted», y un CCNA con la cubierta de «Hitler para 1000 años».
 * La ingesta ya los rechaza (identificadores · esIsbnDeRelleno, en validarISBN); esto limpia lo que entró antes.
 *
 * Qué hace con cada documento con un ISBN de relleno:
 *   · Le quita el ISBN, y los números de relleno de isbn_candidatos.
 *   · TÍTULO AJENO (no comparte ninguna palabra con el nombre del fichero, o con la ficha del ISBN real que lleve ese
 *     nombre): el título vuelve a salir de esa ficha o del nombre, y se retiran autores, editorial, año, sinopsis, Dewey/LCC, palabras clave y colaboradores, que vinieron con él.
 *   · TÍTULO PROPIO: solo se retira lo que coincida con la ficha del Fichero para ese ISBN.
 *   · PORTADA traída por ese ISBN (origen fichero_local u otro remoto): se retira y se reextrae del propio fichero.
 *   · CDU: pasa a 000 si dependía de lo retirado, salvo la manual; y se busca de nuevo sin IA.
 *   · Por último reidentificarDoc busca el ISBN real en el fichero (el nombre o los créditos) y rellena desde ahí.
 *
 * Lo retirado queda en el diario `deshacer` del documento. Un documento con trabajo humano (valoración) conserva el
 * título y se lista; una CDU manual no se toca nunca. Las carpetas no se renombran: las mueve el Conformador si cambia
 * la CDU, y los sidecars los regenera su campaña.
 *
 * En el NAS, donde están los ficheros y el Fichero. Copia antes: D:\Bibliobak\CopiaBase.ps1 en el PC.
 *   sudo docker exec -it gestor-biblioteca node scripts/sanear-isbn-relleno.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/sanear-isbn-relleno.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { esIsbnDeRelleno } from '../src/utils/identificadores.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { extraerISBNs } from '../src/utils/lector-pdf.js';
import { parsearNombre, tituloDeNombreDeLote, tituloDesdeNombre } from '../src/utils/parsear-nombre.js';
import { reidentificarDoc, resolverCduDoc } from '../src/utils/reidentificar-doc.js';
import { reextraerImagenesDoc } from '../src/utils/reextraer-imagenes.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGENES_REMOTOS = /^(fichero_local|openlibrary|apple|remot|isbn-web)/i;
const VACIAS = new Set(['the', 'and', 'for', 'with', 'from', 'que', 'los', 'las', 'del', 'por', 'una', 'pdf', 'book', 'libro']);

const palabras = (t) => new Set(String(t || '').normalize('NFD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
  .filter((p) => p.length >= 4 && !VACIAS.has(p)));
const norm = (t) => [...palabras(t)].sort().join(' ');

/** La ficha del ISBN REAL que lleve el nombre del fichero («0415320895 by Maria Brosius 2006.pdf»), o null. */
async function fichaDelNombre(doc) {
  const isbns = extraerISBNs(doc.nombre_archivo || '');
  if (!isbns.length) return null;
  const f = await buscarEnFicheroLocal({ isbns }).catch(() => null);
  return f?.titulo ? f : null;
}

/**
 * ¿El título es de otro libro? Se compara con la ficha del ISBN del nombre si la hay, y si no con el nombre. Solo
 * cuentan las palabras con letras: un nombre que sea un número o un ASIN no decide, y el título se queda.
 */
function tituloAjeno(doc, ficha) {
  if (!doc.nombre_archivo) return false;
  const referencia = palabras(ficha?.titulo || doc.nombre_archivo.replace(/\.[^.]+$/, ''));
  const conLetras = [...referencia].filter((p) => /[a-z]/.test(p));
  if (!conLetras.length) return false;
  return ![...palabras(doc.titulo)].some((p) => referencia.has(p));
}

function tituloDelFichero(doc, ficha) {
  const nombre = doc.nombre_archivo;
  return ficha?.titulo || tituloDeNombreDeLote(nombre) || parsearNombre(nombre)?.titulo || tituloDesdeNombre(nombre)
    || path.basename(nombre, path.extname(nombre));
}

const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 SECO'} · sanear ISBN de relleno\n`);

const grupos = await col.aggregate([{ $match: { isbn: { $type: 'string' } } }, { $group: { _id: '$isbn', n: { $sum: 1 } } }]).toArray();
const rellenos = grupos.filter((g) => esIsbnDeRelleno(g._id)).sort((a, b) => b.n - a.n);
console.log(`ISBN de relleno: ${rellenos.length}`);
for (const g of rellenos) console.log(`   ${g._id} × ${g.n}`);
const docs = await col.find({ isbn: { $in: rellenos.map((g) => g._id) } }).toArray();

const fichas = new Map();
for (const g of rellenos) fichas.set(g._id, await buscarEnFicheroLocal({ isbns: [g._id] }).catch(() => null) || {});

const CAMPOS_AJENOS = ['autores', 'editorial', 'año_edicion', 'sinopsis', 'dewey', 'lcc', 'palabras_clave', 'contribuciones',
  'subtitulo', 'titulo_original', 'portada_url', 'isbn_dudoso', 'isbn_provisional', 'isbn_sospechoso'];
const cuenta = { docs: docs.length, titulos: 0, portadas: 0, cdu: 0, conIsbnReal: 0, humanos: [], fallos: 0 };
const p = progreso(docs.length, EJECUTAR ? 'Saneando' : 'Analizando');
for (const d of docs) {
  p.paso(d.titulo);
  const ficha = fichas.get(d.isbn);
  const fichaNombre = await fichaDelNombre(d);
  const ajeno = tituloAjeno(d, fichaNombre);
  const conservarTitulo = ajeno && !!d.valoracion;
  if (conservarTitulo) cuenta.humanos.push(`«${d.titulo}» (${d.nombre_archivo})`);

  const unset = { isbn: '' }, set = {};
  const antes = { isbn: d.isbn };
  const quita = (k) => { if (d[k] !== undefined) { unset[k] = ''; antes[k] = d[k]; } };
  if (ajeno && !conservarTitulo) {
    antes.titulo = d.titulo;
    set.titulo = tituloDelFichero(d, fichaNombre);
    cuenta.titulos++;
    CAMPOS_AJENOS.forEach(quita);
  } else {
    // Título propio: solo lo que vino de la ficha del ISBN.
    for (const k of ['sinopsis', 'dewey', 'lcc', 'año_edicion']) if (d[k] && ficha[k] && String(d[k]) === String(ficha[k])) quita(k);
    if (d.subtitulo && ficha.subtitulo && norm(d.subtitulo) === norm(ficha.subtitulo)) quita('subtitulo');
    ['isbn_dudoso', 'isbn_provisional', 'isbn_sospechoso'].forEach(quita);
  }
  // La CDU cae con lo que la sostenía: si se retiró su Dewey/LCC, o si el título era ajeno.
  const cduAjena = !d.cdu_manual && (ajeno || unset.dewey !== undefined || unset.lcc !== undefined);
  if (cduAjena && d.cdu !== '000') { antes.cdu = d.cdu; set.cdu = '000'; quita('cdu_fuente'); cuenta.cdu++; }

  const origenPortada = (d.imagenes || []).find((im) => im.ruta === d.portada)?.origen;
  const portadaAjena = d.portada && ORIGENES_REMOTOS.test(String(origenPortada || ''));
  if (portadaAjena) cuenta.portadas++;

  console.log(`\n· ${d._id} ${d.isbn}${ajeno ? ' TÍTULO AJENO' : ''}\n   «${String(d.titulo).slice(0, 60)}»${set.titulo ? ` → «${String(set.titulo).slice(0, 60)}»` : ''}\n   ${String(d.nombre_archivo).slice(0, 80)}\n   quita: ${Object.keys(unset).join(', ')}${set.cdu ? ` · CDU ${d.cdu} → 000` : ''}${portadaAjena ? ` · portada (${origenPortada})` : ''}`);
  if (!EJECUTAR) continue;

  try {
    if (portadaAjena) { antes.portada = d.portada; antes.imagenes = d.imagenes; unset.portada = ''; }
    await col.updateOne({ _id: d._id }, {
      $set: {
        ...set, fecha_actualizacion: new Date(),
        ...(portadaAjena ? { imagenes: (d.imagenes || []).filter((im) => im.ruta !== d.portada) } : {}),
      },
      $unset: unset,
      $pull: { isbn_candidatos: { $in: [d.isbn, ...rellenos.map((g) => g._id)] } },
      $push: {
        alertas_agente: `ISBN de relleno ${d.isbn} retirado: traía datos de otro libro${set.titulo ? ` (título «${d.titulo}»)` : ''}. Detalle en «deshacer».`,
        deshacer: { fecha: new Date(), origen: 'sanear-isbn-relleno', antes },
      },
    });
    let actual = await col.findOne({ _id: d._id });
    const r = await reidentificarDoc(db, actual, { aplicar: true, usarApis: true });
    actual = await col.findOne({ _id: d._id });
    if (actual.isbn) cuenta.conIsbnReal++;
    if (portadaAjena) await reextraerImagenesDoc(db, actual).catch((e) => p.nota(`⚠️  portada de ${d._id}: ${e.message}`));
    if (actual.cdu === '000') await resolverCduDoc(db, actual, { conIA: false }).catch(() => null);
    await indexarDoc(db, d._id).catch(() => {});
    p.nota(`   → ${r?.estado || 'hecho'}${actual.isbn ? ` · ISBN real ${actual.isbn}` : ''}`);
  } catch (e) {
    cuenta.fallos++;
    p.nota(`⛔ ${d._id}: ${e.message}`);
  }
}
p.fin();

console.log(`\n=== ${JSON.stringify({ ...cuenta, humanos: cuenta.humanos.length })} ===`);
for (const h of cuenta.humanos) console.log(`   ⚠ Valorado, conserva el título: ${h}`);
if (!EJECUTAR) { console.log('\nSECO: no se ha tocado nada. Repite con --ejecutar.\n'); process.exit(0); }

const quedan = await col.countDocuments({ isbn: { $in: rellenos.map((g) => g._id) } });
console.log(`Documentos que siguen con un ISBN de relleno: ${quedan} (debe ser 0)`);
process.exit(cuenta.fallos || quedan ? 1 : 0);
