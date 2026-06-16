import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { buscarPorCriterios } from './buscador-bibliografico.js';

/**
 * Analiza una imagen en base64 para extraer metadatos bibliográficos.
 */
async function analizarImagenConIA(base64Image) {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
                Eres un bibliotecario experto. Analiza la imagen y busca el ISBN (identificador bibliográfico internacional). 
                No asumas que empieza por 978; puede tener 10 o 13 dígitos y distintos prefijos.
                Responde ÚNICAMENTE en JSON: {"isbn": "valor", "editorial": "valor", "año_edicion": 20XX}. 
                Si no encuentras el ISBN, búscalo en el texto. ¡NO devuelvas null si el número está en la imagen!
                `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
        ]);

        const textoRespuesta = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(textoRespuesta);
    } catch (e) {
        console.error(`❌ [Error Visión IA]: ${e.message}`);
        return null;
    }
}

/**
 * Determina la CDU basándose en metadatos y contexto.
 */
async function obtenerCdu(titulo, sinopsis, categoria_origen, fuente_categoria) {
    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = `
            Actúa como un bibliotecario catalogador experto. Asigna la Clasificación Decimal Universal (CDU) al libro.
            REGLAS:
            1. Precisión máxima, máximo 12 caracteres.
            2. Prohibido usar subdivisiones alfabéticas (ej: "(HEIDEGGER, M.)").
            3. Si necesitas cruzar materias, usa ":" una sola vez.
            4. Responde SOLO con el código (ej: "141.78:81'37").
            Datos: Título: "${titulo}", Sinopsis: "${sinopsis || 'N/A'}", Cat. Origen: "${categoria_origen || 'N/A'}"
        `;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (error) {
        console.error(`❌ [Error IA CDU]: ${error.message}`);
        return '000';
    }
}

/**
 * Flujo maestro de enriquecimiento.
 */
export async function buscarMetadatosExternos(titulo, autor, imagenBase64 = null) {
    let datosExtra = {
        isbn: null,
        sinopsis: null,
        editorial: null,
        cdu: null,
        alertas: []
    };

    // 1. Visión Multimodal (si hay imagen)
    if (imagenBase64) {
        const infoIA = await analizarImagenConIA(imagenBase64);
        if (infoIA) {
            datosExtra.isbn = infoIA.isbn;
            datosExtra.editorial = infoIA.editorial;
            datosExtra.alertas.push("IA extrajo metadatos de la imagen.");
        }
    }

    // 2. Validación cruzada en base de datos global
    const infoValidada = await buscarPorCriterios({ 
        isbn: datosExtra.isbn, 
        titulo: titulo, 
        editorial: datosExtra.editorial 
    });

    if (infoValidada) {
        datosExtra.isbn = infoValidada.isbn || datosExtra.isbn;
        datosExtra.editorial = infoValidada.editorial || datosExtra.editorial;
        datosExtra.sinopsis = infoValidada.sinopsis || datosExtra.sinopsis;
        datosExtra.alertas.push("Datos validados contra OpenLibrary.");
    }

    // 3. Resolución final de la CDU
    datosExtra.cdu = await obtenerCdu(titulo, datosExtra.sinopsis, null, "IA + API");

    return datosExtra;
}