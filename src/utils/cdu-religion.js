/**
 * CDU DE RELIGIÓN (clase 2) EN NOTACIÓN ANTIGUA → NOTACIÓN ACTUAL (13-oct).
 *
 * La clase 2 es la única de la CDU que se rehízo entera (revisión de 2000). La antigua seguía al Dewey y era
 * cristiano-céntrica; la actual ordena por religiones:
 *
 *        antigua (y Dewey)                     actual (UDC Summary)
 *   21   teología natural                      religiones prehistóricas y primitivas
 *   22   Biblia                                religiones del Lejano Oriente
 *   23   teología dogmática                    hinduismo y religiones de la India
 *   24   teología práctica, devoción           budismo
 *   25   teología pastoral                     religiones de la Antigüedad
 *   26   la Iglesia cristiana                  judaísmo
 *   27   historia de la Iglesia                cristianismo
 *   28   iglesias y sectas cristianas          islam
 *   29   religiones no cristianas              movimientos espirituales modernos
 *
 * Los registros de la BNE, los CIP de libros viejos y los números Dewey copiados como CDU traen la antigua: un libro
 * con «282» (Iglesia católica) queda hoy bajo el islam, y uno con «297» (islam), entre los movimientos modernos.
 *
 * El mismo número vale en los dos esquemas, así que no se traduce a ciegas:
 *   · un número que NO existe en el esquema actual (220, 231, 248, 283, 289, todos los 29x…) se traduce;
 *   · uno que existe en los dos (26x, 28x, 241-244, 25x…) solo si el LIBRO dice de qué religión trata (Dewey, LCC,
 *     título, materias) y coincide con la lectura antigua; si coincide con la actual, se deja; si no se sabe, queda
 *     como DUDOSA para revisarla a mano;
 *   · 27x no se toca: en los dos esquemas cae dentro del cristianismo, así que al menos está en su religión.
 * Del número antiguo solo se conserva lo que la tabla sabe traducir; los auxiliares comunes (lugar, tiempo,
 * forma, lengua) se conservan tal cual. El antiguo queda en la alerta del documento: no se pierde.
 *
 * Lo usan scripts/modernizar-cdu-religion.js (lo ya guardado) y la ingesta (motor-catalogo, antes de insertar, y
 * prioridad-cdu·aplicarCduConPrioridad, cuando llega una CDU de la BNE a un libro ya catalogado).
 */

// ─── Tabla: número antiguo (solo dígitos, prefijo más largo gana) → número actual ───────────────────────────────
const ANTIGUA_A_ACTUAL = {
  // 21 teología natural → teoría y filosofía de la religión
  21: '2-1', 211: '2-14',
  // 22 Biblia → libros sagrados del cristianismo
  22: '27-23',
  // 23 teología dogmática → doctrina cristiana
  23: '27-1', 231: '27-14', 232: '27-31', 233: '27-18', 234: '27-18', 235: '27-36', 236: '27-18', 239: '27-2',
  // 24 teología práctica, devoción → prácticas religiosas cristianas
  24: '27-4', 241: '27-42',
  // 25 teología pastoral → pastoral cristiana; homilética y sermones → predicación
  25: '27-46', 251: '27-475', 252: '27-475',
  // 26 la Iglesia cristiana → organización, culto, sacramentos, misiones del cristianismo
  26: '27-7', 261: '27-72', 262: '27-7', 264: '27-5', 265: '27-55', 266: '27-76', 267: '27-78', 268: '27-47',
  // 28 iglesias y sectas cristianas → las denominaciones del 27 actual
  28: '27', 281: '271', 282: '272', 284: '274', 285: '275', 286: '274', 287: '274', 289: '279',
  // 29 religiones no cristianas → cada religión en su número actual
  29: '2', 292: '255', 293: '257', 294: '23', 2943: '24', 2944: '234', 2945: '233', 2946: '235',
  295: '254', 296: '26', 297: '28',
};

