/**
 * AUDITORÍA DE LA CDU — Fase 1 de la estrategia (docs/tareas-pendientes §4). SOLO DIAGNÓSTICO: no cambia ninguna CDU ni
 * mueve nada. La CDU decide la carpeta de cada libro y el árbol de la copia sin conexión, así que primero se mide.
 *
 * A cada libro (no manual, no 000) se le buscan INDICIOS de que su CDU esté mal, cada uno con un peso:
 *   · dewey-lcc   (3/1) su propia Dewey/LCC, por la tabla determinista, da otra CLASE (3) u otra división (1);
 *   · bne         (3/1) la CDU que la BNE da a su ISBN (Fichero local) es de otra clase (3) u otra división (1);
 *                       si el título del registro no casa con el del libro, solo cuenta 1 (el ISBN puede ser de otro);
 *   · dewey       (3)   su código es en realidad un número DEWEY (veredicto de revisar-descripciones-cdu.js);
 *   · inexistente (2)   su división de 2 o 3 cifras no existe en el UDC Summary (95-99, 363…: típico de Dewey);
 *   · lugar       (2)   su auxiliar de lugar no casa con los lugares de su título y materias («(430)» y habla de Grecia);
 *                       no en literatura: allí el lugar es la nacionalidad del autor («Iberia» de Michener es 821.111(73));
 *   · hermanos    (2)   es de otra clase que la gran mayoría de los tomos de su OBRA (no de su colección: una serie
 *                       editorial —Austral, Penguin Clásicos— mezcla novelas y biografías y eso no prueba nada);
 *   · literatura  (1)   un 821.x cuya lengua no es la lengua original del libro (a menudo lo malo es idioma_original);
 *   · equivalencia(1)   su CDU sale de una equivalencia aprendida de la IA SIN verificar (el origen de los errores en masa);
 *   · descripcion (1)   la descripción guardada de su código contradice su división.
 * Sospecha: ALTA (≥3), MEDIA (2), BAJA (1). Y la vía de la Fase 3 por la que se corregiría:
 *   · A — hay una autoridad de MAYOR rango (BNE) que la contradice y su CDU es deducida → automático (aplicar-cdu-bne);
 *   · B — su propia Dewey/LCC da otra clase, mismo rango → se propone y se aprueba por grupos;
 *   · C — el resto con sospecha alta/media → a mano.
 * Las CDU manuales (rango 4) no se auditan nunca; las 000 se cuentan aparte (se clasifican con la cascada normal).
 *
 * Escribe un INFORME (logs/auditoria-cdu/auditoria-<fecha>.txt) con los recuentos, los códigos con más libros
 * sospechosos (arreglar el origen arregla muchos), las equivalencias sin verificar de las que más libros dependen
 * (Fase 2) y muestras; y el DETALLE por libro (…-detalle.jsonl) para la Fase 3. Con --selecciones crea además las
 * selecciones «CDU sospechosa A/B/C» para revisarlas en el panel (es lo único que escribe en la base).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/auditar-cdu.js
 *   … --selecciones        crea/actualiza las selecciones A, B y C (alta)
 *   … --sin-fichero        no consulta la BNE del Fichero local (más rápido; sin el indicio «bne»)
 *   … --con-revistas       audita también las revistas (por defecto solo libros: las revistas heredan la de su cabecera)
 *   … --limite N           solo los N primeros libros (para probar)
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
import { buscarEquivalenciaExterna, claseLcc, unidadLcc } from '../src/clasificador-cdu.js';
import { fuenteCduDoc, rangoFuente, cduVacia } from '../src/utils/prioridad-cdu.js';
import { modernizarCDU } from '../src/utils/cdu-moderna.js';
import { lugarContradice, descripcionContradice } from '../src/utils/descripcion-cdu.js';
import { buscarEnFicheroLocal, cerrarFicheroLocal } from '../src/utils/buscador-local.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { mismoTituloLibro } from '../src/utils/titulo-libro.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const SELECCIONES = args.includes('--selecciones');
const SIN_FICHERO = args.includes('--sin-fichero');
const CON_REVISTAS = args.includes('--con-revistas');
const LIMITE = Number(arg('--limite')) || 0;

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'logs', 'auditoria-cdu');
const SELLO = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const INFORME = arg('--informe') || path.join(DIR, `auditoria-${SELLO}.txt`);
const DETALLE = INFORME.replace(/\.txt$/, '') + '-detalle.jsonl';

const db = await conectarDB();
console.log(`\n🔍 AUDITORÍA DE LA CDU (solo diagnóstico)${SIN_FICHERO ? ' · sin Fichero' : ''}${LIMITE ? ` · límite ${LIMITE}` : ''}\n`);

// ─── Lo que sirve de referencia ──────────────────────────────────────────────────────────────────────────────
/** Número principal de una CDU («94(430).085» → «94», «821.134.2-31» → «821.134.2»), en notación moderna. */
const numeroPrincipal = (cdu) => ((modernizarCDU(cdu) || String(cdu || '')).trim().match(/^\d[\d.]*/) || [''])[0].replace(/\.$/, '');
const clase = (num) => num.slice(0, 1);
const division = (num) => num.slice(0, 2);

