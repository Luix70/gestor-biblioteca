import dotenv from 'dotenv';
import { conGemini } from './utils/gemini.js';
import { decodificarCodigoBarras } from './utils/codigo-barras.js';

dotenv.config();

// CONFIGURACIÓN DE RIGIDEZ GRAMATICAL: Forzamos salida JSON nativa a nivel de API.
// El cliente (con fallback free→pago) se construye por llamada en conGemini().
const MODELO_VISION = {
    model: "gemini-2.5-flash",
    generationConfig: {
        responseMimeType: "application/json"
    }
};

const INSTRUCCIONES_SISTEMA = `
Eres un bibliotecario experto y un sistema de extracción de metadatos estructurados.
Tu objetivo es analizar las imágenes provistas (pueden ser una o varias del mismo recurso: portada, lomo, contraportada, o páginas interiores como la portadilla y la página de créditos/copyright de un PDF escaneado) y consolidar la información en ÚNICAMENTE un objeto JSON válido.

REGLAS DE EXTRACCIÓN Y VALIDACIÓN:
1. 'tipo_recurso': Debe ser "libro" o "revista".
2. 'titulo': El título real de la obra tal como aparece en la portada o portadilla. NO inventes.
3. 'autores': Array con los nombres de los autores/autoras tal como aparecen (en la portada o en la página de créditos/copyright, p. ej. "© 2004 Raph Koster"). Si no hay autor visible, deja el array vacío.
4. 'cdu': Infiere el código de Clasificación Decimal Universal más apropiado (ej. "52" para astronomía, "821" para literatura). ¡Obligatorio clasificarlo con rigor!
5. 'idioma': Código ISO 639-1 de dos letras (ej. "es", "en", "de").
6. 'formatos': Por defecto usa ["papel"].
7. 'isbn' / 'issn': Revisa minuciosamente todas las imágenes: códigos de barras (contraportada) Y el texto de la página de créditos ("ISBN: ..."). Extrae el número continuo sin guiones. Si no estás seguro, déjalo vacío en vez de inventarlo.
8. 'estado_verificacion': Si consigues extraer con total claridad el título y el ISBN/Editorial, establece "completado". Si faltan datos o las imágenes no permiten certificar los metadatos obligatorios, establece "pendiente".
9. 'alertas_agente': Si el estado es "pendiente", detalla los motivos en este array de texto.
10. 'sinopsis': Genera un resumen de dos líneas con tus propias palabras. ¡PROHIBIDO copiar o transcribir textualmente párrafos de la imagen para evitar bloqueos por copyright (RECITATION)!
11. 'codigo_barras': Lee y transcribe los DÍGITOS del código de barras EAN-13 (los números impresos bajo las barras de la cubierta o contracubierta), EXACTAMENTE como aparecen y sin guiones (13 dígitos). Si a la derecha del código de barras hay un pequeño código adicional de 2 a 5 dígitos (add-on), transcríbelo aparte en 'codigo_barras_sufijo'. NO inventes dígitos: si no los lees con seguridad, deja ambos campos vacíos. (Pista: un EAN-13 que empieza por 977 corresponde a una REVISTA; 978/979 a un LIBRO.)
ESTRUCTURA JSON REQUERIDA:
{
  "tipo_recurso": "libro|revista",
  "titulo": "string",
  "autores": ["string"],
  "cdu": "string",
  "idioma": "string",
  "formatos": ["papel"],
  "isbn": "string",
  "issn": "string",
  "codigo_barras": "string",
  "codigo_barras_sufijo": "string",
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
        
        const result = await conGemini(MODELO_VISION, (model) => model.generateContent([instruccionesContextuales, ...imageParts]));
        const responseText = result.response.text();
        
        const recursoEstructurado = JSON.parse(responseText.trim());

        // CÓDIGO DE BARRAS: decodifica el EAN-13 leído de la cubierta. 977 → ISSN (revista) + nº de
        // ejemplar (del add-on); 978/979 → ISBN. Rellena SOLO huecos (no pisa lo ya extraído) y, ante
        // un 977 válido sin ISBN propio, fija tipo_recurso='revista' (un libro llevaría 978/979).
        const bc = decodificarCodigoBarras(recursoEstructurado.codigo_barras, recursoEstructurado.codigo_barras_sufijo);
        if (bc) {
            if (bc.issn && !recursoEstructurado.issn) recursoEstructurado.issn = bc.issn;
            if (bc.isbn && !recursoEstructurado.isbn) recursoEstructurado.isbn = bc.isbn;
            if (bc.numero_issue && recursoEstructurado.numero_issue == null) recursoEstructurado.numero_issue = bc.numero_issue;
            if (bc.esRevista && !recursoEstructurado.isbn) recursoEstructurado.tipo_recurso = 'revista';
            recursoEstructurado.alertas_agente = [...(recursoEstructurado.alertas_agente || []),
                `Código de barras leído: ${bc.issn || bc.isbn}${bc.numero_issue ? ' · nº ' + bc.numero_issue : ''}.`];
        }
        delete recursoEstructurado.codigo_barras;          // no se persisten (no son campos del esquema)
        delete recursoEstructurado.codigo_barras_sufijo;

        recursoEstructurado.fecha_ingreso = new Date();
        return recursoEstructurado;

    } catch (error) {
        console.error('\n❌ [ERROR IA]:', error.message);
        throw new Error(`Fallo IA: ${error.message}`);
    }


}