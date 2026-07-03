import { conTexto, extraerJSON } from './vision.js';

/**
 * Descripciones (ES) de códigos Dewey (DDC) y Library of Congress (LCC), análogo a `descripcion-cdu.js`
 * pero para esos dos sistemas. Cacheado en la colección `clasificacion_descripciones` (clave
 * {sistema, codigo}); en un fallo (IA/JSON) devuelve null y se reintenta luego (no inserta basura).
 * El CDU NO pasa por aquí: tiene su propia tabla `cdu_descripciones` (ver `describirCDU`).
 */
const NOMBRES = {
    dewey: 'Clasificación Decimal Dewey (DDC)',
    lcc: 'Library of Congress Classification (LCC)',
};

const prompt = (sistema, codigo) => `Eres un bibliotecario experto en la ${NOMBRES[sistema] || sistema}.
Para el código "${codigo}" de la ${NOMBRES[sistema] || sistema}, redacta:
- un título BREVE en español (la materia que designa, pocas palabras),
- una explicación RIGUROSA y EXTENSA en español (uno o dos párrafos) desglosando la jerarquía del
  código (clase, división, sección y subdivisiones que apliquen).
Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto fuera del JSON):
{"titulo_es":"<título breve>","descripcion_es":"<explicación extensa>"}`;

async function generarIA(sistema, codigo) {
    const txt = await conTexto({ prompt: prompt(sistema, codigo), json: true, maxTokens: 1200 });
    const j = extraerJSON(txt);
    if (!j) throw new Error('respuesta de IA no parseable');
    return j;
}

/**
 * Guarda en caché la descripción Dewey/LCC a partir de datos YA obtenidos (p. ej. una llamada por LOTE),
 * sin gastar IA. Idempotente: si ya existe, no la pisa. Devuelve el doc guardado/existente o null.
 */
export async function guardarDescripcionClasificacion(db, sistema, codigo, datos = {}) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    if (!['dewey', 'lcc'].includes(sistema) || !codigo) return null;
    if (!datos || (!datos.titulo_es && !datos.descripcion_es)) return null;
    const col = db.collection('clasificacion_descripciones');
    if (await col.findOne({ sistema, codigo })) return null; // ya cacheada
    const doc = {
        sistema, codigo,
        titulo_es: datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        fuente: 'ia', verificado: false, fecha: new Date(),
    };
    try { await col.insertOne(doc); return doc; }
    catch { return await col.findOne({ sistema, codigo }); }
}

/**
 * Asegura que un código Dewey/LCC tenga descripción en `clasificacion_descripciones`. Cacheado: si ya
 * existe la devuelve sin llamar a la IA. Best-effort: ante fallo devuelve null.
 * @returns el documento de descripción (existente o nuevo) o null.
 */
export async function describirClasificacion(db, sistema, codigo) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    if (!['dewey', 'lcc'].includes(sistema) || !codigo) return null;

    const col = db.collection('clasificacion_descripciones');
    const ya = await col.findOne({ sistema, codigo });
    if (ya) return ya;

    let datos;
    try { datos = await generarIA(sistema, codigo); } catch { return null; }

    const doc = {
        sistema, codigo,
        titulo_es: datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        fuente: 'ia', verificado: false, fecha: new Date(),
    };
    try { await col.insertOne(doc); return doc; }
    catch { return await col.findOne({ sistema, codigo }); } // carrera: lo insertó otro
}
