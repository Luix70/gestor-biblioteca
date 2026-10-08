/**
 * QUITAR EL PREFIJO DE SUBIDA. Los ficheros subidos desde el panel se guardaban con la hora en milisegundos delante
 * («1791441939492-Schlayer, Felix - Matanzas en el Madrid republicano….epub») y ese prefijo llegó al catálogo:
 *   · al nombre del fichero (en el disco y en la ficha);
 *   · a algún título («1782680126568-Poker The Parody of Capitalism…»);
 *   · y al ISBN: sus 10 primeras cifras pasan a veces el dígito de control de un ISBN-10, y los libros subidos en el
 *     mismo segundo compartían un «ISBN» falso (8-oct: «1791441939» en 5 libros distintos).
 * Medido el 8-oct: 319 documentos desde el 7-ago, 10 con el ISBN sacado del prefijo. La subida ya no lo pone (cada
 * subida va a su subcarpeta con su nombre) y el lector de ISBN ya no toma cifras dentro de un número más largo.
 *
 * Por cada documento: renombra el fichero en su carpeta (si el nombre limpio ya existe allí, lo deja como está),
 * quita el prefijo del título y, si el ISBN salió del prefijo, lo quita (la campaña «Recuperar ISBN que faltan» busca
 * el de verdad). Diario `deshacer[]`. Toca ficheros: en el NAS.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/quitar-prefijo-subida.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/quitar-prefijo-subida.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGEN = 'quitar-prefijo-subida';
// La hora en milisegundos de 2020 en adelante: 13 cifras que empiezan por 1 (1.6e12 … 1.9e12), y un guion.
const RE_PREFIJO = /^1[6-9]\d{11}-/;
const existe = (p) => fs.access(p).then(() => true, () => false);

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · prefijo de subida en nombres, títulos e ISBN\n`);

const docs = await bib.find({ nombre_archivo: { $regex: RE_PREFIJO.source } },
  { projection: { titulo: 1, nombre_archivo: 1, isbn: 1, isbn_propio: 1, ruta_base: 1, cdu: 1, tipo_recurso: 1, formatos: 1, textos: 1 } }).toArray();
const p = progreso(docs.length || 1, 'Documentos');
const cuenta = { docs: docs.length, renombrados: 0, sinFichero: 0, choque: 0, titulos: 0, isbnFalsos: 0 };
const ejemplos = [];
for (const d of docs) {
  p.paso(d.titulo);
  const prefijo = d.nombre_archivo.match(RE_PREFIJO)[0];
  const cifras = prefijo.replace(/\D/g, '');
  const nombreLimpio = d.nombre_archivo.slice(prefijo.length);
  const set = { fecha_actualizacion: new Date() };
  const unset = {};
  const notas = [];

  // 1. El fichero, en su carpeta.
  const carpeta = carpetaDeDoc(d);
  const viejo = path.join(carpeta, d.nombre_archivo);
  const nuevo = path.join(carpeta, nombreLimpio);
  if (!(await existe(viejo))) cuenta.sinFichero++;
  else if (await existe(nuevo)) cuenta.choque++;
  else {
    cuenta.renombrados++;
    set.nombre_archivo = nombreLimpio;
    notas.push('fichero');
    if (EJECUTAR) await fs.rename(viejo, nuevo);
    // Su entrada en el selector de textos, si la hay.
    if (Array.isArray(d.textos)) set.textos = d.textos.map((t) => (t?.ruta && path.posix.basename(t.ruta) === d.nombre_archivo
      ? { ...t, ruta: `${path.posix.dirname(t.ruta)}/${nombreLimpio}` } : t));
  }

  // 2. El título que arrastra el prefijo.
  if (RE_PREFIJO.test(String(d.titulo || ''))) {
    set.titulo = String(d.titulo).replace(RE_PREFIJO, '').trim() || d.titulo;
    cuenta.titulos++;
    notas.push('título');
  }

  // 3. El ISBN sacado del prefijo (sus cifras están dentro de las del prefijo).
  const isbnCifras = String(d.isbn || '').replace(/[^0-9Xx]/g, '');
  if (isbnCifras && (cifras.includes(isbnCifras) || cifras.includes(isbnCifras.slice(0, 9)))) {
    unset.isbn = '';
    if (String(d.isbn_propio || '') === String(d.isbn)) unset.isbn_propio = '';
    cuenta.isbnFalsos++;
    notas.push(`ISBN falso ${d.isbn}`);
  }
  if (ejemplos.length < 25 && notas.length) ejemplos.push(`«${String(d.titulo).slice(0, 60)}»: ${notas.join(', ')}`);
  if (!EJECUTAR || notas.length === 0) continue;

  const upd = {
    $set: set,
    $push: {
      deshacer: { fecha: new Date(), origen: ORIGEN, antes: { nombre_archivo: d.nombre_archivo, titulo: d.titulo, isbn: d.isbn ?? null } },
      alertas_agente: `Prefijo de subida «${prefijo}» quitado (${notas.join(', ')}) (scripts/${ORIGEN}).`,
    },
  };
  if (Object.keys(unset).length) upd.$unset = unset;
  await bib.updateOne({ _id: d._id }, upd);
  await indexarDoc(db, d._id).catch(() => {});
}
p.fin();

console.log(`\nDocumentos con el prefijo de subida: ${cuenta.docs}`);
console.log(`Ficheros renombrados: ${cuenta.renombrados} · sin fichero en su carpeta: ${cuenta.sinFichero} · el nombre limpio ya existía: ${cuenta.choque}`);
console.log(`Títulos que lo arrastraban: ${cuenta.titulos} · ISBN falsos (del prefijo) quitados: ${cuenta.isbnFalsos}\n`);
ejemplos.forEach((e) => console.log(`   ${e}`));
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar (en el NAS: renombra ficheros).');
else console.log('▶ Sidecars: campaña «sidecars». Los que se quedan sin ISBN los recoge la campaña «Recuperar ISBN que faltan».');
process.exit(0);