// Números de 3 cifras o más que SÍ existen en el esquema actual (UDC Summary): ahí hay ambigüedad.
const VALIDOS_ACTUALES = new Set([
  '212', '213', '221', '2213', '223', '225', '233', '234', '235', '241', '242', '243', '244',
  '251', '252', '254', '255', '257', '258', '261', '262', '264', '265', '266', '267',
  '271', '272', '273', '274', '275', '276', '277', '278', '279', '281', '282', '284', '285', '286',
]);

// De qué religión trata cada división en cada esquema.
const RELIGION_ACTUAL = { 21: 'primitiva', 22: 'oriente', 23: 'hinduismo', 24: 'budismo', 25: 'antigua', 26: 'judaismo', 27: 'cristianismo', 28: 'islam' };
function religionAntigua(digitos) {
  if (digitos.startsWith('2943')) return 'budismo';
  if (digitos.startsWith('2945')) return 'hinduismo';
  if (digitos.startsWith('296')) return 'judaismo';
  if (digitos.startsWith('297')) return 'islam';
  if (/^29[235]/.test(digitos)) return 'antigua';
  if (digitos.startsWith('294')) return 'hinduismo';
  if (digitos.startsWith('29') || digitos.startsWith('21')) return null;   // generales: no son de una religión
  return 'cristianismo';                                                     // 22-28 antiguos
}

// ─── De qué religión trata el libro ─────────────────────────────────────────────────────────────────────────────
const PALABRAS = {
  cristianismo: ['iglesia', 'cristian', ' cristo ', 'jesucristo', 'jesus', 'evangeli', 'catolic', 'papa ', 'papado', 'pontific', 'vatican',
    'apostol', 'misa ', 'liturgi', 'concilio', 'protestant', 'luter', 'calvin', 'jesuita', 'francisc', 'benedictin',
    'monast', 'convento', 'sacramento', 'biblia', 'biblic', 'testamento', 'testament', 'salmo', 'psalm', 'apocalipsis', 'evangelio', 'profetas', 'virgen maria',
    'eucarist', 'anglican', 'metodist', 'baptist', 'mormon', 'church', 'christian', ' christ ', 'jesus christ', 'catholic', 'gospel', 'bible', ' pope',
    'jesuit', 'eglise', 'chiesa', 'kirche', 'teologia cristiana', 'santa sede', 'obispo', 'diocesis', 'parroquia', 'inquisi', 'catedral', 'monje', 'monja',
    'fraile', 'clero', 'clerig', 'sacerdote', 'misioner', 'reliquia', 'cardenal', 'peregrin', 'camino de santiago'],
  judaismo: ['judaism', 'judio', 'judia', 'talmud', ' tora ', ' torah', 'cabala', 'kabbal', 'rabino', 'rabbi', 'sinagoga',
    'synagog', 'jewish', 'sefardi', 'asquenazi', 'hasid', 'midrash', 'mishna', 'israelita'],
  islam: ['islam', 'coran', 'quran', 'koran', 'musulman', 'mahoma', 'muhammad', 'mahomet', 'sufi', 'chii', 'shii', 'shiit',
    'sunni', 'suni ', 'mezquita', 'mosque', 'sharia', 'charia', 'imam', 'muslim', 'yihad', 'jihad', 'hadiz', 'hadith'],
  budismo: ['budis', 'buddh', 'bouddh', ' zen', 'dalai', 'mindfulness', 'eightfold', 'vipassana', 'bodhi', 'sangha', 'nirvana', 'sutra', 'dharma', 'theravada', 'mahayana', 'tibetan'],
  hinduismo: ['hindu', ' veda ', ' vedas', ' vedic', ' vedico', ' vedanta', 'upanishad', 'krishna', 'brahman', 'bhagavad', 'shiva', 'vishnu', 'jainis', 'sikh', ' sij '],
  oriente: [' tao', 'taois', 'confuci', 'shinto', 'sintoismo'],
  antigua: ['mitolog', 'mythol', 'egipcio', 'mesopotam', 'zoroastr', 'mitraism', 'druid', 'celta', 'nordic', 'vikingo',
    'azteca', 'olimpo', 'dioses griegos', 'greek gods'],
  primitiva: ['chaman', 'shaman', 'animism', 'totem', 'prehistor'],
};

