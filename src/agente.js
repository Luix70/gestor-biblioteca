import dotenv from 'dotenv';
import { conVision, extraerJSON } from './utils/vision.js';
import { decodificarCodigoBarras } from './utils/codigo-barras.js';
import { validarISBN, validarISSN, variantesISBN } from './utils/identificadores.js';

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
6. 'isbn' / 'issn': Revisa minuciosamente todas las imágenes: códigos de barras (contraportada) Y el texto de la página de créditos ("ISBN: ..."). Extrae el número continuo sin guiones. Si no estás seguro, déjalo vacío en vez de inventarlo. 'isbn' = el del PROPIO ejemplar; 'issn' = el principal.
6b. 'isbns' / 'issns' — CAPTURA TODOS: en la página de créditos suele haber VARIOS ISBN (tapa dura y tapa blanda/rústica, y el del ebook/PDF) y a veces DOS ISSN (impreso y electrónico/e-ISSN). Devuélvelos TODOS. 'isbns' = lista de objetos {"numero":"solo dígitos, sin guiones","rol":"volumen|obra|tapa_dura|tapa_blanda|ebook|desconocido"} — 'volumen' = el de ESTE ejemplar; 'obra' = el de la OBRA COMPLETA/SET; usa 'tapa_dura'/'tapa_blanda'/'ebook' cuando el crédito lo indique («hardcover», «pbk», «eBook», «PDF»), si no 'desconocido'. 'issns' = lista de TODOS los ISSN (solo dígitos con o sin guion). No inventes: incluye solo los que leas con seguridad.
7. 'estado_verificacion': Si consigues extraer con total claridad el título y el ISBN/Editorial, establece "completado". Si faltan datos o las imágenes no permiten certificar los metadatos obligatorios, establece "pendiente".
8. 'alertas_agente': Si el estado es "pendiente", detalla los motivos en este array de texto.
9. 'sinopsis': Genera un resumen de dos líneas con tus propias palabras. ¡PROHIBIDO copiar o transcribir textualmente párrafos de la imagen para evitar bloqueos por copyright (RECITATION)!
10. 'codigo_barras': Lee y transcribe los 13 DÍGITOS del código de barras EAN-13 (los números impresos junto a las barras de la cubierta o contracubierta), EXACTAMENTE como aparecen y sin guiones. El código de barras PUEDE ESTAR GIRADO (en vertical / 90°): léelo igualmente, en cualquier orientación. NO inventes dígitos: si no los lees con seguridad, deja el campo vacío. (Pista: un EAN-13 que empieza por 977 es de una REVISTA; 978/979 de un LIBRO.)
11. 'numero_issue' y 'mes_publicacion': si es una revista, extrae del TEXTO de la portada el número de ejemplar ("ISSUE 44", "Nº 145" → "44"/"145") y el mes de publicación como número 1-12 ("FEBRUARY 2010" → 2). NO los tomes del add-on del código de barras; déjalos vacíos si no aparecen en el texto.
12. OBRA MULTIVOLUMEN (enciclopedias, diccionarios, tratados en varios TOMOS): MUY IMPORTANTE. Si este ejemplar es un VOLUMEN/TOMO de una obra mayor, rellena:
   - 'obra_titulo': el título de la OBRA COMPLETA (p. ej. "Diccionario de Filosofía", "Historia de las ideas políticas"), tal como aparece en la portadilla/créditos; '' si es un libro suelto.
   - 'volumen_numero': el número de ESTE tomo dentro de la obra (entero: "Tomo II"/"Vol. 2"/"II" → 2); null si no consta.
   - 'obra_total': nº total de tomos si se indica ("obra en 4 volúmenes" → 4); null si no.
   - 'isbn_obra': el ISBN de la OBRA COMPLETA / del SET, que en la página de créditos suele figurar JUNTO al del volumen ("ISBN obra completa:", "ISBN O.C.:", "ISBN de la obra:"). Es DISTINTO del 'isbn' de este volumen. Solo dígitos, sin guiones; '' si no aparece.
   OJO: en la página de créditos de estos libros HAY DOS ISBN — el de ESTE volumen (→ 'isbn') y el de la OBRA COMPLETA (→ 'isbn_obra'). Distínguelos con cuidado; no los mezcles.
