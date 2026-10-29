/**
 * CERRAR LA COMILLA PERDIDA DE LAS CDU (29-oct).
 *
 * Por qué: la respuesta de la IA se limpiaba con replace(/^["']|["']$/g, ''), pensado para quitar las comillas que la
 * envuelven, pero que se comía también la de CIERRE de un auxiliar de tiempo al final: «1(73)"20"» quedaba
 * «1(73)"20». Medido: 697 libros. Además el filtro de CDU mal formadas no miraba comillas, así que esas CDU pasaron, y
 * la campaña de descripciones reintentó «78-3(44)"19» cada 11 minutos durante dos días. Las tres cosas están
 * corregidas (clasificador-cdu: solo quita comillas que envuelven; cduBienFormada exige comillas y paréntesis
 * emparejados; modernizarCDU cierra la comilla de un periodo al final).
 *
 * Qué hace: en las CDU de los libros (cdu, cdu_autoridad, cdu_adicionales), de las colecciones y obras, y en la caché
 * equivalencias_cdu, cierra la comilla del periodo final con la misma función (cdu-moderna·cerrarComillasCDU). Solo la
 * base: el nombre de la carpeta es el mismo con o sin la comilla. A los libros les pone fecha_actualizacion, para que
 * la campaña de sidecars regenere su registro.json. Lo que no se puede cerrar sin adivinar (comillas o paréntesis
 * desparejados de otro modo) se lista, no se toca.
 *
 *   node scripts/reparar-comilla-cdu.js              (seco)
 *   node scripts/reparar-comilla-cdu.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { cerrarComillasCDU } from '../src/utils/cdu-moderna.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · cerrar la comilla perdida de las CDU\n`);

const desparejada = (s) => {
  const t = String(s ?? '');
  return (t.match(/"/g) || []).length % 2 === 1 || (t.match(/\(/g) || []).length !== (t.match(/\)/g) || []).length;
};
const cerrar = (s) => cerrarComillasCDU(s);

// ── Libros ──────────────────────────────────────────────────────────────────────────────────────────────────
const col = db.collection('biblioteca');
const libros = await col.find(
  { $or: [{ cdu: { $regex: '"' } }, { cdu_autoridad: { $regex: '"' } }, { cdu_adicionales: { $elemMatch: { $regex: '"' } } }, { cdu: { $regex: '[()]' } }] },
  { projection: { cdu: 1, cdu_autoridad: 1, cdu_adicionales: 1, titulo: 1 } },
).toArray();
const arreglos = [];
const sinArreglo = [];
for (const d of libros) {
  const set = {};
  if (desparejada(d.cdu)) { const n = cerrar(d.cdu); if (n !== d.cdu && !desparejada(n)) set.cdu = n; else sinArreglo.push(d); }
  if (desparejada(d.cdu_autoridad)) { const n = cerrar(d.cdu_autoridad); if (n !== d.cdu_autoridad && !desparejada(n)) set.cdu_autoridad = n; }
  if (Array.isArray(d.cdu_adicionales) && d.cdu_adicionales.some(desparejada)) {
    set.cdu_adicionales = d.cdu_adicionales.map((c) => (desparejada(c) ? cerrar(c) : c));
  }
  if (Object.keys(set).length) arreglos.push({ d, set });
}
console.log(`Libros con comillas o paréntesis: ${libros.length} · a arreglar: ${arreglos.length} · sin arreglo seguro (se listan): ${sinArreglo.length}`);
for (const { d, set } of arreglos.slice(0, 12)) console.log(`   ${String(d.cdu).padEnd(22)} → ${String(set.cdu ?? d.cdu).padEnd(22)} «${String(d.titulo).slice(0, 45)}»`);
for (const d of sinArreglo.slice(0, 30)) console.log(`   ? ${String(d.cdu).padEnd(22)} «${String(d.titulo).slice(0, 45)}» (${d._id})`);

// ── Colecciones, obras y caché ──────────────────────────────────────────────────────────────────────────────
const otras = [];
for (const nombre of ['colecciones', 'obras', 'equivalencias_cdu']) {
  const ds = await db.collection(nombre).find({ cdu: { $regex: '"' } }, { projection: { cdu: 1 } }).toArray();
  for (const d of ds) if (desparejada(d.cdu)) { const n = cerrar(d.cdu); if (n !== d.cdu && !desparejada(n)) otras.push({ nombre, d, n }); }
}
const porColeccion = otras.reduce((m, o) => ({ ...m, [o.nombre]: (m[o.nombre] || 0) + 1 }), {});
console.log(`\nOtras colecciones a arreglar:`, porColeccion);

if (!EJECUTAR) {
  console.log('\nDRY-RUN: no se ha tocado nada. Repite con --ejecutar.\n');
  process.exit(0);
}

const p = progreso(arreglos.length + otras.length, 'Arreglando');
let hechos = 0;
for (const { d, set } of arreglos) {
  p.paso(d.titulo);
  await col.updateOne({ _id: d._id }, {
    $set: { ...set, fecha_actualizacion: new Date() },
    $push: { alertas_agente: `CDU con la comilla de cierre recuperada: «${d.cdu}» → «${set.cdu ?? d.cdu}» (scripts/reparar-comilla-cdu).` },
  });
  hechos++;
}
for (const { nombre, d, n } of otras) {
  p.paso(`${nombre} ${d.cdu}`);
  await db.collection(nombre).updateOne({ _id: d._id }, { $set: { cdu: n } });
  hechos++;
}
p.fin();
console.log(`\n=== HECHO · ${arreglos.length} libros y ${otras.length} registros de colecciones/obras/caché · sin arreglo seguro: ${sinArreglo.length} ===\n`);
process.exit(0);
