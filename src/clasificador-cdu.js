import { conectarDB } from './database.js';
import { conTexto, extraerJSON } from './utils/vision.js';
import { sembrarDescripcionCDU } from './utils/descripcion-cdu.js';

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

/** Busca una equivalencia ya aprendida. Tolerante a fallos de Mongo (devuelve null). */
export async function buscarEquivalencia(sistema, codigo) {
    if (!codigo) return null;
    try {
        const db = await conectarDB();
        const doc = await db.collection(COL).findOne({ sistema_origen: sistema, codigo_origen: normalizarCodigo(codigo) });
        if (doc) {
            db.collection(COL).updateOne({ _id: doc._id }, { $inc: { usos: 1 } }).catch(() => {});
            return doc.cdu;
        }
        return null;
    } catch {
        return null;
    }
}

/** Aprende/actualiza una equivalencia para reutilizarla la próxima vez. */
export async function guardarEquivalencia(sistema, codigo, cdu, fuente = 'IA', descripcion) {
    if (!codigo || !cdu) return;
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
function deweyACDU(codigo) {
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
        '000': '0', '010': '01', '020': '02', '030': '03', '050': '05', '060': '06', '070': '07', '080': '08', '090': '09',
        '100': '1', '110': '11', '140': '14', '160': '16', '170': '17',
        '200': '2', '220': '22', '230': '23', '290': '29',
        '300': '3', '310': '31', '320': '32', '330': '33', '340': '34', '350': '35', '360': '36', '370': '37', '390': '39',
        '900': '9', '910': '91', '920': '929',
    };
    return EXACTAS[d] || null;   // el resto (130, 15x, 4xx, 8xx, historia regional…) → IA
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
    BL: '2', BM: '2', BP: '2', BQ: '2', BR: '2', BS: '2', BT: '2', BV: '2', BX: '2',
    // Ciencias auxiliares de la historia · genealogía/biografía  (D/E/F historia → diferido, necesita área)
    C: '93', CS: '929', CT: '929',
    // Geografía · antropología · folclore · deporte
    G: '91', GB: '551', GC: '551.46', GE: '502', GN: '39', GR: '398', GV: '79',
    // Ciencias sociales
    H: '3', HA: '31', HB: '33', HC: '33', HD: '33', HE: '656', HF: '33', HG: '33', HM: '316', HN: '316', HQ: '316.3', HT: '316', HV: '36',
    // Ciencia política
    J: '32', JX: '327', JZ: '327',
    // Derecho · educación · música
    K: '34', L: '37', M: '78',
    // Bellas artes
    N: '7', NA: '72', NB: '73', NC: '74', ND: '75', NE: '76', NK: '745',
    // Lengua y literatura (SOLO tradición/idioma único; las multi-idioma PA/PQ/PT/PG/PJ/PK/PL/PM → IA)
    PN: '82', PZ: '82', PE: '811.111', PC: '811.13', PR: '821.111', PS: '821.111(73)',
    // Ciencia
    Q: '5', QA: '51', QB: '52', QC: '53', QD: '54', QE: '55', QH: '57', QK: '58', QL: '59',
    // Medicina · agricultura · técnica
    R: '61', S: '63', T: '6',
    // Ciencia militar · naval · biblioteconomía
    U: '355', V: '359', Z: '02',
};
function claseLcc(codigo) {
    const m = String(codigo || '').trim().toUpperCase().match(/^[A-Z]{1,3}/);
    return m ? m[0] : null;
}
function lccACDU(codigo) {
    const letras = claseLcc(codigo);
    if (!letras) return null;
    return LCC_A_CDU[letras.slice(0, 2)] || LCC_A_CDU[letras[0]] || null;
}

/**
 * «Fuente externa» = crosswalk DETERMINISTA (no una API: la CDU deriva del Dewey). Devuelve la CDU o null.
 * Lo que devuelve se APRENDE en la caché de equivalencias (como 'Manual'), así que debe ser CORRECTO — por eso
 * es conservador: mapea solo lo que alinea con certeza y deja lo dudoso a la IA.
 */
async function buscarEquivalenciaExterna(sistema, codigo) {
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
export async function resolverCDU({ dewey, lcc, categorias = [], titulo, autor, sinopsis, permitirIA = true }) {
    // Los códigos se manejan por su UNIDAD de equivalencia: Dewey tal cual; LCC por su CLASE (letras iniciales),
    // no la signatura completa — si no, «PR4589.H39 1998» se guardaría entero y no lo reusaría ningún otro libro.
    const candidatos = [['dewey', dewey], ['lcc', claseLcc(lcc)]].filter(([, c]) => c);
    const categoria = Array.isArray(categorias) && categorias.length > 0 ? categorias[0] : null;

    // APRENDIZAJE A TRES BANDAS (LCC ↔ Dewey ↔ CDU): un libro que trae Dewey Y LCC es un par de entrenamiento
    // gratis. Al resolver la CDU por UN código, se enseña la MISMA CDU a los OTROS códigos presentes, para que un
    // futuro libro que solo traiga ese otro código la herede sin IA (el caso «solo LCC» del Dickens). Se hace
    // SOLO donde el crosswalk determinista NO llega (así una inferencia nunca contradice/ensombrece al crosswalk)
    // y como 'inferido' (no verificado: un mapeo Manual futuro lo corrige).
    const enseñarBandas = async (cdu, resueltoPor, fuentePrimaria) => {
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
        const hit = await buscarEquivalencia(sistema, codigo);
        if (hit) { await enseñarBandas(hit, sistema, null); return { cdu: hit, fuente: `cache:${sistema}`, aprendida: true }; }
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
    const cdu = r.cdu;
    if (cdu && cdu !== '000' && candidatos.length > 0) {
        const [sistema] = candidatos[0]; // el más fiable disponible (Dewey > LC)
        await enseñarBandas(cdu, sistema, 'IA');   // aprende el primario (IA) y los otros presentes (inferido)
    }
    // Sembrar la descripción del código en su caché AHORA (misma llamada IA): evita la 2ª llamada de
    // describirCDU que el panel/mantenimiento harían después. Idempotente y best-effort.
    if (cdu && cdu !== '000' && (r.descripcion_es || r.titulo_es)) {
        try { const db = await conectarDB(); await sembrarDescripcionCDU(db, cdu, r); } catch { /* caché best-effort */ }
    }
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
        const cdu = String(r.cdu || '').trim().replace(/^["']|["']$/g, '');
        if (!cdu || cdu === '000') continue;
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
                if (r.descripcion_es || r.titulo_es) { try { await sembrarDescripcionCDU(db, r.cdu, r); } catch { /* best-effort */ } }
                cambios++;
            }
            if (onProgreso) onProgreso(procesados, pend.length);
        }
    }
    return { procesados, cambios, pendientes: await contarEquivalenciasPendientes(db) };
}