const sinTildes = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function religionPorDewey(dewey) {
  const d = String(dewey || '').replace(/[^\d.]/g, '');
  if (!/^2\d\d/.test(d)) return null;
  if (d.startsWith('296')) return 'judaismo';
  if (d.startsWith('297')) return 'islam';
  if (d.startsWith('294.3')) return 'budismo';
  if (d.startsWith('294')) return 'hinduismo';
  if (/^299\.5[1-6]/.test(d)) return 'oriente';
  if (/^29[235]/.test(d)) return 'antigua';
  if (/^2[2-8]/.test(d)) return 'cristianismo';
  return null;
}

function religionPorLcc(lcc) {
  const m = String(lcc || '').toUpperCase().match(/^([A-Z]{1,3})\s*(\d+)?/);
  if (!m) return null;
  const [, clase, num] = m;
  const n = Number(num || 0);
  if (/^B[R-X]$/.test(clase)) return 'cristianismo';
  if (clase === 'BM') return 'judaismo';
  if (clase === 'BP' && n < 600) return 'islam';
  if (clase === 'BQ') return 'budismo';
  if (clase === 'BL') {
    if (n >= 1100 && n <= 1295) return 'hinduismo';
    if (n >= 1300 && n <= 1380) return 'hinduismo';   // jainismo
    if (n >= 1800 && n <= 2370) return 'oriente';     // China, Japón (taoísmo, sintoísmo)
    if (n >= 700 && n <= 980) return 'antigua';       // religiones antiguas, mitologías
  }
  return null;
}

/**
 * La religión de la que trata el libro, o null si no se sabe. Dewey y LCC mandan (los puso un bibliotecario); si no
 * hay, el título, el subtítulo y las materias, y solo si una religión gana claramente.
 * @returns {{religion:string, por:string}|null}
 */
export function religionDelDoc(doc = {}) {
  const porDewey = religionPorDewey(doc.dewey);
  if (porDewey) return { religion: porDewey, por: `Dewey ${doc.dewey}` };
  const porLcc = religionPorLcc(doc.lcc);
  if (porLcc) return { religion: porLcc, por: `LCC ${doc.lcc}` };
  // Sin tildes ni signos («Cristo,» → « cristo »): las palabras de la lista llevan espacios donde importa el límite.
  const crudo = sinTildes([doc.titulo, doc.subtitulo, ...(Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [])].join(' '));
  const texto = ` ${crudo.replace(/[^a-z0-9]+/g, ' ')} `;
  const cuenta = Object.entries(PALABRAS)
    .map(([religion, palabras]) => [religion, palabras.filter((p) => texto.includes(p)).length])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!cuenta.length) return null;
  if (cuenta.length > 1 && cuenta[1][1] === cuenta[0][1]) return null;   // empate: no se sabe
  return { religion: cuenta[0][0], por: 'título/materias' };
}

// ─── Traducción ─────────────────────────────────────────────────────────────────────────────────────────────────
function traducirNumero(digitos) {
  for (let largo = digitos.length; largo >= 2; largo--) {
    const destino = ANTIGUA_A_ACTUAL[digitos.slice(0, largo)];
    if (destino) return destino;
  }
  return null;
}

/** Facetas de una relación, partidas por los «:» fuera de paréntesis y comillas (como en cdu-moderna.js). */
function partirFacetas(cdu) {
  const facetas = [];
  let actual = '';
  let hondura = 0;
  let entreComillas = false;
  for (const c of cdu) {
    if (c === '"') entreComillas = !entreComillas;
    else if (c === '(' && !entreComillas) hondura++;
    else if (c === ')' && !entreComillas && hondura > 0) hondura--;
    if (c === ':' && hondura === 0 && !entreComillas) { facetas.push(actual); actual = ''; }
    else actual += c;
  }
  facetas.push(actual);
  return facetas;
}

/**
 * Decide UNA faceta: { faceta, cambio?, dudosa?, motivo }.
 *   cambio  → se tradujo (faceta nueva);
 *   dudosa  → parece antigua pero el libro no lo confirma (se deja como está); `traducida` es cómo quedaría si lo
 *             fuera (cduReligionModerna la usa cuando OTRA faceta de la misma CDU prueba que es del esquema antiguo);
 *   conflicto → no existe hoy, pero el libro trata justo de la religión de la lectura actual: no se toca nada.
 */
