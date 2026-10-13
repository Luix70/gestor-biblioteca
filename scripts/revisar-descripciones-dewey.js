/**
 * REVISAR LAS DESCRIPCIONES DEL DEWEY escritas por la IA contra sus referencias oficiales (13-oct).
 *
 * Hasta el 13-oct la IA describía un número Dewey con el número A SECAS, sin referencias: «181.5 = Filosofía japonesa»
 * (181 es filosofía oriental; Japón es 181.12). Ahora hay referencias (scripts/importar-referencias-clasificacion.js):
 * la sección, la división y la clase de los DDC 23 Summaries (© OCLC: solo como referencia interna) y la CDU que da
 * la tabla determinista. Este script se las pone delante a la IA, que JUZGA por tandas de 25 si cada título guardado
 * es coherente; las incoherentes se REHACEN con esas mismas referencias (la vieja se copia en
 * clasificacion_descripciones_retiradas). El LCC no hace falta revisarlo: el panel enseña ya la descripción compuesta
 * con el LC Outline, sin IA.
 *
 * En seco: juzga (IA barata, ~25 por llamada) y enseña el veredicto, sin cambiar nada; guarda los veredictos en
 * logs/clasificaciones/veredictos-dewey.json, que --ejecutar reutiliza. Usa los proveedores de IA activos en el panel.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-dewey.js [--limite N]
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-dewey.js --ejecutar [--limite N]
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { conTexto, extraerJSON } from '../src/utils/vision.js';
import { referenciasOficialesClasificacion, regenerarDescripcionClasificacion } from '../src/utils/descripcion-clasificacion.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = Number(arg('--limite')) || Infinity;
const TANDA = 25;
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(RAIZ, 'logs', 'clasificaciones', 'veredictos-dewey.json');

const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · descripciones del Dewey contra sus referencias oficiales\n`);
if (!(await db.collection('clasificacion_oficial').countDocuments({ sistema: 'dewey' }))) {
  console.log('❌ No hay referencias del Dewey: primero scripts/importar-referencias-clasificacion.js --ejecutar');
  process.exit(1);
}

// Las descripciones de IA sin revisar, empezando por los códigos con más libros.
const libros = new Map();
for (const x of await db.collection('biblioteca').aggregate([{ $match: { dewey: { $exists: true, $nin: [null, ''] } } }, { $group: { _id: '$dewey', n: { $sum: 1 } } }]).toArray()) {
  libros.set(String(x._id).trim(), x.n);
}
const descs = (await db.collection('clasificacion_descripciones').find(
  { sistema: 'dewey', fuente: 'ia', verificado: { $ne: true }, revisada: { $exists: false } },
  { projection: { codigo: 1, titulo_es: 1 } },
).toArray()).sort((a, b) => (libros.get(b.codigo) || 0) - (libros.get(a.codigo) || 0)).slice(0, LIMITE);
console.log(`Descripciones del Dewey a revisar: ${descs.length}`);

let veredictos = {};
try { veredictos = JSON.parse(await fs.readFile(CACHE, 'utf8')); } catch { /* primera vez */ }
const clave = (d) => `${d.codigo}|${d.titulo_es}`;

const promptJuez = (tanda) => `Eres un bibliotecario experto en la Clasificación Decimal Dewey. Para cada número Dewey te doy
el significado OFICIAL de su clase, división y sección (DDC 23 Summaries) y, si la hay, su equivalencia en la CDU; y el
título de la descripción que tenemos guardada. Di si el título es COHERENTE con lo que significa el número. Ten en cuenta:
  · el número puede ser más concreto que la sección oficial (un tema dentro de ella es coherente);
  · NO es coherente si habla de otra disciplina, otro lugar, otra época, o de un LIBRO o autor concreto en vez de la
    materia del número;
  · NI si afirma algo MÁS CONCRETO que la referencia oficial (un país, una escuela, una época) que NO puedas asegurar
    para ese número exacto del DDC: «181.5 = Filosofía japonesa» no es coherente (en el DDC, Japón es 181.12). Ante la
    duda, incoherente: la descripción se rehará quedándose en lo que se puede asegurar.
${tanda.map((d, i) => `${i + 1}. Dewey ${d.codigo} · oficial: ${d.refs.join('; ') || '—'} · título guardado: «${d.titulo_es}»`).join('\n')}
Responde ÚNICAMENTE con JSON, un veredicto por línea («n» es el número de la LÍNEA, 1, 2, 3…): {"veredictos":[{"n":<línea>,"coherente":true|false,"motivo":"<máx. 12 palabras>"}]}`;