// UDC Summary: qué divisiones de 2 y 3 cifras existen.
const oficial = new Set((await db.collection('udc_summary').find({}, { projection: { _id: 1 } }).toArray()).map((x) => x._id));
if (!oficial.size) console.log('⚠ udc_summary vacía: sin el indicio «inexistente» (scripts/importar-udc-summary.js --ejecutar)');
// Se compara por CIFRAS, no por códigos exactos: «159» no está en el resumen pero «159.9» (Psicología) sí, así que
// 159.x existe. Prefijos de 2 y 3 cifras de todos los códigos del resumen («93/94» aporta 93 y 94).
const prefijos = new Set();
const hijosDe = new Map();   // «36» → nº de prefijos de 3 cifras distintos bajo 36 (¿el resumen detalla la rama?)
for (const c of oficial) {
  for (const trozo of String(c).split('/')) {
    const cifras = trozo.replace(/[^0-9]/g, '');
    if (!/^\d/.test(trozo) || cifras.length < 2) continue;
    prefijos.add(cifras.slice(0, 2));
    if (cifras.length >= 3 && !prefijos.has(cifras.slice(0, 3))) {
      prefijos.add(cifras.slice(0, 3));
      hijosDe.set(cifras.slice(0, 2), (hijosDe.get(cifras.slice(0, 2)) || 0) + 1);
    }
  }
}

/** ¿Su división no existe en la CDU? Solo se afirma donde el resumen detalla esa rama (si no, no se sabe). */
function divisionInexistente(num) {
  if (!oficial.size) return null;
  const cifras = num.replace(/\./g, '');
  if (cifras.length >= 2 && !prefijos.has(cifras.slice(0, 2))) return { division: cifras.slice(0, 2), segura: true };
  // Tres cifras: «17.036» o «65.012» son AUXILIARES ESPECIALES (el «.0» tras la división), válidos aunque el resumen no
  // los liste; y el resumen no detalla todas las ramas (787, instrumentos de cuerda, existe y no está), así que una
  // tercera cifra ausente es solo un indicio débil.
  if (/^\d\d\.0/.test(num)) return null;
  if (cifras.length >= 3 && (hijosDe.get(cifras.slice(0, 2)) || 0) >= 3 && !prefijos.has(cifras.slice(0, 3))) return { division: cifras.slice(0, 3), segura: false };
  return null;
}

// Equivalencias aprendidas de la IA SIN verificar: «sistema|código de origen» → CDU.
const eqSinVerificar = new Map();
for (const e of await db.collection('equivalencias_cdu').find({ verificado: { $ne: true } },
  { projection: { sistema_origen: 1, codigo_origen: 1, cdu: 1 } }).toArray()) {
  eqSinVerificar.set(`${String(e.sistema_origen).toLowerCase()}|${String(e.codigo_origen).toLowerCase()}`, String(e.cdu));
}

