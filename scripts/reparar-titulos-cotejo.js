/**
 * DESHACER LOS CAMBIOS DE TÍTULO DEL COTEJO QUE PUSIERON EL DE OTRO LIBRO. La campaña «Cotejar título por ISBN»
 * cambiaba el título por el del Fichero cuando el ISBN se «corroboraba» por el nombre del fichero, con una
 * corroboración que tolera palabras de menos: «El cine contado con sencillez» (ePubLibre) pasó a «El cine ESPAÑOL
 * contado con sencillez», el libro hermano de la serie cuyo ISBN llevaba el fichero. Medido el 6-oct: 1.490 de 13.890
 * cambios trajeron palabras que no decían ni el título anterior ni el nombre del fichero. La campaña ya no lo hace
 * (campanas.js · cotejarPorISBN + titulo-libro.js · palabrasAnadidas). Este script arregla lo hecho:
 *
 *   A. La autoridad solo AÑADIÓ un subtítulo («Y en España se puso el sol» → «…: Cuba 1898»): vuelve el título y lo
 *      añadido pasa a subtítulo (si no tenía).
 *   B. La autoridad es OTRO título («…: Primavera» → «…: Invierno»): vuelve el título; el documento queda con
 *      `isbn_sospechoso` y `revision_requerida` (su ISBN es probablemente el del otro libro) y en la selección
 *      «ISBN de otro libro de la serie (cotejo)».
 *   C. No se sabe el título anterior (el aviso lo guardó cortado a 45 letras y ni el nombre del fichero ni el título
 *      de los créditos lo completan): no se toca; a la misma selección.
 *
 * Y el «título original» que en realidad es el del propio libro (créditos de ePubLibre en un libro escrito en
 * español, sin traducción): si es el título que vuelve, o el mismo que el título, se quita (`titulo_original`).
 *
 * Diario `deshacer[]`. Solo base de datos (el título no mueve la carpeta).
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-titulos-cotejo.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/reparar-titulos-cotejo.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { parsearNombre } from '../src/utils/parsear-nombre.js';
import { palabrasAnadidas, mismoTituloLibro, tituloComparable } from '../src/utils/titulo-libro.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGEN = 'reparar-titulos-cotejo';
const SELECCION = 'ISBN de otro libro de la serie (cotejo)';
// El aviso de la campaña: «Título "<antes, 45 letras>" sustituido por el del Fichero por ISBN (corroborado por el
// nombre): "<después, 45 letras>" (campaña cotejo, sin IA).»
const RE_AVISO = /^Título "(.*)" sustituido por el del Fichero por ISBN \(corroborado por el nombre\): "(.*)" \(campaña cotejo/;
const CORTE = 45;

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · títulos que el cotejo cambió por los de otro libro\n`);

const sinExtension = (n) => String(n || '').replace(/\.[^.]+$/, '');
const empiezaIgual = (largo, corto) => tituloComparable(largo).startsWith(tituloComparable(corto));

/**
 * El trozo de `texto` (con sus acentos y mayúsculas) que, comparado sin ellos, es `buscado`. Los nombres de fichero
 * de ePubLibre no llevan acentos («El incierto senor Don Hamlet…»): si el título actual o el del aviso tienen ese
 * mismo texto acentuado, se usa el suyo. null si `texto` no empieza por `buscado`.
 */
