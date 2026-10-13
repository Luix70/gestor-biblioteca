/**
 * REFINAR CDU (13-oct): que ningún libro se quede con una CDU de 1 o 2 cifras («5», «51», «82») ni en «000».
 *
 * Medido el 13-oct: 20.768 de 62.205 libros (3.359 en 000, 3.140 de una cifra, 14.269 de dos). Una CDU es
 * SUFICIENTE (decisión del usuario) si su número principal tiene 3 cifras o más, o si tiene 2 con un auxiliar que la
 * precisa: de lugar «94(460)», especial «27-23», «2-65», «82-31», o «.0» «82.09». Un auxiliar de forma «51(075)»,
 * de tiempo, de lengua o una relación «82:087.5» no precisa la materia.
 *
 * CASCADA (de lo gratuito y seguro a la IA). La regla de todos los pasos: solo vale una CDU que REFINE la actual
 * —que empiece por ella: 51 → 512, nunca 51 → 004—; con 000 vale cualquiera. Los auxiliares de la actual se
 * conservan («51(075)» → «512(075)»).
 *   1. AUTORIDAD POR ISBN: la CDU de la BNE (Fichero local y, en la campaña, su catálogo en línea), con la
 *      salvaguarda de que el título case (cduDeAutoridadFiable); y el Dewey y el LCC del libro y de la autoridad,
 *      por las TABLAS deterministas (no la caché).
 *   2. HERMANOS: otro ejemplar del mismo título y autor en la biblioteca con una CDU fina; o la CDU dominante de
 *      su colección (3+ libros y 60 %+ de los finos).
 *   3. ÁRBOL INVERSO: entre las subdivisiones oficiales de su rama (UDC Summary), la que casa con el título, el
 *      subtítulo y las materias, si hay UNA ganadora clara («51» + «Álgebra lineal» → 512).
 *   4. IA CON MENÚ CERRADO: la ficha (título, autores, sinopsis, materias, Dewey, LCC) y la lista OFICIAL de
 *      subdivisiones de su rama; elige de la lista (no puede inventar) y solo vale con confianza alta o media. Por
 *      tandas de varios libros de la misma rama. Si el resultado aún es grueso (000 → 51), otra vuelta con la rama
 *      nueva. La historia (94) y la geografía (91) se precisan con el LUGAR.
 *   5. Lo que no se resuelve se queda como está (la campaña/el script lo apartan para revisarlo).
 *
 * PRIORIDAD (decisión del usuario): refinar dentro de la misma rama vale sobre cualquier rango salvo el manual —un
 * «51» de la BNE puede pasar a «512»: no la contradice, la precisa—. El rango (cdu_fuente) se conserva; solo sube a
 * «bne» si quien refina es la BNE.
 *
 * Lo usan la campaña de fondo «Refinar CDU» (mantenimiento/campanas.js), scripts/refinar-cdu.js y la INGESTA
 * (servicio-ingesta: pasos 1 y 3, sin IA, para que un libro nuevo entre ya refinado).
 */
import { buscarAutoridadPorISBN, cduDeAutoridadFiable } from './autoridad-isbn.js';
import { variantesISBN } from './identificadores.js';
import { buscarEquivalenciaExterna, cduBienFormada } from '../clasificador-cdu.js';
import { modernizarCDU } from './cdu-moderna.js';
import { cduReligionModerna } from './cdu-religion.js';
import { conTexto, extraerJSON } from './vision.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { rangoFuente, RANGO_CDU } from './prioridad-cdu.js';

export const VERSION_REFINAR = 1;

// ─── ¿Gruesa? ─────────────────────────────────────────────────────────────────────────────────────────────────
// Una sola expresión (en texto, para poder usarla también en las consultas de Mongo): vacía, 000, 1-2 cifras
// solas, o 1-2 cifras seguidas de un auxiliar que NO precisa (forma «(0…», tiempo «"», lengua «=», relación «:+/»).
export const RE_CDU_GRUESA = String.raw`^\s*$|^0+$|^[0-9]{1,2}$|^[0-9]{1,2}\(0|^[0-9]{1,2}["=:+/]`;
const reGruesa = new RegExp(RE_CDU_GRUESA);

export function esCduGruesa(cdu) {
  return reGruesa.test(String(cdu ?? '').trim());
}

