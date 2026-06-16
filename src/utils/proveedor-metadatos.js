import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEnGoogleBooks } from './buscador-google-books.js';
import { resolverCDU } from '../clasificador-cdu.js';

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
    const { incluirSinopsis = true, incluirCdu = true } = opciones;
    let datosExtra = {
        isbn: null,
        sinopsis: null,
        editorial: null,
        año_edicion: null,
        idioma: null,
        categorias: [],
        dewey: null,
        lcc: null,
        portadas_remotas: [], // candidatos de cubierta (se usan solo si el archivo no aporta una)
        cdu: null,
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

    // TIER 2a · OpenLibrary (autoridad principal). Si el ISBN-pista es erróneo y da 404,
    // el buscador ya recae en una búsqueda por título/autor y lo autocorrige.
    // Un fallo de RED en una API no aborta la ingesta: se degrada con una alerta y se sigue.
    // (Sin conexión real, será MongoDB Atlas quien falle → Reintentos.)
    let infoOL = null;
    try {
        infoOL = await buscarPorCriterios({ isbn: isbnHint, titulo, autor, incluirSinopsis });
    } catch (e) {
        if (e.tipo === 'infraestructura') datosExtra.alertas.push('OpenLibrary inalcanzable: omitida.');
        else throw e;
    }
    if (infoOL) {
        rellenar('isbn', infoOL.isbn);
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
        infoGB = await buscarEnGoogleBooks({ isbn: datosExtra.isbn || isbnHint, titulo, autor });
    } catch (e) {
        if (e.tipo === 'infraestructura') datosExtra.alertas.push('Google Books inalcanzable: omitida.');
        else throw e;
    }
    if (infoGB) {
        rellenar('isbn', infoGB.isbn);
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
            url: `https://covers.openlibrary.org/b/isbn/${isbnLimpio}-L.jpg`
        });
    }

    // TIER 3a (fallback) · Las pistas de la IA solo rellenan lo que NINGUNA API pudo aportar.
    if (pistasIA) {
        rellenar('isbn', pistasIA.isbn);
        rellenar('editorial', pistasIA.editorial);
        rellenar('año_edicion', pistasIA.año_edicion);
    }

    // TIER 3c · Resolución de la CDU vía clasificador con equivalencias aprendidas
    // (Dewey/LC en caché → API externa → IA, aprendiendo la equivalencia).
    if (incluirCdu) {
        const { cdu, fuente } = await resolverCDU({
            dewey: datosExtra.dewey,
            lcc: datosExtra.lcc,
            categoria: datosExtra.categorias.length > 0 ? datosExtra.categorias[0] : null,
            titulo,
            sinopsis: datosExtra.sinopsis,
        });
        datosExtra.cdu = cdu;
        if (fuente.startsWith('cache')) datosExtra.alertas.push(`CDU por equivalencia aprendida (${fuente}).`);
    }

    return datosExtra;
}