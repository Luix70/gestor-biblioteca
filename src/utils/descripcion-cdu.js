import { conTexto, extraerJSON } from './vision.js';
import { sanitizarCDU, arbolCDU } from './cdu-arbol.js';

/**
 * Tabla de descripciones de códigos CDU (colección 'cdu_descripciones'), bilingüe ES/EN.
 * Clave: el código CDU limpio (sanitizarCDU → sin literales ni mojibake, con auxiliares).
 * El front-end une libro.cdu → sanitizarCDU → cdu_descripciones para mostrar la materia.
 */

// REFERENCIAS FIJAS para que la IA no invente (8-oct: «94(430).085» salió como «Geología de la Antártida: la clase 94
// (Geografía) y (430), que indica la Antártida» — 94 es HISTORIA y (430) es ALEMANIA; de 1.537 descripciones de la
// clase 94, 136 no hablaban de historia: la IA confunde 94 con 91 y se inventa los auxiliares de lugar). Se le dan
// el significado de la clase/división y de los lugares que aparecen, y la descripción ya guardada de su padre.
const CLASES = {
    0: 'Generalidades. Ciencia y conocimiento. Información. Documentación. Bibliotecas',
    1: 'Filosofía. Psicología', 2: 'Religión. Teología', 3: 'Ciencias sociales', 5: 'Matemáticas. Ciencias naturales',
    6: 'Ciencias aplicadas. Medicina. Tecnología', 7: 'Arte. Recreación. Entretenimiento. Deporte',
    8: 'Lengua. Lingüística. Literatura', 9: 'Geografía. Biografía. Historia',
};
const DIVISIONES = {
    '91': 'Geografía. Exploración de la Tierra y de los países. Viajes',
    '92': 'Biografía (hoy 929)', '929': 'Estudios biográficos y afines: biografía, genealogía, heráldica',
    '93': 'Ciencia de la historia. Disciplinas auxiliares', '94': 'HISTORIA general (de un lugar y/o época; NO es geografía)',
};
const LUGARES = {
    '(1)': 'lugar en general', '(100)': 'todo el mundo / universal', '(3)': 'mundo antiguo', '(32)': 'antiguo Egipto',
    '(33)': 'antigua Palestina / judíos', '(35)': 'Mesopotamia antigua', '(37)': 'Roma antigua / Italia antigua',
    '(38)': 'antigua Grecia', '(4)': 'Europa', '(410)': 'Reino Unido', '(415)': 'Irlanda', '(430)': 'Alemania',
    '(436)': 'Austria', '(437)': 'Chequia / Checoslovaquia', '(438)': 'Polonia', '(439)': 'Hungría', '(44)': 'Francia',
    '(450)': 'Italia', '(460)': 'España', '(469)': 'Portugal', '(470)': 'Rusia', '(477)': 'Ucrania', '(480)': 'Finlandia',
    '(481)': 'Noruega', '(485)': 'Suecia', '(489)': 'Dinamarca', '(492)': 'Países Bajos', '(493)': 'Bélgica', '(494)': 'Suiza',
    '(495)': 'Grecia', '(497)': 'Balcanes', '(498)': 'Rumanía', '(5)': 'Asia', '(510)': 'China', '(520)': 'Japón',
    '(540)': 'India', '(560)': 'Turquía', '(6)': 'África', '(62)': 'Egipto', '(7)': 'América del Norte y Central',
    '(71)': 'Canadá', '(72)': 'México', '(73)': 'Estados Unidos', '(8)': 'América del Sur', '(81)': 'Brasil',
    '(82)': 'Argentina', '(83)': 'Chile', '(9)': 'Oceanía y regiones polares', '(94)': 'Australia', '(98)': 'Ártico',
    '(99)': 'Antártida', '(=1:4)': 'pueblos europeos', '(=411.16)': 'judíos',
};