// Códigos que el juez de revisar-descripciones-cdu.js declaró números DEWEY (si se ha lanzado aquí).
const codigosDewey = new Set();
try {
  const ver = JSON.parse(await fs.readFile(path.join(RAIZ, 'logs', 'udcs', 'veredictos-descripciones.json'), 'utf8'));
  for (const [k, v] of Object.entries(ver)) if (v?.v === 'dewey') codigosDewey.add(k.split('|')[0]);
} catch { /* aún no se ha lanzado la revisión: sin este indicio */ }

// Descripciones de código incoherentes con su división.
const descIncoherente = new Set((await db.collection('cdu_descripciones').find({ fuente: { $ne: 'udcs' } },
  { projection: { codigo: 1, titulo_es: 1 } }).toArray()).filter((d) => descripcionContradice(d.codigo, d.titulo_es)).map((d) => d.codigo));

// Lengua original → la literatura que le toca (821.x).
const LITERATURA = {
  es: '821.134.2', en: '821.111', fr: '821.133.1', de: '821.112.2', it: '821.131.1', pt: '821.134.3', ca: '821.134.1',
  gl: '821.134.4', ru: '821.161.1', pl: '821.162.1', cs: '821.162.3', nl: '821.112.5', sv: '821.113.6', da: '821.113.4',
  no: '821.113.5', fi: '821.511.111', hu: '821.511.141', el: '821.14', la: '821.124', ja: '821.521', zh: '821.581',
  ar: '821.411.21', he: '821.411.16', tr: '821.512.161',
};

// ─── Los libros ──────────────────────────────────────────────────────────────────────────────────────────────
const filtro = CON_REVISTAS ? {} : { tipo_recurso: 'libro' };
const proyeccion = {
  titulo: 1, subtitulo: 1, cdu: 1, cdu_fuente: 1, cdu_manual: 1, alertas_agente: 1, dewey: 1, lcc: 1, isbn: 1,
  palabras_clave: 1, coleccion: 1, obra: 1, idioma_original: 1,
};
let cursor = db.collection('biblioteca').find(filtro, { projection: proyeccion });
if (LIMITE) cursor = cursor.limit(LIMITE);
const libros = await cursor.toArray();
console.log(`Libros a auditar: ${libros.length}`);

// Hermanos: la división mayoritaria de cada colección/obra (con 5+ miembros y un 70 % o más de acuerdo).
const grupos = new Map();
for (const l of libros) {
  const num = numeroPrincipal(l.cdu);
  if (!num || cduVacia(l.cdu)) continue;
  for (const g of [l.obra && `o:${l.obra}`].filter(Boolean)) {
    if (!grupos.has(g)) grupos.set(g, new Map());
    const m = grupos.get(g);
    m.set(clase(num), (m.get(clase(num)) || 0) + 1);
  }
}
const mayoria = new Map();   // grupo → clase mayoritaria (si es clara)
for (const [g, m] of grupos) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  const [cl, n] = [...m].sort((a, b) => b[1] - a[1])[0];
  if (total >= 5 && n / total >= 0.7) mayoria.set(g, cl);
}

// ─── Auditar ─────────────────────────────────────────────────────────────────────────────────────────────────
const cuenta = { manual: 0, vacia: 0, auditados: 0, alta: 0, media: 0, baja: 0, limpios: 0, A: 0, B: 0, C: 0 };
const porIndicio = new Map();         // tipo → nº de libros
const muestras = new Map();           // tipo → ejemplos
const porCodigo = new Map();          // CDU → nº de libros con sospecha alta/media
const porEquivalencia = new Map();    // «sistema|código → cdu» → nº de libros que dependen de ella
const seleccion = { A: [], B: [], C: [] };
await fs.mkdir(DIR, { recursive: true });
const detalle = [];

