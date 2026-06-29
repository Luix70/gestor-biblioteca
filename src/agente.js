import dotenv from 'dotenv';
import { conVision, extraerJSON } from './utils/vision.js';
import { decodificarCodigoBarras } from './utils/codigo-barras.js';

dotenv.config();

// Salida JSON; la visión va por rotación multi-proveedor (gratis→pago) en conVision().
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
11. 'codigo_barras': Lee y transcribe los 13 DÍGITOS del código de barras EAN-13 (los números impresos junto a las barras de la cubierta o contracubierta), EXACTAMENTE como aparecen y sin guiones. El código de barras PUEDE ESTAR GIRADO (en vertical / 90°): léelo igualmente, en cualquier orientación. NO inventes dígitos: si no los lees con seguridad, deja el campo vacío. (Pista: un EAN-13 que empieza por 977 es de una REVISTA; 978/979 de un LIBRO.)
12. 'numero_issue' y 'mes_publicacion': si es una revista, extrae del TEXTO de la portada el número de ejemplar ("ISSUE 44", "Nº 145" → "44"/"145") y el mes de publicación como número 1-12 ("FEBRUARY 2010" → 2). NO los tomes del add-on del código de barras; déjalos vacíos si no aparecen en el texto.
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
  "numero_issue": "string",
  "mes_publicacion": number,
  "editorial": "string",
  "año_edicion": number,
  "sinopsis": "string",
  "palabras_clave": ["tag1", "tag2"],
  "estado_verificacion": "completado|pendiente",
  "alertas_agente": []
}
`;

// SMART TRIM: para IDENTIFICAR un libro solo hacen falta las páginas CLAVE — portada + primeras de
// cortesía/CRÉDITOS (ISBN/CIP) + CONTRAPORTADA (código de barras). Enviar TODAS las páginas de un escaneo
// (p. ej. un PDF de Adobe Scan explotado) a la visión es caro y choca con el límite de imágenes del modelo
// (que además podía DESCARTAR la página de créditos del medio). Reducimos a las primeras IDENT_FRENTE + la
// última → menos coste de IA y la página de créditos (front matter) SIEMPRE viaja.
const IDENT_FRENTE = Number(process.env.IDENT_PAG_FRENTE) || 6;
function paginasClave(partes) {
    if (!partes || partes.length <= IDENT_FRENTE + 1) return partes || [];
    return [...partes.slice(0, IDENT_FRENTE), partes[partes.length - 1]];
}

/**
 * Procesa un grupo de imágenes (`{ data: Buffer, mimeType: string }`) del mismo recurso y
 * extrae la ficha técnica unificada. Asimila metadatos de texto nativos si provienen de un EPUB.
 */
export async function analizarImagenesRecurso(imagenes, datosEpub = null) {
    try {
        const todas = imagenes.map(({ data, mimeType }) => ({ base64: data.toString("base64"), mimeType: mimeType || "image/jpeg" }));
        const imageParts = paginasClave(todas);   // solo las páginas clave (portada + créditos + contraportada)

        // Inyección dinámica de metadatos nativos para dar máxima prioridad a los datos del archivo
        let instruccionesContextuales = INSTRUCCIONES_SISTEMA;
        if (datosEpub) {
            instruccionesContextuales += `\n\n⚠️ ENTORNO DIGITAL - NOTA PRIORITARIA:\nEl recurso actual es un libro digital (EPUB). El analizador nativo ha extraído el siguiente manifiesto:\n${JSON.stringify(datosEpub, null, 2)}\nUsa estos datos como fuente de verdad absoluta. Tu tarea principal aquí es verificar si el ISBN es correcto, estructurar la sinopsis final, e inferir con el máximo rigor la Clasificación Decimal Universal ('cdu') y las 'palabras_clave'.`;
        }

        console.log(`\n──> [IA] Enviando ${imageParts.length}/${todas.length} imagen(es) CLAVE a la visión (rotación multi-proveedor)...`);

        const responseText = await conVision({ prompt: instruccionesContextuales, imagenes: imageParts });
        const recursoEstructurado = extraerJSON(responseText);
        if (!recursoEstructurado) throw new Error('la visión no devolvió un JSON válido');

        // Resumen (verbose) de lo que EXTRAJO la visión — para juzgar si la llamada mereció la pena.
        console.log(`   ↳ [IA] visión extrajo → tipo=${recursoEstructurado.tipo_recurso || '?'} · título="${String(recursoEstructurado.titulo || '').slice(0, 60)}" · isbn=${recursoEstructurado.isbn || '—'} · issn=${recursoEstructurado.issn || '—'} · cdu=${recursoEstructurado.cdu || '—'} · estado=${recursoEstructurado.estado_verificacion || '?'}`);

        // CÓDIGO DE BARRAS: decodifica el EAN-13 leído de la cubierta (orientación indiferente: 977 →
        // ISSN/revista, 978/979 → ISBN). Rellena SOLO huecos (no pisa lo extraído del texto) y, ante un
        // 977 válido sin ISBN propio, fija tipo_recurso='revista' (un libro llevaría 978/979). El nº de
        // ejemplar y el mes vienen del TEXTO de la portada (el add-on del barras no es fiable).
        const bc = decodificarCodigoBarras(recursoEstructurado.codigo_barras);
        if (bc) {
            if (bc.issn && !recursoEstructurado.issn) recursoEstructurado.issn = bc.issn;
            if (bc.isbn && !recursoEstructurado.isbn) recursoEstructurado.isbn = bc.isbn;
            if (bc.esRevista && !recursoEstructurado.isbn) recursoEstructurado.tipo_recurso = 'revista';
            recursoEstructurado.alertas_agente = [...(recursoEstructurado.alertas_agente || []),
                `Código de barras leído: ${bc.issn || bc.isbn}.`];
        }
        delete recursoEstructurado.codigo_barras;          // no se persiste (no es campo del esquema)

        recursoEstructurado.fecha_ingreso = new Date();
        return recursoEstructurado;

    } catch (error) {
        console.error('\n❌ [ERROR IA]:', error.message);
        throw new Error(`Fallo IA: ${error.message}`);
    }


}

// Lectura FOCALIZADA del bloque CIP / página de créditos de un escaneo (visión). Devuelve SOLO datos
// IMPRESOS (no inferidos): Dewey/LCC/CDU, ISBN, idioma y título originales, traductor. Es de ÚLTIMO
// recurso (idle, en el Conformador) cuando las fuentes GRATIS no dieron CDU — ver [[minimize-ai-ingestion]].
const INSTRUCCIONES_CIP = `Eres un catalogador. En las imágenes (página de CRÉDITOS/copyright y bloque CIP de un libro)
localiza ÚNICAMENTE datos IMPRESOS y devuelve SOLO un objeto JSON válido (sin texto extra). NO inventes:
si un dato no está impreso, déjalo "" (cadena vacía).
{
  "dewey": "clasificación Dewey/CDD impresa (p. ej. '004.1'); '' si no aparece",
  "lcc": "signatura Library of Congress impresa (p. ej. 'QA76.76'); '' si no",
  "cdu": "CDU impreso si aparece literalmente; '' si no",
  "isbn": "ISBN impreso, solo dígitos sin guiones; '' si no",
  "idioma_original": "código ISO 639-1 del idioma original si se indica 'traducido de…'; '' si no",
  "titulo_original": "título original si se indica; '' si no",
  "traductor": "nombre del traductor si aparece; '' si no"
}`;
export async function leerCIPdeImagenes(imagenes) {
    const partes = paginasClave((imagenes || []).map(({ data, mimeType }) => ({ base64: data.toString('base64'), mimeType: mimeType || 'image/jpeg' })));
    if (!partes.length) return {};
    const txt = await conVision({ prompt: INSTRUCCIONES_CIP, imagenes: partes });
    return extraerJSON(txt) || {};
}