// Los AUXILIARES DE TIEMPO, descifrados (13-oct: con «1"04/14"» la IA leyó «/14» como la división 14 y se inventó un
// lugar). En la CDU, entre comillas: 4 cifras = un año ("1939"); 2 cifras = un siglo ("19" = s. XX, "04" = s. V);
// 1 cifra = un milenio ("1" = segundo milenio); «a/b» = de a hasta b.
const ROMANOS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX', 'XXI', 'XXII'];
function tiempoLegible(parte) {
    const p = String(parte).trim();
    if (/^\d{4}$/.test(p)) return `el año ${Number(p)}`;
    if (/^\d{2}$/.test(p)) return `el siglo ${ROMANOS[Number(p) + 1] || Number(p) + 1}`;
    if (/^\d$/.test(p)) return `el ${['primer', 'segundo', 'tercer'][Number(p)] || `${Number(p) + 1}.º`} milenio d. C.`;
    return null;
}
export function auxiliaresDeTiempo(codigo) {
    const lineas = [];
    for (const [, dentro] of String(codigo).matchAll(/"([^"]*)"?/g)) {
        const partes = dentro.split('/');
        // Un final ABREVIADO hereda las cifras de delante del principio: «1920/30» = 1920-1930 (no «el siglo XXXI»).
        if (partes.length === 2 && partes[0].length > partes[1].length && /^\d+$/.test(partes[0] + partes[1])) {
            partes[1] = partes[0].slice(0, partes[0].length - partes[1].length) + partes[1];
        }
        const legibles = partes.map(tiempoLegible);
        if (legibles.some((x) => !x)) continue;
        lineas.push(`"${dentro}" = auxiliar de TIEMPO (no es un lugar ni otra clase): ${legibles.length === 2 ? `desde ${legibles[0]} hasta ${legibles[1]}` : legibles[0]}`);
    }
    return lineas;
}

/**
 * ¿Dice el texto un SIGLO que no es el de los auxiliares de tiempo del código? El error típico de la IA: leer «"19"»
 * como «siglo XIX» cuando es el XX (los años 1900). Medido el 14-oct: 366 descripciones así («821.111(73)-31"19"» =
 * «Novelas estadounidenses en inglés del siglo XIX»). Solo con la NOTACIÓN real (con comillas): en la clave saneada
 * («…-31_19») el «19» ya no se distingue de otras cosas. Devuelve el siglo mal dicho o null.
 */
const NUM_ROMANO = new Map(ROMANOS.map((r, i) => [r, i]));
export function sigloIncoherente(notacion, texto) {
    const validos = new Set();
    for (const [, dentro] of String(notacion || '').matchAll(/"([^"]*)"?/g)) {
        const partes = dentro.split('/');
        if (partes.length === 2 && partes[0].length > partes[1].length && /^\d+$/.test(partes[0] + partes[1])) {
            partes[1] = partes[0].slice(0, partes[0].length - partes[1].length) + partes[1];
        }
        const siglos = partes.map((p) => (/^\d{2}$/.test(p) ? Number(p) + 1 : /^\d{4}$/.test(p) ? Math.floor(Number(p) / 100) + 1 : null));
        if (siglos.some((s) => s === null)) continue;
        // Un periodo («"04/14"») vale entero: del siglo V al XV.
        for (let s = Math.min(...siglos); s <= Math.max(...siglos); s++) validos.add(s);
    }
    if (!validos.size) return null;
    for (const [, r] of String(texto || '').matchAll(/siglos?\s+([IVXL]+)\b/gi)) {
        const s = NUM_ROMANO.get(r.toUpperCase());
        if (s && !validos.has(s)) return `siglo ${r.toUpperCase()}`;
    }
    return null;
}

/** Las referencias fijas que tocan a este código: su clase, su división, los lugares y los tiempos que lleva. */
function referenciasDe(codigo) {
    const lineas = [...auxiliaresDeTiempo(codigo)];
    const c = String(codigo);
    if (CLASES[c[0]]) lineas.push(`clase ${c[0]} = ${CLASES[c[0]]}`);
    for (const d of ['929', '91', '92', '93', '94']) if (c.startsWith(d)) { lineas.push(`${d} = ${DIVISIONES[d]}`); break; }
    for (const [aux, nombre] of Object.entries(LUGARES)) if (c.includes(aux)) lineas.push(`${aux} = ${nombre}`);
    return lineas;
}

