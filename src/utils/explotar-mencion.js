/**
 * EXPLOTAR UNA MENCIÓN DE RESPONSABILIDAD que llegó como si fuera UN autor: «edited by Christopher Fox, Roy Porter,
 * and Robert Wokler», «Clayton Donnell • Illustrated by H Johnson, L Ray», «Langton, Nancy, Robbins, Stephen, Judge,
 * Timothy», «K. Lee Lerner and Brenda Wilmoth Lerner, editors», «Gary B. Nash, general editor. - Rev. ed»… → las
 * PERSONAS con su ROL (autor, editor, ilustrador, prologuista, traductor). 7-oct: de los 102 autores «[?]_» que
 * quedaban, la mayoría eran esto, no basura.
 *
 * Conservador: «Apellido, Nombre» (una sola coma, sin conjunción) es UNA persona; y si algún trozo no parece un
 * nombre (un cargo, una frase, una institución), la mención entera se da por NO fiable y no se toca (`fiable:false`).
 *
 * Consumidores: autor-normalizar · depurarAutores (ingesta) y scripts/explotar-autores-mencion.js (lo ya catalogado).
 * @returns {{ personas: Array<{nombre:string, rol:string}>, fiable: boolean, motivo?: string }}
 */

// Marcadores que INTRODUCEN un rol para los nombres que siguen.
const MARCAS_ROL = [
  [/\b(?:illustrated|illustrations|ilustrado|ilustraciones)\s+(?:by|por|de)\b:?/i, 'ilustrador'],
  [/\b(?:foreword|preface|introduction|pr[oó]logo)\s+(?:by|por|de)\b:?/i, 'prologuista'],
  [/\b(?:translated|traducci[oó]n|traducido)\s+(?:by|por|de)\b:?/i, 'traductor'],
  [/\b(?:edited|ed\.|compiled|edici[oó]n)\s+(?:by|por|de)\b:?/i, 'editor'],
  [/^\s*(?:editors?|editores?|eds?\.)\s*:/i, 'editor'],
];
// Marcadores de rol al FINAL de un tramo («…, editors», «(eds.)», «, general editor»).
const RE_ROL_FINAL = /[,\s]*\(?\b(?:general\s+editor|editors?|eds?\.?|editores?|coord(?:inador)?e?s?\.?)\)?\.?\s*$/i;
// Ruido que se quita: «p. cm», «Rev. ed», tratamientos y grados, paréntesis (afiliaciones, nombres desarrollados).
const RUIDO = [
  /\s*[-–—]?\s*\bRev\.?\s*ed\.?\b/gi,
  /\bp\.\s*cm\.?/gi,
  /\b(?:Professor|Prof\.?|Dr\.?|Ph\.?\s?D\.?|M\.?D\.?)(?=\s|,|$)/g,
  /\([^()]*\)/g,
];
// Lo que nunca está en un nombre de persona (cargos, instituciones, prosa).
const RE_NO_NOMBRE = /\b(?:university|universidad|college|department|institute|instituto|center|centre|school|professor|chair|director|scientist|foundation|colloquia|conference|series|press|editorial|published|reprinted|reading|moved|following|years|is|who|his|her|for|about|from|of\s+the|associate)\b|\d|\b[IVX]{2,}\.\s+\S/i;
// Sufijos que van con el nombre anterior, no son otra persona («Thomas A. Brady, Jr»).
const RE_SUFIJO = /^(?:Jr|Sr|Jnr|Snr|II|III|IV)\.?$/i;
// Conjunciones que separan personas en una lista.
// «y» solo separa personas si a los dos lados hay 2+ palabras: «Liñán y Verdugo, Antonio», «Ortega y Gasset» son
// apellidos; «Juan Pérez y María López», dos personas.
const RE_CONJ = /\s*,\s*(?:and|&)\s+|\s+(?:and|&|with)\s+|\s*&\s*|(?<=\S+\s\S+)\s+y\s+(?=\S+\s\S+)/i;

const tokens = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const esInicial = (w) => /^\p{Lu}\.?$/u.test(w) || /^(?:\p{Lu}\.){1,3}$/u.test(w);

