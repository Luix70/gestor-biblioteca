import axios from 'axios';
import { conGemini } from './gemini.js';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEnGoogleBooks } from './buscador-google-books.js';
import { buscarEnDNB } from './buscador-dnb.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarEnBNF } from './buscador-bnf.js';
import { buscarEnBNE } from './buscador-bne-sru.js';
import { buscarEnCrossref } from './buscador-crossref.js';
import { resolverCDU } from '../clasificador-cdu.js';
import { extraerContribuciones } from './contribuciones.js';
import { variantesISBN } from './identificadores.js';
import { mismoNombreAutor } from './huecos-autoridad.js';
import { esEditorialFalsa } from './editoriales-falsas.js';
import { esNombreRuido } from './editorial-por-prefijo.js';

// ─── BNE en línea (SRU del catálogo) ────────────────────────────────────────────────────────────────────
// Lenguas de España y prefijos ISBN de España (978-84, 979-13): para esas ediciones la BNE es la autoridad.
const LENGUAS_BNE = new Set(['es', 'ca', 'gl', 'eu']);
function esEdicionEspañola(idioma, isbns) {
    if (LENGUAS_BNE.has(String(idioma || '').toLowerCase().slice(0, 2))) return true;
    return (isbns || []).some((i) => /^(97884|97913|84)/.test(String(i || '').replace(/[^0-9Xx]/g, '')));
}
// ¿Queda algo que la BNE pueda aportar? (CDU, páginas, medidas, editorial, año, autores, colección)
const faltaAlgoDeBNE = (d) => !d.cdu || !d.paginas_bne || !d.dimensiones_bne || !d.editorial || !d.año_edicion
    || !(d.autores && d.autores.length) || !d.coleccion_nombre;

/** Completa `datosExtra` con TODO lo que traiga la BNE para ese ISBN y aún falte. Nunca lanza. */
async function completarDesdeBNE(datosExtra, rellenar, isbns) {
    // Las dos formas del ISBN (10 y 13): el catálogo de la BNE no siempre indexa ambas.
    const formas = [...new Set(isbns.filter(Boolean).flatMap((i) => { const v = variantesISBN(i); return v.length ? v : [i]; }))];
    const b = await buscarEnBNE({ isbns: formas }).catch(() => null);
    if (b === null) { datosExtra.alertas.push('BNE en línea no disponible: omitida.'); return false; }
    if (!b.titulo) return false;
    rellenar('titulo', b.titulo);
    rellenar('subtitulo', b.subtitulo);
    rellenar('autores', b.autores);
    rellenar('editorial', b.editorial);
    rellenar('año_edicion', b.año_edicion);
    rellenar('idioma', b.idioma);
    rellenar('coleccion_nombre', b.coleccion_nombre);
    rellenar('coleccion_numero', b.coleccion_numero);
    rellenar('dewey', b.dewey);
    rellenar('contribuciones_nombres', b.contribuciones_nombres);
    if (b.cdu && !datosExtra.cdu) { datosExtra.cdu = b.cdu; datosExtra.cdu_fuente = 'bne'; }   // CDU de la BNE → sin clasificador ni IA
    if (b.paginas && !datosExtra.paginas_bne) datosExtra.paginas_bne = b.paginas;
    if (b.dimensiones && !datosExtra.dimensiones_bne) datosExtra.dimensiones_bne = b.dimensiones;
    datosExtra.alertas.push('Datos complementados desde la BNE (catálogo en línea).');
    return true;
}

