import axios from 'axios';
import { conGemini } from './gemini.js';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEnGoogleBooks } from './buscador-google-books.js';
import { buscarEnDNB } from './buscador-dnb.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarEnBNF } from './buscador-bnf.js';
import { resolverCDU } from '../clasificador-cdu.js';
import { extraerContribuciones, extraerContribucionesBNE, combinarContribuciones } from './contribuciones.js';

// Circuit-breaker de OpenLibrary: si falla N veces seguidas se pausa OL_PAUSA_MS
// para no bloquear cada ingesta con un timeout largo. Se reinicia solo.
const OL_MAX_FALLOS = 3;
const OL_PAUSA_MS = 30 * 60 * 1000; // 30 minutos
let olFallosConsecutivos = 0;
let olBloqueadoHasta = 0;

/**
 * Analiza la portada de un libro para extraer metadatos bibliográficos visibles.
 * Además del ISBN clásico, extrae la colección/serie editorial (ej. "Clásica Maior",
 * "Austral") que permite localizar la edición exacta de obras con miles de versiones.
 */
async function analizarImagenConIA(base64Image) {
    try {
        const prompt = `Eres un bibliotecario experto analizando la portada de un libro.
Extrae TODOS los datos bibliográficos visibles. Presta especial atención a:
- ISBN (10 o 13 dígitos, puede aparecer en el lomo, la contraportada o como código de barras)
- Sello editorial (el nombre del sello concreto, no el grupo empresarial)
- Colección o serie editorial (ej. "Clásica Maior", "Austral", "El Libro de Bolsillo",
  "Biblioteca Universal", "Grandes Clásicos") — muy útil para identificar ediciones concretas
- Número en la colección (si aparece un número de colección)
- Año de publicación visible en la portada

Responde ÚNICAMENTE en JSON (null para los campos que no puedas leer):
{
  "isbn": "valor o null",
  "editorial": "valor o null",
  "coleccion": "nombre exacto de la colección/serie o null",
  "numero_coleccion": número_entero_o_null,
  "año_edicion": número_entero_o_null
}`;

        const result = await conGemini({ model: "gemini-2.5-flash" }, (model) => model.generateContent([
            prompt,
            { inlineData: { data: base64Image, mimeType: "image/jpeg" } }
        ]));

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
    const { incluirSinopsis = true, incluirCdu = true, isbnsArchivo = [], idioma = null, cipDewey = null, cipLcc = null } = opciones;
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
        coleccion_nombre: null,   // serie/colección leída de la portada (rellena hueco)
        coleccion_numero: null,
        contribuciones_nombres: [], // [{nombre,rol}] traductor/ilustrador/… parseados de la mención (by_statement)
        idioma_original: null,      // lengua ORIGINAL de la obra (traducciones): del Fichero (BNE lengua_original)
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

    // CIP del propio fichero: Dewey/LC autoritativos (leídos del libro). Se siembran ANTES que
    // cualquier API para que ganen (rellenar = "gana la primera fuente") — clasifican la CDU sin
    // gastar IA ni llamadas externas, y quedan disponibles para persistirlos en el documento.
    if (cipDewey) rellenar('dewey', cipDewey);
    if (cipLcc) rellenar('lcc', cipLcc);
    if (cipDewey || cipLcc) datosExtra.alertas.push('Dewey/LC del bloque CIP del propio fichero.');

    // TIER 3a · Visión Multimodal: produce solo PISTAS (la IA es la fuente menos fiable;
    // su ISBN se usa para consultar las APIs, pero estas tendrán prioridad sobre ella).
    let pistasIA = null;
    if (imagenBase64) {
        pistasIA = await analizarImagenConIA(imagenBase64);
        if (pistasIA) datosExtra.alertas.push("IA extrajo pistas de la imagen.");
    }
    const isbnHint = pistasIA ? pistasIA.isbn : null;
    const coleccionHint = pistasIA ? pistasIA.coleccion : null;   // serie editorial de la portada

    // ISBN es el pivote: se consulta a las APIs con los identificadores que el ARCHIVO ya
    // aporta (preferentes), y luego con la pista de la IA. Sin esto, un PDF cuyo ISBN está
    // en el texto/nombre nunca se resolvía por identificador (solo por título). Ver case 14.
    const isbnsLookup = [...isbnsArchivo, ...(isbnHint ? [isbnHint] : [])];

    // TIER 2.0 · FICHERO LOCAL (volcados OL+BNE offline en fichero.db). Autoridad principal:
    // sin red, ~0,1 ms por ISBN. Gana a las APIs online (rellenar = primera fuente), que quedan
    // como fallback de FRESCURA para lo que el volcado (una instantánea) no tenga. Si el .db no
    // está o better-sqlite3 no carga, devuelve null y el pipeline sigue con las APIs online.
    let infoLocal = null;
    try {
        infoLocal = await buscarEnFicheroLocal({ isbns: isbnsLookup });
    } catch (e) {
        datosExtra.alertas.push('Fichero local: omitido por error.');
    }
    if (infoLocal && infoLocal.titulo) {
        // La columna `autores` de la BNE puede venir como MENCIÓN estructurada («Apellido, Nombre,
        // ( 1872-1957)( autor) /**​/ Otro( traductor)»). Se separa en: autores LIMPIOS (para `autores`, sin
        // fechas ni marcas de rol → no se contamina el campo) y contribuciones con rol (traductor/…).
        const mencionBNE = (infoLocal.autores || []).join(' /**/ ');
        const conAutor = extraerContribucionesBNE(mencionBNE, { incluirAutor: true });
        const autoresLimpiosBNE = conAutor.filter((c) => c.rol === 'autor').map((c) => c.nombre);
        // ¿La mención es ESTRUCTURADA (con marcas /**​/ o roles entre paréntesis)? Si lo es, NUNCA usar la
        // cadena cruda como autor (contaminaría con «( traductor)», fechas, /**​/); si además no hay un
        // «( autor)» explícito (p. ej. un manga con solo dibujante/traductor), se deja `autores` sin rellenar.
        const mencionEstructurada = conAutor.length > 0 || /\/\*+\//.test(mencionBNE);

        rellenar('isbn', infoLocal.isbn);
        rellenar('titulo', infoLocal.titulo);
        rellenar('autores', autoresLimpiosBNE.length ? autoresLimpiosBNE : (mencionEstructurada ? [] : infoLocal.autores));
        rellenar('editorial', infoLocal.editorial);
        rellenar('sinopsis', infoLocal.sinopsis);
        rellenar('año_edicion', infoLocal.año_edicion);
        rellenar('idioma', infoLocal.idioma);
        rellenar('dewey', infoLocal.dewey);   // alimenta la clasificación CDU
        rellenar('lcc', infoLocal.lcc);
        rellenar('categorias', infoLocal.categorias);
        rellenar('coleccion_nombre', infoLocal.coleccion_nombre);
        rellenar('idioma_original', infoLocal.lengua_original);   // lengua original (traducciones)
        if (infoLocal.cdu) datosExtra.cdu = infoLocal.cdu;   // CDU de la BNE → salta el clasificador IA
        if (infoLocal.paginas) datosExtra.paginas_bne = infoLocal.paginas;       // canales que captura
        if (infoLocal.dimensiones) datosExtra.dimensiones_bne = infoLocal.dimensiones; // motor-enriquecimiento
        if (infoLocal.portada_url) datosExtra.portadas_remotas.push({ origen: 'fichero_local', url: infoLocal.portada_url });
        // ROLES desde la mención: el parser BNE estructurado («Nombre( rol)») + el de texto libre (por si
        // viene «edición preparada por X»). Mejor cobertura para catálogo español que el by_statement de OL.
        if (mencionBNE) {
            const contribs = combinarContribuciones(
                conAutor.filter((c) => c.rol !== 'autor'),
                extraerContribuciones(mencionBNE, { autoresConocidos: autoresLimpiosBNE }),
            );
            if (contribs.length) {
                datosExtra.contribuciones_nombres = contribs;
                datosExtra.alertas.push(`Roles de la mención de la BNE (Fichero): ${contribs.length}.`);
            }
        }
        datosExtra.alertas.push(`Datos del Fichero local (${infoLocal.fuentes.join('+')}).`);
    }
    const localHit = !!(infoLocal && infoLocal.titulo);

    // TIER 2a · OpenLibrary (autoridad principal). Si los ISBN dan 404, el buscador recae
    // en una búsqueda por título/autor filtrada por idioma (da con la edición en la lengua
    // del archivo antes que con ediciones en otras lenguas).
    // Un fallo de RED en una API no aborta la ingesta: se degrada con una alerta y se sigue.
    let infoOL = null;
    if (localHit) {
        // El Fichero local ya trae los datos de OL (mismo origen, sin el timeout de 20-45 s).
        datosExtra.alertas.push('OpenLibrary online omitida: ya la sirve el Fichero local.');
    } else if (Date.now() < olBloqueadoHasta) {
        const minutos = Math.ceil((olBloqueadoHasta - Date.now()) / 60000);
        console.warn(`⚠️  OpenLibrary: circuit-breaker abierto — omitida (${minutos} min restantes).`);
        datosExtra.alertas.push('OpenLibrary pausada (circuit-breaker): omitida.');
    } else {
        try {
            infoOL = await buscarPorCriterios({ isbns: isbnsLookup, titulo, autor, incluirSinopsis, idioma });
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
        // ROLES: la mención de responsabilidad de OL («… translated by X ; edited by Y») → contribuciones,
        // excluyendo a los autores ya conocidos. Solo si aún no se tienen (rellena hueco).
        if (infoOL.by_statement && (!datosExtra.contribuciones_nombres || !datosExtra.contribuciones_nombres.length)) {
            const contribs = extraerContribuciones(infoOL.by_statement, {
                autoresConocidos: [...(datosExtra.autores || []), ...(infoOL.autores || [])],
            });
            if (contribs.length) {
                datosExtra.contribuciones_nombres = contribs;
                datosExtra.alertas.push(`Roles de contribuyentes de OpenLibrary (${contribs.length}).`);
            }
        }
        datosExtra.alertas.push("Datos validados contra OpenLibrary.");
    }

    // TIER 2b · Google Books (segunda autoridad; rellena huecos: sinopsis, categorías, portada).
    // Pasa el idioma para filtrar por lengua en búsquedas de título, y la colección extraída
    // de la portada para localizar la edición exacta (ej. "Clásica Maior" de Anna Karenina).
    let infoGB = null;
    try {
        const isbnsGB = datosExtra.isbn ? [datosExtra.isbn] : isbnsLookup;
        infoGB = await buscarEnGoogleBooks({ isbns: isbnsGB, titulo, autor, idioma, coleccion: coleccionHint });
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
        rellenar('coleccion_nombre', pistasIA.coleccion);
        rellenar('coleccion_numero', pistasIA.numero_coleccion != null ? String(pistasIA.numero_coleccion) : null);
    }

    // BNE RETIRADA del pipeline online: el Fichero local (Tier 2.0, dump COMPLETO OL+BNE) ya aportó
    // arriba la CDU/idioma/tema/páginas/dimensiones de la BNE (su registro fusiona BNE+OL). El antiguo
    // buscador-bne (SPARQL 403 + caché Mongo `bne_cdus`) era redundante y gastaba el free tier de Atlas.
    const isbnParaBusquedas = datosExtra.isbn || isbnsLookup[0] || null;

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

    // TIER 2e · BnF (SRU UNIMARC) — fallback para libros francófonos + Dewey. Se consulta solo si
    // aún faltan clasificación o datos clave; rellena huecos sin pisar nada. (La British National
    // Bibliography será un fallback hermano cuando publique su endpoint Share Family; ver docs.)
    if (isbnParaBusquedas && ((!datosExtra.cdu && !datosExtra.dewey) || !datosExtra.titulo || !datosExtra.autores?.length)) {
        const infoBNF = await buscarEnBNF({ isbns: [datosExtra.isbn, ...isbnsLookup].filter(Boolean) });
        if (infoBNF && infoBNF.titulo) {
            rellenar('titulo', infoBNF.titulo);
            rellenar('autores', infoBNF.autores);
            rellenar('editorial', infoBNF.editorial);
            rellenar('año_edicion', infoBNF.año_edicion);
            rellenar('idioma', infoBNF.idioma);
            rellenar('coleccion_nombre', infoBNF.coleccion_nombre);
            rellenar('dewey', infoBNF.dewey);
            if (infoBNF.cdu && !datosExtra.cdu) datosExtra.cdu = infoBNF.cdu;
            if (infoBNF.paginas && !datosExtra.paginas_bne) datosExtra.paginas_bne = infoBNF.paginas;
            if (infoBNF.dimensiones && !datosExtra.dimensiones_bne) datosExtra.dimensiones_bne = infoBNF.dimensiones;
            datosExtra.alertas.push('Datos/Dewey complementados desde la BnF.');
        }
    }

    // TIER 3c · Resolución de la CDU vía clasificador (solo si BNE no la resolvió ya).
    // Dewey/LC en caché → API externa → IA, aprendiendo la equivalencia.
    if (incluirCdu && !datosExtra.cdu) {
        const { cdu, fuente, palabras_clave } = await resolverCDU({
            dewey: datosExtra.dewey,
            lcc: datosExtra.lcc,
            categorias: datosExtra.categorias,     // lista completa para detectar ficción
            titulo: datosExtra.titulo || titulo,   // el del archivo puede ser un ISBN: usa el resuelto
            autor: (datosExtra.autores && datosExtra.autores[0]) || autor || null,
            sinopsis: datosExtra.sinopsis,
        });
        datosExtra.cdu = cdu;
        datosExtra.cdu_fuente = fuente;   // 'cache:…'|'api:…'|'ia' — para colorear la procedencia en el panel
        // Materias que la MISMA llamada IA dedujo (rentabiliza la llamada): rellenan palabras_clave si faltan.
        if (Array.isArray(palabras_clave) && palabras_clave.length) datosExtra.palabras_clave = palabras_clave;
        if (fuente.startsWith('cache')) datosExtra.alertas.push(`CDU por equivalencia aprendida (${fuente}).`);
    }

    return datosExtra;
}