/**
 * REVISIÓN DE LAS DESCRIPCIONES DEL DEWEY contra sus referencias oficiales (13-oct).
 *
 * Hasta el 13-oct la IA describía un número Dewey con el número A SECAS, sin referencias: «181.5 = Filosofía japonesa»
 * (181 es filosofía oriental; Japón es 181.12). Ahora hay referencias (scripts/importar-referencias-clasificacion.js):
 * la sección, la división y la clase de los DDC 23 Summaries (© OCLC: solo como referencia interna) y la CDU que da
 * la tabla determinista. Este motor se las pone delante a la IA, que JUZGA por tandas de 25 si cada título guardado
 * es coherente; las incoherentes se REHACEN con esas mismas referencias (la vieja se copia en
 * clasificacion_descripciones_retiradas).
 *
 * El veredicto se guarda en la propia descripción (`juicio: {coherente, motivo, fecha}`), así el trabajo es
 * reanudable y escalonable: lo usan la campaña de fondo «revisar-dewey» (mantenimiento/campanas.js, por tandas, SOLO
 * con IA gratuita) y el script scripts/revisar-descripciones-dewey.js.
 *
 * Una descripción está POR JUZGAR si es de IA, no verificada, no rehecha (`revisada`) y sin `juicio`; está POR
 * REHACER si su juicio es incoherente y aún no se rehízo (al rehacerse lleva `revisada` y sale de las dos colas).
 */
import { conTexto, extraerJSON } from './vision.js';
import { referenciasOficialesClasificacion, regenerarDescripcionClasificacion } from './descripcion-clasificacion.js';

export const TANDA_JUEZ = 25;

const BASE = { sistema: 'dewey', fuente: 'ia', verificado: { $ne: true }, revisada: { $exists: false } };
export const FILTRO_DEWEY_POR_JUZGAR = { ...BASE, juicio: { $exists: false } };
// Una que falla al rehacerse 3 veces (respuesta incompleta de la IA…) deja de reintentarse sola: el ↻ de la ficha.
export const MAX_INTENTOS_REHACER = 3;
export const FILTRO_DEWEY_POR_REHACER = { ...BASE, 'juicio.coherente': false, 'juicio.intentos': { $not: { $gte: MAX_INTENTOS_REHACER } } };

/** Nº de descripciones Dewey que aún necesitan trabajo (juzgar o rehacer). */
export async function contarDeweyPendientes(db) {
  const col = db.collection('clasificacion_descripciones');
  const [juzgar, rehacer] = await Promise.all([col.countDocuments(FILTRO_DEWEY_POR_JUZGAR), col.countDocuments(FILTRO_DEWEY_POR_REHACER)]);
  return { juzgar, rehacer, total: juzgar + rehacer };
}

// Libros por código Dewey, para empezar por los que más se ven. Recorre la biblioteca entera, así que se guarda
// una hora en memoria (la campaña corre cada pocos minutos).
let librosCache = null;
let librosFecha = 0;
export async function librosPorDewey(db) {
  if (librosCache && Date.now() - librosFecha < 3600_000) return librosCache;
  const m = new Map();
  const grupos = await db.collection('biblioteca').aggregate([
    { $match: { dewey: { $exists: true, $nin: [null, ''] } } },
    { $group: { _id: '$dewey', n: { $sum: 1 } } },
  ]).toArray();
  for (const x of grupos) m.set(String(x._id).trim(), x.n);
  librosCache = m;
  librosFecha = Date.now();
  return m;
}

/** Las descripciones por juzgar, empezando por los códigos con más libros. */
export async function descripcionesPorJuzgar(db, limite = Infinity) {
  const libros = await librosPorDewey(db);
  const descs = await db.collection('clasificacion_descripciones')
    .find(FILTRO_DEWEY_POR_JUZGAR, { projection: { codigo: 1, titulo_es: 1 } }).toArray();
  return descs.sort((a, b) => (libros.get(b.codigo) || 0) - (libros.get(a.codigo) || 0)).slice(0, limite);
}

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

/**
 * Juzga UNA tanda (≤ 25) con la IA. Devuelve Map codigo → {coherente, motivo} con los veredictos legibles (puede
 * faltar alguno: se juzgará en otra pasada). Lanza si no hay IA disponible (p. ej. todas las gratis en 429).
 */