// ─── ¿Es de ESTE libro lo que devolvió una API? ────────────────────────────────────────────────────────
// OpenLibrary y Google Books, si no encuentran el ISBN, BUSCAN POR TÍTULO y devuelven lo primero que casa… que
// puede ser OTRO libro. Medido: ISBN 9791387600075 («La misión», Tim Weiner, Debate 2026) no está en OpenLibrary;
// su búsqueda por «La misión» devolvió un libro de Laura Gallego (Montena 2019, ISBN 8417460659) y la cascada tomó
// su autor, su editorial, su año Y SU ISBN como si fueran de este libro. Mismo mal que el de las revistas con
// libros homónimos. Regla:
//   · Si CONOCEMOS el ISBN, solo vale un resultado con ESE ISBN (o su variante 10/13). Uno con otro ISBN —o sin
//     ISBN— es otra edición u otro libro: se descarta entero.
//   · Si NO lo conocemos, la búsqueda por título es la única vía, pero si sabemos el autor tiene que coincidir.
function resultadoDeEsteLibro(info, isbnsNuestros, autor) {
    if (!info) return { ok: false };
    if (isbnsNuestros.size) {
        const suyos = variantesISBN(info.isbn);
        if (!suyos.some((v) => isbnsNuestros.has(v))) return { ok: false, motivo: `otro ISBN (${info.isbn || 'sin ISBN'})` };
        return { ok: true };
    }
    if (autor && Array.isArray(info.autores) && info.autores.length && !info.autores.some((a) => mismoNombreAutor(a, autor))) {
        return { ok: false, motivo: `otro autor (${info.autores.join(', ')})` };
    }
    return { ok: true };
}

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
 * ¿Sirve este título para buscar un LIBRO por texto (OpenLibrary, Google Books) o para que la IA razone su CDU?
 *
 * Un título sin letras casa con cualquier cosa. Medido con L'Histoire 2016, cuyos números se llaman «1.pdf» …
 * «12.pdf»: «11» devolvió «11/22/63» de Stephen King, «12» «12 Rules for Life», «1» y «2» «Heartstopper»… y de
 * cada ficha ajena salieron sinopsis, autor, editorial, año, idioma y un Dewey que acabó en la CDU (741.5 → 74).
 * Con menos de dos letras no se busca por texto; el ISBN, si lo hay, sigue sirviendo. «º» y «ª» no cuentan
 * (en «nº 5» no hay nada que buscar).
 */
export function tituloBuscable(titulo) {
    const letras = String(titulo || '').replace(/[ºª]/g, '').match(/\p{L}/gu) || [];
    return letras.length >= 2;
}

/**
 * Flujo maestro de enriquecimiento.
 *
 * `revista: true` → número de una publicación periódica: NO se consultan los catálogos de LIBROS (ver abajo).
 */
