import fs from 'fs/promises';
import path from 'path';
import { extraerMetadatosEpub } from './utils/lector-epub.js';
import { extraerMetadatosPdf, textoPagina } from './utils/lector-pdf.js';
import { medirImagen } from './utils/medir-imagen.js';
import { analizarImagenesRecurso } from './agente.js';
import { enriquecerMetadatos } from './motor-enriquecimiento.js';
import { buscarEnFicheroLocal, corroborarISBNporTitulo } from './utils/buscador-local.js';
import { ErrorIdentificacion, ErrorInfraestructura, ErrorRecursoIlegible } from './errores.js';
import { parsearNombre } from './utils/parsear-nombre.js';
import { pareceSerieLibros } from './utils/revistas.js';
import { clasificarTipo } from './utils/discriminador.js';
import { interpretarIdentificadores } from './utils/interpretar-identificadores.js';
import { extraerMetadatosComic } from './utils/lector-comic.js';
import { validarISBN, validarISSN, variantesISBN } from './utils/identificadores.js';
import { resolverPortada } from './utils/resolver-portada.js';
import { rasterizarFrontalesPdf, ocrDesdeRenders } from './utils/ocr-pdf.js';
import { rasterizarPaginas, pdfEsImagen } from './utils/rasterizar-pdf.js';
import { leerCodigoBarrasPorVision, leerIdentificadorDeImagenes } from './utils/lector-barras.js';
import { paginasMuestraDjvu } from './utils/djvu.js';

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

// Portada: ancho mínimo legible (igual que resolverPortada) y nº de caracteres a partir del cual
// se considera que la página 1 de un PDF es texto (no cubierta).
const PORTADA_ANCHO_MINIMO = Number(process.env.PORTADA_ANCHO_MINIMO || 100);
const PAG1_TEXTO_UMBRAL = Number(process.env.PORTADA_PAG1_TEXTO_UMBRAL || 250);
// PDF ESCANEADO → EXPLOTAR en imágenes (una por página) para que la ficha sea idéntica a un escaneo de
// cámara. Cap de páginas (proteger al Atom de un escaneo gigante) y ancho de cada página-imagen.
const PDF_EXPLOTAR_MAX = Number(process.env.PDF_EXPLOTAR_MAX || 60);
const PDF_EXPLOTAR_ANCHO = Number(process.env.PDF_EXPLOTAR_ANCHO || 1400);

// Tipo MIME real de cada imagen (Gemini soporta jpeg/png/webp/heic de forma nativa).
// Ya no reprocesamos con sharp: enviamos los bytes originales etiquetados con su MIME correcto.
const MIME_IMAGEN = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic',
};
const mimeDeImagen = (ruta) => MIME_IMAGEN[path.extname(ruta).toLowerCase()] || 'image/jpeg';

// Formato (enum del esquema) según extensión. Puerta abierta a nuevos formatos:
// epub/pdf/imágenes tienen lector propio; el resto se catalogan por nombre + APIs (sin leer
// el contenido todavía) y quedan 'pendiente' hasta implementar su lector.
const EXT_COMIC = ['.cbr', '.cbz', '.cb7'];

const FORMATO_POR_EXT = {
    '.epub': 'epub', '.pdf': 'pdf',
    '.mobi': 'mobi', '.cbr': 'cbr', '.cbz': 'cbz', '.cb7': 'cb7', '.djvu': 'djvu', '.zip': 'zip', '.rar': 'rar',
};

export function detectarTipo(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    if (EXT_IMAGEN.includes(ext)) return 'imagen';
    if (EXT_COMIC.includes(ext)) return 'comic';
    if (ext === '.djvu') return 'djvu';
    if (FORMATO_POR_EXT[ext]) return 'otro-formato';
    return 'desconocido';
}

// Metadatos de respaldo a partir del nombre de archivo (delega en el parser compartido,
// que distingue libros con autores de revistas fechadas).
// Funde el resultado del OCR de visión sobre un PDF escaneado. El nombre del archivo NO es
// fiable en estos casos (basura tipo "(ebook - pdf) Título"), así que la visión MANDA: se
// descartan título/autores del nombre y se conservan de 'base' solo los campos técnicos. Las
// APIs rellenarán los huecos después, usando el ISBN leído por OCR como pivote.
function fusionarOcr(base, ocr) {
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
        paginas: base.paginas,
        texto_legible: base.texto_legible,
        titulo: ocr.titulo || null,
        autores: arr(ocr.autores),
        isbn: ocr.isbn || null,
        issn: ocr.issn || null,                       // del código de barras 977 (revista)
        numero_issue: ocr.numero_issue ?? null,       // nº de ejemplar leído del texto de portada
        mes_publicacion: ocr.mes_publicacion ?? null, // mes leído del texto de portada (1-12)
        editorial: ocr.editorial || null,
        año_edicion: ocr.año_edicion || null,
        idioma: ocr.idioma || null,
        cdu: ocr.cdu || null,
        sinopsis: ocr.sinopsis || null,
        palabras_clave: arr(ocr.palabras_clave),
    };
}

