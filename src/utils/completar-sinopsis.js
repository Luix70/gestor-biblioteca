/**
 * RECUPERACIÓN DE SINOPSIS POR ISBN (sin IA).
 *
 * EL AGUJERO QUE TAPA: el 37% del catálogo no tenía sinopsis, y ninguna acción la rellenaba. La única tarea
 * que la tocaba era `re-enriquecer-degradados`, cuya condición es `esDegradado` (título no fiable, CDU
 * genérica, APIs caídas o estado 'pendiente'). Un documento LIMPIO pero sin sinopsis —lo que deja una ingesta
 * sin IA— no cumple ninguna de las cuatro, así que jamás se le buscaba.
 *
 * CÓMO: `buscarMetadatosExternos` ya encadena Fichero local (offline, 58,7 M registros, GRATIS y sin red) →
 * OpenLibrary → Google Books, y las tres traen sinopsis. Aquí solo se le pide eso y se guarda el resultado.
 * NUNCA se usa IA: los documentos SIN ISBN no tienen vía por aquí y se cuentan aparte (para esos, el camino
 * es primero «🔎 Extraer ISBN» y después esta acción).
 *
 * TRES CONSUMIDORES, un solo motor (mismo patrón que `reidentificar-doc.js`):
 *   · la tarea `completar-sinopsis` del Conformador (progresiva, al ralentí — no dispara límites de las APIs)
 *   · `scripts/completar-sinopsis.js` (backfill masivo, con freno configurable)
 *   · la acción «📝 Buscar sinopsis» del panel (selección del catálogo y ficha de un documento)
 */
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { variantesISBN } from './identificadores.js';

/** Sinopsis mínima aceptable: descarta restos tipo «.» o «Sin descripción» que no aportan nada. */
const SINOPSIS_MIN = 40;
const utilizable = (s) => typeof s === 'string' && s.trim().length >= SINOPSIS_MIN;

/**
 * Busca la sinopsis de UN documento por su ISBN.
 *
 * @param doc            documento de Mongo (necesita `isbn`)
 * @param soloFichero    true = SOLO el volcado local: cero red, cero riesgo de bloqueo por uso. Útil para
 *                       drenar el grueso del atraso sin tocar las APIs y dejar solo el resto para después.
 * @returns {Promise<{sinopsis:string|null, fuente:string|null}>}
 */
export async function buscarSinopsis(doc, { soloFichero = false } = {}) {
    const isbnVar = variantesISBN(doc.isbn);
    if (!isbnVar.length) return { sinopsis: null, fuente: null };   // sin ISBN válido no hay por dónde

    if (soloFichero) {
        try {
            const local = await buscarEnFicheroLocal({ isbns: isbnVar });
            return utilizable(local?.sinopsis)
                ? { sinopsis: local.sinopsis.trim(), fuente: 'fichero' }
                : { sinopsis: null, fuente: null };
        } catch { return { sinopsis: null, fuente: null }; }
    }

    try {
        // La cascada ya prueba Fichero → OpenLibrary → Google Books y se queda con el primer valor válido.
        const datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
            incluirSinopsis: true,
            incluirCdu: false,          // la CDU es asunto de re-clasificar-cdu; aquí solo estorbaría
            isbnsArchivo: isbnVar,
            idioma: doc.idioma || null,
            sinIA: true,                // explícito: esta vía NUNCA gasta IA
        });
        return utilizable(datos?.sinopsis)
            ? { sinopsis: datos.sinopsis.trim(), fuente: 'cascada' }
            : { sinopsis: null, fuente: null };
    } catch {
        return { sinopsis: null, fuente: null };   // API caída: se reintentará en otra pasada
    }
}

