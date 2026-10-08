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

/** Las referencias fijas que tocan a este código: su clase, su división y los lugares que lleva. */
function referenciasDe(codigo) {
    const lineas = [];
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
async function referenciasOficiales(db, codigo) {
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

async function generarIA(db, codigo) {
    const padre = await descripcionDelPadre(db, codigo).catch(() => null);
    const equivalencias = await equivalenciasDe(db, codigo);
    // Las oficiales primero: si existen, mandan sobre la tabla fija (que es un resumen hecho a mano).
    const refs = [...await referenciasOficiales(db, codigo), ...referenciasDe(codigo)];
    const txt = await conTexto({ prompt: prompt(codigo, refs, padre, equivalencias), json: true, maxTokens: 1200 });
    const j = extraerJSON(txt);
    if (!j) throw new Error('respuesta de IA no parseable');
    if (descripcionContradice(codigo, j.titulo_es)) throw new Error(`descripción incoherente con la división («${j.titulo_es}»)`);
    if (lugarContradice(codigo, `${j.titulo_es || ''} ${j.descripcion_es || ''}`)) throw new Error(`descripción con otro lugar («${j.titulo_es}»)`);
    return j;
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
export async function describirCDU(db, cdu) {
    const codigo = sanitizarCDU(cdu);
    if (!codigo || !/[0-9]/.test(codigo)) return null; // sin parte codificable

    const col = db.collection('cdu_descripciones');
    const ya = await col.findOne({ codigo });
    if (ya) return ya;

    let datos;
    try {
        datos = await generarIA(db, codigo);
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