const p = progreso(libros.length, 'Auditando');
for (const l of libros) {
  p.paso(String(l.titulo || '').slice(0, 30));
  if (cduVacia(l.cdu)) { cuenta.vacia++; continue; }
  const fuente = fuenteCduDoc(l);
  const rango = rangoFuente(fuente);
  if (rango >= 4) { cuenta.manual++; continue; }
  cuenta.auditados++;
  const num = numeroPrincipal(l.cdu);
  const indicios = [];
  const anota = (tipo, peso, texto, extra = {}) => indicios.push({ tipo, peso, texto, ...extra });

  // 1. Su propia Dewey/LCC por la tabla determinista. La LCC va por CLASE (QA → 51 aunque QA76 sea informática), así
  //    que pesa menos que la Dewey; una «LCC» que no lo es («MLCS 2006/45384») no cuenta; y la informática (004-006)
  //    frente a 5/6 no es una contradicción (la tabla manda la informática de Dewey/LCC a ciencias o técnica).
  for (const sistema of ['dewey', 'lcc']) {
    if (!l[sistema] || !num) continue;
    if (sistema === 'lcc' && (!/^[A-Z]{1,3}\s?-*\d/.test(String(l.lcc).trim()) || /^MLC/.test(String(l.lcc)))) continue;
    const c = await buscarEquivalenciaExterna(sistema, String(l[sistema])).catch(() => null);
    const cn = c ? numeroPrincipal(c) : '';
    if (!cn || cduVacia(c)) continue;
    const informatica = (x) => /^00[4-6]/.test(x);
    if ((informatica(num) && /^[56]/.test(cn)) || (informatica(cn) && /^[56]/.test(num))) continue;
    if (clase(cn) !== clase(num)) anota('dewey-lcc', sistema === 'dewey' ? 3 : 2, `su ${sistema.toUpperCase()} ${l[sistema]} → CDU ${c}`, { propuesta: c, via: 'B' });
    else if (division(cn).length === 2 && division(num).length === 2 && division(cn) !== division(num)) anota('dewey-lcc', 1, `su ${sistema.toUpperCase()} ${l[sistema]} → CDU ${c} (otra división)`);
  }

  // 2. La CDU de la BNE por su ISBN (Fichero local).
  if (!SIN_FICHERO && l.isbn && num) {
    const f = await buscarEnFicheroLocal({ isbns: variantesISBN(l.isbn) }).catch(() => null);
    if (f && f.cdu) {
      const bn = numeroPrincipal(f.cdu);
      const casa = mismoTituloLibro(f.titulo || '', l.titulo || '');
      if (bn && clase(bn) !== clase(num)) {
        if (casa) anota('bne', 3, `la BNE le da ${f.cdu}`, { propuesta: f.cdu, via: rango < 2 ? 'A' : 'C' });
        else anota('bne', 1, `la BNE le da ${f.cdu}, pero a «${String(f.titulo).slice(0, 40)}» (¿ISBN de otro libro?)`);
      } else if (bn && casa && division(bn) !== division(num) && rango < 2) {
        anota('bne', 1, `la BNE le da ${f.cdu} (otra división)`, { propuesta: f.cdu, via: 'A' });
      }
    }
  }

  // 3. El código es un número Dewey (veredicto del juez de las descripciones).
  if (codigosDewey.has(sanitizarCDU(l.cdu))) anota('dewey', 3, `«${l.cdu}» es un número Dewey, no CDU`);

  // 4. División que no existe en la CDU.
  const inex = num ? divisionInexistente(num) : null;
  if (inex) {
    const religion = clase(num) === '2';
    anota('inexistente', inex.segura && !religion ? 2 : 1,
      `la división ${inex.division} ${inex.segura ? 'no existe en la CDU' : 'no está en el UDC Summary'}${religion ? ' (religión: notación anterior a 2000)' : ''}`);
  }

  // 5. El lugar del código frente al del título y las materias.
  const texto = `${l.titulo || ''} ${l.subtitulo || ''} ${(l.palabras_clave || []).join(' ')}`;
  if (clase(num) !== '8' && lugarContradice(l.cdu, texto)) anota('lugar', 2, 'su lugar no casa con el título/materias');

  // 6. Hermanos.
  for (const g of [l.obra && `o:${l.obra}`].filter(Boolean)) {
    const cl = mayoria.get(g);
    if (cl && num && clase(num) !== cl) { anota('hermanos', 2, `los demás tomos de su obra son casi todos de la clase ${cl}`); break; }
  }

  // 7. Literatura: la lengua del 821.x frente a la lengua original.
  const lit = LITERATURA[String(l.idioma_original || '').toLowerCase()];
  if (lit && num.startsWith('821.') && !num.startsWith(lit)) anota('literatura', 1, `literatura ${num} pero escrito en «${l.idioma_original}» (${lit})`);

  // 8. De una equivalencia de la IA sin verificar.
  const claves = [l.dewey && `dewey|${String(l.dewey).toLowerCase()}`,
    l.lcc && `lcc|${String(unidadLcc(l.lcc) || '').toLowerCase()}`, l.lcc && `lcc|${String(claseLcc(l.lcc) || '').toLowerCase()}`].filter(Boolean);
  for (const k of claves) {
    const eq = eqSinVerificar.get(k);
    if (eq && sanitizarCDU(eq) === sanitizarCDU(l.cdu)) {
      // Si la tabla determinista da lo mismo, la IA no aportó nada (ni riesgo): no se marca.
      const [sis, cod] = k.split('|');
      const tabla = await buscarEquivalenciaExterna(sis, cod).catch(() => null);
      if (tabla && sanitizarCDU(tabla) === sanitizarCDU(eq)) break;
      anota('equivalencia', 1, `sale de la equivalencia IA sin verificar ${k} → ${eq}`);
      const e = `${k} → ${eq}`;
      porEquivalencia.set(e, (porEquivalencia.get(e) || 0) + 1);
      break;
    }
  }

  // 9. Descripción del código incoherente.
  if (descIncoherente.has(sanitizarCDU(l.cdu))) anota('descripcion', 1, 'la descripción de su código contradice su división');

  // ── Resultado del libro ──
  const puntos = indicios.reduce((s, i) => s + i.peso, 0);
  if (!puntos) { cuenta.limpios++; continue; }
  const nivel = puntos >= 3 ? 'alta' : puntos === 2 ? 'media' : 'baja';
  cuenta[nivel]++;
  for (const t of new Set(indicios.map((i) => i.tipo))) {
    porIndicio.set(t, (porIndicio.get(t) || 0) + 1);
    if (!muestras.has(t)) muestras.set(t, []);
    if (muestras.get(t).length < 12) muestras.get(t).push(`${String(l.cdu).padEnd(18)} «${String(l.titulo).slice(0, 50)}» — ${indicios.find((i) => i.tipo === t).texto}`);
  }
  let via = null;
  if (nivel !== 'baja') {
    porCodigo.set(l.cdu, (porCodigo.get(l.cdu) || 0) + 1);
    via = indicios.find((i) => i.via === 'A') ? 'A' : indicios.find((i) => i.via === 'B') ? 'B' : 'C';
    cuenta[via]++;
    if (via !== 'C' || nivel === 'alta') seleccion[via].push(l._id);
  }
  const propuesta = indicios.find((i) => i.propuesta)?.propuesta || null;
  detalle.push(JSON.stringify({ _id: String(l._id), titulo: l.titulo, cdu: l.cdu, fuente, puntos, nivel, via, propuesta, indicios: indicios.map(({ tipo, peso, texto }) => ({ tipo, peso, texto })) }));
}
p.fin();
cerrarFicheroLocal?.();

