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

/** Deriva una CDU con IA, convirtiendo desde Dewey/LC si están disponibles. */
async function iaCDU({ dewey, lcc, categoria, titulo, sinopsis }) {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = `
            Actúa como bibliotecario catalogador experto en Clasificación Decimal Universal (CDU).
            Devuelve SOLO el código CDU (máx. 12 caracteres, sin subdivisiones alfabéticas, ":" como máximo una vez).
            ${dewey ? `Código Dewey (DDC) de origen: "${dewey}". Conviértelo a su CDU equivalente.` : ''}
            ${lcc ? `Clasificación Library of Congress: "${lcc}".` : ''}
            ${categoria ? `Categoría temática: "${categoria}".` : ''}
            Título: "${titulo || 'N/A'}". Sinopsis: "${(sinopsis || 'N/A').slice(0, 400)}".
        `;
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
export async function resolverCDU({ dewey, lcc, categoria, titulo, sinopsis }) {
    const candidatos = [['dewey', dewey], ['lcc', lcc]].filter(([, c]) => c);

    // 1) Caché aprendida.
    for (const [sistema, codigo] of candidatos) {
        const hit = await buscarEquivalencia(sistema, codigo);
        if (hit) return { cdu: hit, fuente: `cache:${sistema}`, aprendida: true };
    }

    // 2) Fuente externa (preparada, aún sin proveedor).
    for (const [sistema, codigo] of candidatos) {
        const ext = await buscarEquivalenciaExterna(sistema, codigo);
        if (ext) {
            await guardarEquivalencia(sistema, codigo, ext, 'Manual', categoria);
            return { cdu: ext, fuente: `api:${sistema}`, aprendida: false };
        }
    }

    // 3) IA + aprendizaje.
    const cdu = await iaCDU({ dewey, lcc, categoria, titulo, sinopsis });
    if (cdu && cdu !== '000' && candidatos.length > 0) {
        const [sistema, codigo] = candidatos[0]; // el más fiable disponible (Dewey > LC)
        await guardarEquivalencia(sistema, codigo, cdu, 'IA', categoria);
    }
    return { cdu, fuente: 'ia', aprendida: false };
}