// ── OVERRIDE manual (sidecar) ────────────────────────────────────────────────
// Para FORZAR la catalogación de un documento mal identificado (p. ej. "Guns" confundido por las
// APIs con "Guns, Germs and Steel"): se deja junto al fichero un JSON "<fichero>.meta.json" (o
// "<base>.meta.json") con los campos a imponer. Mandan sobre el archivo Y las APIs. Claves
// especiales: "sin_apis": true (no consultar APIs/IA — usa solo archivo+override), "sin_isbn": true
// (el documento NO tiene ISBN; evita que se le adjudique el de un homónimo) y "forzar_nuevo": true
// (OMITE la deduplicación: cataloga el fichero como documento DISTINTO aunque comparta ISBN/título
// con uno ya existente — "conservar ambos"; lo usa el panel para reingestar duplicados que en
// realidad son ediciones/ejemplares diferentes).
const CAMPOS_OVERRIDE = ['titulo', 'subtitulo', 'autores', 'editorial', 'cdu', 'idioma', 'año_edicion',
    'sinopsis', 'palabras_clave', 'coleccion_nombre', 'coleccion_numero', 'tipo_recurso',
    'obra_titulo', 'volumen_numero', 'isbn_obra'];

export async function leerOverride(rutaArchivo) {
    const sinExt = path.join(path.dirname(rutaArchivo), path.basename(rutaArchivo, path.extname(rutaArchivo)));
    for (const c of [rutaArchivo + '.meta.json', sinExt + '.meta.json']) {
        try { const j = JSON.parse(await fs.readFile(c, 'utf8')); if (j && typeof j === 'object') return j; }
        catch { /* no existe o JSON inválido: probar el siguiente */ }
    }
    return null;
}

/** Aplica el override a datosBase (in situ) y devuelve { sinApis, forzarNuevo }. */
function aplicarOverride(datosBase, override) {
    for (const k of CAMPOS_OVERRIDE) {
        if (override[k] !== undefined && override[k] !== null) datosBase[k] = override[k];
    }
    if (override.isbn) { const v = validarISBN(override.isbn); if (v) { datosBase.isbn = v; datosBase.isbn_candidatos = variantesISBN(v); } }
    if (override.issn) { const v = validarISSN(override.issn); if (v) datosBase.issn = v; }
    if (override.sin_isbn === true) { delete datosBase.isbn; datosBase.isbn_candidatos = []; datosBase._isbnBloqueado = true; }
    const sinApis = override.sin_apis === true || override.forzar === true;
    const forzarNuevo = override.forzar_nuevo === true;
    datosBase.alertas_agente = [...(datosBase.alertas_agente || []),
        `Override manual (.meta.json) aplicado${sinApis ? ' · sin APIs' : ''}${forzarNuevo ? ' · forzar nuevo (sin dedup)' : ''}.`];
    return { sinApis, forzarNuevo };
}

function metadatosDesdeNombre(ruta) {
    const p = parsearNombre(path.basename(ruta));
    const datos = { titulo: p.titulo, autores: p.autores };
    if (p.isbn) datos.isbn = p.isbn;   // el nombre era un ISBN: que las APIs resuelvan el resto
    if (p.esFechada) { datos.año_edicion = p.año_edicion; datos.idioma = p.idioma; }
    if (p.coleccion_nombre) {
        datos.coleccion_nombre = p.coleccion_nombre;
        if (p.coleccion_numero) datos.coleccion_numero = p.coleccion_numero;
    }
    if (p.editorial) datos.editorial = p.editorial;
    return datos;
}

// Heurística: ¿el título parece el de una publicación periódica?
// Señales: marcadores de número/año, palabras clave, "review/magazine", o un mes + año
// (es/en/fr), patrón muy típico de revistas (p. ej. "… Février-Mars 2017").
const MESES = '(?:ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic|jan|apr|aug|dec|janv|févr|fevr|avr|mai|juin|juil|aoû|aou|déc|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|june|july|august|september|october|november|december|janvier|février|fevrier|mars|avril|juillet|septembre|octobre|novembre|décembre)';
function pareceRevista(titulo) {
    const t = titulo || '';
    if (/n[úu]m(?:ero)?\.?\s*[\wIVXLC]+|a[ñn]o\s+[IVXLC0-9]+|revista|bolet[íi]n|índice literario|magazine|review|gazette|journal/i.test(t)) return true;
    if (new RegExp(`${MESES}[a-zé]*[-\\s/]*${MESES}?[a-zé]*\\s*[-,]?\\s*(19|20)\\d{2}`, 'i').test(t)) return true;
    return false;
}

/**
 * Orquestador universal (Tier 0–4). Recibe un recurso (1 archivo o un grupo de imágenes
 * del MISMO libro) y devuelve { documento, activos }.
 *   - documento: listo para enriquecer/persistir (sin resolver aún autores/editorial→ObjectId).
 *   - activos:   imágenes a guardar [{ tipo, origen, base64?, rutaOrigen?, url? }]; la primera es la portada.
 *
 * @param entrada { rutas: string[], contexto?: { ubicacion } }
 */
