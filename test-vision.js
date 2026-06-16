import 'dotenv/config';
import fs from 'fs/promises';
import { GoogleGenerativeAI } from '@google/generative-ai';

async function testVision() {
    console.log("👁️ Probando capacidad de visión de Gemini...");

    try {
        // 1. Cargamos tu imagen de créditos
        const imageBuffer = await fs.readFile('./content.jfif');
        const base64Image = imageBuffer.toString('base64');

        // 2. Inicializamos Gemini
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim());
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // 3. Prompt de extracción de metadatos
            const prompt = `
            Eres un bibliotecario experto. Extrae de esta imagen de créditos los datos exactos.
            Busca el ISBN (cadena de 13 dígitos empezando por 978). Es obligatorio extraerlo si está presente.
            Responde ÚNICAMENTE en JSON: {"isbn": "978...", "editorial": "...", "año_edicion": 20XX}. 
            Si no encuentras el ISBN, búscalo en el texto. ¡NO devuelvas null si el número está en la imagen!
            `;

        const result = await model.generateContent([
            prompt,
            { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
        ]);

        console.log("✅ [ÉXITO] Datos extraídos:");
        console.log(result.response.text());

    } catch (error) {
        console.error("❌ [FALLO] Error en la visión:", error.message);
    }
}

testVision();