// ─── Informe ─────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (n) => cuenta.auditados ? ` (${(100 * n / cuenta.auditados).toFixed(1)} %)` : '';
const NOMBRES = {
  'dewey-lcc': 'su propia Dewey/LCC da otra clase/división', bne: 'la BNE le da otra CDU', dewey: 'el código es un número Dewey',
  inexistente: 'su división no existe en la CDU', lugar: 'su lugar no casa con el título', hermanos: 'distinta de su colección/obra',
  literatura: 'literatura de otra lengua', equivalencia: 'sale de una equivalencia IA sin verificar', descripcion: 'descripción del código incoherente',
};
const lineas = [
  `AUDITORÍA DE LA CDU — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (solo diagnóstico: no se ha cambiado nada)`,
  '',
  `Libros: ${libros.length} · manuales (no se auditan): ${cuenta.manual} · sin clasificar (000, aparte): ${cuenta.vacia} · auditados: ${cuenta.auditados}`,
  `   sin ningún indicio: ${cuenta.limpios}${pct(cuenta.limpios)}`,
  `   sospecha ALTA: ${cuenta.alta}${pct(cuenta.alta)} · MEDIA: ${cuenta.media}${pct(cuenta.media)} · BAJA: ${cuenta.baja}${pct(cuenta.baja)}`,
  '',
  'Vía de corrección (Fase 3) de las de sospecha alta/media:',
  `   A — una autoridad de mayor rango (BNE) la contradice → automático: ${cuenta.A}`,
  `   B — su propia Dewey/LCC da otra clase → propuesta para aprobar por grupos: ${cuenta.B}`,
  `   C — el resto → a mano: ${cuenta.C}`,
  '',
  'Libros por indicio (uno puede tener varios):',
  ...[...porIndicio].sort((a, b) => b[1] - a[1]).map(([t, n]) => `   ${String(n).padStart(6)}  ${NOMBRES[t] || t}`),
  '',
  'CDU con más libros sospechosos (alta/media) — arreglar el origen arregla todos sus libros:',
  ...[...porCodigo].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([c, n]) => `   ${String(n).padStart(5)}  ${c}`),
  '',
  'Equivalencias de la IA SIN verificar de las que más libros dependen (Fase 2: revisarlas primero):',
  ...[...porEquivalencia].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([e, n]) => `   ${String(n).padStart(5)}  ${e}`),
  '',
  'Muestras por indicio:',
  ...[...muestras].flatMap(([t, l]) => ['', `── ${NOMBRES[t] || t}`, ...l.map((x) => `   ${x}`)]),
  '',
  `Detalle por libro (para la Fase 3): ${path.relative(RAIZ, DETALLE)}`,
  codigosDewey.size ? '' : '(Sin el indicio «número Dewey»: lanza antes scripts/revisar-descripciones-cdu.js en esta máquina.)',
];
await fs.writeFile(INFORME, lineas.join('\n'));
await fs.writeFile(DETALLE, detalle.join('\n') + '\n');
console.log('\n' + lineas.slice(2, 22).join('\n'));
console.log(`\n📄 Informe completo: ${path.relative(RAIZ, INFORME)}`);

