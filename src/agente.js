import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// CONFIGURACIÓN DE RIGIDEZ GRAMATICAL: Forzamos salida JSON nativa a nivel de API
const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: { 
        responseMimeType: "application/json" 
    }
});

const INSTRUCCIONES_SISTEMA = `
Eres un bibliotecario experto y un sistema de extracción de metadatos estructurados. 
Tu objetivo es analizar las imág/enes provistas (pueden ser una o varias correspondientes al mismo recurso, como portada, lomo o contraportada) y consolidar la información en un ÚNICAMENTE objeto JSON válido. 

REGLAS DE EXTRACCIÓN Y VALIDACIÓN:
1. 'tipo_recurso': Debe ser "libro" o "revista".
2. 'cdu': Infiere el código de Clasificación Decimal Universal más apropiado (ej. "52" para astronomía, "821" para literatura). ¡Obligatorio clasificarlo con rigor!
3. 'idioma': Código ISO 639-1 de dos letras (ej. "es", "en", "de").
4. 'formatos': Por defecto usa ["papel"].
5. 'isbn' / 'issn': Revisa minuciosamente todas las imágenes (especialmente códigos de barras en contraportadas). Extrae el número continuo sin guiones.
6. 'estado_verificacion': Si consigues extraer con total claridad el título y el ISBN/Editorial, establece "completado". Si faltan datos o las imágenes no permiten certificar los metadatos obligatorios, establece "pendiente".
7. 'alertas_agente': Si el estado es "pendiente", detalla los motivos en este array de texto.
8. 'sinopsis': Genera un resumen de dos líneas con tus propias palabras. ¡PROHIBIDO copiar o transcribir textualmente párrafos de la imagen para evitar bloqueos por copyright (RECITATION)!
ESTRUCTURA JSON REQUERIDA:
{
  "tipo_recurso": "libro|revista",
  "titulo": "string",
  "cdu": "string",
  "idioma": "string",
  "formatos": ["papel"],
  "isbn": "string",
  "editorial": "string",
  "año_edicion": number,
  "sinopsis": "string",
  "palabras_clave": ["tag1", "tag2"],
  "estado_verificacion": "completado|pendiente",
  "alertas_agente": []
}
`;

/**
 * Procesa un grupo de imágenes (`{ data: Buffer, mimeType: string }`) del mismo recurso y
 * extrae la ficha técnica unificada. Asimila metadatos de texto nativos si provienen de un EPUB.
 */
export async function analizarImagenesRecurso(imagenes, datosEpub = null) {
    try {
        const imageParts = imagenes.map(({ data, mimeType }) => ({
            inlineData: {
                data: data.toString("base64"),
                mimeType: mimeType || "image/jpeg"
            }
        }));

        // Inyección dinámica de metadatos nativos para dar máxima prioridad a los datos del archivo
        let instruccionesContextuales = INSTRUCCIONES_SISTEMA;
        if (datosEpub) {
            instruccionesContextuales += `\n\n⚠️ ENTORNO DIGITAL - NOTA PRIORITARIA:\nEl recurso actual es un libro digital (EPUB). El analizador nativo ha extraído el siguiente manifiesto:\n${JSON.stringify(datosEpub, null, 2)}\nUsa estos datos como fuente de verdad absoluta. Tu tarea principal aquí es verificar si el ISBN es correcto, estructurar la sinopsis final, e inferir con el máximo rigor la Clasificación Decimal Universal ('cdu') y las 'palabras_clave'.`;
        }

        console.log(`\n──> [IA] Enviando ${imageParts.length} imagen(es) combinada(s) al pipeline de Gemini...`);
        
        const result = await model.generateContent([instruccionesContextuales, ...imageParts]);
        const responseText = result.response.text();
        
        const recursoEstructurado = JSON.parse(responseText.trim());
        recursoEstructurado.fecha_ingreso = new Date();
        return recursoEstructurado;

    } catch (error) {
        console.error('\n❌ [ERROR IA]:', error.message);
        throw new Error(`Fallo IA: ${error.message}`);
    }


}