export async function procesarRecurso(entrada) {
    const rutas = entrada.rutas;
    const contexto = entrada.contexto || {};
    if (!rutas || rutas.length === 0) throw new Error("procesarRecurso: 'rutas' vacío");

    const tipo = detectarTipo(rutas[0]);
    console.log(`[Orquestador] ${path.basename(rutas[0])} · tipo=${tipo} · extrayendo metadatos del archivo...`);
    let datosBase, formatos, tipo_recurso;
    let activos = [];
    let escaneadoSinTexto = false;
    let isbnDelArchivo = false;

    if (tipo === 'epub') {
        // TIER 1 · metadatos nativos del EPUB
        datosBase = await extraerMetadatosEpub(rutas[0]);
        formatos = ['epub'];
        tipo_recurso = 'libro';
        // FICHERO DEFECTUOSO: EPUB con ZIP/OPF dañado → a Cuarentena/ilegibles (no se cataloga).
        if (datosBase.recurso_ilegible) {
            throw new ErrorRecursoIlegible(`EPUB ilegible (ZIP/OPF dañado): ${path.basename(rutas[0])}. Requiere una copia mejor.`);
        }
        // La cubierta embebida se resuelve más abajo (resolverPortada), midiéndola frente a las
        // portadas remotas; aquí solo se conserva en datosBase para la pista de visión.

    } else if (tipo === 'pdf') {
        // TIER 1 · capa de texto + info-dict
        datosBase = await extraerMetadatosPdf(rutas[0]);
        formatos = ['pdf'];

        // Sidecars + SEGUNDA OPINIÓN sobre la legibilidad: rasteriza las portadas con poppler (las 5
        // primeras + la última; la 1ª hace de portada para resolverPortada). Se hace ANTES del veredicto
        // de "ilegible": un PDF que el parser de TEXTO rechaza (cifrado/raro) o que sufrió un fallo
        // TRANSITORIO de E/S (p. ej. leído sobre una unidad de red mapeada, o abierto a la vez en Acrobat)
        // puede rasterizarse sin problema → NO es ilegible, es un escaneado y se procesa por OCR/visión/
        // barras. (Sin poppler, renders=[].)
        const renders = await rasterizarFrontalesPdf(rutas[0], datosBase.paginas);

        // FICHERO DEFECTUOSO: ilegible SÓLO si NI el parser de texto NI poppler pudieron con él. Así un
        // PDF legible (que Acrobat abre) que el parser tropezó, o un glitch puntual de red, ya NO va a
        // Cuarentena por error.
        if (datosBase.pdf_ilegible && renders.length === 0) {
            throw new ErrorRecursoIlegible(`PDF ilegible (ni el parser ni poppler pudieron leerlo): ${path.basename(rutas[0])}. Requiere una copia mejor.`);
        }
        if (datosBase.pdf_ilegible) {
            datosBase.pdf_ilegible = false;          // poppler SÍ lo rasterizó → procesable como escaneado
            datosBase.texto_legible = false;
            datosBase.texto_util = false;
            if (!datosBase.paginas && renders.length) datosBase.paginas = Math.max(...renders.map(r => r.pagina));
        }

        // CORROBORACIÓN AUTORITATIVA (offline, Fichero) — «identificar PRIMERO, clasificar después»: un
        // ISBN del CUERPO es solo pista… salvo que el Fichero lo resuelva a un LIBRO REAL cuyo TÍTULO casa
        // con el del doc / su nombre. Entonces el documento ES ese libro y su ISBN pasa a PROPIO → se
        // clasifica libro aunque traiga un ISSN de serie y aunque el nombre sea significativo (no un
        // ISBN/DOI). Se intenta SIEMPRE que aún no hay ISBN propio y el nombre no es fechado (un nombre
        // fechado / un 977 son señal fuerte de periódico y mandan). El falso positivo «revista que reseña
        // un libro» se descarta solo: el título de la revista NO casa con el del libro reseñado.
        if (!datosBase.isbn_propio && (datosBase.isbn_candidatos || []).length && !datosBase.esFechada) {
            const refTitulo = datosBase.titulo || path.basename(rutas[0]).replace(/\.[^.]+$/, '');
            const isbnOk = await corroborarISBNporTitulo({ candidatos: datosBase.isbn_candidatos, titulo: refTitulo });
            if (isbnOk) {
                datosBase.isbn_propio = isbnOk;
                if (!datosBase.isbn) datosBase.isbn = isbnOk;
                datosBase.alertas_agente = datosBase.alertas_agente || [];
                datosBase.alertas_agente.push(`ISBN ${isbnOk} corroborado por título en el Fichero → libro.`);
            }
        }

        // libro vs revista (DISCRIMINADOR por confianza): una señal débil (ISBN del CUERPO del texto, que
        // puede ser de un libro anunciado dentro de una revista) nunca pisa a una fuerte (ISBN PROPIO /
        // CIP / serie editorial → libro;  nombre fechado / ISSN 977 → revista). El 977/impreso lo añade
        // luego el lector de barras; aquí va la decisión provisional con texto + nombre.
        // Intérprete unificado de identificadores (fase 2·2): reúne TODOS los ISBN/ISSN y decide qué es
        // cada uno → señales por confianza para el discriminador. El 977/impreso lo resuelve luego el lector
        // de barras (aquí el ISSN del cuerpo es solo pista, vía issnCandidatos).
        const clasif = clasificarTipo(interpretarIdentificadores({
            isbnCandidatos: datosBase.isbn_candidatos || (datosBase.isbn ? [datosBase.isbn] : []),
            isbnPropio: datosBase.isbn_propio,                          // CIP / nombre-es-ISBN / incrustado
            isbnsRol: datosBase.isbns_rol,
            isbnObra: datosBase.isbn_obra,
            cip: !!datosBase.cip,
            issnCandidatos: datosBase.issn_candidatos || (datosBase.issn ? [datosBase.issn] : []),
            esFechada: !!datosBase.esFechada,
            volumenNumero: datosBase.volumen_numero,
            obraTitulo: datosBase.obra_titulo,
            pareceSerieLibros: pareceSerieLibros(datosBase.titulo),
            pareceRevista: pareceRevista(datosBase.titulo),
            titulo: datosBase.titulo,
        }).senales);
        tipo_recurso = clasif.tipo_recurso;
        isbnDelArchivo = !!datosBase.isbn_propio; // solo el ISBN PROPIO (no el del cuerpo) cuenta como fiable

        // ¿Es realmente un ESCANEO? Tres señales (cualquiera basta):
        //  1) sin capa de texto;
        //  2) la capa de texto NO es UTILIZABLE (OCR basura / extracción rota) — muy común;
        //  3) PDF de imágenes con capa OCR (Adobe Scan/Lens): pdfEsImagen lo detecta por productor + fuentes.
        // Así un escaneo con OCR ilegible deja de catalogarse como "libro digital en PDF".
        const esEscaneado = !datosBase.texto_legible || !datosBase.texto_util || await pdfEsImagen(rutas[0]);
        if (esEscaneado) {
            // PDF ESCANEADO = fotos de un libro FÍSICO (Adobe Scan / cámara / Lens), NO un PDF digital.
            // Se trata IGUAL que el grupo de imágenes de la cámara (que sí identifica bien): se identifican
            // las páginas rasterizadas con la MISMA visión (analizarImagenesRecurso) y el soporte es
            // 'papel'. Su nombre suele ser la FECHA del escaneo ("Adobe Scan Jun 29, 2024"), por eso aquí
            // NO se aplica la heurística nombre-fechado→revista (eso archivaba escaneos de libros como revistas).
            escaneadoSinTexto = true;
            formatos = ['papel'];
            // EXPLOTAR el PDF en imágenes: una por página (todas, con un cap) → se guardan como las
            // imágenes del libro (carrusel), igual que un escaneo de cámara. Así la ficha es idéntica
            // para todos los libros escaneados. Se conservan TODAS las páginas escaneadas.
            const totalPag = datosBase.paginas || (renders.length ? Math.max(...renders.map(r => r.pagina)) : 0);
            let paginasImg = renders;
            if (totalPag > renders.length) {
                const nums = Array.from({ length: Math.min(totalPag, PDF_EXPLOTAR_MAX) }, (_, i) => i + 1);
                const todas = await rasterizarPaginas(rutas[0], { paginas: nums, ancho: PDF_EXPLOTAR_ANCHO });
                if (todas.length) paginasImg = todas;
            }
            for (const r of paginasImg) {
                activos.push({ tipo: r.pagina === 1 ? 'portada' : 'otra', origen: `pdf:pag-${r.pagina}`, base64: r.buffer.toString('base64') });
            }
            const tecnicos = { paginas: datosBase.paginas, isbns_rol: datosBase.isbns_rol, cip: datosBase.cip };
            const isbnForm = contexto.isbn ? validarISBN(contexto.isbn) : null;
            let local = null;
            if (isbnForm) local = await buscarEnFicheroLocal({ isbns: [isbnForm] }).catch(() => null);
            if (isbnForm && local && local.titulo) {
                // FAST-PATH: ISBN conocido y en el Fichero local → sin visión IA.
                datosBase = { isbn: isbnForm, isbn_propio: isbnForm, isbn_candidatos: variantesISBN(isbnForm),
                    titulo: local.titulo, tipo_recurso: 'libro', paginas: tecnicos.paginas, texto_legible: false,
                    alertas_agente: [`PDF escaneado: ISBN ${isbnForm} hallado en el Fichero local → identificado sin visión IA.`] };
                isbnDelArchivo = true; tipo_recurso = 'libro';
                console.log(`[Orquestador] PDF escaneado con ISBN ${isbnForm} en Fichero: FAST-PATH (sin visión IA).`);
            } else {
                const imgs = renders.map(r => ({ data: r.buffer, mimeType: 'image/png' }));
                let visto = null;
                if (imgs.length) { try { visto = await analizarImagenesRecurso(imgs); } catch (e) { console.warn(`[PDF escaneado] visión falló: ${e.message}; OCR de reserva.`); } }
                if (visto && (visto.titulo || visto.isbn || visto.issn)) {
                    datosBase = { ...visto, paginas: tecnicos.paginas, texto_legible: false };
                    isbnDelArchivo = !!visto.isbn;
                    tipo_recurso = visto.tipo_recurso || tipo_recurso;
                    datosBase.alertas_agente = ['PDF escaneado tratado como libro físico: identificado por visión sobre las páginas (soporte: papel).'];
                    if (visto.isbn) datosBase.alertas_agente.push(`ISBN ${visto.isbn} leído de las páginas por VISIÓN IA (servidor); no se usó lector de código de barras dedicado.`);
                } else {
                    // Reserva: OCR clásico sobre los renders.
                    const v = await ocrDesdeRenders(renders);
                    if (v && (v.titulo || v.isbn || v.issn)) { datosBase = fusionarOcr(datosBase, v); isbnDelArchivo = !!v.isbn; if (v.tipo_recurso) tipo_recurso = v.tipo_recurso; }
                    datosBase.alertas_agente = ['PDF escaneado, OCR de reserva (visión no concluyente): páginas como sidecars para revisión.'];
                }
                if (tecnicos.isbns_rol) datosBase.isbns_rol = tecnicos.isbns_rol;
                if (tecnicos.cip) datosBase.cip = tecnicos.cip;
            }
        } else {
            // PDF DIGITAL (con capa de texto): se conserva el PDF; sus páginas clave (portada + créditos +
            // contraportada) van como SIDECARS (preview/portada), no se explota en imágenes.
            for (const r of renders) {
                activos.push({ tipo: r.etiqueta === 'portada' ? 'portada' : 'otra', origen: `pdf:${r.etiqueta}`, base64: r.buffer.toString('base64') });
            }
            // La FECHA DEL NOMBRE es autoridad para el nº de revista ("Title YYYY-MM" / "Title Mes Año") —
            // el curador lo nombró con la fecha real del número; un nº mensual NO es un libro. (En
            // ESCANEADOS no se aplica: su nombre es la fecha del escaneo.)
            const fechaNombre = parsearNombre(path.basename(rutas[0]));
            if (fechaNombre.esFechada) {
                datosBase.año_edicion = fechaNombre.año_edicion;
                if (fechaNombre.mes_publicacion != null) datosBase.mes_publicacion = fechaNombre.mes_publicacion;
                if (datosBase.isbn) datosBase.alertas_agente = [...(datosBase.alertas_agente || []),
                    `ISBN ${datosBase.isbn} descartado: nombre de revista fechado → el identificador es el ISSN.`];
                tipo_recurso = 'revista';
                delete datosBase.isbn;
                datosBase.isbn_candidatos = [];
            }
        }

        // CÓDIGO DE BARRAS (recorte→visión): lee el EAN-13 de la cubierta cuando falta el identificador
        // PROPIO del tipo. Una REVISTA necesita su ISSN aunque el OCR le haya colado un ISBN espurio (las
        // revistas no llevan ISBN); un LIBRO necesita su ISBN. 977→ISSN/revista, 978/979→ISBN. Recortes a
        // alta resolución (la visión lee bien un recorte enfocado). No gasta visión si el id propio ya está.
        if (!datosBase.issn && (!datosBase.isbn || tipo_recurso === 'revista')) {
            const bc = await leerCodigoBarrasPorVision(rutas[0], datosBase.paginas, renders);
            if (bc) {
                if (bc.issn) datosBase.issn = bc.issn;
                if (bc.isbn) { datosBase.isbn = bc.isbn; isbnDelArchivo = true; }
                if (bc.mes_publicacion && datosBase.mes_publicacion == null) datosBase.mes_publicacion = bc.mes_publicacion;
                if (bc.esRevista && !bc.isbn) tipo_recurso = 'revista'; // un 977 = periódico (los libros llevan 978/979)
                datosBase.alertas_agente = [...(datosBase.alertas_agente || []),
                    `Código de barras (recorte→visión): ${bc.issn || bc.isbn}${bc.mes_publicacion ? ' · mes ' + bc.mes_publicacion : ''}.`];
                console.log(`[Barras] EAN-13 leído de la cubierta → ${bc.issn || bc.isbn}`);
            }
        }

    } else if (tipo === 'imagen') {
        // FAST-PATH por ISBN (código de barras leído en el MÓVIL → formulario): si ese ISBN está en el
        // Fichero local, NO se gasta VISIÓN IA — se identifica por ISBN (Fichero → APIs) y las fotos son
        // solo la portada/escaneo. Sin ISBN, o si no está en el Fichero, se cae a la visión de siempre.
        const isbnForm = contexto.isbn ? validarISBN(contexto.isbn) : null;
        let local = null;
        if (isbnForm) local = await buscarEnFicheroLocal({ isbns: [isbnForm] }).catch(() => null);
        if (isbnForm && local && local.titulo) {
            datosBase = {
                isbn: isbnForm, isbn_propio: isbnForm, isbn_candidatos: variantesISBN(isbnForm),
                titulo: local.titulo, tipo_recurso: 'libro',
                alertas_agente: [`ISBN ${isbnForm} (formulario/código de barras) hallado en el Fichero local → identificado sin visión IA.`],
            };
            console.log(`[Orquestador] Imagen con ISBN ${isbnForm} en Fichero: FAST-PATH (sin visión IA).`);
        } else {
            // TIER 3 · libro físico: visión multimodal sobre el grupo de imágenes.
            // Sin reprocesado local (sin sharp): se envían los bytes originales con su MIME real.
            // El redimensionado/orientación de fotos escaneadas se delega al front-end emisor.
            const imagenes = [];
            for (const r of rutas) {
                imagenes.push({ data: await fs.readFile(r), mimeType: mimeDeImagen(r) });
            }
            try {
                datosBase = await analizarImagenesRecurso(imagenes);
            } catch (e) {
                // Sin texto ni metadatos, si la visión falla no hay forma de identificar el libro.
                throw new ErrorIdentificacion(`Visión IA falló sobre el grupo de imágenes: ${e.message}`);
            }
            if (datosBase.isbn) datosBase.alertas_agente = [...(datosBase.alertas_agente || []),
                `ISBN ${datosBase.isbn} leído de las imágenes por VISIÓN IA (servidor); el código de barras no se leyó en el móvil.`];
        }
        formatos = ['papel'];
        tipo_recurso = datosBase.tipo_recurso || 'libro';
        // CONSOLIDACIÓN (fase 2, unifica el escaneo con el PDF): la visión da su propio veredicto de tipo,
        // pero puede equivocarse (una monografía con ISSN de serie —Springer— leída como «revista»). Si dijo
        // REVISTA y hay un ISBN que el Fichero CORROBORA como un libro real (su título casa), es un LIBRO. Es
        // seguro: una revista de verdad no tiene un ISBN de libro cuyo título coincida con el suyo. Offline.
        if (tipo_recurso === 'revista' && !datosBase.esFechada && (datosBase.isbn_candidatos || []).length) {
            const refTitulo = datosBase.titulo || path.basename(rutas[0]).replace(/\.[^.]+$/, '');
            const isbnOk = await corroborarISBNporTitulo({ candidatos: datosBase.isbn_candidatos, titulo: refTitulo });
            if (isbnOk) {
                tipo_recurso = 'libro';
                datosBase.isbn_propio = datosBase.isbn_propio || isbnOk;
                if (!datosBase.isbn) datosBase.isbn = isbnOk;
                datosBase.alertas_agente = [...(datosBase.alertas_agente || []), `Reclasificado a LIBRO: ISBN ${isbnOk} corroborado por título en el Fichero.`];
            }
        }
        // Cada imagen aportada es un activo local; la primera se marca como portada.
        rutas.forEach((r, i) => activos.push({
            tipo: i === 0 ? 'portada' : 'otra',
            origen: 'escaneo',
            rutaOrigen: r
        }));

    } else if (tipo === 'comic') {
        // CÓMIC (.cbz/.cbr/.cb7): portada (CBZ→adm-zip, CBR/CB7→bsdtar) + clasificación serie/álbum. naturaleza:'comic'.
        datosBase = await extraerMetadatosComic(rutas[0]);
        formatos = datosBase.formatos;
        // Diagnóstico (titular: visible en modo simple): ¿se extrajo la PORTADA del comprimido al ingerir?
        console.log(`  📕 Cómic «${path.basename(rutas[0])}»: ${datosBase.paginas || 0} pág · portada ${datosBase.cubierta_base64 ? 'extraída ✓' : 'NO ✗'} · ${datosBase.muestra_paginas?.length || 0} de muestra${(datosBase.alertas_agente || []).length ? ' · ' + datosBase.alertas_agente.join('; ') : ''}`);
        // VISIÓN sobre las páginas de muestra (5 primeras + última, como un PDF): busca el código de barras /
        // ISBN / ISSN impreso. El ISBN es el PIVOTE para identificar el cómic por Fichero/APIs. Una sola
        // llamada; se omite si el nombre ya trajo un ISBN propio (coste mínimo).
        if (datosBase.muestra_paginas?.length && !datosBase.isbn_propio) {
            try {
                const id = await leerIdentificadorDeImagenes(datosBase.muestra_paginas);
                if (id?.isbn) {
                    datosBase.isbn = id.isbn; datosBase.isbn_propio = id.isbn;
                    datosBase.isbn_candidatos = [...new Set([...(datosBase.isbn_candidatos || []), ...variantesISBN(id.isbn)])];
                    datosBase.alertas_agente.push(`ISBN leído de las páginas (visión): ${id.isbn}.`);
                    console.log(`[Cómic] ISBN de las páginas → ${id.isbn}`);
                }
                if (id?.issn) {
                    datosBase.issn = id.issn;
                    if (id.mes_publicacion && !datosBase.mes_publicacion) datosBase.mes_publicacion = id.mes_publicacion;
                    datosBase.alertas_agente.push(`ISSN leído de las páginas (visión): ${id.issn}.`);
                    console.log(`[Cómic] ISSN de las páginas → ${id.issn}`);
                }
            } catch (e) {
                datosBase.alertas_agente.push(`Lectura de identificador por visión falló: ${e.message}`);
            }
        }
        const clasif = clasificarTipo(interpretarIdentificadores({
            esComic: true,
            comicSerie: datosBase.comic_serie,
            esFechada: !!datosBase.esFechada,
            isbnPropio: datosBase.isbn_propio || null,
            isbnCandidatos: datosBase.isbn_candidatos,
            issnBarras977: datosBase.issn,           // el ISSN del cómic viene del barras 977 ⇒ cómic-revista
            titulo: datosBase.titulo,
        }).senales);
        tipo_recurso = clasif.tipo_recurso;          // revista (nº de serie / ISSN) | libro (álbum/novela gráfica)
        datosBase.naturaleza = clasif.naturaleza;    // 'comic'
        // Un cómic-LIBRO (álbum/novela gráfica suelto) NO es una obra multivolumen: obra_titulo se fijó
        // SOLO para agrupar una SERIE-revista por cabecera. Si quedó como libro (p. ej. trae ISBN), se
        // descarta — si no, motor-catalogo lo enruta al árbol de obras y, SIN volumen_numero, los
        // ejemplares colisionan todos en obras/<serie>/vol-x. Como libro, cada ejemplar es su propio doc.
        if (tipo_recurso === 'libro') delete datosBase.obra_titulo;
        delete datosBase.muestra_paginas;            // páginas de muestra: solo para la visión, no se persisten

    } else if (tipo === 'djvu') {
        // DjVu (normalmente un LIBRO escaneado): metadatos del nombre + rasterizado de páginas de muestra
        // (ddjvu→pdftoppm) → VISIÓN para código de barras / ISBN / ISSN, igual que un cómic o un PDF.
        datosBase = metadatosDesdeNombre(rutas[0]);
        datosBase.formatos = ['djvu'];
        formatos = ['djvu'];
        datosBase.alertas_agente = datosBase.alertas_agente || [];
        if (datosBase.isbn) datosBase.isbn_propio = datosBase.isbn; // el nombre ERA un ISBN (señal fuerte)
        try {
            const { paginas, cubierta_base64, muestra } = await paginasMuestraDjvu(rutas[0]);
            if (paginas) datosBase.paginas = paginas;
            if (cubierta_base64) datosBase.cubierta_base64 = cubierta_base64;
            if (muestra?.length) datosBase.muestra_paginas = muestra;
            else datosBase.alertas_agente.push('DjVu: no se pudieron rasterizar páginas para la visión.');
        } catch (e) {
            datosBase.alertas_agente.push(`DjVu: rasterizado de páginas falló (${e.message}).`);
        }
        if (datosBase.muestra_paginas?.length && !datosBase.isbn_propio) {
            try {
                const id = await leerIdentificadorDeImagenes(datosBase.muestra_paginas);
                if (id?.isbn) {
                    datosBase.isbn = id.isbn; datosBase.isbn_propio = id.isbn;
                    datosBase.isbn_candidatos = [...new Set([...(datosBase.isbn_candidatos || []), ...variantesISBN(id.isbn)])];
                    datosBase.alertas_agente.push(`ISBN leído de las páginas (visión): ${id.isbn}.`);
                    console.log(`[DjVu] ISBN de las páginas → ${id.isbn}`);
                }
                if (id?.issn) {
                    datosBase.issn = id.issn;
                    if (id.mes_publicacion && !datosBase.mes_publicacion) datosBase.mes_publicacion = id.mes_publicacion;
                    datosBase.alertas_agente.push(`ISSN leído de las páginas (visión): ${id.issn}.`);
                    console.log(`[DjVu] ISSN de las páginas → ${id.issn}`);
                }
            } catch (e) {
                datosBase.alertas_agente.push(`Lectura de identificador por visión falló: ${e.message}`);
            }
        }
        const clasif = clasificarTipo(interpretarIdentificadores({
            isbnPropio: datosBase.isbn_propio || null,
            isbnCandidatos: datosBase.isbn_candidatos,
            issnBarras977: datosBase.issn,                // un 977-ISSN escaneado ⇒ revista
            pareceRevista: pareceRevista(datosBase.titulo || ''),
            titulo: datosBase.titulo,
        }).senales);
        tipo_recurso = clasif.tipo_recurso;               // libro (por defecto) | revista (ISSN / título de revista)
        delete datosBase.muestra_paginas;                 // solo para la visión, no se persiste

    } else if (tipo === 'otro-formato') {
        // Puerta abierta: formato conocido sin lector propio aún (mobi/djvu/zip/rar; los cómics .cbz/.cbr/.cb7 tienen su rama).
        datosBase = metadatosDesdeNombre(rutas[0]);
        datosBase.alertas_agente = [`Formato "${path.extname(rutas[0])}" sin lector de contenido: catalogado por nombre + APIs.`];
        formatos = [FORMATO_POR_EXT[path.extname(rutas[0]).toLowerCase()]];
        tipo_recurso = 'libro';

    } else {
        throw new ErrorIdentificacion(`Tipo de archivo no soportado: ${path.basename(rutas[0])}`);
    }

    // OVERRIDE manual (sidecar .meta.json): el usuario FUERZA campos para corregir una identificación
    // errónea. Se aplica ANTES de enriquecer: sus valores guían/bloquean el enriquecimiento (un ISBN
    // correcto pasa a ser el pivote; sin_apis evita que las APIs vuelvan a confundirlo).
    let sinApis = false, forzarNuevo = false;
    const override = await leerOverride(rutas[0]);
    if (override) {
        ({ sinApis, forzarNuevo } = aplicarOverride(datosBase, override));
        if (override.tipo_recurso) tipo_recurso = override.tipo_recurso;
        console.log(`[Orquestador] Override manual aplicado a ${path.basename(rutas[0])}${sinApis ? ' (sin APIs)' : ''}${forzarNuevo ? ' (forzar nuevo)' : ''}.`);
    }

    // ISBN provisto por el usuario (formulario del Inbox): AUTORIDAD (como un override.isbn) → la
    // identificación es directa y barata, y cuenta como señal fuerte de LIBRO (isbn_propio).
    if (contexto.isbn) {
        const v = validarISBN(contexto.isbn);
        if (v) {
            datosBase.isbn = v; datosBase.isbn_propio = v;
            datosBase.isbn_candidatos = [...new Set([...(datosBase.isbn_candidatos || []), ...variantesISBN(v)])];
            datosBase.alertas_agente = [...(datosBase.alertas_agente || []), contexto.isbn_origen === 'movil'
                ? `ISBN ${v} leído del CÓDIGO DE BARRAS en el móvil (cliente, antes de subir).`
                : `ISBN ${v} aportado en el formulario de la subida.`];
            console.log(`[Orquestador] ISBN del formulario aplicado a ${path.basename(rutas[0])}: ${v}.`);
        }
    }

    // TIER 2–4 · enriquecimiento conservador (APIs + IA solo para huecos)
    const documento = await enriquecerMetadatos(datosBase, {
        tipo_recurso,
        formatos,
        ubicacion: contexto.ubicacion,
        coleccion: contexto.coleccion,   // drop por carpeta: colección autoritativa
        obra: contexto.obra,             // tomo de obra multivolumen (titulo, numero, titulo_volumen)
        sinApis,                         // override sin_apis: no consultar APIs/IA
    });

    // Portada de calidad (las imágenes escaneadas ya son su propia portada; no se tocan).
    // Mide la cubierta embebida y las remotas, descarta las degeneradas (1x1 de OpenLibrary)
    // y, si ninguna llega al ancho objetivo y es un PDF, rasteriza páginas clave con poppler.
    if (tipo !== 'imagen' && !activos.some(a => a.tipo === 'portada')) {
        // Portada pre-extraída (covers/ del drop por carpeta): otra candidata que compite por tamaño.
        let preextraidaBase64 = null;
        if (contexto.portadaLocal) {
            try { preextraidaBase64 = (await fs.readFile(contexto.portadaLocal)).toString('base64'); } catch { /* ilegible: se ignora */ }
        }
        const { portada, extras } = await resolverPortada({
            tipo,
            rutas,
            numPaginas: datosBase.paginas || 2,
            embebidaBase64: datosBase.cubierta_base64 || datosBase.imagen_adicional || null,
            preextraidaBase64,
            remotos: Array.isArray(documento._portadas_remotas) ? documento._portadas_remotas : [],
        });
        if (portada) activos.push({ tipo: 'portada', origen: portada.origen, base64: portada.base64 });
        for (const ex of extras) activos.push({ tipo: 'otra', origen: ex.origen, base64: ex.base64 });
    }

    // PDF + candidata externa de portada (covers/ o fichero suelto): algunos digitalizadores
    // extraen la cubierta a un fichero aparte, así que la página 1 del PDF que rasterizamos es en
    // realidad la primera página de TEXTO, no la cubierta. Solo cuando HAY candidata externa lo
    // evaluamos: si la página 1 parece texto, la candidata ES la cubierta; si no, gana la más
    // ancha ("widest wins" también para PDF). El raster desplazado queda como sidecar.
    if (tipo === 'pdf' && contexto.portadaLocal) {
        try {
            const candBuf = await fs.readFile(contexto.portadaLocal);
            const candM = medirImagen(candBuf);
            if (candM && candM.width >= PORTADA_ANCHO_MINIMO) {
                const idx = activos.findIndex(a => a.tipo === 'portada');
                const rasterM = idx >= 0 ? medirImagen(Buffer.from(activos[idx].base64, 'base64')) : null;
                const texto1 = await textoPagina(rutas[0], 1);
                const pag1EsTexto = texto1.replace(/\s/g, '').length > PAG1_TEXTO_UMBRAL;
                const usarCandidata = !rasterM || pag1EsTexto || candM.width > rasterM.width;
                if (usarCandidata) {
                    if (idx >= 0) activos[idx].tipo = 'otra'; // el raster de la pág.1 pasa a sidecar
                    activos.unshift({ tipo: 'portada', origen: 'covers', base64: candBuf.toString('base64') });
                    documento.alertas_agente.push(pag1EsTexto
                        ? 'Portada tomada del fichero externo (la página 1 del PDF es texto, no cubierta).'
                        : 'Portada tomada del fichero externo (mayor resolución que la página 1).');
                }
            }
        } catch { /* candidata ilegible: se conserva la portada rasterizada */ }
    }
    delete documento._portadas_remotas;

    // Regla conservadora: un PDF escaneado sin ISBN propio no puede darse por verificado;
    // cualquier coincidencia de API es una conjetura a partir de un título débil.
    if (escaneadoSinTexto && !isbnDelArchivo) {
        documento.estado_verificacion = 'pendiente';
        documento.alertas_agente.push("Identificación NO verificada (PDF escaneado, sin OCR): requiere revisión humana.");
    }

    // Sin título: pero un ISBN/ISSN válido ES un identificador fuerte. No se descarta a Cuarentena
    // solo porque las APIs no resolvieran el título ahora (caídas, o ISBN no indexado en las libres):
    // se cataloga como PENDIENTE con el identificador de título provisional, y el Conformador
    // (re-enriquecer-degradados) recuperará el título real buscando por ISBN cuando se pueda.
    // Solo va a Cuarentena lo que NO tiene ni título ni identificador (irreconocible de verdad).
    if (!documento.titulo || !String(documento.titulo).trim()) {
        const identificador = documento.isbn || documento.issn;
        if (identificador) {
            documento.titulo = String(identificador);
            documento.estado_verificacion = 'pendiente';
            documento.alertas_agente.push(`Sin título resoluble ahora; catalogado como pendiente con ${documento.isbn ? 'ISBN' : 'ISSN'} ${identificador} (se reintentará por identificador).`);
        } else {
            throw new ErrorIdentificacion(`No se pudo identificar ni título ni ISBN/ISSN para: ${path.basename(rutas[0])}`);
        }
    }

    return { documento, activos, forzarNuevo };
}
