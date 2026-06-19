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
        const prompt = `
Actúa como bibliotecario catalogador experto en Clasificación Decimal Universal (CDU).
Devuelve SOLO el código CDU (máx. 12 caracteres, sin subdivisiones alfabéticas, ":" como máximo una vez).

REGLA CRÍTICA — OBRAS DE FICCIÓN Y LITERATURA:
Si la obra es ficción (novela, cuento, poesía, teatro) o literatura en general, DEBES clasificarla
bajo 82x según la TRADICIÓN LITERARIA DEL AUTOR, NO por el tema de la obra.
  Literatura rusa   → 821.161.1
  Literatura española → 821.134.2
  Literatura inglesa  → 821.111
  Literatura francesa → 821.133.1
  Literatura alemana  → 821.112.2
  Literatura italiana → 821.131.1
Un cuento sobre un manicomio escrito por un autor ruso es "literatura rusa" (821.161.1), NO "psiquiatría" (616.89).
Un poema de amor es literatura de la lengua del autor, no "amor" (159.9).
${esLiteratura ? 'ESTA OBRA ES LITERATURA/FICCIÓN: aplica obligatoriamente la regla anterior.' : ''}

${dewey ? `Código Dewey (DDC): "${dewey}". Conviértelo a CDU.` : ''}
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