export async function buscarMetadatosExternos(titulo, autor, imagenBase64 = null, opciones = {}) {
    const { incluirSinopsis = true, incluirCdu = true, isbnsArchivo = [], idioma = null, cipDewey = null, cipLcc = null, sinIA = false,
        revista = false } = opciones;
    let datosExtra = {
        isbn: null,
        titulo: null,        // título de la autoridad (solo se usa si el archivo no aporta uno fiable)
        subtitulo: null,     // subtítulo de la autoridad (rellena hueco)
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

    // REVISTA: los catálogos de LIBROS no describen un número de revista. No hay ISBN que consultar
    // (motor-enriquecimiento ya los descarta: los de una revista son de anuncios o suscripciones) y una búsqueda
    // por TÍTULO solo encuentra un libro homónimo, con su sinopsis, autor, editorial, año, idioma y Dewey. El
    // número se identifica por su CABECERA (ISSN, guía de la carpeta, la colección ya catalogada), no por aquí.
    // Tampoco la visión de «portada de libro» (busca ISBN, colección y sello: nada que sirva). Queda la CDU, y
    // solo si hay un título con el que razonarla; si la guía de la carpeta ya la da, ni eso (incluirCdu=false).
    if (revista) {
        datosExtra.alertas.push('Revista: sin búsqueda en catálogos de libros (sinopsis, autor, editorial y Dewey no aplican a un número).');
        if (incluirCdu && tituloBuscable(titulo)) {
            const { cdu, fuente } = await resolverCDU({ titulo, permitirIA: !sinIA });
            datosExtra.cdu = cdu;
            datosExtra.cdu_fuente = fuente;
        }
        return datosExtra;
    }

    // Título para las búsquedas POR TEXTO: uno sin letras («11», «7-8») no se usa (ver tituloBuscable).
    const tituloTexto = tituloBuscable(titulo) ? titulo : null;
    if (titulo && !tituloTexto) datosExtra.alertas.push(`Título «${String(titulo).slice(0, 30)}» sin letras: no se busca por texto en los catálogos.`);

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
    // Cada ISBN en sus DOS formas (10 y 13): hay fuentes que solo indexan la forma con que se registró el libro
    // (medido 30-sep: Crossref tiene «Reading, Writing, and Proving» 2003 solo como 0387008349, y la BNE «indexa las
    // dos formas, pero no siempre»). Preguntar por una sola forma daba «no encontrado» con el libro dentro.
    const conAmbasFormas = (lista) => [...new Set(lista.filter(Boolean).flatMap((i) => {
        const v = variantesISBN(i);
        return v.length ? v : [i];
    }))];
    const isbnsLookup = conAmbasFormas([...isbnsArchivo, ...(isbnHint ? [isbnHint] : [])]);

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
        // `infoLocal.autores` ya viene LIMPIO y `infoLocal.contribuciones_nombres` con los roles: la mención
        // de la BNE la parsea el propio buscador-local, así el tratamiento de autores es IDÉNTICO sea cual
        // sea el camino de entrada (fichero, alta por ISBN…).
        rellenar('isbn', infoLocal.isbn);
        rellenar('titulo', infoLocal.titulo);
        rellenar('subtitulo', infoLocal.subtitulo);
        rellenar('autores', infoLocal.autores);
        rellenar('editorial', infoLocal.editorial);
        rellenar('sinopsis', infoLocal.sinopsis);
        rellenar('año_edicion', infoLocal.año_edicion);
        rellenar('idioma', infoLocal.idioma);
        rellenar('dewey', infoLocal.dewey);   // alimenta la clasificación CDU
        rellenar('lcc', infoLocal.lcc);
        rellenar('categorias', infoLocal.categorias);
        rellenar('coleccion_nombre', infoLocal.coleccion_nombre);
        rellenar('idioma_original', infoLocal.lengua_original);   // lengua original (traducciones)
        // CDU del Fichero: solo la trae el volcado de la BNE → es la de la BNE (catalogada por bibliotecarios).
        if (infoLocal.cdu) { datosExtra.cdu = infoLocal.cdu; datosExtra.cdu_fuente = 'bne'; }   // salta el clasificador IA
        if (infoLocal.paginas) datosExtra.paginas_bne = infoLocal.paginas;       // canales que captura
        if (infoLocal.dimensiones) datosExtra.dimensiones_bne = infoLocal.dimensiones; // motor-enriquecimiento
        if (infoLocal.portada_url) datosExtra.portadas_remotas.push({ origen: 'fichero_local', url: infoLocal.portada_url });
        // ROLES (traductor/ilustrador/…) parseados por buscador-local desde la mención de la BNE.
        if (Array.isArray(infoLocal.contribuciones_nombres) && infoLocal.contribuciones_nombres.length
            && !(datosExtra.contribuciones_nombres && datosExtra.contribuciones_nombres.length)) {
            datosExtra.contribuciones_nombres = infoLocal.contribuciones_nombres;
            datosExtra.alertas.push(`Roles de la mención de la BNE (Fichero): ${infoLocal.contribuciones_nombres.length}.`);
        }
        datosExtra.alertas.push(`Datos del Fichero local (${infoLocal.fuentes.join('+')}).`);
    }
    const localHit = !!(infoLocal && infoLocal.titulo);

    // TIER 2.1 · BNE EN LÍNEA, ANTES que OpenLibrary/Google si la edición es ESPAÑOLA (la BNE es su autoridad:
    // cataloga en CDU, con colección, nº, páginas, medidas y traductor). Para el resto de lenguas va al final,
    // como respaldo (ver más abajo). En los dos casos se completa TODO lo que aún falte, no solo el título.
    const española = esEdicionEspañola(idioma || datosExtra.idioma, [datosExtra.isbn, ...isbnsLookup]);
    // Si el registro del Fichero YA viene del volcado de la BNE, el catálogo en línea no añadiría nada: no se llama.
    let bneConsultada = (infoLocal?.fuentes || []).includes('bne');
    if (española && faltaAlgoDeBNE(datosExtra) && (datosExtra.isbn || isbnsLookup.length)) {
        bneConsultada = true;
        await completarDesdeBNE(datosExtra, rellenar, [datosExtra.isbn, ...isbnsLookup]);
    }

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
            infoOL = await buscarPorCriterios({ isbns: isbnsLookup, titulo: tituloTexto, autor, incluirSinopsis, idioma });
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
    // Los ISBN que ya sabemos de este libro (del fichero, de la visión o del Fichero local).
    const isbnsNuestros = new Set([datosExtra.isbn, ...isbnsLookup].filter(Boolean).flatMap((x) => variantesISBN(x)));
    if (infoOL) {
        const v = resultadoDeEsteLibro(infoOL, isbnsNuestros, autor);
        if (!v.ok) {
            datosExtra.alertas.push(`OpenLibrary devolvió por título OTRO libro («${String(infoOL.titulo || '?').slice(0, 60)}», ${v.motivo}): descartado.`);
            infoOL = null;
        }
    }
    if (infoOL) {
        rellenar('isbn', infoOL.isbn);
        rellenar('titulo', infoOL.titulo);
        rellenar('subtitulo', infoOL.subtitulo);
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
        const isbnsGB = datosExtra.isbn ? conAmbasFormas([datosExtra.isbn]) : isbnsLookup;
        infoGB = await buscarEnGoogleBooks({ isbns: isbnsGB, titulo: tituloTexto, autor, idioma, coleccion: coleccionHint });
    } catch (e) {
        // El mensaje distingue «sin cuota diaria» (lo normal con ingestas masivas) de una caída de verdad.
        if (e.tipo === 'infraestructura') datosExtra.alertas.push(`${/cuota/.test(e.message) ? e.message : 'Google Books inalcanzable'}: omitida.`);
        else throw e;
    }
    if (infoGB) {
        const v = resultadoDeEsteLibro(infoGB, isbnsNuestros, autor);
        if (!v.ok) {
            datosExtra.alertas.push(`Google Books devolvió por título OTRO libro («${String(infoGB.titulo || '?').slice(0, 60)}», ${v.motivo}): descartado.`);
            infoGB = null;
        }
    }
    if (infoGB) {
        rellenar('isbn', infoGB.isbn);
        rellenar('titulo', infoGB.titulo);
        rellenar('subtitulo', infoGB.subtitulo);
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
        // La editorial que la visión LEE en la cubierta. Dos precauciones (medido el 30-sep: 225 libros con la
        // editorial «se», «Se», «ge» o «9e», y 219 con «Seix Barral» sin serlo — la visión leía así el logotipo de
        // ePubLibre en sus cubiertas):
        //   · un nombre de una o dos letras no es una editorial: no se toma;
        //   · se marca de dónde viene, para que quien fusiona pueda desconfiar (motor-enriquecimiento no la usa
        //     cuando el fichero es de un maquetador: la cubierta es la suya, no la de la editorial).
        const editorialVision = pistasIA.editorial && !esNombreRuido(pistasIA.editorial) && !esEditorialFalsa(pistasIA.editorial)
            ? pistasIA.editorial : null;
        if (editorialVision && !datosExtra.editorial) datosExtra.editorial_de_vision = true;
        rellenar('editorial', editorialVision);
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
        const infoBNF = await buscarEnBNF({ isbns: conAmbasFormas([datosExtra.isbn, ...isbnsLookup]) });
        if (infoBNF && infoBNF.titulo) {
            rellenar('titulo', infoBNF.titulo);
            rellenar('autores', infoBNF.autores);
            rellenar('editorial', infoBNF.editorial);
            rellenar('año_edicion', infoBNF.año_edicion);
            rellenar('idioma', infoBNF.idioma);
            rellenar('coleccion_nombre', infoBNF.coleccion_nombre);
            rellenar('dewey', infoBNF.dewey);
            if (infoBNF.cdu && !datosExtra.cdu) { datosExtra.cdu = infoBNF.cdu; datosExtra.cdu_fuente = 'bnf'; }
            if (infoBNF.paginas && !datosExtra.paginas_bne) datosExtra.paginas_bne = infoBNF.paginas;
            if (infoBNF.dimensiones && !datosExtra.dimensiones_bne) datosExtra.dimensiones_bne = infoBNF.dimensiones;
            datosExtra.alertas.push('Datos/Dewey complementados desde la BnF.');
        }
    }

    // TIER 2g · CROSSREF — para los libros ACADÉMICOS (Springer, Routledge, CUP, OUP, Elsevier, Wiley…) sabe la
    // SERIE con su ISSN y lo reciente, que al Fichero le faltan (medido 30-sep: «Reading, Writing, and Proving» →
    // Undergraduate Texts in Mathematics; el Fichero lo tenía sin serie). Gratis y sin clave; solo huecos, y solo
    // si falta algo que pueda dar. Nunca para revistas (no se llega aquí) ni sin ISBN.
    const faltaAlgoDeCrossref = !datosExtra.coleccion_nombre || !datosExtra.editorial || !datosExtra.año_edicion
        || !datosExtra.titulo || !(datosExtra.autores && datosExtra.autores.length);
    if (faltaAlgoDeCrossref && (datosExtra.isbn || isbnsLookup.length)) {
        const infoCR = await buscarEnCrossref({ isbns: conAmbasFormas([datosExtra.isbn, ...isbnsLookup]) }).catch(() => null);
        if (infoCR === null) datosExtra.alertas.push('Crossref no disponible: omitido.');
        else if (infoCR.titulo) {
            rellenar('titulo', infoCR.titulo);
            rellenar('subtitulo', infoCR.subtitulo);
            rellenar('autores', infoCR.autores);
            rellenar('editorial', infoCR.editorial);
            rellenar('año_edicion', infoCR.año_edicion);
            if (infoCR.coleccion_nombre && !datosExtra.coleccion_nombre) {
                datosExtra.coleccion_nombre = infoCR.coleccion_nombre;
                if (infoCR.coleccion_numero) datosExtra.coleccion_numero = infoCR.coleccion_numero;
                // El ISSN de la SERIE (no del libro): identifica la colección sin ambigüedad (lo usará el trabajo
                // de colecciones para ratificarla y ver sus huecos).
                if (infoCR.coleccion_issn) datosExtra.coleccion_issn = infoCR.coleccion_issn;
            }
            if (infoCR.doi && !datosExtra.doi) datosExtra.doi = infoCR.doi;
            datosExtra.alertas.push(`Datos complementados desde Crossref${infoCR.coleccion_nombre ? ` (serie «${infoCR.coleccion_nombre}»)` : ''}.`);
        }
    }

    // TIER 2f · BNE como RESPALDO para las ediciones no españolas (o las que no se reconocieron como tales):
    // si tras las demás fuentes aún falta algo, se prueba también. Si una fuente falla, se prueban las siguientes.
    if (!bneConsultada && faltaAlgoDeBNE(datosExtra) && (datosExtra.isbn || isbnsLookup.length)) {
        await completarDesdeBNE(datosExtra, rellenar, [datosExtra.isbn, ...isbnsLookup]);
    }

    // TIER 3c · Resolución de la CDU vía clasificador (solo si BNE no la resolvió ya).
    // Dewey/LC en caché → API externa → IA, aprendiendo la equivalencia.
    if (incluirCdu && !datosExtra.cdu) {
        const tituloCdu = datosExtra.titulo || titulo;   // el del archivo puede ser un ISBN: usa el resuelto
        // Sin código Dewey/LC, la IA razona la CDU por el título y la sinopsis: con un título sin letras y sin
        // sinopsis no tiene de qué, y lo que devuelva es una conjetura que luego parece un dato.
        const conQueRazonar = !!(datosExtra.dewey || datosExtra.lcc || datosExtra.sinopsis || tituloBuscable(tituloCdu));
        const { cdu, fuente, palabras_clave } = await resolverCDU({
            dewey: datosExtra.dewey,
            lcc: datosExtra.lcc,
            categorias: datosExtra.categorias,     // lista completa para detectar ficción
            titulo: tituloCdu,
            autor: (datosExtra.autores && datosExtra.autores[0]) || autor || null,
            sinopsis: datosExtra.sinopsis,
            permitirIA: !sinIA && conQueRazonar,   // investigación «sin IA»: solo caché + crosswalk determinista
        });
        datosExtra.cdu = cdu;
        datosExtra.cdu_fuente = fuente;   // 'cache:…'|'api:…'|'ia' — para colorear la procedencia en el panel
        // Materias que la MISMA llamada IA dedujo (rentabiliza la llamada): rellenan palabras_clave si faltan.
        if (Array.isArray(palabras_clave) && palabras_clave.length) datosExtra.palabras_clave = palabras_clave;
        if (fuente.startsWith('cache')) datosExtra.alertas.push(`CDU por equivalencia aprendida (${fuente}).`);
    }

    return datosExtra;
}