export async function juzgarTanda(db, descs, { soloGratis = true } = {}) {
  const tanda = [];
  for (const d of descs) {
    const refs = (await referenciasOficialesClasificacion(db, 'dewey', d.codigo)).map((r) => r.replace(/\s*\[.*\]$/, ''));
    tanda.push({ ...d, refs });
  }
  const txt = await conTexto({ prompt: promptJuez(tanda), json: true, maxTokens: 8000, soloGratis });
  const j = extraerJSON(txt);
  // Tolerante con la forma: algunos modelos devuelven la lista suelta o con otra clave, y «true» como texto.
  const lista = Array.isArray(j) ? j : (j?.veredictos || j?.verdicts || j?.resultados || []);
  const out = new Map();
  for (const v of lista) {
    // «n» debería ser la posición en la lista, pero hay modelos que ponen el propio número Dewey («510»): se acepta
    // primero por el código exacto y, si no, por la posición.
    const n = String(v.n ?? v.numero ?? v.id ?? '').trim();
    const d = tanda.find((x) => x.codigo === n) || tanda[parseInt(n, 10) - 1];
    const coherente = typeof v.coherente === 'boolean' ? v.coherente
      : v.coherente === 'true' ? true
        : v.coherente === 'false' ? false
          : null;
    if (d && coherente !== null) out.set(d.codigo, { coherente, motivo: String(v.motivo || '').slice(0, 200) });
  }
  return out;
}

/** Guarda el veredicto en la descripción (solo si sigue siendo la misma que se juzgó). */
export async function guardarJuicio(db, d, veredicto) {
  await db.collection('clasificacion_descripciones').updateOne(
    { sistema: 'dewey', codigo: d.codigo, titulo_es: d.titulo_es },
    { $set: { juicio: { ...veredicto, fecha: new Date() } } },
  );
}

/**
 * UNA tanda de trabajo, para la campaña de fondo: primero rehace las ya juzgadas incoherentes, luego juzga nuevas
 * (y rehace en el acto las incoherentes), hasta `limite` descripciones. SOLO IA gratuita por defecto: si las gratis
 * están saturadas, la tanda para sin error y lo que falte queda para la siguiente.
 * @returns {Promise<{procesados, cambios, pendientes, sinIA:boolean}>}
 */
export async function revisarTandaDewey(db, { limite = 50, soloGratis = true, onProgreso = null } = {}) {
  const col = db.collection('clasificacion_descripciones');
  let procesados = 0;
  let cambios = 0;
  let sinIA = false;
  const avisar = () => onProgreso && onProgreso(procesados, limite);

  const rehacer = async (d) => {
    try {
      await regenerarDescripcionClasificacion(db, 'dewey', d.codigo, { conIA: true, soloGratis });
      cambios++;
      return true;
    } catch (e) {
      // Sin IA gratuita disponible: se deja para otra tanda (el juicio se queda, se rehará entonces).
      if (/gratuit|gratis|429|cuota|proveedor/i.test(e.message)) sinIA = true;
      else await col.updateOne({ sistema: 'dewey', codigo: d.codigo }, { $inc: { 'juicio.intentos': 1 } });
      return false;
    }
  };

  // 1) Las que ya se juzgaron incoherentes y quedaron sin rehacer.
  const atrasadas = await col.find(FILTRO_DEWEY_POR_REHACER, { projection: { codigo: 1 } }).limit(limite).toArray();
  for (const d of atrasadas) {
    if (sinIA) break;
    await rehacer(d);
    procesados++;
    avisar();
  }

  // 2) Juzgar nuevas, por tandas de 25.
  while (!sinIA && procesados < limite) {
    const descs = await descripcionesPorJuzgar(db, Math.min(TANDA_JUEZ, limite - procesados));
    if (!descs.length) break;
    let veredictos;
    try {
      veredictos = await juzgarTanda(db, descs, { soloGratis });
    } catch {
      sinIA = true;
      break;
    }
    if (!veredictos.size) break;   // respuesta ilegible: no insistir en esta tanda
    for (const d of descs) {
      const v = veredictos.get(d.codigo);
      if (!v) continue;
      await guardarJuicio(db, d, v);
      if (!v.coherente && !sinIA) await rehacer(d);
      procesados++;
      avisar();
    }
  }

  const { total } = await contarDeweyPendientes(db);
  return { procesados, cambios, pendientes: total, sinIA };
}