function decidirFaceta(faceta, religion) {
  const m = faceta.match(/^(\s*)(2\d\d(?:\.\d+)*)(.*)$/s);
  if (!m) return { faceta };
  const [, espacio, numero, restoCrudo] = m;
  const resto = restoCrudo.replace(/^\.(?!\d)/, '');   // «299.» → «299»: el punto suelto no es parte de nada
  const digitos = numero.replace(/\./g, '');
  if (digitos.startsWith('27')) return { faceta };                         // cristianismo en los dos esquemas
  const destino = traducirNumero(digitos);
  if (!destino) return { faceta };
  const antigua = religionAntigua(digitos);
  const actual = RELIGION_ACTUAL[digitos.slice(0, 2)] || null;
  const ambiguo = [...VALIDOS_ACTUALES].some((v) => digitos.startsWith(v));
  // Un auxiliar especial de la clase 2 actual («-14», «-5») tras un número que también vale hoy: es moderna.
  const conAuxiliarActual = /^-\d/.test(resto);
  const traducida = `${espacio}${destino}${resto}`;

  if (ambiguo) {
    if (conAuxiliarActual) return { faceta };
    if (religion && religion === actual) return { faceta };                                // el libro confirma la actual
    if (religion && antigua && religion === antigua) {
      return { faceta: traducida, cambio: true, motivo: `${numero} es notación antigua (${antigua}, confirmado)` };
    }
    return { faceta, traducida, dudosa: true, motivo: `${numero}: vale en los dos esquemas y el libro no dice de qué religión trata` };
  }
  // No existe en el esquema actual: es antigua. Salvo que el libro trate justo de la religión de la lectura actual.
  if (religion && religion === actual && religion !== antigua) {
    return { faceta, conflicto: true, dudosa: true, motivo: `${numero} no existe hoy, pero el libro trata de ${religion} (la lectura actual del ${digitos.slice(0, 2)})` };
  }
  return { faceta: traducida, cambio: true, motivo: `${numero} es notación antigua` };
}

/**
 * La CDU con la clase 2 en notación actual, decidida con el contexto del libro (dewey, lcc, titulo, subtitulo,
 * palabras_clave). Devuelve { cdu, cambio:boolean, dudosa:boolean, motivos:[], religion }.
 */
export function cduReligionModerna(cdu, doc = {}) {
  const sin = { cdu, cambio: false, dudosa: false, motivos: [], religion: null };
  if (typeof cdu !== 'string' || !/(^|:)\s*2\d\d/.test(cdu)) return sin;
  const r = religionDelDoc(doc);
  const religion = r?.religion || null;
  const decisiones = partirFacetas(cdu).map((f) => decidirFaceta(f, religion));
  const sufijo = r ? ` · religión del libro: ${religion} (${r.por})` : '';
  const motivos = decisiones.filter((d) => d.motivo).map((d) => d.motivo + sufijo);
  const hayAntigua = decisiones.some((d) => d.cambio);
  const hayDudosa = decisiones.some((d) => d.dudosa);
  // Una CDU la escribe UN catalogador en UN esquema: si una faceta es antigua sin duda, las dudosas de esa misma CDU
  // también lo son («225:296» → «27-23:26», no «225:26»). Salvo un conflicto (el libro trata de la religión de la
  // lectura actual): entonces no se toca nada y queda para revisar a mano. Nunca se deja una CDU a medio traducir.
  if (!hayAntigua || decisiones.some((d) => d.conflicto)) {
    return { cdu, cambio: false, dudosa: hayDudosa, motivos, religion };
  }
  if (hayDudosa) motivos.push('las facetas dudosas se traducen también: otra faceta de la misma CDU es antigua sin duda');
  const nueva = decisiones.map((d) => (d.dudosa ? d.traducida : d.faceta)).join(':');
  return { cdu: nueva, cambio: true, dudosa: false, motivos, religion };
}
