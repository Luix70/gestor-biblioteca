/**
 * REVISAR LAS DESCRIPCIONES DE CDU ESCRITAS POR LA IA CONTRA EL UDC SUMMARY OFICIAL (colección `udc_summary`, ver
 * scripts/importar-udc-summary.js). Medido el 8-oct sobre 14.193 descripciones de IA:
 *   1. TÍTULOS CORTADOS (~1.200): la IA se quedó sin sitio y se guardó medio título («Láseres y sus longitudes de»,
 *      «Psic»). Defectuosas sin más → se rehacen.
 *   2. SOSPECHOSAS (~1.300): no comparten ni una palabra con el significado oficial de ningún antepasado de su código
 *      («78.2 = Cine», y 78 es Música; «332.4(44) = Política comercial de Japón»). Muchas son falsas alarmas
 *      («Terrorismo» bajo 36), así que la IA las JUZGA por tandas de 25 con el significado oficial delante:
 *        · coherente → no se toca (prueba 8-oct: 2 de cada 3);
 *        · incoherente → se rehace;
 *        · dewey → la descripción es la del número en DEWEY («363.325 Terrorismo»): lo malo es la CDU del LIBRO, no la
 *          descripción. No se toca; se lista en logs/udcs/cdu-con-numero-dewey.txt para la auditoría de la CDU (§4).
 * Se excluye la clase 2 (religión): ahí el problema no es la descripción sino que la CDU del LIBRO está en la
 * notación anterior a 2000 (docs/tareas-pendientes §4). Nunca toca las oficiales (`udcs`) ni las verificadas a mano.
 *
 * Seguridad: la nueva se genera ANTES de quitar la vieja (si la IA falla, la vieja se queda); la vieja se copia en
 * `cdu_descripciones_retiradas`. Las descripciones no mueven libros ni carpetas.
 *
 * En seco: cuenta y enseña muestras; el juicio de las sospechosas SÍ llama a la IA (~50 llamadas baratas) para que
 * veas el veredicto antes de aplicar, y lo guarda en logs/udcs/veredictos-descripciones.json (--ejecutar lo reutiliza).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-cdu.js                    (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/revisar-descripciones-cdu.js --ejecutar
 *   … --fase cortadas|sospechosas   solo una de las dos (por defecto, las dos)
 *   … --sin-ia                       en seco, sin juzgar (solo cuenta)
 *   … --limite N                     como mucho N códigos por fase (los que más libros tienen primero)
 *   … --permitir-pago                usar también la IA de PAGO (por defecto solo gratis: si se saturan, espera y reintenta)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { sanitizarCDU } from '../src/utils/cdu-arbol.js';
import { tituloCortado, generarDescripcionCDU } from '../src/utils/descripcion-cdu.js';
import { conTexto, extraerJSON } from '../src/utils/vision.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SIN_IA = args.includes('--sin-ia') && !EJECUTAR;
const FASE = arg('--fase') || 'todas';
const LIMITE = Number(arg('--limite')) || Infinity;
const TANDA = 25;
const PAGO = args.includes('--permitir-pago');   // por defecto, SOLO proveedores gratis

/**
 * Llama a la IA SOLO con proveedores gratis (salvo --permitir-pago). Los gratis se saturan por MINUTO (Groq: tokens
 * por minuto; 8-oct, en tandas seguidas caía al de pago una de cada cuatro), así que si están todos saturados se
 * espera un minuto y se reintenta, hasta 5 veces. Lanza si sigue sin haber ninguno (cupo diario agotado).
 */
async function conIAGratis(llamada, nota) {
  for (let intento = 1; ; intento++) {
    try {
      return await llamada({ soloGratis: !PAGO });
    } catch (e) {
      // Solo se espera si es SATURACIÓN (cuota/límite por minuto); una respuesta mala o incompleta no mejora esperando.
      const saturada = /429|cuota|quota|rate limit|too many|no hay proveedores/i.test(String(e.message));
      if (PAGO || !saturada || intento >= 5) throw e;
      nota(`   ⏸ IA gratis saturada (${String(e.message).slice(0, 60)}); espero 60 s y reintento (${intento}/4)`);
      await new Promise((r) => setTimeout(r, 60000));
    }
  }
}

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_VEREDICTOS = path.join(RAIZ, 'logs', 'udcs', 'veredictos-descripciones.json');