// ─── Selecciones (opcional; lo único que escribe en la base) ─────────────────────────────────────────────────
if (SELECCIONES) {
  const { crearSeleccion, reemplazarDocs, editarSeleccion } = await import('../src/utils/selecciones.js');
  const fecha = new Date().toISOString().slice(0, 10);
  const guardar = async (prefijo, descripcion, ids) => {
    if (!ids.length) return;
    const previa = await db.collection('selecciones').findOne({ nombre: { $regex: '^' + prefijo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    if (previa) {
      await reemplazarDocs(db, previa._id, ids);
      await editarSeleccion(db, previa._id, { nombre: `${prefijo} ${fecha}` });
    } else {
      await crearSeleccion(db, { nombre: `${prefijo} ${fecha}`, descripcion, docs: ids });
    }
    console.log(`   ✓ ${prefijo}: ${ids.length}`);
  };
  console.log('\nSelecciones:');
  await guardar('CDU sospechosa A (la BNE la contradice)', 'Auditoría de la CDU, vía A: la BNE da otra CDU a su ISBN (título corroborado) y la actual es deducida. Fase 3: automático.', seleccion.A);
  await guardar('CDU sospechosa B (su Dewey-LCC dice otra cosa)', 'Auditoría de la CDU, vía B: su propia Dewey/LCC, por la tabla determinista, da otra clase. Fase 3: se propone y se aprueba por grupos.', seleccion.B);
  await guardar('CDU sospechosa C (revisar a mano)', 'Auditoría de la CDU, vía C, sospecha alta: lugar, hermanos, literatura, código Dewey o inexistente. Fase 3: a mano.', seleccion.C);
}
process.exit(0);