/**
 * Resuelve y (si `aplicar`) guarda la sinopsis de un documento.
 *
 * `forzar` reemplaza una sinopsis que YA existe. Sin él solo se rellenan huecos, que es la política
 * conservadora de toda la casa: lo extraído del fichero manda sobre lo que digan las fuentes externas.
 *
 * No se reindexa la búsqueda a propósito: el índice FTS no incluye la sinopsis. Sí se marca
 * `fecha_actualizacion`, que es lo que hace que la campaña de sidecars regenere el registro.json —
 * si no, la sinopsis viviría solo en Mongo y no llegaría a la copia en disco.
 *
 * Devuelve `{ estado, sinopsis }` —y no solo el estado— para que el llamante pueda ENSEÑAR lo que se
 * guardaría sin tener que volver a pedirlo (en un dry-run, repetir la consulta sería una llamada de red
 * malgastada por cada ejemplo mostrado).
 *
 * @returns {Promise<{estado:'recuperada'|'ya_tenia'|'sin_isbn'|'sin_fuente', sinopsis:string|null}>}
 */
export async function completarSinopsisDoc(db, doc, { aplicar = false, forzar = false, soloFichero = false } = {}) {
    if (doc.sinopsis && !forzar) return { estado: 'ya_tenia', sinopsis: null };
    if (!doc.isbn) return { estado: 'sin_isbn', sinopsis: null };

    const { sinopsis } = await buscarSinopsis(doc, { soloFichero });
    if (!sinopsis) return { estado: 'sin_fuente', sinopsis: null };
    if (doc.sinopsis && sinopsis.trim() === String(doc.sinopsis).trim()) return { estado: 'ya_tenia', sinopsis: null };

    if (aplicar) {
        await db.collection('biblioteca').updateOne(
            { _id: doc._id },
            { $set: { sinopsis, fecha_actualizacion: new Date() } },
        );
    }
    return { estado: 'recuperada', sinopsis };
}

// ─── Trabajo en 2.º plano (mismo patrón que reidentificar-doc.js: el panel lo sondea y puede cancelarlo) ───

let trabajo = {
    en_curso: false, total: 0, hechos: 0,
    recuperadas: 0, ya_tenia: 0, sin_isbn: 0, sin_fuente: 0,
    titulo: '', cancelar: false, ts: null,
};

export function estadoCompletarSinopsis() { return { ...trabajo }; }
export function cancelarCompletarSinopsis() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

/**
 * Lanza el proceso para una lista de documentos. Devuelve enseguida; el progreso se consulta con
 * `estadoCompletarSinopsis()`.
 *
 * `pausaMs` frena entre documentos para no disparar los límites de uso de las APIs. Con `soloFichero`
 * no hace falta ninguna pausa (no hay red), y por eso se ignora.
 */
export function lanzarCompletarSinopsis({ ids, forzar = false, soloFichero = false, pausaMs = 250 } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una búsqueda de sinopsis en curso' };

    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };

    trabajo = {
        en_curso: true, total: lista.length, hechos: 0,
        recuperadas: 0, ya_tenia: 0, sin_isbn: 0, sin_fuente: 0,
        titulo: '', cancelar: false, ts: new Date().toISOString(),
    };

    (async () => {
        try {
            const db = await conectarDB();
            const col = db.collection('biblioteca');
            for (const _id of lista) {
                if (trabajo.cancelar) break;
                const doc = await col.findOne({ _id }, { projection: { titulo: 1, isbn: 1, sinopsis: 1, idioma: 1 } });
                if (!doc) { trabajo.hechos++; continue; }
                trabajo.titulo = doc.titulo || '';
                try {
                    const { estado } = await completarSinopsisDoc(db, doc, { aplicar: true, forzar, soloFichero });
                    trabajo[estado === 'recuperada' ? 'recuperadas' : estado]++;
                } catch { trabajo.sin_fuente++; }
                trabajo.hechos++;
                if (!soloFichero && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs));
            }
        } catch (e) {
            console.error('❌ completar-sinopsis:', e.message);
        } finally {
            trabajo.en_curso = false;
            trabajo.titulo = '';
        }
    })();

    return { ok: true, total: lista.length };
}
