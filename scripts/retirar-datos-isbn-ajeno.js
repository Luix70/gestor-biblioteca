/**
 * RETIRAR LO QUE TRAJO UN ISBN EQUIVOCADO (14-oct).
 *
 * Un libro con el ISBN de OTRO libro hereda los datos de ese otro libro: «La conjura de los necios» tenía la CDU 929
 * y las materias «Marx, Groucho – Correspondencia» de «Las cartas de Groucho». Dos casos, los dos aquí:
 *   · el ISBN ACTUAL es de otro libro (un EPUB maquetado con el ISBN de otro: la ingesta lo adoptaba sin mirar el
 *     título) → el ISBN se descarta (queda en `isbns_descartados`, no se vuelve a adoptar);
 *   · el ISBN ANTERIOR —el que da nombre a la carpeta— era de otro libro, y lo que trajo sigue ahí.
 * En los dos: su CDU, si es la de ese otro libro, va a la cola de reclasificación DESDE CERO (campaña «Refinar
 * CDU», que la cambia y mueve la carpeta), y se retiran las materias que solo vienen de él.
 * «Otro libro» = título CLARAMENTE distinto (ninguna palabra con cuerpo en común: utils/titulo-libro.js) Y de otro
 * autor, para no tomar por ajeno el mismo libro con el título abreviado, traducido o con el nombre del tomo. Las CDU manuales no se tocan. Nada se borra: lo retirado
 * queda en la alerta y en el diario `deshacer` de cada libro. El detector es el de «Extraer ISBN» y la ingesta
 * (utils/isbn-ajeno.js).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-datos-isbn-ajeno.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-datos-isbn-ajeno.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { datosDeIsbnAjeno, aplicarRetirada, isbnDeCarpeta, nombresDeAutores } from '../src/utils/isbn-ajeno.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · datos heredados de un ISBN de otro libro\n`);

const todos = await col.find(
  { tipo_recurso: 'libro', isbn: { $type: 'string' } },
  { projection: { isbn: 1, ruta_base: 1, titulo: 1, subtitulo: 1, cdu: 1, cdu_manual: 1, palabras_clave: 1, mantenimiento_firma: 1, isbns_descartados: 1, autores: 1, idioma: 1 } },
).toArray();
const conCarpetaDeOtro = todos.filter((d) => {
  const c = isbnDeCarpeta(d.ruta_base);
  return c && !variantesISBN(d.isbn).includes(c) && !variantesISBN(c).includes(d.isbn);
}).length;
console.log(`Libros con ISBN: ${todos.length} (${conCarpetaDeOtro} con la carpeta nombrada por otro ISBN)`);

const hallados = [];
const p = progreso(todos.length, 'Comparando cada ISBN con su autoridad');
for (const d of todos) {
  p.paso(d.titulo);
  const r = await datosDeIsbnAjeno(d, d.isbn, { autores: await nombresDeAutores(db, d.autores) });
  if (r) hallados.push({ doc: d, ...r });
}
p.fin();

const isbnAjeno = hallados.filter((h) => h.isbnActualAjeno);
const conCdu = hallados.filter((h) => h.cduAjena);
const conMaterias = hallados.filter((h) => h.quitadas.length);
console.log(`\nCon datos de OTRO libro: ${hallados.length} · su ISBN ACTUAL es de otro libro (se descarta): ${isbnAjeno.length}`
  + ` · CDU heredada (a reclasificar): ${conCdu.length} · con materias ajenas: ${conMaterias.length}`);
const porOtro = new Map();
for (const h of hallados) {
  const k = `${h.anterior} «${h.otroTitulo}»`;
  porOtro.set(k, (porOtro.get(k) || 0) + 1);
}
console.log('\nISBN de otro libro más repetidos (uno compartido por muchos libros es el origen):');
for (const [k, n] of [...porOtro].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${k}`);
const muestra = (titulo, lista) => {
  console.log(`\n${titulo} (${lista.length}):`);
  for (const h of lista.slice(0, 40)) {
    console.log(`  «${String(h.doc.titulo).slice(0, 45)}» · ISBN ${h.anterior} = «${String(h.otroTitulo).slice(0, 35)}»`
      + `${h.isbnActualAjeno ? ' · ISBN ACTUAL → descartar' : ''}${h.cduAjena ? ` · CDU ${h.doc.cdu} → reclasificar` : ''}`
      + `${h.quitadas.length ? ` · materias: ${h.quitadas.join(' | ').slice(0, 60)}` : ''}`);
  }
};
muestra('ISBN actual de otro libro', isbnAjeno);
muestra('ISBN anterior de otro libro', hallados.filter((h) => !h.isbnActualAjeno && !/0140110925/.test(h.anterior)));

if (!EJECUTAR) {
  console.log('\n▶ Repite con --ejecutar para aplicarlo (no mueve nada: la CDU la cambiará la campaña «Refinar CDU»).');
  process.exit(0);
}

let hechos = 0;
const p2 = progreso(hallados.length, 'Retirando');
for (const h of hallados) {
  p2.paso(h.doc.titulo);
  await aplicarRetirada(db, h.doc, h, { origen: 'scripts/retirar-datos-isbn-ajeno' });
  hechos++;
}
p2.fin();
console.log(`\n=== HECHO · ${hechos} libros · ${isbnAjeno.length} ISBN descartados · ${conCdu.length} a la cola de «Refinar CDU» (desde cero)`
  + ` · ${conMaterias.length} con materias retiradas ===`);
console.log('▶ Para los que se quedaron sin ISBN: «🔎 Extraer ISBN» (o reidentificar-sin-isbn.js) busca la edición buena por título y autor.');
process.exit(0);