const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · revisión de las descripciones de CDU contra el UDC Summary\n`);

// ─── El UDC Summary y el uso de cada código ──────────────────────────────────────────────────────────────────
const oficial = new Map((await db.collection('udc_summary').find({}, { projection: { es: 1, en: 1 } }).toArray()).map((x) => [x._id, x]));
if (!oficial.size) {
  console.log('❌ La colección udc_summary está vacía: primero scripts/importar-udc-summary.js --ejecutar');
  process.exit(1);
}
const tituloOficial = (c) => oficial.get(c)?.es?.titulo || oficial.get(c)?.en?.titulo || '';

/** Los antepasados del número principal que están en el UDC Summary, del más concreto al más general (≥ 2 cifras). */
function antepasados(codigo) {
  const num = (String(codigo).match(/^\d[\d.]*/) || [])[0];
  if (!num) return [];
  const out = [];
  for (let x = num.replace(/\.$/, ''); x.length >= 2; x = x.slice(0, -1).replace(/\.$/, '')) {
    if (oficial.has(x)) out.push(x);
  }
  return out;
}

// Raíces de palabras con significado (5 letras), para la criba sin IA.
const VACIAS = new Set(['general', 'generales', 'generalidades', 'otros', 'otras', 'varios', 'varias', 'cuestiones', 'aspectos', 'estudio', 'estudios', 'ciencia', 'ciencias', 'teoria']);
const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const raices = (s) => plano(s).split(/[^a-z]+/).filter((w) => w.length >= 5 && !VACIAS.has(w)).map((w) => w.slice(0, 5));

const raicesOficiales = (c) => raices(`${oficial.get(c)?.es?.titulo || ''} ${oficial.get(c)?.en?.titulo || ''}`);

/**
 * ¿Por qué es sospechosa? (null = no lo es)
 *  · «ajena»: no comparte ni una palabra con el significado oficial de ningún antepasado («78.2 = Cine», 78 es Música).
 *  · «sin lo propio»: comparte las del abuelo pero no las que DISTINGUEN a su antepasado más concreto de su padre
 *    («930.85 = Historia del mundo antiguo»: dice «historia» como 930, pero no «civilización» ni «cultural», que es lo
 *    que es 930.85; era el Dewey 930).
 *  · «a ciegas»: su código lleva una fecha entre comillas o una relación «:», y la descripción se escribió con la clave
 *    limpia, que las pierde (`930.85:94(430)` → «Grecia clásica, año 430 a.C.»; (430) es Alemania). Hasta el 8-oct
 *    todas se escribieron así, así que todas se juzgan.
 */
function motivoSospecha(d, ants, notacion) {
  const texto = new Set(raices(`${d.titulo_es} ${d.descripcion_es}`));
  if (!ants.some((a) => raicesOficiales(a).some((r) => texto.has(r)))) return 'ajena';
  if (ants.length >= 2) {
    const delPadre = new Set(ants.slice(1).flatMap(raicesOficiales));
    const propias = raicesOficiales(ants[0]).filter((r) => !delPadre.has(r));
    if (propias.length && !propias.some((r) => texto.has(r))) return 'sin lo propio';
  }
  if (notacion && /[":]/.test(notacion)) return 'a ciegas';
  return null;
}

// Libros por código (se empieza por los que más se ven) y la NOTACIÓN real de cada clave (para el juez y para
// rehacerla: la clave limpia pierde las comillas de las fechas y los «:»).
const libros = new Map();
const notacionDe = new Map();
for (const x of await db.collection('biblioteca').aggregate([{ $group: { _id: '$cdu', n: { $sum: 1 } } }]).toArray()) {
  const k = sanitizarCDU(x._id);
  if (!k) continue;
  libros.set(k, (libros.get(k) || 0) + x.n);
  if (!notacionDe.has(k)) notacionDe.set(k, String(x._id).trim());
}
const porLibros = (a, b) => (libros.get(b.codigo) || 0) - (libros.get(a.codigo) || 0);
const notacion = (d) => notacionDe.get(d.codigo) || d.codigo;

// ─── Clasificar ──────────────────────────────────────────────────────────────────────────────────────────────
const col = db.collection('cdu_descripciones');
const descs = await col.find({ fuente: { $ne: 'udcs' }, verificado: { $ne: true } },
  { projection: { codigo: 1, titulo_es: 1, descripcion_es: 1 } }).toArray();
const cortadas = [];
const sospechosas = [];
let religion = 0;
for (const d of descs) {
  if (tituloCortado(d.titulo_es)) { cortadas.push(d); continue; }
  if (/^2/.test(d.codigo)) { religion++; continue; }
  const ants = antepasados(d.codigo);
  const motivo = ants.length ? motivoSospecha(d, ants, notacionDe.get(d.codigo)) : null;
  if (motivo) sospechosas.push({ ...d, ants, motivo });
}
cortadas.sort(porLibros);
sospechosas.sort(porLibros);
const suma = (l) => l.reduce((s, d) => s + (libros.get(d.codigo) || 0), 0);
const deMotivo = (m) => sospechosas.filter((d) => d.motivo === m);
console.log(`Descripciones de IA: ${descs.length}`);
console.log(`   1. con el título cortado: ${cortadas.length} (${suma(cortadas)} libros)`);
console.log(`   2. sospechosas: ${sospechosas.length} (${suma(sospechosas)} libros) — se juzgan con IA:`);
console.log(`        · ajenas a su significado oficial: ${deMotivo('ajena').length}`);
console.log(`        · sin lo que distingue a su código de su padre: ${deMotivo('sin lo propio').length}`);
console.log(`        · escritas sin ver su fecha o su relación «:»: ${deMotivo('a ciegas').length}`);
console.log(`   (clase 2, religión, excluidas: ${religion} — su problema es la notación del libro, §4)\n`);
cortadas.slice(0, 8).forEach((d) => console.log(`   ✂ ${d.codigo.padEnd(22)} «${d.titulo_es}»`));

const hacerCortadas = FASE === 'todas' || FASE === 'cortadas';
const hacerSospechosas = FASE === 'todas' || FASE === 'sospechosas';

// ─── Fase 2: la IA juzga las sospechosas por tandas ─────────────────────────────────────────────────────────
let veredictos = {};
try { veredictos = JSON.parse(await fs.readFile(CACHE_VEREDICTOS, 'utf8')); } catch { /* primera vez */ }
const claveVeredicto = (d) => `${d.codigo}|${d.titulo_es}`;   // si la descripción cambia, se vuelve a juzgar
const veredictoDe = (d) => veredictos[claveVeredicto(d)]?.v;

// Tres respuestas, no dos: en la prueba del 8-oct una parte de las «incoherentes» estaba BIEN descrita para su número
// en DEWEY («363.325 Terrorismo», «332.64 Mercado de capitales», «523.12 Cosmología»): el problema ahí no es la
// descripción sino que la CDU del LIBRO es un número Dewey (contaminación). Rehacer su descripción lo escondería; se
// listan aparte para la auditoría de la CDU (docs/tareas-pendientes §4), que es la que decide su carpeta.
const promptJuez = (tanda) => `Eres un bibliotecario experto en la Clasificación Decimal Universal (CDU) y en Dewey.
Para cada código CDU te doy el significado OFICIAL de sus antepasados (UDC Summary) y el título de la descripción que
tenemos guardada. Clasifica cada uno:
  · "coherente": el título encaja con lo que significa el código en CDU. El antepasado oficial es más GENERAL: un tema
    concreto dentro de él es coherente. ":" une dos facetas relacionadas (basta con que trate de ellas). Los
    auxiliares cuentan: lugar entre paréntesis — (73) Estados Unidos, así que 821.111(73) es literatura estadounidense —,
    tiempo entre comillas, forma (0…), lengua =…, y 087.5 = para niños/jóvenes.
  · "dewey": el título NO encaja con la CDU pero SÍ es exactamente lo que ese número significa en DEWEY (p. ej.
    363.325 Terrorismo, 523.1 Cosmología): el código del libro es un número Dewey guardado como CDU.
  · "incoherente": ni lo uno ni lo otro (otra disciplina, otro lugar u otra época), o un título vacío de sentido
    («Psic», «Impactos»).
