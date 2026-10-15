import { conectarDB } from './database.js';
import { conTexto, extraerJSON } from './utils/vision.js';
import { modernizarCDU, cduParaUbicar } from './utils/cdu-moderna.js';

// Tabla de tradiciones/lenguas literarias → CDU (82x). El Dewey 8xx y la LCC P* YA codifican la lengua, así que
// la equivalencia por código es estable. Se usa en el prompt de iaCDU (por doc) y de iaCDULote (por lote).
const TABLA_LIT = [
    'Rusa/soviética → 821.161.1',
    'Española       → 821.134.2',
    'Latinoamer.    → 821.134.2-* (o código del país: ARG 821.134.2(82), MEX 821.134.2(72)…)',
    'Inglesa/bri.   → 821.111',
    'Norteamer.     → 821.111(73)',
    'Francesa       → 821.133.1',
    'Alemana/aust.  → 821.112.2',
    'Italiana       → 821.131.1',
    'Portuguesa     → 821.134.3',
    'Griega antigua → 821.14',
    'Latina clásica → 821.124',
    'Árabe          → 821.411.21',
    'Japonesa       → 821.521',
    'China          → 821.581',
].join('\n  ');

const COL = 'equivalencias_cdu';

/**
 * Colección `equivalencias_cdu` (caché de equivalencias APRENDIDAS):
 *   { sistema_origen: 'dewey'|'lcc'|'categoria'|'bne', codigo_origen: '<normalizado>',
 *     cdu, fuente: 'IA'|'OpenLibrary'|'BNE'|'Manual'|…, verificado: bool, descripcion?, usos, fecha_creacion }
 * Clave única: { sistema_origen, codigo_origen }. Normaliza a CDU códigos de otros sistemas
 * (Dewey/LC de OpenLibrary/WorldCat) y los reutiliza sin volver a gastar IA.
 */