/**
 * Los libros que le quedan por refinar: CDU gruesa, no manual, no tomo de una obra (comparten la CDU de la obra), y
 * no intentados en esta versión —o intentados sin IA, si ahora la hay (`refinar_cdu.ia`)—.
 */
export function filtroRefinarCdu({ conIA = true } = {}) {
  return {
    tipo_recurso: 'libro',
    cdu_manual: { $ne: true },
    obra: { $in: [null] },
    cdu: { $regex: RE_CDU_GRUESA },
    $or: [{ 'refinar_cdu.v': { $ne: VERSION_REFINAR } }, ...(conIA ? [{ 'refinar_cdu.ia': { $ne: true } }] : [])],
  };
}

/** El número principal («512.64» de «512.64(075)»). */
const principal = (cdu) => String(cdu || '').trim().match(/^\d+(?:\.\d+)*/)?.[0] || '';
const esCero = (cdu) => /^0*$/.test(principal(cdu)) || !String(cdu || '').trim();

/**
 * La CDU refinada que se guardaría: la nueva + los auxiliares de la actual que no traiga («51(075)» + 512 →
 * «512(075)»; «82:087.5» + 821.134.2 → «821.134.2:087.5»). null si no refina o no queda bien formada.
 */
export function componerRefinada(actual, nueva) {
  const a = String(actual || '').trim();
  let n = modernizarCDU(String(nueva || '').trim());
  if (!n || !/^\d/.test(n)) return null;
  if (!esCero(a)) {
    const pa = principal(a);
    if (!principal(n).startsWith(pa) || principal(n) === pa && n === a) return null;
    const cola = a.slice(pa.length);
    // Un RANGO («5/6» ciencias puras y aplicadas, «51/53») abarca varias ramas: no se refina. Si no, «5/6(035.062)»
    // + 52 daba «52/6(035.062)», que no significa nada (2 libros el 13-oct).
    if (cola.startsWith('/')) return null;
    if (cola && !n.includes(cola)) n = `${n}${cola}`;
  }
  if (!cduBienFormada(n) || esCduGruesa(n) && principal(n) === principal(a)) return null;
  return n;
}

// ─── Paso 1: autoridad por ISBN y tablas ──────────────────────────────────────────────────────────────────────
async function pasoAutoridad(doc, { enLinea }) {
  const candidatas = [];
  const conTabla = async (sistema, codigo, via) => {
    if (!codigo) return;
    const cdu = await buscarEquivalenciaExterna(sistema, String(codigo)).catch(() => null);
    if (cdu) candidatas.push({ cdu, fuente: 'tabla', via });
  };
  await conTabla('dewey', doc.dewey, `Dewey ${doc.dewey} del libro`);
  await conTabla('lcc', doc.lcc, `LCC ${doc.lcc} del libro`);
  if (doc.isbn) {
    const reg = await buscarAutoridadPorISBN(variantesISBN(doc.isbn), { enLinea }).catch(() => null);
    if (reg) {
      if (reg.cdu && cduDeAutoridadFiable(doc, reg)) {
        const cdu = cduReligionModerna(modernizarCDU(String(reg.cdu)), { ...doc, dewey: doc.dewey || reg.dewey }).cdu;
        candidatas.push({ cdu, fuente: 'bne', via: `CDU de la BNE por ISBN (${reg.cdu})` });
      }
      // El Dewey/LCC de la autoridad solo si el registro es este libro (mismo criterio de título).
      if (cduDeAutoridadFiable(doc, { ...reg, cdu: '0' })) {
        if (reg.dewey && reg.dewey !== doc.dewey) await conTabla('dewey', reg.dewey, `Dewey ${reg.dewey} de la autoridad`);
        if (reg.lcc && reg.lcc !== doc.lcc) await conTabla('lcc', reg.lcc, `LCC ${reg.lcc} de la autoridad`);
      }
    }
  }
  return mejorCandidata(doc, candidatas);
}

/** De varias candidatas, la que refina la actual y es más detallada (a igualdad, la de la BNE). */
function mejorCandidata(doc, candidatas) {
  let mejor = null;
  for (const c of candidatas) {
    const cdu = componerRefinada(doc.cdu, c.cdu);
    if (!cdu) continue;
    const peso = principal(cdu).replace(/\./g, '').length * 10 + (c.fuente === 'bne' ? 1 : 0);
    if (!mejor || peso > mejor.peso) mejor = { ...c, cdu, peso };
  }
  return mejor ? { cdu: mejor.cdu, fuente: mejor.fuente, via: mejor.via } : null;
}

