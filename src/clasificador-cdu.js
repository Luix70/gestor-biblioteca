import { conectarDB } from './database.js';
import { conTexto, extraerJSON } from './utils/vision.js';
import { sembrarDescripcionCDU } from './utils/descripcion-cdu.js';

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

// LC → CDU: solo las clases de CIENCIA/TÉCNICA de correspondencia clara (la mayoría de libros técnicos traen
// TAMBIÉN Dewey, que se prueba primero; esto es la red para los que solo llevan signatura LC).
const LCC_A_CDU = {
    Q: '5', QA: '51', QB: '52', QC: '53', QD: '54', QE: '55', QH: '57', QK: '58', QL: '59',
    R: '61', S: '63', T: '6',
};
function lccACDU(codigo) {
    const m = String(codigo || '').trim().toUpperCase().match(/^[A-Z]{1,3}/);
    if (!m) return null;
    const letras = m[0];
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

        // Tabla de nacionalidades literarias conocidas, para el prompt
        const tablaLit = [
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
export async function resolverCDU({ dewey, lcc, categorias = [], titulo, autor, sinopsis }) {
    const candidatos = [['dewey', dewey], ['lcc', lcc]].filter(([, c]) => c);
    const categoria = Array.isArray(categorias) && categorias.length > 0 ? categorias[0] : null;

    // 1) Caché aprendida. Solo se usa si el código NO es de literatura (para evitar cache
    //    poisoning: una entrada dewey:891.73→616.89 incorrecta puede haberse aprendido antes).
    const esLit = esFiccionLiteratura({ dewey, lcc, categorias });
    if (!esLit) {
        for (const [sistema, codigo] of candidatos) {
            const hit = await buscarEquivalencia(sistema, codigo);
            if (hit) return { cdu: hit, fuente: `cache:${sistema}`, aprendida: true };
        }
    }

    // 2) Fuente externa (preparada, aún sin proveedor).
    for (const [sistema, codigo] of candidatos) {
        const ext = await buscarEquivalenciaExterna(sistema, codigo);
        if (ext) {
            await guardarEquivalencia(sistema, codigo, ext, 'Manual', categoria);
            return { cdu: ext, fuente: `api:${sistema}`, aprendida: false };
        }
    }

    // 3) IA + aprendizaje (solo aprende equivalencias no literarias; la ficción varía por autor). La MISMA
    //    llamada trae ya la descripción y las materias → se aprovechan sin gastar más IA.
    const r = await iaCDU({ dewey, lcc, categorias, titulo, autor, sinopsis });
    const cdu = r.cdu;
    if (cdu && cdu !== '000' && candidatos.length > 0 && !esLit) {
        const [sistema, codigo] = candidatos[0]; // el más fiable disponible (Dewey > LC)
        await guardarEquivalencia(sistema, codigo, cdu, 'IA', r.titulo_es || categoria);
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
