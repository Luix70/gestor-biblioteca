import { conectarDB } from './database.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
async function buscarEquivalenciaExterna(/* sistema, codigo */) {
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

/** Deriva una CDU con IA, convirtiendo desde Dewey/LC si están disponibles. */
async function iaCDU({ dewey, lcc, categorias, titulo, autor, sinopsis }) {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
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
Devuelve SOLO el código CDU, sin explicación. Máx. 12 caracteres, sin subdivisiones alfabéticas,
":" como separador de materias como máximo una vez.

═══ REGLAS (en orden de prioridad) ═══

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
        `.trim();
        const result = await model.generateContent(prompt);
        return result.response.text().trim().replace(/^["']|["']$/g, '');
    } catch (e) {
        console.error(`❌ [Clasificador CDU IA]: ${e.message}`);
        return '000';
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

    // 3) IA + aprendizaje (solo aprende equivalencias no literarias; la ficción varía por autor).
    const cdu = await iaCDU({ dewey, lcc, categorias, titulo, autor, sinopsis });
    if (cdu && cdu !== '000' && candidatos.length > 0 && !esLit) {
        const [sistema, codigo] = candidatos[0]; // el más fiable disponible (Dewey > LC)
        await guardarEquivalencia(sistema, codigo, cdu, 'IA', categoria);
    }
    return { cdu, fuente: 'ia', aprendida: false };
}
