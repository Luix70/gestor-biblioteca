import { conGemini } from './gemini.js';

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
    const res = await conGemini({ model: 'gemini-2.5-flash' }, (model) => model.generateContent(prompt(sistema, codigo)));
    const txt = res.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(txt);
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