function prefijoCon(texto, buscado, { palabraCompleta = true } = {}) {
  const i = corte(texto, buscado, { palabraCompleta });
  if (i == null) return null;
  // Con la puntuación que cierra el título («?», «!», «)», «»»): «¿Por qué es divertido el sexo?».
  const cierre = texto.slice(i).match(/^[?!)»"'\]]*/)[0];
  return (texto.slice(0, i) + cierre).trim();
}

// Comparación sin acentos ni mayúsculas, pero SIN quitar paréntesis (tituloComparable los quita, y «Obras completas
// (B. A. C.)» se quedaba en «Obras completas»).
const RE_DIACR = new RegExp('[\\u0300-\\u036f]', 'g');
const plano = (t) => String(t || '').toLowerCase().normalize('NFD').replace(RE_DIACR, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Posición de `texto` hasta la que, comparado en plano, dice `buscado` (al final de una palabra si `palabraCompleta`). */
function corte(texto, buscado, { palabraCompleta = true } = {}) {
  const meta = plano(buscado);
  if (!meta) return null;
  for (let i = 1; i <= texto.length; i++) {
    const c = plano(texto.slice(0, i));
    if (c === meta && (!palabraCompleta || !/[\p{L}\p{N}]/u.test(texto[i] || ''))) return i;
    if (c.length > meta.length) return null;
  }
  return null;
}

/**
 * El título anterior completo: el del aviso si no está cortado; si lo está, los créditos o el nombre del fichero que
 * empiecen igual. Y con los acentos buenos: del título del aviso, de los créditos o del título actual.
 */
function tituloAnterior(antes, doc) {
  let anterior = null;
  if (antes.length < CORTE) anterior = antes;
  else {
    const delFichero = parsearNombre(doc.nombre_archivo || '').titulo;
    anterior = [doc.titulo_original, delFichero].find((c) => c && empiezaIgual(c, antes)) || null;
  }
  if (!anterior) return null;
  // Del aviso sin cortar o de los créditos ya viene bien escrito. Del nombre del fichero viene sin acentos: si otro
  // texto dice lo mismo con acentos (los créditos, el título actual), se toma el suyo; si no, la parte del aviso
  // (acentuada) más lo que falte del nombre del fichero («…del tiempo: Primaver» + «a»).
  if (anterior === antes || anterior === doc.titulo_original || /[À-ÿ]/.test(anterior)) return anterior;
  for (const fuente of [doc.titulo_original, doc.titulo]) {
    const acentuado = fuente && prefijoCon(fuente, anterior);
    if (acentuado) return acentuado;
  }
  const i = corte(anterior, antes, { palabraCompleta: false });
  if (i != null) return (antes + anterior.slice(i)).trim();
  return anterior;
}

// Un SUBTÍTULO pegado: tras el título anterior viene un separador («:», «.», «;», «=», « - ») y lo añadido no habla
// de tomos («Volume 2», «Tomo II», «Libro 3»: eso es otro libro de la obra).
const RE_SEPARADOR = /^\s*(?:[:.;=]|\s-\s|\s—\s)/;
const RE_TOMO = /\b(?:vol(?:ume|umen)?|tomo|libro|book|part[e]?|band|livre)\b\.?\s*(?:\d+|[ivxlc]+)\b/i;
function restoComoSubtitulo(actual, anterior) {
  const inicio = prefijoCon(actual, anterior);
  if (!inicio) return null;
  const resto = actual.slice(inicio.length);
  if (!RE_SEPARADOR.test(resto)) return null;
  const limpio = resto.replace(/^[\s.:;=,–—-]+/, '').replace(/[\s.]+$/, '').trim();
  if (!limpio || RE_TOMO.test(limpio)) return null;
  return limpio;
}

const filtro = { alertas_agente: { $regex: 'sustituido por el del Fichero por ISBN' } };
const total = await bib.countDocuments(filtro);
const p = progreso(total, 'Revisando');
const cuenta = { A: 0, B: 0, C: 0, origenQuitado: 0 };
const ejemplos = { A: [], B: [], C: [] };
const aSeleccion = [];

for await (const d of bib.find(filtro, { projection: { titulo: 1, subtitulo: 1, titulo_original: 1, nombre_archivo: 1, alertas_agente: 1, idioma: 1, idioma_original: 1, contribuciones: 1 } })) {
  p.paso(d.titulo);
  const aviso = (d.alertas_agente || []).map((x) => String(x).match(RE_AVISO)).filter(Boolean).pop();
  if (!aviso) continue;
  const [, antes, despues] = aviso;
  // Si el título cambió después del cotejo (a mano, otra reparación), no es asunto de este script.
  if (!empiezaIgual(d.titulo, despues)) continue;
  const referencia = sinExtension(d.nombre_archivo);
  if (!palabrasAnadidas(d.titulo, antes, referencia).length) continue;   // no añadió nada: el cambio era bueno

  const anterior = tituloAnterior(antes, d);
  if (!anterior) {
    cuenta.C++;
    aSeleccion.push(d._id);
    if (ejemplos.C.length < 10) ejemplos.C.push(`«${d.titulo}» (antes «${antes}…»)`);
    continue;
  }

  // A: el título de la autoridad es el anterior + un subtítulo. B: es otro.
  const subtitulo = restoComoSubtitulo(d.titulo, anterior);
  const soloSubtitulo = !!subtitulo;
  const clase = soloSubtitulo ? 'A' : 'B';
  cuenta[clase]++;
  const set = { titulo: anterior, fecha_actualizacion: new Date() };
  const unset = {};
  if (soloSubtitulo && !d.subtitulo) set.subtitulo = subtitulo;
  if (!soloSubtitulo) {
    set.isbn_sospechoso = true;
    set.revision_requerida = true;
    aSeleccion.push(d._id);
  }
  // El «título original» que es el del propio libro (sin traducción): fuera.
  const traducido = (d.idioma_original && d.idioma_original !== d.idioma) || (d.contribuciones || []).some((c) => c.rol === 'traductor');
  if (d.titulo_original && !traducido && mismoTituloLibro(d.titulo_original, anterior)) {
    unset.titulo_original = '';
    cuenta.origenQuitado++;
  }
  if (ejemplos[clase].length < 12) ejemplos[clase].push(`«${d.titulo}» → «${anterior}»${set.subtitulo ? ` + subtítulo «${set.subtitulo}»` : ''}`);

  if (EJECUTAR) {
    const upd = {
      $set: set,
      $push: {
        deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo: d.titulo, subtitulo: d.subtitulo ?? null, titulo_original: d.titulo_original ?? null } },
        alertas_agente: soloSubtitulo
          ? `Título «${d.titulo}» → «${anterior}»: el cotejo le había pegado el subtítulo (scripts/${ORIGEN}).`
          : `Título «${d.titulo}» → «${anterior}»: el cotejo había puesto el de OTRO libro (el del Fichero para su ISBN). Su ISBN es probablemente el de ese otro libro: revisar (scripts/${ORIGEN}).`,
      },
    };
    if (Object.keys(unset).length) upd.$unset = unset;
    await bib.updateOne({ _id: d._id }, upd);
    await indexarDoc(db, d._id).catch(() => {});
  }
}
p.fin();