13. COLECCIÓN/SERIE editorial: si el ejemplar pertenece a una colección/serie con nombre y número (p. ej. "Círculo Universidad, 8", "Biblioteca Básica, 12"), rellena 'coleccion_nombre' (el nombre de la colección) y 'coleccion_numero' (su número DENTRO de la colección). OJO: este número es DISTINTO de 'volumen_numero' (el tomo dentro de la OBRA). Una obra en 2 tomos puede ocupar UN SOLO número de colección (p. ej. ambos tomos son el nº 8 de la colección "Círculo Universidad", pero volumen 1 y 2 de la obra "Historia de las Ideas Políticas"). No confundas colección (serie editorial amplia, con muchos títulos distintos) con obra (un único título en varios tomos).
14. COLABORADORES: además de los AUTORES, identifica TODAS las personas que colaboran en la obra con su ROL, leyendo la portada, la mención de responsabilidad y los créditos: TRADUCTOR ("traducción de", "translated by"), ILUSTRADOR ("ilustraciones de", "dibujos de", "grabados de"), EDITOR/coordinador ("edición de", "a cargo de", "edited by"), PROLOGUISTA ("prólogo de", "introducción de", "estudio preliminar"), ANOTADOR ("notas de"), COMPILADOR ("selección de", "antología de"). Devuélvelos en 'contribuciones' como {nombre, rol}. NO metas a los autores aquí (van en 'autores'). Cuantos más colaboradores reales encuentres, mejor.
ESTRUCTURA JSON REQUERIDA:
{
  "tipo_recurso": "libro|revista",
  "titulo": "string",
  "autores": ["string"],
  "contribuciones": [{ "nombre": "string", "rol": "traductor|ilustrador|editor|prologuista|anotador|compilador" }],
  "cdu": "string",
  "idioma": "string",
  "isbn": "string",
  "issn": "string",
  "isbns": [{ "numero": "string", "rol": "volumen|obra|tapa_dura|tapa_blanda|ebook|desconocido" }],
  "issns": ["string"],
  "codigo_barras": "string",
  "numero_issue": "string",
  "mes_publicacion": number,
  "editorial": "string",
  "año_edicion": number,
  "obra_titulo": "string",
  "volumen_numero": number,
  "obra_total": number,
  "isbn_obra": "string",
  "coleccion_nombre": "string",
  "coleccion_numero": "string",
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
        // El FORMATO no lo decide la visión: es un hecho del FICHERO (su extensión), no algo que se vea en una
        // foto. Lo fija el orquestador (pdf/epub/mobi/…; 'papel' solo para fotos de un ejemplar físico). Si el
        // modelo lo emite de todos modos, se descarta aquí: colaba `['papel']` en TODO PDF ESCANEADO que la
        // visión lograba identificar, y lo convertía en un «libro de papel» sin fichero digital.
        delete recursoEstructurado.formatos;

        // OBRA MULTIVOLUMEN: normaliza el ISBN de la obra (solo dígitos) y descarta si coincide con el del
        // volumen (no sería el ISBN de la obra completa). El pivote de agrupación es isbn_obra (resolverObra
        // deduplica por él → todos los tomos del set caen en la MISMA obra).
        const digitos = (s) => String(s || '').replace(/[^0-9Xx]/g, '');
        if (recursoEstructurado.isbn_obra) {
            const io = digitos(recursoEstructurado.isbn_obra);
            recursoEstructurado.isbn_obra = (io.length >= 10 && io !== digitos(recursoEstructurado.isbn)) ? io : '';
        }
        // volumen_numero como entero (o fuera si no consta) y obra_total como entero.
        const ent = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
        if (recursoEstructurado.volumen_numero != null) recursoEstructurado.volumen_numero = ent(recursoEstructurado.volumen_numero);
        if (recursoEstructurado.obra_total != null) recursoEstructurado.obra_total = ent(recursoEstructurado.obra_total);
        // Si trae obra_titulo o isbn_obra, es un tomo → limpia el título de la obra.
        if (recursoEstructurado.obra_titulo) recursoEstructurado.obra_titulo = String(recursoEstructurado.obra_titulo).trim() || null;

        // TODOS los identificadores leídos por la VISIÓN → mismas estructuras que el lector de texto
        // (isbn_candidatos + isbn_propio + isbns_rol + issn_candidatos), para que el interpretador (obra/
        // ediciones alternativas, corroboración por Fichero, serie por ISSN) los trate IGUAL sea cual sea la
        // fuente. El ISBN del ejemplar y sus ediciones son PROPIOS (leídos de SUS créditos); el de la OBRA no.
        {
            const ROL_ISBN = new Set(['obra', 'volumen', 'tapa_dura', 'tapa_blanda', 'ebook']);
            const cand = new Set(), propios = new Set(), rolesOut = [];
            const addISBN = (raw, rol) => {
                const v = validarISBN(raw); if (!v) return;
                for (const x of variantesISBN(v)) cand.add(x);
                if (rol !== 'obra') propios.add(v);
                if (rol && ROL_ISBN.has(rol)) rolesOut.push({ isbn: v, rol });
            };
            addISBN(recursoEstructurado.isbn, 'volumen');
            for (const it of (Array.isArray(recursoEstructurado.isbns) ? recursoEstructurado.isbns : [])) addISBN(it && (it.numero || it.isbn), it && it.rol);
            if (recursoEstructurado.isbn_obra) addISBN(recursoEstructurado.isbn_obra, 'obra');
            if (cand.size) recursoEstructurado.isbn_candidatos = [...new Set([...(recursoEstructurado.isbn_candidatos || []), ...cand])];
            recursoEstructurado.isbn_propio = recursoEstructurado.isbn_propio || [...propios].find((c) => c.length === 13) || [...propios][0] || null;
            if (rolesOut.length) recursoEstructurado.isbns_rol = [...(recursoEstructurado.isbns_rol || []), ...rolesOut];

            const issnCand = new Set();
            const addISSN = (raw) => { const v = validarISSN(raw); if (v) issnCand.add(v); };
            addISSN(recursoEstructurado.issn);
            for (const s of (Array.isArray(recursoEstructurado.issns) ? recursoEstructurado.issns : [])) addISSN(typeof s === 'string' ? s : (s && (s.numero || s.issn)));
            if (issnCand.size) {
                recursoEstructurado.issn_candidatos = [...issnCand];
                if (!recursoEstructurado.issn) recursoEstructurado.issn = [...issnCand][0];
            }
            delete recursoEstructurado.isbns;   // ya volcados a las estructuras internas
            delete recursoEstructurado.issns;
        }

        // COLABORADORES leídos por la VISIÓN → contribuciones_nombres [{nombre, rol}] (mismo formato que la
        // mención de la BNE/OpenLibrary), que motor-catalogo resuelve a contribuciones[persona,rol]. Solo
        // roles válidos; se ACUMULAN (no se pisan) con los que ya hubiera.
        {
            const ROLES = new Set(['traductor', 'ilustrador', 'editor', 'prologuista', 'anotador', 'compilador']);
            const cn = [];
            for (const c of (Array.isArray(recursoEstructurado.contribuciones) ? recursoEstructurado.contribuciones : [])) {
                const nombre = String((c && c.nombre) || '').trim();
                const rol = String((c && c.rol) || '').trim().toLowerCase();
                if (nombre && ROLES.has(rol)) cn.push({ nombre, rol });
            }
            if (cn.length) recursoEstructurado.contribuciones_nombres = [...(recursoEstructurado.contribuciones_nombres || []), ...cn];
            delete recursoEstructurado.contribuciones;
        }

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