function normalizarCodigo(c) {
    return String(c || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** La equivalencia aprendida entera ({cdu, fuente, verificado…}) o null. Tolerante a fallos de Mongo. */
async function buscarEquivalenciaDoc(sistema, codigo) {
    if (!codigo) return null;
    try {
        const db = await conectarDB();
        const doc = await db.collection(COL).findOne({ sistema_origen: sistema, codigo_origen: normalizarCodigo(codigo) });
        if (doc) db.collection(COL).updateOne({ _id: doc._id }, { $inc: { usos: 1 } }).catch(() => {});
        return doc || null;
    } catch {
        return null;
    }
}

/** Busca una equivalencia ya aprendida (solo la CDU). Tolerante a fallos de Mongo (devuelve null). */
export async function buscarEquivalencia(sistema, codigo) {
    return (await buscarEquivalenciaDoc(sistema, codigo))?.cdu || null;
}

/**
 * ¿Se puede USAR (o aprender) una equivalencia de la caché? La caché sirve UNA decisión a TODOS los libros con ese
 * código, así que una decisión de la IA sobre un libro solo vale donde el código es tan concreto como esa decisión.
 * La auditoría del 8-oct (scripts/auditar-cdu.js) encontró miles de libros mal por estas cuatro vías:
 *   1. CDU MAL FORMADA: «dewey 193 → 19.035» (la división 19 no existe; 190 libros).
 *   2. LCC de CLASE ENTERA aprendida de la IA: «lcc b → 141.4» (toda la filosofía como «librepensamiento», 467
 *      libros), «qh → 573.016», «hm → 316.774:32»… El arreglo de septiembre solo rechazaba las que CONTRADECÍAN a la
 *      tabla; estas pasaban por «afinarla» (141.4 empieza por el «1» de la B), pero afinar una clase entera por un
 *      libro es el mismo error. Solo se usan si una persona las ha verificado.
 *   3. DEWEY AMPLIO (tres cifras, sin decimales) que la tabla ya resuelve: «520 → 522.2», «004 → 004.451:658.78»,
 *      «530 → 530.145». Un «520» es toda la astronomía; su «afinado» por un libro no vale para los demás: manda la tabla.
 *   4. DEWEY que cambia de CLASE PRINCIPAL: la clase de la CDU coincide con la cifra del Dewey (4xx lengua → 8).
 *      «973 → 39(73)» (historia de EE. UU. como etnología, 162 libros), «092 → 821.133.1».
 * Las verificadas (o 'Manual': la tabla determinista) siempre valen. Devuelve { usable, motivo }.
 */
export function equivalenciaUsable(sistema, codigo, eq) {
    if (!eq || !eq.cdu) return { usable: false, motivo: 'vacía' };
    if (eq.verificado === true || eq.fuente === 'Manual') return { usable: true, motivo: null };
    if (sistema !== 'dewey' && sistema !== 'lcc') return { usable: true, motivo: null };
    const cdu = String(eq.cdu).trim();
    const cod = String(codigo || '').trim();
    if (!cduBienFormada(cdu)) return { usable: false, motivo: 'CDU mal formada' };
    if (sistema === 'lcc') {
        // (Si dice lo mismo que la tabla —«ps → 821.111(73)», «bf → 159.9»— no hay riesgo: vale.)
        if (/^[a-z]{1,3}$/i.test(cod) && cdu !== lccACDU(cod)) return { usable: false, motivo: 'aprendida de un libro para toda una clase LCC' };
        return { usable: true, motivo: null };
    }
    const d = (cod.match(/\d{3}/) || [])[0];
    if (!d) return { usable: true, motivo: null };
    // 5. La IA COPIÓ el número Dewey como CDU, en una división donde los dos sistemas NO coinciden (12-oct: «dewey
    //    181.5 → 181.5»: en Dewey es filosofía islámica; en la CDU, 18 es ESTÉTICA, y al-Ghazali acabó entre libros de
    //    estética). Coinciden en ciencias, técnica, artes, informática y casi toda la 3; divergen 13 (paranormal ≠
    //    filosofía de la mente), 15 (psicología → 159.9), 18-19, la 2 (reorganizada), 38, la 4 (lengua → 81), la 8
    //    (literatura → 82) y la historia 92-99.
    const principal = (cdu.match(/^\d[\d.]*/) || [''])[0];
    const esCopia = principal && principal.replace(/\./g, '') === cod.replace(/[^\d]/g, '');
    const div2 = d.slice(0, 2);
    const divergen = ['13', '15', '18', '19', '38'].includes(div2) || '248'.includes(d[0]) || (d[0] === '9' && div2 !== '91');
    if (esCopia && divergen) return { usable: false, motivo: `copia el número Dewey ${cod} como CDU, y en esa división no coinciden` };
    // Las reglas 3 y 4 son para el Dewey AMPLIO (tres cifras sin decimales: «520», «973»), que abarca muchos libros
    // distintos. Un Dewey CONCRETO sí puede cambiar de clase con razón: «652.80151 → 003.26» (la criptografía cae
    // en el 652 de Dewey por una rareza de su jerarquía; en la CDU es 003), «621.39 → 004».
    if (!/^\d{3}$/.test(cod)) return { usable: true, motivo: null };
    // Con la tabla: una DIVISIÓN entera (acaba en 0: «520» astronomía, «530» física, «500») no admite el «afinado» de
    // un libro («522.2», «530.145»); una SECCIÓN («547» química orgánica, «512» álgebra) sí, porque en ciencias el
    // número Dewey y el CDU coinciden hasta las tres cifras — siempre que se quede dentro de la rama de la tabla.
    const tabla = deweyACDU(cod);
    const division = cod.endsWith('0') || ['004', '005', '006'].includes(cod);   // 004-006: toda la informática
    if (tabla && cdu !== tabla && (division || !cdu.startsWith(tabla))) {
        return { usable: false, motivo: `Dewey amplio ${cod}: manda la tabla («${tabla}»)` };
    }
    // La clase se mira donde se UBICA el libro (087.5:82, juvenil, va a la literatura: ver cduParaUbicar).
    const claseCdu = (String(cduParaUbicar(cdu) || cdu).match(/^\d/) || [])[0];
    const esperada = d[0] === '4' ? '8' : d[0];
    if (claseCdu && claseCdu !== esperada) return { usable: false, motivo: `Dewey ${d}, amplio, no puede ser CDU de la clase ${claseCdu}` };
    return { usable: true, motivo: null };
}

/** Aprende/actualiza una equivalencia para reutilizarla la próxima vez. */
export async function guardarEquivalencia(sistema, codigo, cdu, fuente = 'IA', descripcion) {
    if (!codigo || !cdu) return;
    // Lo que el motor no USARÍA tampoco se APRENDE (ver equivalenciaUsable): así no se vuelve a sembrar el error.
    if (!equivalenciaUsable(sistema, normalizarCodigo(codigo), { cdu, fuente, verificado: fuente === 'Manual' }).usable) return;
    try {
        const db = await conectarDB();
        await db.collection(COL).updateOne(
            { sistema_origen: sistema, codigo_origen: normalizarCodigo(codigo) },
            {
                $set: {
                    sistema_origen: sistema,
                    codigo_origen: normalizarCodigo(codigo),
                    cdu,
                    fuente,
                    verificado: fuente === 'Manual',  // IA = sin verificar; sólo lo manual nace verificado
                    descripcion: descripcion || null,
                    fecha_creacion: new Date(),
                },
                $setOnInsert: { usos: 0 },
            },
            { upsert: true }
        );
    } catch { /* la persistencia de la caché no debe romper la ingesta */ }
}

/**
 * Punto de extensión: equivalencia desde APIs/webs públicas (p. ej. servicios de mapeo
 * Dewey↔UDC). De momento no hay una API libre fiable; se deja preparado.
 */
// ── CROSSWALK DETERMINISTA Dewey/LC → CDU ────────────────────────────────────────────────────────────────
// La CDU se construyó SOBRE el Dewey, así que para las clases de CIENCIAS (5), TÉCNICA (6) y ARTES (7) la
// división de las decenas COINCIDE (Dewey 510 Matemáticas = CDU 51; 530 Física = 53; 610 Medicina = 61;
// 720 Arquitectura = 72; 780 Música = 78…). Ahí NO hace falta IA: un libro con Dewey 510 debe ser CDU 51,
// gratis y aunque la IA esté caída (que es justo lo que dejaba estos libros en el saco «000»). Se mapea SOLO
// lo que alinea con CERTEZA; lo divergente (Dewey 4xx lengua → CDU 81, 8xx literatura → 82, y las
// subdivisiones finas) devuelve null y sigue a la IA, que sí distingue el idioma/tradición. Nunca se
// «adivina»: un mapeo dudoso envenenaría la caché aprendida, así que ante la duda → null → IA.
// ── Dewey → CDU con MÁS DETALLE (13-oct), solo donde la equivalencia es segura ─────────────────────────────────
// Las tres primeras cifras COINCIDEN entre los dos sistemas en medicina (611-618), ingeniería (621-625, 627-629),
// agricultura (631-639), hogar (641-649), gestión (651, 657-659), física (531-539), química (543, 546-549), geología
// (551-553), parte de la biología y de las artes, deportes y espectáculos (792-799), y en varias de las ciencias
// sociales. Antes se mapeaba solo a la división de 2 cifras (61, 62…): 1.074 libros de medicina en «61».
const DEWEY_ALINEADO = new Set([
    '611', '612', '613', '614', '615', '616', '617', '618',
    '621', '622', '623', '624', '625', '627', '628', '629',
    '631', '632', '633', '634', '635', '636', '637', '638', '639',
    '641', '642', '643', '644', '645', '646', '647', '648', '649',
    '651', '657', '658', '659',
    '531', '532', '533', '534', '535', '536', '537', '538', '539',
    '543', '546', '547', '548', '549', '551', '552', '553', '579', '591', '595', '597', '599',
    '741', '745', '746', '747', '748', '749', '781', '791', '792', '793', '794', '795', '796', '797', '798', '799',
    '321', '324', '325', '327', '328', '331', '338', '341', '342', '355', '359', '368', '374', '378', '391', '392', '394', '398',
]);
// Equivalencias conocidas donde el número NO coincide (prefijo con punto: gana el más largo).
const DEWEY_FINO = {
    '512': '512', '514': '515.1', '515': '517', '516': '514', '518': '519.6', '519.2': '519.2', '519.5': '519.2',
    '503': '5(03)', '509': '5(091)', '526': '528', '541': '544', '572': '577.1', '576': '575', '576.8': '575.8',
    '577': '574', '598': '598.2', '523.1': '524.8', '523.8': '524',
    '791.43': '791.43', '709': '7(091)', '809': '82.09',
    '292': '25', '294.3': '24', '294.4': '23', '294.5': '23', '296': '26', '297': '28',
    '301': '316', '302': '316', '303': '316', '304': '316', '305': '316', '306': '316.7', '307': '316',
    '332': '336', '345': '343', '346': '347', '364': '343.9', '372': '373.3', '373': '373.5',
};
function deweyFino(codigo) {
    const limpio = (String(codigo || '').match(/\d{3}(?:\.\d+)?/) || [''])[0];   // «791.4372» , «294.3/4» → «294.3»
    if (!limpio) return null;
    for (let largo = limpio.length; largo >= 3; largo--) {
        const pref = limpio.slice(0, largo).replace(/\.$/, '');
        if (DEWEY_FINO[pref]) return DEWEY_FINO[pref];
    }
    const d = limpio.slice(0, 3);
    if (DEWEY_ALINEADO.has(d)) return d;
    if (/^2[4-8]\d$/.test(d)) return '27';                   // 240-289: cristianismo (iglesias, órdenes, historia…)
    if (/^21\d$/.test(d)) return '2-1';                      // 210-219: filosofía y teoría de la religión
    // Historia 931-999: el número ya dice el LUGAR (y a veces el periodo) → 94(lugar), con la misma traducción que
    // modernizarCDU (973 → 94(73), 946.081 → 94(460).081). 930 es la ciencia de la historia: no.
    // El Dewey 931 es CHINA (hasta 420) → 94(31). (En la CDU antigua, 931 era la historia antigua en general, y
    // modernizarCDU lo lleva a 94(3): aquí se resuelve antes para que el Dewey no herede esa lectura.)
    if (d === '931') return '94(31)';
    if (/^9[3-9]\d/.test(d) && d !== '930') {
        // Como mucho tres decimales: lo que sigue suele ser una subdivisión común del Dewey (941.084092: el «092» es
        // BIOGRAFÍA, no parte del periodo; daba «94(410).084.092»).
        const h = modernizarCDU(limpio.replace(/^(\d{3}\.\d{1,3})\d*$/, '$1'));
        if (/^94\(/.test(h)) return h;
        const h3 = modernizarCDU(d);
        if (/^94\(/.test(h3)) return h3;
    }
    return null;
}

function deweyACDU(codigo) {
    const fino = deweyFino(codigo);
    if (fino) return fino;
    const m = String(codigo || '').match(/\d{3}/);   // «510/.3» → «510»
    if (!m) return null;
    const d = m[0];
    const c0 = d[0], c1 = d[1];
    // Informática: Dewey 004/005/006 → CDU 004.
    if (d === '004' || d === '005' || d === '006') return '004';
    // Ciencias / técnica / artes: la decena coincide (5N, 6N, 7N); las unidades divergen, así que se mapea a
    // la DIVISIÓN de 2 cifras (segura), no a 3.
    if ('567'.includes(c0)) return c1 !== '0' ? c0 + c1 : c0;
    // Suelos de clase principal + las decenas cuya división coincide con la CDU SIN ambigüedad. Se DEJAN FUERA
    // a propósito (→ IA): Dewey 130 (paranormal ≠ CDU 13 filosofía de la mente), 150 (psicología → CDU 159.9),
    // 4xx (lengua → CDU 81), 8xx (literatura → 82) y la historia regional 93x-99x (necesita el área). Un mapeo
    // dudoso envenenaría la caché, así que ante la duda NO se mapea.
    const EXACTAS = {
        '000': '0', '010': '01', '020': '02', '030': '03', '050': '05', '060': '06', '070': '070', '080': '08',   // 070 periodismo: en la CDU es 070 («07» no existe)
        '090': '09',
        '100': '1', '110': '11', '140': '14', '160': '16', '170': '17',
        // La clase 2 se reorganizó (hoy 22 = religiones del Lejano Oriente, 23 = hinduismo, 29 = movimientos
        // espirituales modernos): el Dewey 220 (Biblia) y 230 (teología cristiana) son CRISTIANISMO, 27; el 290
        // (otras religiones) se queda en 2. (13-oct: la tabla tenía la clase 2 ANTIGUA: 220 → 22, 230 → 23.)
        '200': '2', '220': '27', '230': '27', '290': '2',
        '300': '3', '310': '31', '320': '32', '330': '33', '340': '34', '350': '35', '360': '36', '370': '37', '390': '39',
        '900': '9', '910': '91', '920': '929',
    };
    // Filosofía MODERNA por países (Dewey 190-199): en la CDU es la filosofía (1) con el auxiliar de lugar. Exacto, así
    // que no hace falta IA (9-oct: 137 libros de Dewey 193 tenían «19.035», un invento de la IA aprendido de un libro).
    const FILOSOFIA_PAIS = {
        '190': '1', '191': '1(73)', '192': '1(410)', '193': '1(430)', '194': '1(44)', '195': '1(450)',
        '196': '1(460)', '197': '1(470)', '198': '1(48)', '199': '1',
    };
    // Filosofía ANTIGUA y MEDIEVAL (Dewey 180-189, 13-oct): la CDU las pone con auxiliar de lugar o de tiempo —
    // Grecia (38), Roma (37), mundo antiguo (3), Edad Media "04/14"—. Quedaban en «1» a secas (37 de Platón, 184).
    // El 181 (oriental: China, India, judía, islámica…) es demasiado variado: se deja.
    const FILOSOFIA_ANTIGUA = {
        '180': '1(3)', '182': '1(38)', '183': '1(38)', '184': '1(38)', '185': '1(38)', '186': '1(38)',
        '187': '1(38)', '188': '1(3)', '189': '1"04/14"',
    };
    // Sistemas filosóficos (Dewey 141-149) son la división 14 de la CDU; epistemología (121) es el 165.
    const OTRAS_FILOSOFIA = { '121': '165' };
    if (/^14[1-9]$/.test(d)) return '14';
    return EXACTAS[d] || FILOSOFIA_PAIS[d] || FILOSOFIA_ANTIGUA[d] || OTRAS_FILOSOFIA[d] || null;   // el resto (130, 15x, 4xx, 8xx, historia regional…) → IA
}

// LC → CDU. La correspondencia se hace por CLASE (1-2 letras iniciales de la signatura). Es CONSERVADORA, como
// el crosswalk Dewey: mapea solo lo que alinea con CERTEZA (a la DIVISIÓN, no a subdivisiones finas dudosas) y
// deja fuera lo ambiguo → null → IA. En concreto DEFIERE: la HISTORIA regional (D/E/F: necesita el área) y las
// literaturas/lenguas MULTI-idioma (PA grecolatino, PQ románicas, PT germánicas, PG eslavas, PJ/PK/PL/PM
// orientales: el idioma exacto lo distingue la IA). Sí resuelve la literatura/lengua de UNA sola tradición
// (PR inglesa, PS estadounidense, PE lengua inglesa, PC lenguas románicas). Lo que devuelve se APRENDE como
// autoridad, así que ante la duda se deja en null.
const LCC_A_CDU = {
    // Obras generales
    A: '0', AE: '03', AM: '069', AN: '070', AP: '05', AZ: '001',
    // Filosofía · psicología · religión
    B: '1', BC: '16', BD: '11', BF: '159.9', BH: '18', BJ: '17',
    // Religiones con su división MODERNA de la CDU (12-oct; antes todas a «2»): BM judaísmo 26, BP islam 28,
    // BQ budismo 24, BR-BX cristianismo 27. BL (religión en general, mitologías) se queda en 2.
    BL: '2', BM: '26', BP: '28', BQ: '24', BR: '27', BS: '27', BT: '27', BV: '27', BX: '27',
    // Ciencias auxiliares de la historia · genealogía/biografía  (D/E/F historia → diferido, necesita área)
    C: '93', CS: '929', CT: '929',
    // (13-oct) Ciencias auxiliares de la historia con su número propio en la CDU.
    CB: '930.85', CC: '902', CD: '930.25', CJ: '737', CN: '930.27', CR: '929.6',
    // Geografía · antropología · folclore · deporte
    G: '91', GB: '551', GC: '551.46', GE: '502', GN: '39', GR: '398', GV: '79',
    // Ciencias sociales
    H: '3', HA: '31', HB: '33', HC: '33', HD: '33', HE: '656', HF: '33', HG: '33', HM: '316', HN: '316', HQ: '316.3', HT: '316', HV: '36',
    // Ciencia política
    J: '32', JX: '327', JZ: '327',
    JK: '32(73)', JN: '32(4)',             // (13-oct) política de EE. UU. · de Europa
    // Derecho · educación · música
    K: '34', L: '37', M: '78',
    KF: '34(73)', KD: '34(410)', KZ: '341', LA: '37(091)',   // (13-oct) derecho de EE. UU. · del Reino Unido · internacional · historia de la educación
    // Bellas artes
    N: '7', NA: '72', NB: '73', NC: '74', ND: '75', NE: '76', NK: '745',
    // Lengua y literatura (SOLO tradición/idioma único; las multi-idioma PA/PQ/PT/PG/PJ/PK/PL/PM → IA)
    PN: '82', PZ: '82', PE: '811.111', PC: '811.13', PR: '821.111', PS: '821.111(73)',
    // Ciencia
    Q: '5', QA: '51', QB: '52', QC: '53', QD: '54', QE: '55', QH: '57', QK: '58', QL: '59',
    QM: '611', QP: '612', QR: '579',   // anatomía · fisiología · microbiología
    // Medicina · agricultura · técnica
    R: '61', S: '63', T: '6',
    TK: '621.3', TP: '66',             // electrotecnia · tecnología química
    // (12-oct) Subclases de la T que coinciden con una división de la CDU (antes caían en el «6» genérico).
    TA: '62', TC: '626', TD: '628', TH: '69', TJ: '621', TL: '629', TN: '622', TR: '77', TS: '67', TX: '64',
    // Ciencia militar · naval · biblioteconomía
    U: '355', V: '359', Z: '02',
};
/**
 * CONTRASTE CON LA CDU DE LA CARPETA (fase 3 del agente de estructura).
 *
 * La carpeta donde alguien dejó un libro («Algebra/», «Cryptography/») dice de qué va, y el agente la traduce a
 * CDU. Pero la casa tiene una regla: los IDENTIFICADORES del fichero mandan sobre las pistas. Así que la
 * carpeta no pisa nada — solo hace tres cosas, todas conservadoras:
 *
 *   · RELLENAR  — la CDU calculada está vacía o es «000»      → la de la carpeta.
 *   · PRECISAR  — la de la carpeta está DENTRO de la calculada (misma rama, más fina: «51» → «512») → la de la
 *                 carpeta. Solo añade precisión en la dirección que ya marcaba el identificador.
 *   · CONTRADICE — son de RAMAS distintas (ninguna es prefijo de la otra) → se deja la calculada y se AVISA,
 *                 para revisarlo a mano: puede fallar el identificador… o el libro estar mal archivado.
 *
 * Por qué el prefijo: la CDU es jerárquica por prefijo (512 está dentro de 51, que está dentro de 5). Casos
 * reales de la colección de matemáticas: «Linear Algebra» con 51 en «Algebra/» (512) → se precisa; Strogatz con
 * 5 en «Dynamical Systems/» (517.93) → se precisa; criptografía con 65 (gestión, rareza del Dewey 652.8) en
 * «Cryptography/» (003.26) → se AVISA, no se cambia.
 *
 * @returns {{ cdu: string|null, accion: 'rellenar'|'precisar'|'contradice'|null, alerta: string|null }}
 */
export function contrastarCduCarpeta(cduCalculada, cduCarpeta, nombreCarpeta = null) {
    const limpia = (c) => String(c || '').trim();
    const calc = limpia(cduCalculada);
    const carp = limpia(cduCarpeta);
    const donde = nombreCarpeta ? ` de la carpeta «${nombreCarpeta}»` : ' de la carpeta';

    // La de la carpeta viene de la IA: si no parece una CDU (empieza por cifra o por paréntesis de auxiliar),
    // se ignora en vez de colarla.
    if (!carp || !/^[0-9(]/.test(carp) || carp.length > 40) return { cdu: calc || null, accion: null, alerta: null };

    if (!calc || calc === '000' || calc === '0') {
        return { cdu: carp, accion: 'rellenar', alerta: `CDU tomada de la materia${donde}: «${carp}» (no había CDU calculada).` };
    }
    if (carp === calc || calc.startsWith(carp)) return { cdu: calc, accion: null, alerta: null };   // igual o ya más fina
    if (carp.startsWith(calc)) {
        return { cdu: carp, accion: 'precisar', alerta: `CDU precisada con la materia${donde}: «${calc}» → «${carp}».` };
    }
    return {
        cdu: calc, accion: 'contradice',
        alerta: `⚠️ Revisar CDU: la calculada «${calc}» es de otra rama que la materia${donde} («${carp}»). No se ha cambiado.`,
    };
}

// Exportada para la reparación de la contaminación por clase (scripts/reparar-cdu-contaminada.js), que tiene que
// seleccionar los documentos por su clase EXACTA con la misma regla que usa la búsqueda.
export function claseLcc(codigo) {
    const m = String(codigo || '').trim().toUpperCase().match(/^[A-Z]{1,3}/);
    return m ? m[0] : null;
}

/**
 * La UNIDAD por la que se busca y se aprende una equivalencia LCC → CDU.
 *   · Clase que la tabla resuelve (QA, PR, T…): la CLASE. Todos sus libros comparten rama, y lo aprendido solo
 *     puede afinarla.
 *   · Clase que la tabla APLAZA a la IA porque abarca temas o lenguas distintos (D, E, F: historia por países;
 *     PA, PQ, PT…: literaturas de varias lenguas): la clase MÁS EL NÚMERO entero («E185», «PQ6555»). El número
 *     es lo que dice de qué trata: E185 afroamericanos, E855 Nixon, PQ6000-8929 literatura española…
 *
 * Por qué (medido el 30-sep): la decisión de la IA sobre UN libro se aprendía para la clase entera y se servía a
 * todos los demás. «lcc:e → 972.5» (de un libro sobre México) clasificó 115 libros de historia de EE. UU. — y el
 * Conformador movió allí a los que ya estaban bien («94(73)"1969/1974"» → «972.5»). Igual «pa → 791.43» (clásicos
 * grecolatinos como cine, 96 usos), «d → 93.04.2» (165), «f → 918.3» (150), «pq → 821.13» (171)… El arreglo de
 * «qa» (la caché puede afinar la tabla, nunca contradecirla) no las cubría: para estas clases no hay tabla.
 * @returns {string|null} null si la clase está aplazada y la signatura no trae número (no hay unidad fiable)
 */
export function unidadLcc(codigo) {
    const clase = claseLcc(codigo);
    if (!clase) return null;
    if (lccACDU(clase)) return clase;
    const numero = parseInt(String(codigo).trim().slice(clase.length).replace(/^[^0-9]+/, ''), 10);
    return Number.isFinite(numero) ? `${clase}${numero}` : null;
}

/**
 * ¿Está BIEN FORMADA una CDU? El número principal lleva un punto cada tres cifras (821.134.2, 004.738): todos sus
 * grupos menos el último tienen exactamente tres. La IA devuelve a veces inventos que no lo cumplen —«93.04.2»,
 * «31.5:61.1», «43.5.2.1», «94-(Normandy)»— y se aprendían como equivalencia (medido el 30-sep). Una CDU así no
 * se aprende ni se aplica.
 */
export function cduBienFormada(cdu) {
    const texto = String(cdu || '').trim();
    if (!/^\d/.test(texto)) return false;
    // Una palabra (un nombre, un lugar escrito con letras): no es una CDU. Las abreviaturas de un auxiliar, sí
    // («(460.355 C.)»): por eso se piden tres letras seguidas.
    if (/\p{L}{3,}/u.test(texto)) return false;
    // Cada faceta (separadas por «:», «+» o «/» FUERA de paréntesis y comillas): su número principal, antes de
    // cualquier auxiliar. «94(100)"1939/1945"» es una sola faceta.
    const sinAuxiliares = texto.replace(/\([^)]*\)|"[^"]*"/g, ' ');
    for (const faceta of sinAuxiliares.split(/[:+/]/)) {
        const entero = faceta.trim().match(/^\d+(?:\.\d+)*/)?.[0];
        if (!entero) continue;                                   // «/.2», un auxiliar suelto: no se juzga
        // Los AUXILIARES ESPECIALES «.0…» (72.01 teoría de la arquitectura, 82.09 crítica literaria, 7.046
        // iconografía, 159.9.01) van tras el número principal sin la regla de las tres cifras: se juzga solo lo de
        // ANTES del primer «.0». (12-oct: tomarlos por mal formados hizo que la reparación del 9-oct dejara
        // «72.01 → 72», «82.09 → 82», y que la ingesta los recortara desde el 30-sep.)
        const numero = entero.split(/\.(?=0)/)[0];
        const grupos = numero.split('.');
        if (grupos.slice(0, -1).some((g) => g.length !== 3) || grupos[grupos.length - 1].length > 3) return false;
    }
    return true;
}

/**
 * REPARA una CDU mal formada sin gastar otra llamada de IA: en cada faceta, conserva del número principal la parte
 * bien escrita y descarta lo que sobra, manteniendo los auxiliares. «94.02(6):71» → «94(6):71» (en la CDU el punto va
 * cada TRES cifras: «94.02» no existe), «93.04.2» → «93», «821111» → «821.111» (faltaban los puntos). Devuelve la
 * CDU reparada si queda bien formada, o null (una palabra dentro, «94-(Normandy)», no tiene arreglo).
 */
export function repararCDU(cdu) {
    const texto = String(cdu || '').trim();
    if (!texto || cduBienFormada(texto)) return texto || null;
    if (/\p{L}{3,}/u.test(texto)) return null;
    // Trocear en facetas por «:», «+» o «/» FUERA de paréntesis y comillas, guardando los separadores.
    const facetas = [];
    const separadores = [];
    let actual = '';
    let profundidad = 0;
    let enComillas = false;
    for (const ch of texto) {
        if (ch === '(') profundidad++;
        else if (ch === ')') profundidad = Math.max(0, profundidad - 1);
        else if (ch === '"') enComillas = !enComillas;
        if (!profundidad && !enComillas && /[:+/]/.test(ch)) {
            facetas.push(actual);
            separadores.push(ch);
            actual = '';
        } else actual += ch;
    }
    facetas.push(actual);
    const arreglar = (numero) => {
        const grupos = numero.split('.');
        // Sin puntos y con más de tres cifras: se ponen («821111» → «821.111»).
        if (grupos.length === 1) return grupos[0].match(/\d{1,3}/g).join('.');
        // Se conservan los grupos mientras el anterior tenga tres cifras; el resto sobra.
        const buenos = [grupos[0]];
        for (let i = 1; i < grupos.length && buenos[buenos.length - 1].length === 3 && grupos[i].length <= 3; i++) buenos.push(grupos[i]);
        return buenos[0].length <= 3 ? buenos.join('.') : buenos[0].match(/\d{1,3}/g).join('.');
    };
    const reparada = facetas
        .map((f) => f.replace(/^(\s*)(\d+(?:\.\d+)*)/, (_, espacio, numero) => espacio + arreglar(numero)))
        .reduce((acc, f, i) => acc + (i ? separadores[i - 1] : '') + f, '');
    return cduBienFormada(reparada) ? reparada : null;
}

// Reglas de NOTACIÓN que se dan a la IA (las mismas que comprueba cduBienFormada): medido el 5-oct, la IA devolvía
// «94.02(6):71» y la CDU se perdía. Se le explica cómo se escribe y se le pide comprobarla antes de responder.
const REGLAS_NOTACION_CDU = `═══ CÓMO SE ESCRIBE UNA CDU (compruébalo ANTES de responder) ═══
- Solo cifras, puntos y signos de auxiliar: NADA de letras ni palabras.
- El punto separa grupos de TRES cifras contados desde el principio: 821.111 · 004.43 · 539.12 · 94.
  MAL: «94.02», «93.04.2», «82.3» (tras el primer punto no puede quedar un grupo de dos cifras en medio).
- Auxiliares: lugar entre paréntesis y en cifras «(460)», «(6)»; tiempo entre comillas «"19"», «"1939/1945"»;
  forma «(038)», «(091)»; aspectos con guion «-3» (82-3 novela). Relación entre dos materias: «:» (una vez como máximo).
- Historia: 94 + lugar + época: 94(460)"19" (España, s. XX), 94(6) (África). MAL: «94.02(6)».
- Si dudas de una subdivisión, quédate en el nivel superior VÁLIDO (94(6) mejor que inventar 94.02(6)).`;

// LCC por TRAMOS DE NÚMERO dentro de una clase (12-oct). La tabla de arriba va por clase (QA → 51), y dentro de una
// clase el número dice mucho: «Calculus» (QA303) es análisis (517), no «matemáticas» a secas; Nietzsche (B3311) es
// filosofía ALEMANA, 1(430). Solo tramos SEGUROS del esquema de la Library of Congress; el más concreto va antes.
// Un resultado por tramo NUNCA se aprende como equivalencia de la clase (sería repetir el error de «qa → 004.8»).
const LCC_RANGOS = {
    QA: [[75, 76.999, '004'], [164, 167.999, '519.1'], [241, 247.999, '511'], [150, 272.999, '512'], [273, 280.999, '519.2'],
        [297, 299.999, '519.6'], [300, 433.999, '517'], [440, 699.999, '514'], [801, 939.999, '531']],
    QB: [[500, 785.999, '523'], [980, 991.999, '524.8'], [799, 903.999, '524']],
    QC: [[173.96, 174.999, '530.145'], [170, 197.999, '539.1'], [221, 246.999, '534'], [251, 338.999, '536'],
        [350, 467.999, '535'], [501, 766.999, '537'], [770, 798.999, '539.1'], [801, 809.999, '550.3'], [851, 999.999, '551.5']],
    QD: [[71, 142.999, '543'], [146, 199.999, '546'], [241, 441.999, '547'], [450, 801.999, '544'], [901, 999.999, '548']],
    QE: [[351, 399.999, '549'], [420, 499.999, '552'], [701, 760.999, '56']],
    QH: [[426, 470.999, '575'], [540, 549.999, '574'], [573, 671.999, '576.3']],
    QL: [[461, 599.999, '595.7'], [614, 639.999, '597'], [640, 669.999, '597.6'], [671, 699.999, '598.2'], [700, 739.999, '599']],
    // Filosofía moderna por países (la misma regla que el Dewey 19x).
    // Filosofía por PERIODOS (13-oct): historia general (B69-99), antigua (B108-708: Grecia B165-629 —Platón B350-398,
    // Aristóteles B400-491—, Roma B630-708), medieval (B720-765), Renacimiento (B770-785); y la moderna por PAÍSES.
    B: [[69, 99.999, '1(091)'], [108, 164.999, '1(3)'], [165, 629.999, '1(38)'], [630, 708.999, '1(37)'],
        [720, 765.999, '1"04/14"'], [770, 785.999, '1"14/16"'],
        [851, 945.999, '1(73)'], [1111, 1674.999, '1(410)'], [1801, 2430.999, '1(44)'], [2521, 3396.999, '1(430)'], [3551, 3636.999, '1(450)']],
    BP: [[500, 610.999, '2']],          // teosofía y movimientos nuevos: no es islam
    // Literatura en general por GÉNEROS (13-oct): crítica e historia (82.09), poesía (82-1), novela (82-3), humor (82-7).
    PN: [[80, 99.999, '82.09'], [441, 1009.999, '82.09'], [1010, 1525.999, '82-1'], [1560, 1590.999, '792'],
        [1991, 1992.999, '654.19'], [1993, 1999.999, '791.43'], [2000, 3307.999, '792'], [3311, 3503.999, '82-3'],
        [4699, 5650.999, '070'], [6157, 6222.999, '82-7']],
    PZ: [[5, 90.999, '82-93']],                 // literatura infantil y juvenil
    BD: [[143, 237.999, '165'], [300, 450.999, '111'], [493, 708.999, '113']],   // epistemología · ontología · cosmología
    G: [[149, 570.999, '910.4'], [1000, 3122.999, '912']],                       // viajes y exploraciones · atlas y mapas
    LB: [[2300, 2430.999, '378']],              // enseñanza superior
    // Escritura y paleografía · criptografía · el libro (imprenta, edición) · bibliotecas · bibliografías (13-oct:
    // «Cryptography», Z103, caía en 02 bibliotecas).
    Z: [[40, 102.499, '003'], [102.5, 104.999, '003.26'], [116, 659.999, '655'], [665, 997.999, '02'], [1001, 8999.999, '01']],
    HF: [[5410, 5417.999, '658.8'], [5601, 5689.999, '657'], [5001, 6182.999, '658']],
    HD: [[4801, 8943.999, '331']],
    TK: [[5105.5, 5105.999, '004.7'], [7885, 7895.999, '004'], [5101, 6720.999, '621.39'], [7800, 8360.999, '621.38']],
};

/** El número de una signatura LCC tras sus letras: «QA303.2.L367» → 303.2; «QA-0076.9…» → 76.9; sin número → NaN. */
function numeroDeLcc(codigo) {
    // Solo las cifras (y su decimal): con parseFloat a secas, «PN5214.E8» se leía como 5214·10⁸ — la marca de autor
    // «.E8» es un EXPONENTE para JavaScript — y toda signatura con un cutter en E se salía de su tramo (13-oct).
    const resto = String(codigo || '').trim().toUpperCase().replace(/^[A-Z]{1,3}/, '').replace(/^[^0-9]+/, '');
    const m = resto.match(/^\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : NaN;
}

/** La CDU por el TRAMO de número de la signatura, o null (sin tramo conocido, o sin número). */
export function lccPorRango(codigo) {
    const letras = claseLcc(codigo);
    const n = numeroDeLcc(codigo);
    if (!letras || !Number.isFinite(n)) return null;
    const tramos = LCC_RANGOS[letras] || LCC_RANGOS[letras.slice(0, 2)] || (letras.length === 1 ? null : null);
    const tramo = (tramos || []).find(([desde, hasta]) => n >= desde && n <= hasta);
    return tramo ? tramo[2] : null;
}

function lccACDU(codigo) {
    const letras = claseLcc(codigo);
    if (!letras) return null;
    return lccPorRango(codigo) || LCC_A_CDU[letras.slice(0, 2)] || LCC_A_CDU[letras[0]] || null;
}

/**
 * Como lccACDU pero SIN el respaldo a la letra suelta: devuelve la CDU solo si la tabla tiene una entrada
 * ESPECÍFICA para esa clase. «QA» → «51» (la tabla la tiene); «QP» → null (no la tiene: lccACDU devolvería el
 * «5» genérico de la letra Q).
 *
 * Existe para decidir cuándo la tabla puede DESAUTORIZAR a una equivalencia aprendida. El respaldo de la letra
 * es un comodín grueso, no una afirmación sobre esa clase concreta, así que no debe pisar nada. Caso real:
 * la IA aprendió «qp → 612» (fisiología: CORRECTO, QP es fisiología); si el «5» del respaldo de Q ganara,
 * 52 libros de fisiología pasarían de «612» a «ciencias naturales» a secas.
 */
export function lccACDUEspecifica(codigo) {
    const letras = claseLcc(codigo);
    if (!letras) return null;
    return LCC_A_CDU[letras.slice(0, 2)] || null;
}

/**
 * «Fuente externa» = crosswalk DETERMINISTA (no una API: la CDU deriva del Dewey). Devuelve la CDU o null.
 * Lo que devuelve se APRENDE en la caché de equivalencias (como 'Manual'), así que debe ser CORRECTO — por eso
 * es conservador: mapea solo lo que alinea con certeza y deja lo dudoso a la IA.
 */
// Avisa (una sola vez por código y proceso) de una equivalencia aprendida que CONTRADICE a la tabla determinista.
// Sin el «una vez» cada libro de matemáticas repetiría el aviso: con 242 afectados, el registro se inundaría.
// El aviso es lo que permite descubrir OTRAS entradas contaminadas como la de «qa»; para listarlas todas de
// golpe está scripts/auditar-equivalencias-cdu.js.
const _cacheContradictoriaAvisada = new Set();
function avisarCacheContradictoria(sistema, codigo, hit, tabla) {
    const clave = `${sistema}:${String(codigo).toLowerCase()}`;
    if (_cacheContradictoriaAvisada.has(clave)) return;
    _cacheContradictoriaAvisada.add(clave);
    // `tabla` es la CDU de la tabla, o el MOTIVO por el que equivalenciaUsable la descarta (texto con espacios).
    console.warn(/\s/.test(String(tabla))
        ? `⚠️  [CDU] Equivalencia aprendida ${clave} → «${hit}» no se usa: ${tabla}.`
        : `⚠️  [CDU] Equivalencia aprendida ${clave} → «${hit}» CONTRADICE la tabla (→ «${tabla}»): se ignora y manda la tabla.`);
}

// Exportada para la auditoría de la caché (scripts/auditar-equivalencias-cdu.js): comprobar qué equivalencias
// aprendidas contradicen a esta tabla exige poder consultarla desde fuera.
export async function buscarEquivalenciaExterna(sistema, codigo) {
    if (sistema === 'dewey') return deweyACDU(codigo);
    if (sistema === 'lcc') return lccACDU(codigo);
    return null;
}

/**
 * Detecta si la obra es ficción/literatura a partir de los datos disponibles.
 * La ficción se clasifica por tradición literaria del autor (82x), no por tema.
 */
function esFiccionLiteratura({ dewey, lcc, categorias }) {
    if (dewey && /^8/.test(String(dewey).trim())) return true;           // Dewey 800-899 = Literatura
    if (lcc && /^P[A-Z]/.test(String(lcc).trim())) return true;          // LCC P* = Lengua y Literatura
    if (!Array.isArray(categorias)) return false;
    const pat = /ficción|fiction|literatura|literature|novel|poesía|poetry|drama|cuentos|relatos/i;
    return categorias.some(c => pat.test(c));
}

const IA_CDU_VACIO = { cdu: '000', titulo_es: null, descripcion_es: null, titulo_en: null, descripcion_en: null, palabras_clave: [] };

/**
 * Deriva la CDU con IA y, en la MISMA llamada, su descripción bilingüe y las materias que la IA pueda
 * DEDUCIR de los datos aportados. Rentabiliza al máximo la llamada (Gemini cobra por TOKENS, no por tiempo:
 * una sola respuesta rica cuesta casi lo mismo que pedir solo el código y evita una 2ª llamada para describir
 * el código). Devuelve { cdu, titulo_es, descripcion_es, titulo_en, descripcion_en, palabras_clave[] }.
 */
async function iaCDU({ dewey, lcc, categorias, titulo, autor, sinopsis }) {
    try {
        const esLiteratura = esFiccionLiteratura({ dewey, lcc, categorias });
        const categoria = Array.isArray(categorias) && categorias.length > 0 ? categorias[0] : null;
        const tablaLit = TABLA_LIT;

        const prompt = `
Eres un bibliotecario catalogador experto en Clasificación Decimal Universal (CDU).
Tu tarea: (1) determinar el código CDU de la obra, (2) describirlo, y (3) deducir sus materias.

═══ REGLAS PARA EL CÓDIGO 'cdu' (en orden de prioridad) ═══
Formato: máx. 12 caracteres, sin subdivisiones alfabéticas, ":" como separador de materias como máx. una vez.

REGLA A — FICCIÓN Y LITERATURA (solo si ESTÁS SEGURO de que es ficción):
  Si la obra es novela, cuento, poesía, teatro o ensayo literario, clasifícala por la
  TRADICIÓN LITERARIA DEL AUTOR (82x), NUNCA por el tema de la obra.
  Tabla de naciones:
  ${tablaLit}
  IMPORTANTE: Aplica esta regla SOLO si sabes la nacionalidad del autor con certeza.
  Si el nombre no indica claramente el idioma, ve a la REGLA D.
  Ejemplos CORRECTOS:
    Chéjov (ruso)         → 821.161.1
    Zweig (austriaco)     → 821.112.2  (NOT 821.161.1 — Zweig es austríaco, no ruso)
    García Márquez (col.) → 821.134.2
    Shakespeare (inglés)  → 821.111
  Ejemplos INCORRECTOS (nunca hagas esto):
    Cuento de un manicomio por autor ruso → 616.89 (¡INCORRECTO! Debe ser 821.161.1)
    Poema de amor en español              → 159.9  (¡INCORRECTO! Debe ser 821.134.2)
    Novela médica por autor inglés        → 610    (¡INCORRECTO! Debe ser 821.111)

REGLA B — TEXTOS CLÁSICOS GRECOLATINOS:
  Si el autor es de la Antigüedad griega o latina, clasifica siempre como literatura clásica:
    Griego antiguo → 821.14
    Latín clásico  → 821.124

REGLA C — NO FICCIÓN:
  Clasifica por el tema principal de la obra. Usa el Dewey/LCC como guía si se proporciona.

REGLA D — INCERTIDUMBRE (aplícala antes de inventar una clasificación):
  Si no puedes determinar la tradición literaria del autor con confianza razonable,
  usa el código genérico de literatura: 82 (o 82-3 para novela, 82-1 para poesía, etc.)
  NUNCA inventes una nacionalidad — un error es peor que un código genérico.

${REGLAS_NOTACION_CDU}

═══ DATOS DE LA OBRA ═══
${esLiteratura ? '⚑ FICCIÓN/LITERATURA detectada: aplica REGLA A (o D si no conoces la nacionalidad).' : ''}
${dewey ? `Dewey (DDC): "${dewey}" → convierte a CDU.` : ''}
${lcc ? `Library of Congress: "${lcc}".` : ''}
${categoria ? `Categoría: "${categoria}".` : ''}
${autor ? `Autor: "${autor}".` : ''}
Título: "${titulo || 'N/A'}".
Sinopsis: "${(sinopsis || 'N/A').slice(0, 400)}".

Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto fuera del JSON):
{
  "cdu": "<código CDU>",
  "titulo_es": "<título breve de la materia del código, en español>",
  "descripcion_es": "<explicación del código y su desglose por componentes, 1-3 frases, en español>",
  "titulo_en": "<short subject title in English>",
  "descripcion_en": "<short explanation with the breakdown, in English>",
  "palabras_clave": ["<materia1>", "<materia2>"]
}
'palabras_clave': 3-6 términos de materia deducidos de los datos aportados (temas, género, ámbito). No
inventes datos concretos (fechas, nombres) que no puedas justificar con lo dado.
        `.trim();
        // Texto multi-proveedor (Gemini free → Groq/OpenRouter free → Gemini pago).
        const txt = await conTexto({ prompt, json: true, maxTokens: 1200 });
        const j = extraerJSON(txt);
        if (!j) throw new Error('respuesta de IA no parseable');
        const cdu = String(j.cdu || '').trim().replace(/^["']|["']$/g, '');
        return {
            cdu: cdu || '000',
            titulo_es: j.titulo_es || null,
            descripcion_es: j.descripcion_es || null,
            titulo_en: j.titulo_en || null,
            descripcion_en: j.descripcion_en || null,
            palabras_clave: Array.isArray(j.palabras_clave) ? j.palabras_clave.map(String).map(s => s.trim()).filter(Boolean).slice(0, 8) : [],
        };
    } catch (e) {
        console.error(`❌ [Clasificador CDU IA]: ${e.message}`);
        return { ...IA_CDU_VACIO };
    }
}

/**
 * Resuelve la CDU minimizando IA:
 *   1) caché de equivalencias aprendidas (Dewey, luego LC),
 *   2) API/web externa (extensible),
 *   3) IA — y APRENDE la equivalencia (Dewey/LC) para la próxima vez.
 */
/**
 * Envoltorio: TODA CDU que sale del clasificador (caché, tabla, IA) va en notación MODERNA (820 → 821.111): la IA y
 * algunas equivalencias aprendidas de fichas antiguas la devuelven a veces con la antigua (cdu-moderna.js).
 */
export async function resolverCDU(args) {
    const r = await resolverCDUSinModernizar(args);
    if (r?.cdu) r.cdu = modernizarCDU(r.cdu);
    return r;
}

// `aprender: false` = solo CONSULTAR: no se escribe nada en la caché de equivalencias. Lo usan los diagnósticos y las
// pasadas en seco: el 9-oct el seco de reparar-cdu-contaminada guardó como «Manual» (verificada) la CDU de la tabla
// sobre 87 equivalencias —23 de ellas buenas, «547 → 547» pasó a «54»—; hubo que devolverlas desde la copia.
async function resolverCDUSinModernizar({ dewey, lcc, categorias = [], titulo, autor, sinopsis, permitirIA = true, aprender = true }) {
    // Los códigos se manejan por su UNIDAD de equivalencia: Dewey tal cual; LCC por su CLASE (letras iniciales),
    // no la signatura completa — si no, «PR4589.H39 1998» se guardaría entero y no lo reusaría ningún otro libro.
    // (LCC de una clase APLAZADA —historia, literaturas de varias lenguas—: por clase + número; ver unidadLcc.)
    const candidatos = [['dewey', dewey], ['lcc', unidadLcc(lcc)]].filter(([, c]) => c);
    const categoria = Array.isArray(categorias) && categorias.length > 0 ? categorias[0] : null;

    // APRENDIZAJE A TRES BANDAS (LCC ↔ Dewey ↔ CDU): un libro que trae Dewey Y LCC es un par de entrenamiento
    // gratis. Al resolver la CDU por UN código, se enseña la MISMA CDU a los OTROS códigos presentes, para que un
    // futuro libro que solo traiga ese otro código la herede sin IA (el caso «solo LCC» del Dickens). Se hace
    // SOLO donde el crosswalk determinista NO llega (así una inferencia nunca contradice/ensombrece al crosswalk)
    // y como 'inferido' (no verificado: un mapeo Manual futuro lo corrige).
    const enseñarBandas = async (cdu, resueltoPor, fuentePrimaria) => {
        if (!aprender) return;
        for (const [s2, c2] of candidatos) {
            if (s2 === resueltoPor) { if (fuentePrimaria) await guardarEquivalencia(s2, c2, cdu, fuentePrimaria, categoria); continue; }
            if (await buscarEquivalenciaExterna(s2, c2)) continue;      // el crosswalk ya lo resuelve mejor → no inferir
            await guardarEquivalencia(s2, c2, cdu, 'inferido', categoria);
        }
    };

    // 1) Caché aprendida (por CÓDIGO Dewey/LCC). Se lee SIEMPRE que haya un código — también para literatura:
    //    el Dewey 8xx ya CODIFICA la lengua/tradición (84x francés, 83x alemán, 82x inglés…), así que la
    //    equivalencia «código → CDU» es ESTABLE (no depende del autor concreto). La antigua exclusión de la
    //    ficción solo tenía sentido SIN código (inferencia por título); con Dewey/LC presente, cachear es correcto
    //    y evita re-consultar la IA por CADA libro de literatura (el gran gasto en lotes de humanidades).
    const esLit = esFiccionLiteratura({ dewey, lcc, categorias });
    for (const [sistema, codigo] of candidatos) {
        // EL LCC: LA TABLA ANTES QUE LA CACHÉ (12-oct). La caché del LCC va por CLASE («qa»), y una entrada de clase
        // no puede saber más que la tabla curada (que ahora además mira el TRAMO del número: QA303 → 517). La caché
        // solo decide en las clases que la tabla aplaza (historia D/E/F, literaturas PQ/PT…: por clase + número).
        // Lo resuelto por TRAMO no se aprende para la clase (sería servir «517» a todo el QA).
        if (sistema === 'lcc' && lcc) {
            const tablaLcc = lccACDU(lcc);
            if (tablaLcc) {
                await enseñarBandas(tablaLcc, 'lcc', lccPorRango(lcc) ? null : 'Manual');
                return { cdu: tablaLcc, fuente: 'api:lcc', aprendida: false };
            }
        }
        // EL DEWEY ANTES QUE EL LCC (9-oct). Si el Dewey no tiene caché utilizable, su TABLA se consulta aquí mismo,
        // antes de pasar a la caché del LCC: si no, «After Nietzsche» (Dewey 193 = filosofía alemana, LCC dudoso «M27»)
        // salía 78 —música— por la caché «lcc m», y la tabla del Dewey (193 → 1(430)) ni se miraba.
        const usarTablaDewey = async () => {
            if (sistema !== 'dewey') return null;
            const ext = await buscarEquivalenciaExterna('dewey', codigo);
            if (!ext) return null;
            // La tabla del Dewey es gruesa a propósito (515 → «51»): si el TRAMO del LCC del mismo libro la AFINA
            // dentro de la misma rama (QA303 → 517), manda el tramo.
            const fino = lcc ? lccPorRango(lcc) : null;
            if (fino && fino !== ext && fino.startsWith(ext)) return { cdu: fino, fuente: 'api:lcc', aprendida: false };
            await enseñarBandas(ext, 'dewey', 'Manual');
            return { cdu: ext, fuente: 'api:dewey', aprendida: false };
        };
        const eq = await buscarEquivalenciaDoc(sistema, codigo);
        if (!eq || !eq.cdu) {
            const porTabla = await usarTablaDewey();
            if (porTabla) return porTabla;
            continue;
        }
        const hit = eq.cdu;

        // Una decisión de la IA que la caché serviría a libros que no le corresponden: no se usa (ver equivalenciaUsable).
        const uso = equivalenciaUsable(sistema, normalizarCodigo(codigo), eq);
        if (!uso.usable) {
            avisarCacheContradictoria(sistema, codigo, hit, uso.motivo);
            const porTabla = await usarTablaDewey();
            if (porTabla) return porTabla;
            continue;
        }

        // LA CACHÉ PUEDE AFINAR LA TABLA DETERMINISTA, NUNCA CONTRADECIRLA.
        // La caché es APRENDIDA (a menudo de una sola decisión de la IA) y la tabla está CURADA. Si la tabla
        // conoce este código, la caché solo vale si es una PRECISIÓN dentro de lo que la tabla dice
        // (tabla «51» → caché «512.64» es un refinamiento correcto) — si es OTRA rama, se ignora.
        //
        // Por qué hacía falta (caso real, 242 documentos): el 23-jun la IA clasificó un libro de LCC «QA»
        // —la clase cubre toda la MATEMÁTICA y también la INFORMÁTICA (QA75-76)— como inteligencia artificial,
        // y se aprendió «lcc:qa → 004.8:004.832.2». Dormía, porque entonces se buscaba por signatura completa
        // («qa184.l37» nunca casaba con «qa»). El 4-sep se pasó a buscar el LCC por CLASE, y desde ese día
        // TODO libro de matemáticas con LCC QA la encontraba: esta caché va ANTES que la tabla (que dice
        // QA → 51, correcto), así que la tabla no llegaba a consultarse. Álgebra lineal, análisis numérico,
        // geometría proyectiva… clasificados como IA. Y como el bucle recorre la caché de TODOS los códigos
        // antes que la tabla de NINGUNO, ni un Dewey perfecto (516.35 → geometría algebraica) lo salvaba.
        //
        // SOLO PARA LCC, y a propósito. El peligro no es la caché en sí: es una equivalencia de CLASE aprendida
        // de UN libro, que luego se aplica a TODOS los de esa clase. Eso solo pasa en el LCC, que se busca por
        // clase («qa»). El Dewey se busca por el código COMPLETO («652.80151»): su equivalencia aprendida es
        // específica de ese código y suele ser MÁS FINA que la tabla, que es deliberadamente gruesa. Aplicarle
        // esta regla la DEGRADARÍA: «652.80151 → criptografía» (bien) cedería ante la tabla «652 → 65, gestión»
        // (mal: la criptografía cae bajo gestión en Dewey por una rareza de su jerarquía).
        //
        // Y solo con una entrada ESPECÍFICA de la tabla para esa clase, nunca con el respaldo genérico de la
        // letra (ver lccACDUEspecifica): «qp → 612» (fisiología, correcto) no debe ceder ante el «5» de la Q.
        //
        // (30-sep) Se amplía al RESPALDO DE LA LETRA: lo que motivó la excepción («qp → 612») ya está en la tabla, y
        // sin ella seguían vivas «tk → 004.738» (toda la electrotecnia como redes de ordenadores, 132 usos),
        // «tp → 542.8» o «gf → 302.2». Una equivalencia de CLASE que no afina lo que dice la tabla, no se usa.
        const tabla = sistema === 'lcc' ? lccACDU(codigo) : null;
        if (tabla && !String(hit).startsWith(String(tabla))) {
            avisarCacheContradictoria(sistema, codigo, hit, tabla);
            continue;   // la tabla decidirá en el paso 2
        }

        await enseñarBandas(hit, sistema, null);
        return { cdu: hit, fuente: `cache:${sistema}`, aprendida: true };
    }

    // 2) Crosswalk determinista Dewey/LC → CDU (gratis, sin IA).
    for (const [sistema, codigo] of candidatos) {
        const ext = await buscarEquivalenciaExterna(sistema, codigo);
        if (ext) {
            await enseñarBandas(ext, sistema, 'Manual');
            return { cdu: ext, fuente: `api:${sistema}`, aprendida: false };
        }
    }

    // Modo SIN IA (investigación «sin IA»): no se llama a la IA; se devuelve lo que el crosswalk determinista/
    // caché haya dado (o null). Así la CDU entrante, sin IA, es la del Fichero/APIs o la deducible sin coste.
    if (!permitirIA) return { cdu: null, fuente: 'sin-ia', aprendida: false, descripcion: null, palabras_clave: [] };

    // 3) IA + aprendizaje. Se aprende la equivalencia por CÓDIGO también para literatura (hay Dewey/LC → estable,
    //    ver arriba). La MISMA llamada trae ya la descripción y las materias → se aprovechan sin gastar más IA.
    const r = await iaCDU({ dewey, lcc, categorias, titulo, autor, sinopsis });
    // Una CDU mal formada («93.04.2», «94-(Normandy)») es un invento: ni se aplica ni se aprende.
    // Primero se intenta REPARAR (gratis): «94.02(6):71» → «94(6):71». Solo si no tiene arreglo se descarta.
    if (r.cdu && r.cdu !== '000' && !cduBienFormada(r.cdu)) {
        const reparada = repararCDU(r.cdu);
        if (reparada) {
            console.warn(`⚠️  [CDU] La IA devolvió una CDU mal formada («${r.cdu}») para «${String(titulo || '').slice(0, 50)}»: reparada → «${reparada}».`);
            r.cdu = reparada;
        } else {
            console.warn(`⚠️  [CDU] La IA devolvió una CDU mal formada («${r.cdu}») para «${String(titulo || '').slice(0, 50)}»: sin arreglo, se descarta.`);
            r.cdu = '000';
        }
    }
    const cdu = r.cdu;
    if (cdu && cdu !== '000' && candidatos.length > 0) {
        const [sistema] = candidatos[0]; // el más fiable disponible (Dewey > LC)
        await enseñarBandas(cdu, sistema, 'IA');   // aprende el primario (IA) y los otros presentes (inferido)
    }
    // (Ya NO se siembra aquí la descripción del código con la respuesta de la IA: describía el LIBRO, no el código —
    // «12 Epistemología y lógica: Willard Van Orman Quine», «908 Portugal»— y, si el código era equivocado, dejaba en
    // él la materia de otro libro para siempre: «572.4 Botánica – Fisiología vegetal» (8-oct). La descripción la hace
    // describirCDU a partir del CÓDIGO, con referencias.)
    return {
        cdu,
        fuente: 'ia',
        aprendida: false,
        descripcion: { titulo_es: r.titulo_es, descripcion_es: r.descripcion_es, titulo_en: r.titulo_en, descripcion_en: r.descripcion_en },
        palabras_clave: r.palabras_clave || [],
    };
}

// ── EQUIVALENCIAS CDU POR LOTE (una llamada de IA por N códigos) ─────────────────────────────────────────
// El coste real en un lote grande es deducir la CDU de códigos Dewey/LCC NUEVOS (uno por llamada). Aquí se
// resuelven MUCHOS códigos en UNA llamada (como las descripciones), y se APRENDEN en equivalencias_cdu → luego
// resolverCDU (y re-clasificar-cdu) los sirve gratis desde caché. Se trabaja por CÓDIGO, no por documento: la
// equivalencia es por código y la comparten todos los libros que lo usan.

// Convierte una lista de códigos Dewey/LCC a CDU en UNA llamada. Devuelve Map codigo → {cdu, titulo_es, …}.
async function iaCDULote(items) {
    const out = new Map();
    if (!items.length) return out;
    const lista = items.map((it, i) => `${i + 1}. ${String(it.sistema).toUpperCase()} "${it.codigo}"`).join('\n');
    const prompt = `Eres un bibliotecario catalogador experto en Clasificación Decimal Universal (CDU).
Convierte CADA código Dewey (DDC) o Library of Congress (LCC) de la lista a su código CDU equivalente.
Formato CDU: máx. 12 caracteres, sin subdivisiones alfabéticas.

LITERATURA (Dewey 8xx / LCC P*): clasifica por la TRADICIÓN/LENGUA que el propio código ya indica (Dewey 84x=francés,
83x=alemán, 82x=inglés, 86x=español…):
  ${TABLA_LIT}
NO ficción: por el tema (usa el Dewey/LC como guía). Si un código es demasiado genérico, da el CDU genérico
razonable (Dewey 800→82, 500→5, 300→3…). NUNCA inventes; ante la duda, el genérico.

${REGLAS_NOTACION_CDU}

CÓDIGOS:
${lista}

Responde ÚNICAMENTE con JSON válido (sin markdown):
{"resultados":[{"i":1,"cdu":"<CDU>","titulo_es":"<materia breve ES>","descripcion_es":"<1-2 frases ES>","titulo_en":"<subject EN>","descripcion_en":"<1-2 sentences EN>","palabras_clave":["m1","m2"]}]}
Un objeto por código, en el MISMO orden, con su "i" (1..${items.length}).`;
    let txt;
    try { txt = await conTexto({ prompt, json: true, maxTokens: 3200 }); }
    catch (e) { console.error(`❌ [CDU lote IA]: ${e.message}`); return out; }
    const j = extraerJSON(txt);
    const arr = Array.isArray(j) ? j : (j && (j.resultados || j.items)) || [];
    for (const r of arr) {
        const idx = Number(r.i) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) continue;
        const bruta = String(r.cdu || '').trim().replace(/^["']|["']$/g, '');
        // Mal formada: se repara si se puede; si no, no se aprende (se serviría a todos los libros de ese código).
        const cdu = bruta && bruta !== '000' ? repararCDU(bruta) : null;
        if (!cdu) continue;
        out.set(items[idx].codigo, {
            cdu, titulo_es: r.titulo_es || null, descripcion_es: r.descripcion_es || null,
            titulo_en: r.titulo_en || null, descripcion_en: r.descripcion_en || null,
            palabras_clave: Array.isArray(r.palabras_clave) ? r.palabras_clave.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 8) : [],
        });
    }
    return out;
}

// Códigos Dewey/LCC (de documentos con CDU POBRE) que aún NO están ni en caché ni en el crosswalk determinista
// → los únicos que necesitarían IA. Se cargan los códigos ya cacheados de una vez (en memoria) para no consultar
// la BD por cada código. `limite` acota cuántos devolver (para una tanda).
const CDU_POBRE_MATCH = { $or: [{ cdu: { $in: ['0', '00', '000'] } }, { cdu: { $exists: false } }, { cdu: null }] };
async function codigosPendientes(db, { limite = 500 } = {}) {
    const bib = db.collection('biblioteca');
    const base = { $and: [CDU_POBRE_MATCH, { obra: { $exists: false } }, { cdu_manual: { $ne: true } }] };
    const deweys = await bib.distinct('dewey', { $and: [base, { dewey: { $exists: true, $nin: [null, ''] } }] });
    // LCC solo de los que NO tienen Dewey (resolverCDU prueba Dewey primero; aprender el Dewey ya los resuelve).
    const lccs = await bib.distinct('lcc', { $and: [base, { $or: [{ dewey: { $exists: false } }, { dewey: { $in: [null, ''] } }] }, { lcc: { $exists: true, $nin: [null, ''] } }] });
    const cacheDe = async (sistema) => new Set((await db.collection('equivalencias_cdu')
        .find({ sistema_origen: sistema }, { projection: { codigo_origen: 1 } }).toArray()).map((e) => e.codigo_origen));
    const cacheDewey = await cacheDe('dewey');
    const cacheLcc = await cacheDe('lcc');
    const pend = [];
    for (const [sistema, valores, cacheSet] of [['dewey', deweys, cacheDewey], ['lcc', lccs, cacheLcc]]) {
        for (const c of valores) {
            if (pend.length >= limite) return pend;
            const codigo = String(c);
            if (cacheSet.has(normalizarCodigo(codigo))) continue;      // ya en caché
            if (await buscarEquivalenciaExterna(sistema, codigo)) continue; // determinista (gratis, no IA)
            pend.push({ sistema, codigo });
        }
    }
    return pend;
}

/** Nº de códigos Dewey/LCC pendientes de aprender (para la campaña). */
export async function contarEquivalenciasPendientes(db) {
    return (await codigosPendientes(db, { limite: 100000 })).length;
}

/**
 * PRE-CALIENTA la caché de equivalencias CDU: coge códigos Dewey/LCC pendientes (de docs con CDU pobre), los
 * resuelve POR LOTES (una llamada de IA cada `porLlamada`) y los APRENDE. Luego re-clasificar-cdu resuelve cada
 * documento gratis desde caché y mueve su carpeta. Devuelve { procesados, cambios, pendientes }.
 */
export async function precalentarEquivalencias(db, { limite = 60, porLlamada = 12, onProgreso } = {}) {
    const pend = await codigosPendientes(db, { limite });
    let procesados = 0, cambios = 0;
    for (let i = 0; i < pend.length; i += porLlamada) {
        const lote = pend.slice(i, i + porLlamada);
        const mapa = await iaCDULote(lote);
        for (const it of lote) {
            procesados++;
            const r = mapa.get(it.codigo);
            if (r && r.cdu) {
                await guardarEquivalencia(it.sistema, it.codigo, r.cdu, 'IA', r.titulo_es || null);
                // (La descripción del CÓDIGO CDU ya no se siembra con la del código de origen: ver arriba.)
                cambios++;
            }
            if (onProgreso) onProgreso(procesados, pend.length);
        }
    }
    return { procesados, cambios, pendientes: await contarEquivalenciasPendientes(db) };
}
