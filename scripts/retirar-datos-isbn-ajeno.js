/**
 * RETIRAR LO QUE TRAJO UN ISBN EQUIVOCADO (14-oct).
 *
 * Libros cuya carpeta lleva el nombre de OTRO ISBN (el que tuvieron antes de corregirse): con ese ISBN pudieron
 * heredar datos del registro de OTRO libro —«La conjura de los necios» tenía la CDU 929 y las materias «Marx,
 * Groucho – Correspondencia» de «Las cartas de Groucho»—. El detector (utils/isbn-ajeno.js, el mismo que usa
 * «Extraer ISBN») compara cada uno con la autoridad de su ISBN anterior; si es de OTRO título:
 *   · su CDU, si es la de ese otro libro, va a la cola de reclasificación DESDE CERO (campaña «Refinar CDU»), que la
 *     cambiará y moverá la carpeta (con el nombre del ISBN bueno);
 *   · se retiran las materias que solo vienen de él.
 * Un ISBN anterior del MISMO título (otra edición del mismo libro) no cuenta. Las CDU manuales no se tocan.
 * Nada se borra: lo retirado queda en el diario `deshacer` de cada libro y en su alerta.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-datos-isbn-ajeno.js              (seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/retirar-datos-isbn-ajeno.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { datosDeIsbnAjeno, isbnDeCarpeta, FIRMA_RECLASIFICAR } from '../src/utils/isbn-ajeno.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const db = await conectarDB();
const col = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · datos heredados de un ISBN equivocado\n`);

const todos = await col.find(
  { tipo_recurso: 'libro', isbn: { $type: 'string' }, ruta_base: { $type: 'string' } },
  { projection: { isbn: 1, ruta_base: 1, titulo: 1, subtitulo: 1, cdu: 1, cdu_manual: 1, palabras_clave: 1, mantenimiento_firma: 1 } },
).toArray();
const candidatos = todos.filter((d) => {
  const c = isbnDeCarpeta(d.ruta_base);
  return c && !variantesISBN(d.isbn).includes(c) && !variantesISBN(c).includes(d.isbn);
});
console.log(`Libros cuya carpeta lleva el nombre de otro ISBN: ${candidatos.length}`);

const hallados = [];
let mismoTitulo = 0;
const p = progreso(candidatos.length, 'Comparando con la autoridad del ISBN anterior');
for (const d of candidatos) {
  p.paso(d.titulo);
  const r = await datosDeIsbnAjeno(d, d.isbn);
  if (r) hallados.push({ doc: d, ...r }); else mismoTitulo++;
}
p.fin();

const conCdu = hallados.filter((h) => h.cduAjena);
const conMaterias = hallados.filter((h) => h.quitadas.length);
console.log(`\nCon datos de OTRO libro: ${hallados.length} · CDU heredada (a reclasificar): ${conCdu.length} · con materias ajenas: ${conMaterias.length}`);
console.log(`Sin nada que retirar (mismo título, sin autoridad o sin datos heredados): ${mismoTitulo}`);
const porOtro = new Map();
for (const h of hallados) porOtro.set(`${h.anterior} «${h.otroTitulo}»`, (porOtro.get(`${h.anterior} «${h.otroTitulo}»`) || 0) + 1);
console.log('\nISBN anteriores más repetidos (un ISBN compartido por muchos libros: el origen):');
for (const [k, n] of [...porOtro].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log('\nEjemplos:');
for (const h of hallados.slice(0, 40)) {
  console.log(`  «${String(h.doc.titulo).slice(0, 45)}» · ISBN anterior ${h.anterior} = «${String(h.otroTitulo).slice(0, 35)}»`
    + `${h.cduAjena ? ` · CDU ${h.doc.cdu} → reclasificar` : ''}${h.quitadas.length ? ` · materias: ${h.quitadas.join(' | ').slice(0, 70)}` : ''}`);
}

if (!EJECUTAR) {
  console.log('\n▶ Repite con --ejecutar para aplicarlo (no mueve nada: la CDU la cambiará la campaña «Refinar CDU»).');
  process.exit(0);
}

let hechos = 0;
const p2 = progreso(hallados.length, 'Retirando');
for (const h of hallados) {
  p2.paso(h.doc.titulo);
  const set = {};
  const unset = {};
  if (h.cduAjena) set.mantenimiento_firma = FIRMA_RECLASIFICAR;
  if (h.materias) { if (h.materias.length) set.palabras_clave = h.materias; else unset.palabras_clave = ''; }
  const antes = {};
  if (h.materias) antes.palabras_clave = h.doc.palabras_clave ?? null;
  if (h.cduAjena) antes.mantenimiento_firma = h.doc.mantenimiento_firma ?? null;
  const alerta = `Datos de «${h.otroTitulo}» (ISBN anterior ${h.anterior}, otro libro) retirados (scripts/retirar-datos-isbn-ajeno):`
    + `${h.cduAjena ? ` la CDU ${h.doc.cdu} se reclasificará desde cero;` : ''}${h.quitadas.length ? ` materias quitadas: ${h.quitadas.join(' | ')}.` : ''}`;
  await col.updateOne({ _id: h.doc._id }, {
    ...(Object.keys(set).length ? { $set: set } : {}),
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
    $push: { alertas_agente: alerta, deshacer: { fecha: new Date(), origen: 'retirar-datos-isbn-ajeno', antes } },
  });
  hechos++;
}
p2.fin();
console.log(`\n=== HECHO · ${hechos} libros · ${conCdu.length} a la cola de «Refinar CDU» (desde cero) · ${conMaterias.length} con materias retiradas ===`);
process.exit(0);