/** «PATRIZIA CASTIGLIONE» → «Patrizia Castiglione» (solo si va todo en mayúsculas). */
function capitalizar(nombre) {
  if (/\p{Ll}/u.test(nombre)) return nombre;
  return nombre.toLowerCase().replace(/(^|[\s'.-])(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
}

// Partículas que SÍ van en minúscula dentro de un nombre («Heinrich von Kleist», «Manuel Rivero de la Calle»).
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'du', 'des', 'le', 'van', 'von', 'der', 'den', 'ter', 'ten', 'y', 'e', 'i', 'bin', 'ibn', 'al', 'el', 'zu', 'af', 'av']);
// Palabras de institución o de título de libro: un nombre de persona no las lleva (7-oct: «Aeronautics and Space
// Engineering Board», «AGI Creative Team» se partían como si fueran personas).
const RE_INSTITUCION = /\b(?:board|team|committee|council|society|association|academy|group|staff|office|bureau|agency|ministry|commission|company|corporation|inc|ltd|llc|editorial|library|museum|companion|guide|history|approach|introduction|handbook|american|scientific|magazine|journal|review|news|media|publishing|studio|project|muse|architect|terms|data)\b/i;
// Palabras de título con mayúscula inicial («Enterprise Architect And Rational Rose»): en un nombre no salen.
const RE_PALABRA_TITULO = /\b(?:And|The|Of|For|To|In|On|With)\b/;

/**
 * ¿Parece el nombre de una persona? 1-6 palabras, la primera en mayúscula, nada de cargos, instituciones ni prosa,
 * y en minúscula solo las partículas. Un nombre de UNA palabra solo vale si `suelto` (dentro de una lista: «Novalis»).
 */
function pareceNombre(n, { suelto = false } = {}) {
  const t = tokens(n);
  if (!t.length || t.length > 6) return false;
  if (t.length === 1 && !suelto) return false;
  if (RE_NO_NOMBRE.test(n) || RE_INSTITUCION.test(n) || RE_PALABRA_TITULO.test(n)) return false;
  if (!/^\p{Lu}/u.test(n)) return false;
  if (t.some((w) => /^\p{Ll}/u.test(w) && !PARTICULAS.has(w.toLowerCase()))) return false;   // «to», «and», «of»…
  return t.some((w) => /\p{L}{2,}/u.test(w));   // al menos un trozo que no sea una inicial
}

/**
 * ¿Dos trozos separados por UNA coma son DOS personas («Stanley L. Engerman, Robert E. Gallman», «H Johnson, L Ray»)
 * y no «Apellido, Nombre» («Areán Álvarez, Luis Fernando», «Moore, Will H.», «Evans, J. A. S.»)? Sí si los dos
 * tienen forma de nombre completo: una inicial EN MEDIO («Stanley L. Engerman»), o empiezan por inicial y acaban en
 * apellido («H Johnson»), o los dos tienen 3+ palabras. Ante la duda («Hervé This, Pierre Gagnaire»), una.
 */
function dosPersonas(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  const inicialEnMedio = (t) => t.length >= 3 && t.slice(1, -1).some(esInicial) && !esInicial(t[t.length - 1]);
  const inicialYApellido = (t) => t.length === 2 && esInicial(t[0]) && !esInicial(t[1]);
  return (inicialEnMedio(ta) || inicialYApellido(ta)) && (inicialEnMedio(tb) || inicialYApellido(tb))
    || (ta.length >= 3 && tb.length >= 3);
}

// Sin la puntuación del final; el punto solo tras una palabra entera (no tras una inicial: «Tolkien, J. R. R.»).
const sinCola = (x) => String(x).trim().replace(/[,;]+$/, '').replace(/(\p{L}{2,})\.$/u, '$1').trim();

/** Los nombres de un tramo: lista con comas/conjunciones, «Apellido, Nombre» o pares invertidos. */
function nombresDeTramo(tramo, { esLista = false } = {}) {
  const conConjuncion = RE_CONJ.test(tramo);
  const partes = [];
  for (const p of tramo.split(RE_CONJ).flatMap((x) => x.split(',')).map(sinCola).filter(Boolean)) {
    if (RE_SUFIJO.test(p) && partes.length) partes[partes.length - 1] += `, ${p}`;   // «…Brady, Jr»
    else partes.push(p);
  }
  if (partes.length <= 1) return partes;
  // «Areán Álvarez, Luis Fernando», «Moore, Will H.»: una coma y sin conjunción → una persona (salvo que los dos
  // trozos sean nombres completos, o el tramo sea una lista por su rol: «edited by A, B»).
  if (!conConjuncion && partes.length === 2 && !esLista && !dosPersonas(partes[0], partes[1])) return [sinCola(tramo)];
  // «Langton, Nancy, Robbins, Stephen», «Rushworth, Alan., Daniels, Charles, Bishop, M. C.»: trozos de 1-2
  // palabras (apellido / nombre o iniciales), en número par → de dos en dos, como «Apellido, Nombre».
  const cortos = partes.every((p) => tokens(p).length <= 3);
  const algunoSuelto = partes.some((p) => tokens(p).length === 1 && !esInicial(p));
  if (cortos && algunoSuelto && partes.length % 2 === 0 && partes.length >= 2 && partes.filter((_, i) => i % 2 === 1).some((p) => tokens(p).length === 1 || esInicial(tokens(p)[0]))) {
    const pares = [];
    for (let i = 0; i < partes.length; i += 2) pares.push(`${partes[i]}, ${partes[i + 1]}`);
    return pares;
  }
  return partes;
}

export function explotarMencion(cadena) {
  let s = String(cadena || '').replace(/^\[\?\]_/, '').trim();
  if (!s) return { personas: [], fiable: false, motivo: 'vacía' };
  s = s.replace(/\s*\[and\]\s*/gi, ' and ');   // «P. M. Holt, Ann K. S. Lambton [and] Bernard Lewis»
  s = s.replace(/\s*\((?:edt|eds?\.?|editors?|coords?\.?)\)/gi, ', editors');   // «… (edt)» antes de quitar paréntesis
  s = s.replace(/\s+:\s+/g, ' and ');             // «Adams, Jody : Rivard, Ken»
  s = s.replace(/\b(\p{Lu})\s+\./gu, '$1.');      // «ANDREW J . MAJDA»
  for (const re of RUIDO) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Tramos por separadores fuertes («•», «·», « - » antes de un rol) y por los marcadores de rol.
  s = s.replace(/\s*[•·]\s*/g, ' | ').replace(/\s+[-–—]\s+(?=(?:illustrated|foreword|translated|edited)\b)/gi, ' | ');
  const tramos = [];
  let rolActual = 'autor';
  for (const bloque of s.split('|')) {
    let resto = bloque.trim();
    // Un bloque puede llevar varios marcadores («X, eds. foreword by Y»): se corta en cada uno.
    while (resto) {
      let primero = null;
      for (const [re, rol] of MARCAS_ROL) {
        const m = resto.match(re);
        if (m && (primero == null || m.index < primero.index)) primero = { index: m.index, largo: m[0].length, rol };
      }
      if (!primero) { tramos.push({ texto: resto, rol: rolActual }); break; }
      if (primero.index > 0) tramos.push({ texto: resto.slice(0, primero.index), rol: rolActual });
      rolActual = primero.rol;
      resto = resto.slice(primero.index + primero.largo).trim();
    }
    rolActual = 'autor';   // el rol de un marcador no pasa al bloque siguiente
  }

  const personas = [];
  for (const { texto, rol } of tramos) {
    let t = texto.trim().replace(/^[,;:.\s]+|[,;:\s]+$/g, '');
    let rolTramo = rol;
    // Solo un rol puesto DELANTE («edited by A, B») hace del tramo una lista; uno al final no («Gregory, Timothy E.
    // (Editor)» es una persona, «Apellido, Nombre»).
    const esLista = rol !== 'autor';
    if (RE_ROL_FINAL.test(t)) { rolTramo = 'editor'; t = t.replace(RE_ROL_FINAL, '').trim(); }
    t = t.replace(/^(?:by|por)\s+/i, '').trim();
    if (!t) continue;
    const nombres = nombresDeTramo(t, { esLista });
    // Una lista de palabras sueltas («Ivan, Peter, Jan», «Terms, Formulas, Data») no se sabe de quién habla.
    if (nombres.length >= 2 && nombres.every((n) => tokens(n).length === 1)) return { personas: [], fiable: false, motivo: 'solo palabras sueltas' };
    for (const n of nombres) {
      // Espacio tras una inicial pegada («Andrew E.Dessler» → «Andrew E. Dessler»).
      const nombre = capitalizar(n.replace(/\s+/g, ' ').trim()).replace(/\b(\p{Lu})\.(?=\p{Lu}\p{Ll})/gu, '$1. ');
      // Una palabra sola solo vale en una lista de 3+ («Ludwig Tieck, Novalis, Heinrich von Kleist»); en una de dos
      // es casi siempre un título partido («A Guide to Health and Nutrition» → «Nutrition»).
      if (!pareceNombre(nombre, { suelto: nombres.length >= 3 })) return { personas: [], fiable: false, motivo: `«${nombre}» no parece un nombre` };
      if (!personas.some((p) => p.nombre === nombre && p.rol === rolTramo)) personas.push({ nombre, rol: rolTramo });
    }
  }
  if (!personas.length) return { personas: [], fiable: false, motivo: 'sin nombres' };
  // Una sola palabra suelta («Russell», «Seif»: lo que quedó tras quitar el cargo) no basta para saber quién es.
  // Dentro de una lista sí vale («Ludwig Tieck, Novalis, Heinrich von Kleist…»).
  if (personas.length === 1 && tokens(personas[0].nombre).length < 2) return { personas: [], fiable: false, motivo: `«${personas[0].nombre}» solo` };
  return { personas, fiable: true };
}