// Juzgar las que faltan.
const pendientes = [];
const pRefs = progreso(descs.length, 'Preparando referencias');
for (const d of descs) {
  pRefs.paso(d.codigo);
  if (veredictos[clave(d)]) continue;
  pendientes.push({ ...d, refs: (await referenciasOficialesClasificacion(db, 'dewey', d.codigo)).map((r) => r.replace(/\s*\[.*\]$/, '')) });
}
pRefs.fin();
if (pendientes.length) {
  await fs.mkdir(path.dirname(CACHE), { recursive: true });
  const p = progreso(Math.ceil(pendientes.length / TANDA), 'Juzgando (IA)');
  for (let i = 0; i < pendientes.length; i += TANDA) {
    const tanda = pendientes.slice(i, i + TANDA);
    p.paso(`tanda ${i / TANDA + 1}`);
    try {
      const txt = await conTexto({ prompt: promptJuez(tanda), json: true, maxTokens: 8000 });
      const j = extraerJSON(txt);
      // Tolerante con la forma: algunos modelos devuelven la lista suelta o con otra clave, y «true» como texto.
      const lista = Array.isArray(j) ? j : (j?.veredictos || j?.verdicts || j?.resultados || []);
      let leidos = 0;
      for (const v of lista) {
        // «n» debería ser la posición en la lista, pero hay modelos que ponen el propio número Dewey («510»): se acepta
        // primero por el código exacto y, si no, por la posición.
        const n = String(v.n ?? v.numero ?? v.id ?? '').trim();
        const d = tanda.find((x) => x.codigo === n) || tanda[parseInt(n, 10) - 1];
        const coherente = typeof v.coherente === 'boolean' ? v.coherente : v.coherente === 'true' ? true : v.coherente === 'false' ? false : null;
        if (d && coherente !== null) { veredictos[clave(d)] = { coherente, motivo: v.motivo || '' }; leidos++; }
      }
      if (leidos < tanda.length / 2) p.nota(`   ⚠ tanda ${i / TANDA + 1}: solo ${leidos} de ${tanda.length} veredictos legibles · respuesta: ${String(txt).slice(0, 300).replace(/\s+/g, ' ')}`);
    } catch (e) {
      p.nota(`   ⚠ tanda ${i / TANDA + 1}: ${e.message} (se juzgará al relanzar)`);
    }
    await fs.writeFile(CACHE, JSON.stringify(veredictos));
  }
  p.fin();
}

const juzgadas = descs.filter((d) => veredictos[clave(d)]);
const incoherentes = juzgadas.filter((d) => !veredictos[clave(d)].coherente);
console.log(`\nJuzgadas: ${juzgadas.length} de ${descs.length} · coherentes: ${juzgadas.length - incoherentes.length} · incoherentes: ${incoherentes.length}`);
incoherentes.slice(0, 25).forEach((d) => console.log(`   ✗ ${String(libros.get(d.codigo) || 0).padStart(4)}  Dewey ${d.codigo.padEnd(12)} «${String(d.titulo_es).slice(0, 50)}» · ${veredictos[clave(d)].motivo.slice(0, 70)}`));

let rehechas = 0, fallidas = 0;
if (EJECUTAR && incoherentes.length) {
  console.log('');
  const p = progreso(incoherentes.length, 'Rehaciendo');
  for (const d of incoherentes) {
    p.paso(d.codigo);
    try {
      const nueva = await regenerarDescripcionClasificacion(db, 'dewey', d.codigo, { conIA: true });
      rehechas++;
      if (rehechas <= 25) p.nota(`   Dewey ${d.codigo.padEnd(12)} «${String(d.titulo_es).slice(0, 40)}» → «${String(nueva.titulo_es).slice(0, 50)}»`);
    } catch (e) {
      fallidas++;
    }
  }
  p.fin();
}
console.log(`\n=== ${EJECUTAR ? `HECHO · ${rehechas} rehechas · ${fallidas} sin rehacer (relanza para reintentar)` : `DRY-RUN · se rehacerían ${incoherentes.length}`} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar (reutiliza los veredictos guardados).');
process.exit(0);