// ─── Paso 2: hermanos ─────────────────────────────────────────────────────────────────────────────────────────
const escapar = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function pasoHermanos(db, doc) {
  const col = db.collection('biblioteca');
  const candidatas = [];
  // Otro ejemplar del mismo título y autor (otra edición, otro formato) con la CDU fina.
  // (Hay títulos con bytes nulos o de control —«cover-image-large.jpg\0»—: Mongo rechaza una expresión con ellos.)
  const titulo = String(doc.titulo || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (titulo && Array.isArray(doc.autores) && doc.autores.length && typeof doc.autores[0] === 'object') {
    const otros = await col.find(
      { _id: { $ne: doc._id }, titulo: new RegExp(`^${escapar(titulo)}$`, 'i'), autores: { $in: doc.autores } },
      { projection: { cdu: 1 } },
    ).limit(10).toArray();
    for (const o of otros) if (!esCduGruesa(o.cdu)) candidatas.push({ cdu: o.cdu, fuente: 'hermano', via: `otro ejemplar del mismo título y autor (${o._id})` });
  }
  const r = mejorCandidata(doc, candidatas);
  if (r) return r;

  // La CDU dominante de su colección: 3+ libros finos y el 70 %+ de ellos con la misma (con el 60 %, «Richard
  // Dawkins» —3 de 5— pasaba).
  if (doc.coleccion && typeof doc.coleccion === 'object') {
    const cuentas = await col.aggregate([
      { $match: { coleccion: doc.coleccion, _id: { $ne: doc._id } } },
      { $group: { _id: '$cdu', n: { $sum: 1 } } },
    ]).toArray();
    const finos = cuentas.filter((c) => c._id && !esCduGruesa(c._id));
    const total = finos.reduce((s, c) => s + c.n, 0);
    const top = finos.sort((a, b) => b.n - a.n)[0];
    if (top && top.n >= 3 && top.n / total >= 0.7) {
      return mejorCandidata(doc, [{ cdu: top._id, fuente: 'coleccion', via: `CDU de ${top.n} de los ${total} libros de su colección` }]);
    }
  }
  return null;
}

// ─── Paso 3: el árbol inverso (UDC Summary) ───────────────────────────────────────────────────────────────────
let resumen = null;   // [{ codigo, es, en, nivel }] — se carga una vez por proceso
async function cargarResumen(db) {
  if (resumen) return resumen;
  const filas = await db.collection('udc_summary').find({}, { projection: { codigo: 1, 'es.titulo': 1, 'en.titulo': 1 } }).toArray();
  resumen = filas.map((f) => ({ codigo: String(f.codigo), es: f.es?.titulo || '', en: f.en?.titulo || '' }));
  return resumen;
}

/** Las subdivisiones OFICIALES (números puros) por debajo de una rama, de las menos a las más profundas. */
function subdivisiones(filas, rama, max = 90) {
  const r = principal(rama);
  const lista = filas
    .filter((f) => /^\d+(\.\d+)*$/.test(f.codigo) && f.codigo !== r && (r ? f.codigo.startsWith(r) : f.codigo.replace(/\./g, '').length <= 2))
    .sort((a, b) => a.codigo.replace(/\./g, '').length - b.codigo.replace(/\./g, '').length || a.codigo.localeCompare(b.codigo));
  return lista.slice(0, max).sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/** Los lugares (para 94 historia y 91 geografía): países y regiones principales. */
function lugares(filas) {
  return filas.filter((f) => /^\(\d{1,3}(\.\d)?\)$/.test(f.codigo));
}
const ramaDeLugar = (cdu) => ['94', '91'].includes(principal(cdu));

// Solo palabras GRAMATICALES: si se quitaran también las genéricas («teoría», «general»), el nombre de un código
// se quedaría en una palabra y casaría de más («Teoría general de la música» → «música» → 781.2 para un libro de
// blues; seco del 13-oct).
const VACIAS = new Set(('de del la las los el en y a con para por una uno unos unas sobre como entre sus su al lo que ' +
  'se o u e otros otras otro otra distintas distintos the of and in to for on with an a by from its as at or into ' +
  'than other others').split(' '));
const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Desde 3 letras: con 4, «Set theory» se quedaba en «theory» y «Law in general» en «general» (seco del NAS, 13-oct:
// 35 libros con «theory» en el título a «Teoría de conjuntos», 14 a «Derecho en general»).
const raices = (texto) => new Set(sinTildes(texto).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !VACIAS.has(w) && !/^\d+$/.test(w)).map((w) => w.slice(0, 6)));

// Un nombre de UNA sola palabra solo vale si la palabra es específica (no «Lenguas», «Cristiandad» —«christ» está
// también en Christmas, Christopher—, «Física» de un libro de «physical therapy»…) y está en el TÍTULO, no solo en
// las materias.
const GENERICAS = new Set(['theory', 'teoria', 'genera', 'langua', 'lengua', 'histor', 'scienc', 'cienci', 'method',
  'metodo', 'system', 'sistem', 'analys', 'analis', 'univer', 'intern', 'social', 'christ', 'cristi', 'politi',
  'econom', 'physic', 'fisica', 'mathem', 'matema', 'philos', 'filoso', 'religi', 'arte', 'art', 'music', 'musica',
  'litera', 'law', 'derech', 'educat', 'educac', 'techno', 'tecnol', 'medici', 'health', 'salud', 'biolog', 'chemis',
  'quimic', 'cultur', 'nature', 'natura', 'world', 'mundo', 'life', 'vida', 'human', 'humano', 'europe', 'europa',
  'church', 'iglesi', 'system', 'intern', 'relati', 'relaci', 'organi', 'manage', 'gestio', 'study', 'studie']);

/** Quita los paréntesis («Greek (Hellenic) literature» → «Greek literature») y se queda con la primera frase. */
const primeraFrase = (t) => raices(String(t || '').replace(/\([^)]*\)/g, ' ').split(/[.;]/)[0]);

function pasoArbol(filas, doc) {
  if (esCero(doc.cdu)) return null;   // con 000 el árbol entero es demasiado: que decida la IA
  const delLibro = raices([doc.titulo, doc.subtitulo, ...(Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [])].join(' '));
  const delTitulo = raices([doc.titulo, doc.subtitulo].join(' '));
  if (!delLibro.size) return null;
  // Coincidir en palabras sueltas no basta (seco del 13-oct: «Sustainable DEVELOPMENT Goals» → 622.2 «Operaciones
  // mineras… desarrollo», «Neural ENGINEERING» → 004.41 «Ingeniería de software», «sociología» + «cultura» →
  // 316.7 para un libro sobre comida halal). Solo vale si el NOMBRE del código —su primera frase, en español o en
  // inglés— está ENTERO en el libro («Álgebra lineal», «Topología», «Perros»); puntúa por cuántas palabras tiene.
  // Todo el nombre en el libro (título o materias) Y al menos una palabra ESPECÍFICA suya en el TÍTULO: con dos
  // genéricas casaban «Religiones de Europa» con «The Politics of Secularism», «El sistema solar» con «Astronomy
  // for Beginners» (por sus materias), «Derecho en general» con «Lawyers' Ethics».
  const vale = (s) => {
    if (!s.size || ![...s].every((r) => delLibro.has(r))) return false;
    return [...s].some((r) => !GENERICAS.has(r) && delTitulo.has(r));
  };
  const puntuadas = [];
  for (const f of subdivisiones(filas, doc.cdu, 400)) {
    const nombres = [primeraFrase(f.es), primeraFrase(f.en)].filter(vale);
    if (!nombres.length) continue;
    const comunes = [...nombres.sort((a, b) => b.size - a.size)[0]];
    puntuadas.push({ ...f, n: comunes.length, comunes });
  }
  if (!puntuadas.length) return null;
  const max = Math.max(...puntuadas.map((p) => p.n));
  const top = puntuadas.filter((p) => p.n === max);
  // Varias empatadas: solo vale si están todas en UNA línea (una contiene a las demás) → la más profunda.
  const masHonda = top.sort((a, b) => b.codigo.length - a.codigo.length)[0];
  if (!top.every((p) => masHonda.codigo.startsWith(p.codigo))) return null;
  return mejorCandidata(doc, [{ cdu: masHonda.codigo, fuente: 'arbol', via: `UDC Summary «${masHonda.es || masHonda.en}» (casa: ${masHonda.comunes.join(', ')})` }]);
}

// ─── Paso 4: IA con menú cerrado ──────────────────────────────────────────────────────────────────────────────
async function nombresAutores(db, doc) {
  if (!Array.isArray(doc.autores) || !doc.autores.length) return [];
  if (typeof doc.autores[0] === 'string') return doc.autores;
  const filas = await db.collection('autores').find({ _id: { $in: doc.autores } }, { projection: { nombre: 1 } }).toArray();
  return filas.map((a) => a.nombre).filter(Boolean);
}

function promptIA(libros, menu, porLugar) {
  const lineas = menu.map((m) => `${m.codigo} — ${m.es || m.en}${m.en && m.es ? ` (${m.en})` : ''}`).join('\n');
  const fichas = libros.map((l, i) => {
    const partes = [`${i + 1}. «${l.doc.titulo}»${l.doc.subtitulo ? ` — ${l.doc.subtitulo}` : ''}`];
    if (l.autores.length) partes.push(`autor: ${l.autores.slice(0, 3).join('; ')}`);
    if (l.doc.dewey) partes.push(`Dewey ${l.doc.dewey}`);
    if (l.doc.lcc) partes.push(`LCC ${l.doc.lcc}`);
    if (Array.isArray(l.doc.palabras_clave) && l.doc.palabras_clave.length) partes.push(`materias: ${l.doc.palabras_clave.slice(0, 8).join(', ')}`);
    if (l.doc.sinopsis) partes.push(`sinopsis: ${String(l.doc.sinopsis).replace(/\s+/g, ' ').slice(0, 350)}`);
    partes.push(`CDU actual: ${l.doc.cdu || '000'}`);
    return partes.join(' · ');
  }).join('\n');
  return `Eres un bibliotecario experto en la Clasificación Decimal Universal (CDU). Para cada libro, elige de la LISTA
OFICIAL de abajo el código ${porLugar ? 'de LUGAR del que trata (país o región; el libro es de historia o geografía)' : 'MÁS CONCRETO que corresponda a la materia de TODO el libro'}.
Reglas: solo códigos de la lista, copiados tal cual; si ninguno encaja con seguridad, "codigo": null. La confianza es
"alta" si no hay duda, "media" si es lo más probable, "baja" si es una conjetura.

LISTA OFICIAL:
${lineas}

LIBROS:
${fichas}

Responde ÚNICAMENTE con JSON: {"r":[{"n":<número del libro>,"codigo":"<código de la lista o null>","confianza":"alta|media|baja"}]}`;
}

/**
 * Pasa a la IA los libros de UNA rama, en tandas de `porLlamada`. Devuelve Map _id → { cdu, fuente:'ia', via }.
 * Si la IA no está disponible (la política del trabajo, o todas saturadas), lanza: quien llama decide.
 */
async function pasoIA(db, libros, { porLlamada = 8 } = {}) {
  const filas = await cargarResumen(db);
  const resultado = new Map();
  const porRama = new Map();
  for (const l of libros) {
    const rama = esCero(l.doc.cdu) ? '' : principal(l.doc.cdu);
    if (!porRama.has(rama)) porRama.set(rama, []);
    porRama.get(rama).push(l);
  }
  for (const [rama, grupo] of porRama) {
    const porLugar = ramaDeLugar(rama);
    const menu = porLugar ? lugares(filas) : subdivisiones(filas, rama, 90);
    if (!menu.length) continue;
    const validos = new Set(menu.map((m) => m.codigo));
    for (let i = 0; i < grupo.length; i += porLlamada) {
      const tanda = grupo.slice(i, i + porLlamada);
      for (const l of tanda) l.autores = await nombresAutores(db, l.doc);
      const txt = await conTexto({ prompt: promptIA(tanda, menu, porLugar), json: true, maxTokens: 2000 });
      const j = extraerJSON(txt);
      for (const v of (Array.isArray(j) ? j : j?.r || [])) {
        const l = tanda[Number(v.n) - 1];
        const codigo = String(v.codigo ?? '').trim();
        if (!l || !validos.has(codigo) || !['alta', 'media'].includes(String(v.confianza))) continue;
        const nueva = porLugar ? `${rama}${codigo}` : codigo;
        const cdu = componerRefinada(l.doc.cdu, nueva);
        const m = menu.find((x) => x.codigo === codigo);
        if (cdu) resultado.set(String(l.doc._id), { cdu, fuente: 'ia', via: `IA con menú oficial: «${m?.es || m?.en}» (confianza ${v.confianza})` });
      }
    }
  }
  return resultado;
}

// ─── Lote ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Decide la CDU refinada de un lote de libros. No escribe nada.
 * @param opts.conIA      usar el paso 4 (la política de IA del contexto decide cuál)
 * @param opts.enLinea    consultar la BNE en línea en el paso 1
 * @param opts.hermanos   paso 2 (requiere los documentos ya guardados: autores/colección como ObjectId)
 * @param opts.onPaso     (i, total, titulo) para el progreso
 * @returns {Promise<{decisiones: Array<{doc, cdu, fuente, via}>, sinResolver: Array<doc>, iaNoDisponible: boolean, errorIA: string|null}>}
 */
export async function decidirLote(db, docs, { conIA = true, enLinea = true, hermanos = true, onPaso = null } = {}) {
  const filas = await cargarResumen(db);
  const decisiones = [];
  const pendientes = [];
  let i = 0;
  for (const doc of docs) {
    onPaso?.(++i, docs.length, doc.titulo);
    // Pasos 1-3 encadenados: cada uno parte de lo que haya refinado el anterior (51 → 512 por tabla → 512.64 por árbol).
    let actual = { ...doc };
    const vias = [];
    let fuente = null;
    for (const paso of [() => pasoAutoridad(actual, { enLinea }), () => (hermanos ? pasoHermanos(db, actual) : null), () => pasoArbol(filas, actual)]) {
      const r = await paso();
      if (r) {
        actual = { ...actual, cdu: r.cdu };
        vias.push(r.via);
        if (!fuente || r.fuente === 'bne') fuente = r.fuente;
      }
    }
    if (actual.cdu !== doc.cdu) decisiones.push({ doc, cdu: actual.cdu, fuente, via: vias.join(' → ') });
    if (esCduGruesa(actual.cdu)) pendientes.push({ doc: actual, original: doc, vias, fuente });
  }

  // Paso 4: hasta tres vueltas (000 → 5 → 51 → 512), cada una con la rama que dejó la anterior.
  let iaNoDisponible = false;
  let errorIA = null;
  let ronda = pendientes;
  if (conIA) {
    for (let vuelta = 0; vuelta < 3 && ronda.length; vuelta++) {
      let res;
      try {
        res = await pasoIA(db, ronda.map((p) => ({ doc: p.doc })));
      } catch (e) {
        iaNoDisponible = true;
        errorIA = e.message;
        break;
      }
      const siguiente = [];
      for (const p of ronda) {
        const r = res.get(String(p.doc._id));
        if (!r) continue;
        p.doc = { ...p.doc, cdu: r.cdu };
        p.vias.push(r.via);
        p.fuente = p.fuente || 'ia';
        const previa = decisiones.findIndex((d) => d.doc._id === p.original._id);
        const decision = { doc: p.original, cdu: r.cdu, fuente: p.fuente, via: p.vias.join(' → ') };
        if (previa >= 0) decisiones[previa] = decision; else decisiones.push(decision);
        if (esCduGruesa(r.cdu)) siguiente.push(p);
      }
      ronda = siguiente;
    }
  }
  const resueltos = new Set(decisiones.filter((d) => !esCduGruesa(d.cdu)).map((d) => String(d.doc._id)));
  const sinResolver = docs.filter((d) => !resueltos.has(String(d._id)));
  return { decisiones, sinResolver, iaNoDisponible, errorIA };
}

/**
 * Aplica una decisión a un libro ya catalogado: cambia la CDU y MUEVE su carpeta (reubicarPorCdu: copia
 * verificada; colisiones a una carpeta propia). Nunca toca una CDU manual. Conserva el rango, salvo que quien
 * refina sea la BNE (entonces sube a «bne»). Deja la alerta con la vía.
 */
export async function aplicarRefinamiento(db, doc, decision) {
  if (doc.cdu_manual) return { aplicado: false, motivo: 'CDU manual' };
  const col = db.collection('biblioteca');
  const reub = await reubicarPorCdu(doc, decision.cdu);
  const set = { ...(reub?.set || { cdu: decision.cdu }) };
  if (decision.fuente === 'bne' && rangoFuente(doc.cdu_fuente) < RANGO_CDU.bne) set.cdu_fuente = 'bne';
  await aplicarCambio(col, doc, carpetaDeDoc({ ...doc, ...set }), {
    set,
    alertas: [`CDU refinada: «${doc.cdu || '000'}» → «${decision.cdu}» (${decision.via}).`, ...(reub?.alertas || [])],
  });
  return { aplicado: true, movida: !!(set.ruta_base && set.ruta_base !== doc.ruta_base) };
}