/**
 * Los significados OFICIALES (UDC Summary, colección `udc_summary`, ver scripts/importar-udc-summary.js) de las piezas
 * de este código: su número principal y sus antecesores (94 → 9), y los auxiliares de lugar y lengua que lleve
 * («(430)», «(43)», «(4)», «=111»). Son la referencia más fiable que se le puede dar a la IA. Vacío si no se importó.
 */
export async function referenciasOficiales(db, codigo) {
    const candidatos = new Set();
    const conPrefijos = (s, minimo) => {
        let x = s;
        while (x.length >= minimo) {
            candidatos.add(x);
            x = x.slice(0, -1).replace(/\.$/, '');
        }
    };
    // Cada faceta («94(430).085_008»: el «_» es el «:» saneado) aporta su número principal.
    for (const faceta of String(codigo).split(/[_:+/]/)) {
        const num = (faceta.match(/^\d[\d.]*/) || [])[0];
        if (num) conPrefijos(num.replace(/\.$/, ''), 1);
    }
    // Lugares «(430)» → «(43)», «(4)»; lenguas «=111» → «=11», «=1».
    for (const [, lugar] of String(codigo).matchAll(/\((\d[\d.]*)\)/g)) {
        for (let x = lugar; x.length >= 1; x = x.slice(0, -1).replace(/\.$/, '')) candidatos.add(`(${x})`);
    }
    for (const [, lengua] of String(codigo).matchAll(/=(\d[\d.]*)/g)) {
        for (let x = lengua; x.length >= 1; x = x.slice(0, -1).replace(/\.$/, '')) candidatos.add(`=${x}`);
    }
    candidatos.delete(String(codigo));
    if (!candidatos.size) return [];
    const filas = await db.collection('udc_summary').find({ _id: { $in: [...candidatos] } },
        { projection: { es: 1, en: 1 } }).toArray().catch(() => []);
    return filas
        .sort((a, b) => String(a._id).length - String(b._id).length)
        .map((f) => `${f._id} = ${f.es?.titulo || f.en?.titulo}${f.en?.titulo && f.es?.titulo ? ` (en: ${f.en.titulo})` : ''} [UDC Summary oficial]`);
}