${tanda.map((d, i) => `${i + 1}. código ${notacion(d)} · oficial: ${d.ants.map((a) => `${a} = ${tituloOficial(a)}`).join('; ')} · título guardado: «${d.titulo_es}»`).join('\n')}
Responde ÚNICAMENTE con JSON, un veredicto por número: {"veredictos":[{"n":<número>,"v":"coherente"|"dewey"|"incoherente","motivo":"<máx. 12 palabras>"}]}`;

const pendientesJuicio = hacerSospechosas ? sospechosas.slice(0, LIMITE).filter((d) => !veredictoDe(d)) : [];
if (hacerSospechosas && pendientesJuicio.length && !SIN_IA) {
  const tandas = Math.ceil(pendientesJuicio.length / TANDA);
  const p = progreso(tandas, 'Juzgando (IA)');
  for (let i = 0; i < pendientesJuicio.length; i += TANDA) {
    const tanda = pendientesJuicio.slice(i, i + TANDA);
    p.paso(`tanda ${i / TANDA + 1}`);
    try {
      const j = extraerJSON(await conIAGratis((o) => conTexto({ prompt: promptJuez(tanda), json: true, maxTokens: 8000, ...o }), p.nota));
      for (const v of j?.veredictos || []) {
        // Por NÚMERO, no por código: la IA reescribe los códigos («332.4(44)» → «332.4 (44)») y no casarían.
        const d = tanda[Number(v.n) - 1];
        if (d && ['coherente', 'dewey', 'incoherente'].includes(v.v)) veredictos[claveVeredicto(d)] = { v: v.v, motivo: v.motivo || '' };
      }
    } catch (e) {
      p.nota(`   ⚠ tanda ${i / TANDA + 1}: ${e.message} (se juzgará en otra pasada)`);
    }
    await fs.mkdir(path.dirname(CACHE_VEREDICTOS), { recursive: true });
    await fs.writeFile(CACHE_VEREDICTOS, JSON.stringify(veredictos));
  }
  p.fin();
}
const juzgadas = hacerSospechosas ? sospechosas.slice(0, LIMITE).filter((d) => veredictoDe(d)) : [];
const incoherentes = juzgadas.filter((d) => veredictoDe(d) === 'incoherente');
const dewey = juzgadas.filter((d) => veredictoDe(d) === 'dewey');
const linea = (d) => `${String(libros.get(d.codigo) || 0).padStart(4)} ${d.codigo.padEnd(20)} «${String(d.titulo_es).slice(0, 45)}» ← ${d.ants[0]} = ${tituloOficial(d.ants[0]).slice(0, 40)} · ${veredictos[claveVeredicto(d)].motivo.slice(0, 60)}`;
if (hacerSospechosas) {
  console.log(`\nSospechosas juzgadas: ${juzgadas.length} de ${Math.min(sospechosas.length, LIMITE)} · coherentes (falsa alarma): ${juzgadas.length - incoherentes.length - dewey.length} · incoherentes: ${incoherentes.length} (${suma(incoherentes)} libros) · número Dewey: ${dewey.length} (${suma(dewey)} libros)`);
  incoherentes.slice(0, 25).forEach((d) => console.log(`   ✗ ${linea(d)}`));
  dewey.slice(0, 15).forEach((d) => console.log(`   D ${linea(d)}`));
  // Los «Dewey» se apuntan para la auditoría de la CDU: su descripción no se toca.
  if (dewey.length) {
    const informe = path.join(RAIZ, 'logs', 'udcs', 'cdu-con-numero-dewey.txt');
    await fs.writeFile(informe, [
      `CDU de libros que parecen números DEWEY (${new Date().toISOString().slice(0, 10)}): ${dewey.length} códigos, ${suma(dewey)} libros.`,
      'Su descripción no se ha tocado. Revisar en la auditoría de la CDU (docs/tareas-pendientes §4).', '',
      ...dewey.map(linea),
    ].join('\n'));
    console.log(`   → lista completa de los «Dewey»: ${path.relative(RAIZ, informe)}`);
  }
}

// ─── Rehacer ─────────────────────────────────────────────────────────────────────────────────────────────────
const aRehacer = [
  ...(hacerCortadas ? cortadas.slice(0, LIMITE).map((d) => ({ ...d, motivo: 'título cortado' })) : []),
  ...incoherentes.map((d) => ({ ...d, motivo: `incoherente con el UDC Summary: ${veredictos[claveVeredicto(d)].motivo}` })),
];
let rehechas = 0, fallidas = 0;
if (EJECUTAR && aRehacer.length) {
  console.log('');
  const p = progreso(aRehacer.length, 'Rehaciendo');
  for (const d of aRehacer) {
    p.paso(d.codigo);
    let nueva;
    try {
      nueva = await conIAGratis((o) => generarDescripcionCDU(db, notacion(d), o), p.nota);   // primero la nueva: si falla, la vieja se queda
    } catch (e) {
      fallidas++;
      continue;
    }
    const vieja = await col.findOne({ _id: d._id });
    if (!vieja || vieja.verificado) continue;              // la tocaron a mano mientras tanto
    const { _id, ...copia } = vieja;
    await db.collection('cdu_descripciones_retiradas').insertOne({ ...copia, _id_original: _id, retirada: { fecha: new Date(), motivo: d.motivo } });
    await col.updateOne({ _id }, {
      $set: {
        titulo_es: nueva.titulo_es, descripcion_es: nueva.descripcion_es,
        titulo_en: nueva.titulo_en, descripcion_en: nueva.descripcion_en,
        fuente: 'ia', verificado: false, fecha: new Date(), revisada: { fecha: new Date(), motivo: d.motivo },
      },
    });
    rehechas++;
    if (rehechas <= 30) p.nota(`   ${d.codigo.padEnd(20)} «${String(d.titulo_es).slice(0, 40)}» → «${String(nueva.titulo_es).slice(0, 50)}»`);
  }
  p.fin();
}

console.log(`\n=== ${EJECUTAR
  ? `HECHO · ${rehechas} rehechas · ${fallidas} sin rehacer (la IA falló o salió incoherente: se quedan como estaban; relanza para reintentar)`
  : `DRY-RUN · se rehacerían ${aRehacer.length} (${hacerCortadas ? Math.min(cortadas.length, LIMITE) : 0} cortadas + ${incoherentes.length} incoherentes)`} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar (reutiliza los veredictos ya guardados).');
process.exit(0);
