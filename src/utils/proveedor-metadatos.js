import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEnGoogleBooks } from './buscador-google-books.js';
import { buscarCDUsEnBNE } from './buscador-bne.js';
import { buscarEnDNB } from './buscador-dnb.js';
import { resolverCDU } from '../clasificador-cdu.js';

// Circuit-breaker de OpenLibrary: si falla N veces seguidas se pausa OL_PAUSA_MS
// para no bloquear cada ingesta con un timeout largo. Se reinicia solo.
const OL_MAX_FALLOS = 3;
const OL_PAUSA_MS = 30 * 60 * 1000; // 30 minutos
let olFallosConsecutivos = 0;
let olBloqueadoHasta = 0;

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
 * Flujo maestro de enriquecimiento.
 */
export async function buscarMetadatosExternos(titulo, autor, imagenBase64 = null, opciones = {}) {
    const { incluirSinopsis = true, incluirCdu = true, isbnsArchivo = [] } = opciones;
    let datosExtra = {
        isbn: null,
        titulo: null,        // título de la autoridad (solo se usa si el archivo no aporta uno fiable)
        autores: [],         // autores de la autoridad (idem)
        sinopsis: null,
        editorial: null,
        año_edicion: null,
        idioma: null,
        categorias: [],
        dewey: null,
        lcc: null,
        portadas_remotas: [], // candidatos de cubierta (se usan solo si el archivo no aporta una)
        cdu: null,
        cdu_adicionales: [],   // CDUs secundarios de fuentes autoritativas (BNE, etc.)
        alertas: []
    };

    // Rellena un campo de datosExtra solo si sigue vacío (gana la primera fuente consultada).
    const rellenar = (campo, valor) => {
        if (valor === null || valor === undefined || valor === '') return;
        if (Array.isArray(valor) && valor.length === 0) return;
        const actual = datosExtra[campo];
        const vacio = actual === null || actual === undefined || actual === ''
            || (Array.isArray(actual) && actual.length === 0);
        if (vacio) datosExtra[campo] = valor;
    };

    // TIER 3a · Visión Multimodal: produce solo PISTAS (la IA es la fuente menos fiable;
    // su ISBN se usa para consultar las APIs, pero estas tendrán prioridad sobre ella).
    let pistasIA = null;
    if (imagenBase64) {
        pistasIA = await analizarImagenConIA(imagenBase64);
        if (pistasIA) datosExtra.alertas.push("IA extrajo pistas de la imagen.");
    }
    const isbnHint = pistasIA ? pistasIA.isbn : null;

    // ISBN es el pivote: se consulta a las APIs con los identificadores que el ARCHIVO ya
    // aporta (preferentes), y luego con la pista de la IA. Sin esto, un PDF cuyo ISBN está
    // en el texto/nombre nunca se resolvía por identificador (solo por título). Ver case 14.
    const isbnsLookup = [...isbnsArchivo, ...(isbnHint ? [isbnHint] : [])];

    // TIER 2a · OpenLibrary (autoridad principal). Si los ISBN dan 404, el buscador recae
    // en una búsqueda por título/autor.
    // Un fallo de RED en una API no aborta la ingesta: se degrada con una alerta y se sigue.
    // (Sin conexión real, será MongoDB Atlas quien falle → Reintentos.)
    let infoOL = null;
    if (Date.now() < olBloqueadoHasta) {
        const minutos = Math.ceil((olBloqueadoHasta - Date.now()) / 60000);
        console.warn(`⚠️  OpenLibrary: circuit-breaker abierto — omitida (${minutos} min restantes).`);
        datosExtra.alertas.push('OpenLibrary pausada (circuit-breaker): omitida.');
    } else {
        try {
            infoOL = await buscarPorCriterios({ isbns: isbnsLookup, titulo, autor, incluirSinopsis });
            olFallosConsecutivos = 0; // éxito → resetear contador
        } catch (e) {
            if (e.tipo === 'infraestructura') {
                olFallosConsecutivos++;
                const detalle = e.causa?.code || e.causa?.response?.status || e.message;
                if (olFallosConsecutivos >= OL_MAX_FALLOS) {
                    olBloqueadoHasta = Date.now() + OL_PAUSA_MS;
                    console.warn(`⚠️  OpenLibrary: ${OL_MAX_FALLOS} fallos seguidos (${detalle}) → pausada 30 min.`);
                } else {
                    console.warn(`⚠️  OpenLibrary inalcanzable (${detalle}): omitida. [${olFallosConsecutivos}/${OL_MAX_FALLOS}]`);
                }
                datosExtra.alertas.push('OpenLibrary inalcanzable: omitida.');
            } else throw e;
        }
    }
    if (infoOL) {
        rellenar('isbn', infoOL.isbn);
        rellenar('titulo', infoOL.titulo);
        rellenar('autores', infoOL.autores);
        rellenar('editorial', infoOL.editorial);
        rellenar('sinopsis', infoOL.sinopsis);
        rellenar('año_edicion', infoOL.año_edicion);
        rellenar('dewey', infoOL.dewey);   // para derivar/aprender la CDU
        rellenar('lcc', infoOL.lcc);
        datosExtra.alertas.push("Datos validados contra OpenLibrary.");
    }

    // TIER 2b · Google Books (segunda autoridad; rellena huecos: sinopsis, categorías, portada).
    let infoGB = null;
    try {
        const isbnsGB = datosExtra.isbn ? [datosExtra.isbn] : isbnsLookup;
        infoGB = await buscarEnGoogleBooks({ isbns: isbnsGB, titulo, autor });
    } catch (e) {
        if (e.tipo === 'infraestructura') datosExtra.alertas.push('Google Books inalcanzable: omitida.');
        else throw e;
    }
    if (infoGB) {
        rellenar('isbn', infoGB.isbn);
        rellenar('titulo', infoGB.titulo);
        rellenar('autores', infoGB.autores);
        rellenar('editorial', infoGB.editorial);
        if (incluirSinopsis) rellenar('sinopsis', infoGB.sinopsis);
        rellenar('año_edicion', infoGB.año_edicion);
        rellenar('idioma', infoGB.idioma);
        rellenar('categorias', infoGB.categorias);
        if (infoGB.portada_url) {
            datosExtra.portadas_remotas.push({ origen: 'google_books', url: infoGB.portada_url });
        }
        datosExtra.alertas.push("Datos complementados con Google Books.");
    }

    // Candidato de portada de OpenLibrary (construible desde el ISBN, sin llamada extra).
    if (datosExtra.isbn) {
        const isbnLimpio = datosExtra.isbn.replace(/-/g, '');
        datosExtra.portadas_remotas.push({
            origen: 'openlibrary',
            // default=false → si no hay cubierta real, OpenLibrary responde 404 en vez de servir
            // su marcador 1x1; así la descarga falla limpiamente y no se cuela una portada falsa.
            url: `https://covers.openlibrary.org/b/isbn/${isbnLimpio}-L.jpg?default=false`
        });
    }

    // TIER 3a (fallback) · Las pistas de la IA solo rellenan lo que NINGUNA API pudo aportar.
    if (pistasIA) {
        rellenar('isbn', pistasIA.isbn);
        rellenar('editorial', pistasIA.editorial);
        rellenar('año_edicion', pistasIA.año_edicion);
    }

    // TIER 2c · BNE — códigos CDU directos de catalogadores profesionales (autoridad para
    // obras en español). Si la BNE localiza el ISBN, su primera CDU se usa como primaria y
    // las demás se guardan en cdu_adicionales. Si la BNE no lo localiza, se sigue al clasificador.
    const isbnParaBusquedas = datosExtra.isbn || isbnsLookup[0] || null;
    if (incluirCdu && isbnParaBusquedas) {
        const cdusBNE = await buscarCDUsEnBNE(isbnParaBusquedas);
        if (cdusBNE && cdusBNE.length > 0) {
            datosExtra.cdu = cdusBNE[0];
            if (cdusBNE.length > 1) datosExtra.cdu_adicionales = cdusBNE.slice(1);
            datosExtra.alertas.push(`CDU de la BNE: ${cdusBNE.join(' / ')}.`);
        }
    }

    // TIER 2d · DNB — Dewey/DDC de la Deutsche Nationalbibliothek para libros europeos.
    // Complementa OpenLibrary cuando ésta no dio Dewey (p.ej. ISBN no indexado en OL).
    // La DNB es SRU público, sin bloqueos: funciona para alemán, inglés y muchos otros idiomas.
    if (!datosExtra.dewey && !datosExtra.lcc && isbnParaBusquedas) {
        const infoDNB = await buscarEnDNB({ isbn: isbnParaBusquedas });
        if (infoDNB) {
            rellenar('dewey', infoDNB.dewey);
            rellenar('lcc', infoDNB.lcc);
            if (infoDNB.dewey || infoDNB.lcc)
                datosExtra.alertas.push('Dewey/LCC complementados desde DNB (Deutsche Nationalbibliothek).');
        }
    }

    // TIER 3c · Resolución de la CDU vía clasificador (solo si BNE no la resolvió ya).
    // Dewey/LC en caché → API externa → IA, aprendiendo la equivalencia.
    if (incluirCdu && !datosExtra.cdu) {
        const { cdu, fuente } = await resolverCDU({
            dewey: datosExtra.dewey,
            lcc: datosExtra.lcc,
            categorias: datosExtra.categorias,     // lista completa para detectar ficción
            titulo: datosExtra.titulo || titulo,   // el del archivo puede ser un ISBN: usa el resuelto
            autor: (datosExtra.autores && datosExtra.autores[0]) || autor || null,
            sinopsis: datosExtra.sinopsis,
        });
        datosExtra.cdu = cdu;
        if (fuente.startsWith('cache')) datosExtra.alertas.push(`CDU por equivalencia aprendida (${fuente}).`);
    }

    return datosExtra;
}