console.log(`\nA · solo subtítulo pegado (vuelve el título, lo demás a subtítulo): ${cuenta.A}`);
ejemplos.A.forEach((e) => console.log(`     ${e}`));
console.log(`\nB · el título de OTRO libro (vuelve el título; ISBN sospechoso, a revisar): ${cuenta.B}`);
ejemplos.B.forEach((e) => console.log(`     ${e}`));
console.log(`\nC · sin el título anterior completo (no se toca; a revisar): ${cuenta.C}`);
ejemplos.C.forEach((e) => console.log(`     ${e}`));
// ─── 2. «Título original» que es el del propio libro, en los demás ──────────────────────────────────────
// La pasada de recuperar-titulo-original (antes del arreglo del 6-oct) tomó el «Título original:» de ePubLibre
// también en libros escritos en español. Sin traducción a la vista (ni idioma original distinto ni traductor) y con
// el mismo título que el libro (con o sin subtítulo, otra grafía), no es un título original: se quita. Solo base
// de datos: no hace falta volver a leer los ficheros.
// Las mismas palabras (o unas empiezan por las otras: subtítulo); SIN tolerar erratas, que entre lenguas parecidas
// confunden una traducción con el original («Un billete de lotería» / «Un billet de loterie»).
const mismasPalabras = (a, b) => {
  const [x, y] = [plano(a), plano(b)].sort((m, n) => m.length - n.length);
  return !!x && (x === y || y.startsWith(x + ' '));
};
const filtroOrig = { titulo_original: { $exists: true } };
const p2 = progreso(await bib.countDocuments(filtroOrig), 'Títulos originales');
let mismos = 0;
const ejemplosOrig = [];
for await (const d of bib.find(filtroOrig, { projection: { titulo: 1, titulo_original: 1, idioma: 1, idioma_original: 1, contribuciones: 1, deshacer: 1 } })) {
  p2.paso(d.titulo);
  if ((d.deshacer || []).some((x) => x.origen === ORIGEN && EJECUTAR)) continue;   // ya visto arriba en esta ejecución
  const traducido = (d.idioma_original && d.idioma_original !== d.idioma) || (d.contribuciones || []).some((c) => c.rol === 'traductor');
  if (traducido || !mismasPalabras(d.titulo_original, d.titulo)) continue;
  mismos++;
  if (ejemplosOrig.length < 10) ejemplosOrig.push(`«${d.titulo}» · «${d.titulo_original}»`);
  if (EJECUTAR) {
    await bib.updateOne({ _id: d._id }, {
      $unset: { titulo_original: '', titulos_originales: '' },
      $set: { fecha_actualizacion: new Date() },
      $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo_original: d.titulo_original } } },
    });
  }
}
p2.fin();
cuenta.origenQuitado += mismos;
ejemplosOrig.forEach((e) => console.log(`     ${e}`));

console.log(`\n«Título original» que era el del propio libro, quitado: ${cuenta.origenQuitado}`);

if (EJECUTAR && aSeleccion.length) {
  const ya = await db.collection('selecciones').findOne({ nombre: SELECCION });
  if (ya) await db.collection('selecciones').updateOne({ _id: ya._id }, { $addToSet: { docs: { $each: aSeleccion } }, $set: { fecha_actualizacion: new Date() } });
  else await crearSeleccion(db, { nombre: SELECCION, descripcion: `Libros cuyo título había cambiado el cotejo por el de otro libro de la serie (el del Fichero para su ISBN): el ISBN del documento es probablemente el de ese otro libro. Corregir el ISBN (🔎 Extraer ISBN con «forzar», o a mano) (scripts/${ORIGEN}).`, docs: aSeleccion });
}
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${cuenta.A + cuenta.B} títulos vuelven · ${aSeleccion.length} a la selección «${SELECCION}» ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
process.exit(0);
