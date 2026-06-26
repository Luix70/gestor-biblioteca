import { conGemini } from './gemini.js';
import { sanitizarCDU, arbolCDU } from './cdu-arbol.js';

/**
 * Tabla de descripciones de códigos CDU (colección 'cdu_descripciones'), bilingüe ES/EN.
 * Clave: el código CDU limpio (sanitizarCDU → sin literales ni mojibake, con auxiliares).
 * El front-end une libro.cdu → sanitizarCDU → cdu_descripciones para mostrar la materia.
 */

const prompt = (codigo) => `Eres un bibliotecario experto en la Clasificación Decimal Universal (CDU/UDC).
Para el código CDU "${codigo}", redacta una descripción RIGUROSA y EXTENSA (uno o dos párrafos por
idioma), DESGLOSANDO cada componente: clase principal y divisiones, y los auxiliares comunes que
aparezcan, p. ej.:
  -05 personas · -055.2 mujeres · (4/9) lugar · "..." tiempo · =... lengua · .0... auxiliar especial
  : y + relaciones/combinaciones · (0...) forma del documento.
Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto fuera del JSON):
{
  "titulo_es": "<título breve en español>",
  "descripcion_es": "<explicación extensa en español, con el desglose de cada componente>",
  "titulo_en": "<short title in English>",
  "descripcion_en": "<extensive explanation in English, with the breakdown of each component>"
}`;

async function generarIA(codigo) {
    const res = await conGemini({ model: 'gemini-2.5-flash' }, (model) => model.generateContent(prompt(codigo)));
    const txt = res.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
    return JSON.parse(txt);
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
        datos = await generarIA(codigo);
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