/** La descripción ya guardada del código «padre» más cercano (quitando el último auxiliar o la última cifra). */
async function descripcionDelPadre(db, codigo) {
    const col = db.collection('cdu_descripciones');
    let c = String(codigo);
    for (let i = 0; i < 6 && c.length > 1; i++) {
        c = c.replace(/(?:[:+/]\d[\d.]*|\([^()]*\)|"[^"]*"|-\d+|\.\d+|\d)$/, '').replace(/[.:+/_-]+$/, '');
        if (!c) break;
        const p = await col.findOne({ codigo: c }, { projection: { codigo: 1, titulo_es: 1 } });
        if (p?.titulo_es) return p;
    }
    return null;
}

/**
 * Las clasificaciones Dewey/LCC que ya se tradujeron a este código (`equivalencias_cdu`) y lo que significan: la
 * mejor pista de qué quiere decir una subdivisión rara («94(430).085:008» ← Dewey 943.085 «Historia de Alemania:
 * República», es decir, la de Weimar). Hasta 4.
 */
async function equivalenciasDe(db, codigo) {
    const esc = String(codigo).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return db.collection('equivalencias_cdu').find({ cdu: { $regex: `^${esc}` }, descripcion: { $exists: true, $ne: '' } },
        { projection: { sistema_origen: 1, codigo_origen: 1, descripcion: 1 } }).limit(4).toArray().catch(() => []);
}

const prompt = (codigo, refs = [], padre = null, equivalencias = []) => `Eres un bibliotecario experto en la Clasificación Decimal Universal (CDU/UDC).
Para el código CDU "${codigo}", redacta una descripción RIGUROSA y EXTENSA (uno o dos párrafos por
idioma), DESGLOSANDO cada componente: clase principal y divisiones, y los auxiliares comunes que
aparezcan, p. ej.:
  -05 personas · -055.2 mujeres · (4/9) lugar · "..." tiempo · =... lengua · .0... auxiliar especial
  : y + relaciones/combinaciones · (0...) forma del documento.
${refs.length ? `REFERENCIAS OBLIGATORIAS (son las tablas de la CDU; no las contradigas):\n${refs.map((r) => `  · ${r}`).join('\n')}\n` : ''}${padre ? `El código padre «${padre.codigo}» significa «${padre.titulo_es}»: este código es una subdivisión suya.\n` : ''}${equivalencias.length ? `En esta biblioteca, a este código se llegó desde: ${equivalencias.map((e) => `${String(e.sistema_origen || '').toUpperCase()} ${e.codigo_origen} («${e.descripcion}»)`).join('; ')}. Úsalo para saber qué significa.\n` : ''}Si no conoces el significado exacto de una subdivisión, dilo con prudencia en vez de inventarlo.
Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto fuera del JSON):
{
  "titulo_es": "<título breve en español>",
  "descripcion_es": "<explicación extensa en español, con el desglose de cada componente>",
  "titulo_en": "<short title in English>",
  "descripcion_en": "<extensive explanation in English, with the breakdown of each component>"
}`;

/**
 * ¿La descripción contradice su división? Un 94/93 que no habla de historia, un 91 que no habla de geografía o
 * viajes, un 929 que no habla de biografía. Entonces no se guarda (se reintentará).
 */
export function descripcionContradice(codigo, titulo) {
    const c = String(codigo || '');
    const t = String(titulo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (!t) return false;
    if (/^929/.test(c)) return !/biograf|genealog|heraldic|vida|memorias/.test(t);
    // Un tema histórico no siempre dice «historia» («Segunda Guerra Mundial», «Genocidio», «Administración Johnson»,
    // «Reino Romano»: 8-oct se retiraron por eso descripciones que estaban bien). Lo que delata el error es que
    // hable de GEOGRAFÍA, así que vale cualquier palabra de acontecimiento, época o poder.
    const HISTORICO = /histor|guerra|batalla|revoluc|reinad|reino|imperi|conquist|dinast|periodo|epoca|edad|siglo|republica|monarqu|genocid|holocaust|administracion|gobierno|dictadura|colonia|independencia|civilizacion|antigu|medieval/;
    if (/^94/.test(c)) return !HISTORICO.test(t);
    if (/^93/.test(c)) return !(HISTORICO.test(t) || /arqueolog|archiv|cronolog|fuentes|paleograf|epigraf|numismat|diplomat|prehist/.test(t));
    if (/^91/.test(c)) return !/geograf|viaj|explorac|turis|pais|cartograf|mapa|atlas|expedic|regional/.test(t);
    return false;
}

/**
 * ¿La descripción se inventa el LUGAR? El código lleva un auxiliar de lugar conocido («(430)» = Alemania) y el texto
 * no lo nombra pero nombra OTRO de la tabla («Antártida»).
 */
export function lugarContradice(codigo, texto) {
    const c = String(codigo || '');
    const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const plano = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const nombres = (v) => v.split(/\s*\/\s*/).map((x) => plano(x).replace(/^(?:antigua?|antiguo)\s+/, '').split(/\s+/)[0]);
    const propios = Object.entries(LUGARES).filter(([aux]) => c.includes(aux) && /^\(\d/.test(aux));
    if (!propios.length || !t) return false;
    // Solo el lugar más concreto (el auxiliar más largo): «(430)» antes que «(4)».
    const [, nombre] = propios.sort((a, b) => b[0].length - a[0].length)[0];
    if (nombres(nombre).some((n) => n.length > 3 && t.includes(n))) return false;
    const otros = Object.entries(LUGARES).filter(([aux, v]) => !c.includes(aux) && /^\(\d/.test(aux) && v !== nombre)
        .flatMap(([, v]) => nombres(v)).filter((n) => n.length > 4 && !['europa', 'mundo', 'lugar', 'todo'].includes(n));
    return otros.some((n) => new RegExp(`\\b${n}\\b`).test(t));
}

/**
 * ¿Título CORTADO? Cuando la IA se queda sin tokens, `extraerJSON` cierra el JSON a medias y el título se guardaba
 * tal cual: «Láseres y sus longitudes de», «Mujeres en el», «Psic» (1.227 medidos el 8-oct). Se delata porque acaba
 * en preposición/artículo/conjunción, o porque es demasiado corto para ser un título.
 */
export function tituloCortado(titulo) {
    const t = String(titulo || '').trim();
    if (t.length < 4) return true;
    // Con un ESPACIO delante, no \b: para \b la «í» no es letra, y «Psicología» acababa «en la palabra "a"».
    return /(?:^|\s)(?:de|del|la|las|el|los|y|e|o|en|con|a|al|para|por|sobre|su|sus|un|una|entre|sin|como|que)$/i.test(t);
}

/**
 * `codigo` es la CLAVE saneada (la de cdu_descripciones); `notacion`, la CDU tal cual la lleva el libro. A la IA se le
 * da la NOTACIÓN: la clave pierde lo que distingue un lugar de un año (8-oct: `930.85(460:73)"1920/30"` le llegaba
 * como `930.85(460_73)_192030` y salió «Historia del mundo antiguo»; `930.85:94(430)` → «Grecia clásica, año 430 a.C.»).
 */
async function generarIA(db, codigo, { soloGratis = false, notacion = null } = {}) {
    const real = notacion && sanitizarCDU(notacion) === codigo ? String(notacion).trim() : codigo;
    const padre = await descripcionDelPadre(db, codigo).catch(() => null);
    const equivalencias = await equivalenciasDe(db, real);
    // Las oficiales primero: si existen, mandan sobre la tabla fija (que es un resumen hecho a mano).
    const refs = [...await referenciasOficiales(db, real), ...referenciasDe(real)];
    // sinRazonar (27-oct): la descripción se apoya en las REFERENCIAS OFICIALES del prompt; el razonamiento de Gemini 2.5
    // se cobraba como salida y hacía de esta campaña la más cara (~0,0036 € por llamada, 5 veces una de clasificación).
    const txt = await conTexto({ prompt: prompt(real, refs, padre, equivalencias), json: true, maxTokens: 4000, soloGratis, sinRazonar: true });
    const j = extraerJSON(txt);
    if (!j) throw new Error('respuesta de IA no parseable');
    // Respuesta INCOMPLETA (se le acabó el sitio y extraerJSON la cerró a medias): no se guarda, se reintentará.
    if (!j.titulo_es || !j.descripcion_es || !j.titulo_en || !j.descripcion_en || tituloCortado(j.titulo_es)) {
        throw new Error(`respuesta de IA incompleta («${j.titulo_es || ''}»)`);
    }
    if (descripcionContradice(codigo, j.titulo_es)) throw new Error(`descripción incoherente con la división («${j.titulo_es}»)`);
    if (lugarContradice(codigo, `${j.titulo_es || ''} ${j.descripcion_es || ''}`)) throw new Error(`descripción con otro lugar («${j.titulo_es}»)`);
    // El siglo, como dicen sus auxiliares de tiempo («"19"» = siglo XX, no XIX): con la notación real.
    const malSiglo = sigloIncoherente(real, `${j.titulo_es || ''} ${j.descripcion_es || ''}`);
    if (malSiglo) throw new Error(`descripción con otro siglo («${j.titulo_es}»: ${malSiglo})`);
    return j;
}

/**
 * Genera (sin guardar) la descripción de un código, con todas las referencias y comprobaciones. Para REHACER una que
 * ya existe (scripts/revisar-descripciones-cdu.js): primero se genera y solo si sale bien se sustituye la vieja.
 * Lanza si la IA falla o la respuesta es incoherente/incompleta.
 */
export async function generarDescripcionCDU(db, cdu, { soloGratis = false } = {}) {
    const codigo = sanitizarCDU(cdu);
    if (!codigo || !/[0-9]/.test(codigo)) throw new Error('código sin parte codificable');
    return generarIA(db, codigo, { soloGratis, notacion: cdu });
}

/**
 * Siembra una descripción de CDU en 'cdu_descripciones' a partir de datos YA obtenidos (p. ej. la MISMA
 * llamada a la IA que dedujo el código, ver clasificador-cdu.js·iaCDU) — así NO se gasta otra llamada de IA
 * después con describirCDU. Best-effort e idempotente: si ya existe la descripción, no hace nada.
 * `datos` = { titulo_es, descripcion_es, titulo_en, descripcion_en }.
 */
export async function sembrarDescripcionCDU(db, cdu, datos = {}) {
    const codigo = sanitizarCDU(cdu);
    if (!codigo || !/[0-9]/.test(codigo)) return null;
    if (!datos || (!datos.descripcion_es && !datos.titulo_es)) return null;
    // Una descripción incoherente no se siembra: ya la hará describirCDU con las referencias.
    if (descripcionContradice(codigo, datos.titulo_es) || lugarContradice(codigo, `${datos.titulo_es || ''} ${datos.descripcion_es || ''}`)) return null;
    const col = db.collection('cdu_descripciones');
    if (await col.findOne({ codigo })) return null; // ya cacheada: no re-generar ni pisar
    const { clase, division } = arbolCDU(cdu);
    const doc = {
        codigo, clase, division,
        titulo_es: datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        titulo_en: datos.titulo_en || null,
        descripcion_en: datos.descripcion_en || null,
        fuente: 'ia',
        verificado: false,
        fecha: new Date(),
    };
    try { await col.insertOne(doc); return doc; }
    catch { return await col.findOne({ codigo }); } // carrera con el índice único
}

/**
 * Asegura que el código CDU tenga descripción en 'cdu_descripciones'. Cacheado: si ya existe,
 * la devuelve sin llamar a la IA. Best-effort: ante fallo de IA/JSON devuelve null (se reintenta
 * más tarde, no inserta basura).
 *
 * @returns el documento de descripción (existente o nuevo) o null.
 */
/**
 * REHACER la descripción de un código a petición (botón «↻» junto a la CDU en la ficha, 12-oct).
 *   · sin IA: el texto OFICIAL del UDC Summary si el código está en él; si no, una descripción COMPUESTA con el
 *     significado oficial de sus piezas (número y antepasados, lugar, lengua). Si no hay ninguna pieza oficial, no
 *     se inventa nada: lanza («usa la opción con IA»).
 *   · con IA: generada con referencias y con la NOTACIÓN real del libro (no la clave limpia).
 * La que hubiera se copia antes en cdu_descripciones_retiradas. Devuelve la nueva.
 */
export async function regenerarDescripcionCDU(db, cdu, { conIA = false } = {}) {
    const codigo = sanitizarCDU(cdu);
    if (!codigo || !/[0-9]/.test(codigo)) throw new Error('código sin parte codificable');
    const notacion = String(cdu).trim();
    let datos;
    let fuente;
    if (conIA) {
        datos = await generarIA(db, codigo, { notacion });
        fuente = 'ia';
    } else {
        // ¿Está tal cual en el UDC Summary? (por su notación, que empiece por cifra; la clave sola no basta)
        const oficial = await db.collection('udc_summary').findOne({ _id: notacion }) ||
            await db.collection('udc_summary').findOne({ clave: codigo, _id: { $regex: '^[0-9]' } });
        if (oficial) {
            const texto = (lado) => [lado?.titulo ? `${lado.titulo}.` : '', ...(lado?.notas || []).map((n) => n.texto)].filter(Boolean).join('\n\n');
            datos = {
                titulo_es: oficial.es?.titulo || oficial.en?.titulo || null, descripcion_es: texto(oficial.es) || texto(oficial.en) || null,
                titulo_en: oficial.en?.titulo || null, descripcion_en: texto(oficial.en) || null,
            };
            fuente = 'udcs';
        } else {
            const piezas = await referenciasOficiales(db, notacion);
            if (!piezas.length) throw new Error('ninguna pieza de este código está en el UDC Summary: usa la opción con IA');
            const limpia = (p) => p.replace(/\s*\[UDC Summary oficial\]$/, '');
            // El título: el significado del número más concreto, y el del lugar y la lengua más concretos si los hay
            // («94(430).085» → «Historia general — Alemania»). Las piezas vienen de la más corta a la más larga.
            const significado = (p) => limpia(p).split(' = ').slice(1).join(' = ').replace(/\s*\(en: .*\)$/, '').split('. ')[0];
            const ultima = (re) => piezas.filter((p) => re.test(p)).pop();
            const partes = [ultima(/^\d/), ultima(/^\(/), ultima(/^=/)].filter(Boolean).map(significado);
            // El periodo, si lo lleva («"04/14"» → «desde el siglo V hasta el siglo XV»).
            const tiempos = auxiliaresDeTiempo(notacion);
            const periodo = tiempos.map((t) => t.split(': ').slice(1).join(': ')).join('; ');
            datos = {
                titulo_es: `${partes.join(' — ')}${periodo ? ` (${periodo})` : ''}`,
                descripcion_es: `Descripción compuesta, sin IA, con el significado oficial de sus piezas (UDC Summary):\n${[...piezas.map(limpia), ...tiempos].map((p) => `· ${p}`).join('\n')}`,
                titulo_en: null, descripcion_en: null,
            };
            fuente = 'udcs-compuesta';
        }
    }
    const col = db.collection('cdu_descripciones');
    const vieja = await col.findOne({ codigo });
    if (vieja) {
        const { _id, ...copia } = vieja;
        await db.collection('cdu_descripciones_retiradas').insertOne({ ...copia, _id_original: _id, retirada: { fecha: new Date(), motivo: `regenerada desde la ficha (${conIA ? 'con IA' : 'sin IA'})` } });
    }
    const { clase, division } = arbolCDU(cdu);
    const doc = {
        codigo, clase, division,
        titulo_es: datos.titulo_es || null, descripcion_es: datos.descripcion_es || null,
        titulo_en: datos.titulo_en || null, descripcion_en: datos.descripcion_en || null,
        fuente, verificado: fuente === 'udcs', fecha: new Date(), revisada: { fecha: new Date(), motivo: 'regenerada desde la ficha' },
    };
    await col.updateOne({ codigo }, { $set: doc }, { upsert: true });
    return doc;
}

export async function describirCDU(db, cdu) {
    const codigo = sanitizarCDU(cdu);
    if (!codigo || !/[0-9]/.test(codigo)) return null; // sin parte codificable

    const col = db.collection('cdu_descripciones');
    const ya = await col.findOne({ codigo });
    if (ya) return ya;

    let datos;
    try {
        datos = await generarIA(db, codigo, { notacion: cdu });
    } catch {
        return null; // transitorio → se reintentará
    }

    const { clase, division } = arbolCDU(cdu);
    const doc = {
        codigo, clase, division,
        titulo_es:     datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        titulo_en:     datos.titulo_en || null,
        descripcion_en: datos.descripcion_en || null,
        fuente: 'ia',
        verificado: false,
        fecha: new Date(),
    };
    try {
        await col.insertOne(doc);
        return doc;
    } catch {
        // Carrera con el índice único: otro proceso lo insertó. Devolver el existente.
        return await col.findOne({ codigo });
    }
}
