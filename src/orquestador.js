import fs from 'fs/promises';
import path from 'path';
import { extraerMetadatosEpub } from './utils/lector-epub.js';
import { extraerMetadatosPdf } from './utils/lector-pdf.js';
import { analizarImagenesRecurso } from './agente.js';
import { enriquecerMetadatos } from './motor-enriquecimiento.js';
import { ErrorIdentificacion, ErrorInfraestructura } from './errores.js';
import { parsearNombre } from './utils/parsear-nombre.js';
import { resolverPortada } from './utils/resolver-portada.js';
import { rasterizarFrontalesPdf, ocrDesdeRenders } from './utils/ocr-pdf.js';

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

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
const FORMATO_POR_EXT = {
    '.epub': 'epub', '.pdf': 'pdf',
    '.mobi': 'mobi', '.cbr': 'cbr', '.djvu': 'djvu', '.zip': 'zip', '.rar': 'rar',
};

export function detectarTipo(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    if (EXT_IMAGEN.includes(ext)) return 'imagen';
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
        editorial: ocr.editorial || null,
        año_edicion: ocr.año_edicion || null,
        idioma: ocr.idioma || null,
        cdu: ocr.cdu || null,
        sinopsis: ocr.sinopsis || null,
        palabras_clave: arr(ocr.palabras_clave),
    };
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
        // La cubierta embebida se resuelve más abajo (resolverPortada), midiéndola frente a las
        // portadas remotas; aquí solo se conserva en datosBase para la pista de visión.

    } else if (tipo === 'pdf') {
        // TIER 1 · capa de texto + info-dict
        datosBase = await extraerMetadatosPdf(rutas[0]);
        formatos = ['pdf'];
        // Señales de revista: prefijo de fecha ISO en nombre (esFechada), ISSN encontrado en
        // el texto, o título con patrones de publicación periódica.
        tipo_recurso = (datosBase.esFechada || datosBase.issn || pareceRevista(datosBase.titulo))
            ? 'revista' : 'libro';
        isbnDelArchivo = !!datosBase.isbn; // ISBN leído del propio PDF (fiable)

        // Sidecars de TODO PDF: rasteriza las 5 primeras + la última (preview + OCR de datos/
        // código de barras). La 1ª hace de portada → resolverPortada no re-rasteriza más abajo.
        // (Si no hay poppler, renders=[] y la portada vendrá de fuentes remotas.)
        const renders = await rasterizarFrontalesPdf(rutas[0], datosBase.paginas);
        for (const r of renders) {
            activos.push({
                tipo: r.etiqueta === 'portada' ? 'portada' : 'otra',
                origen: `pdf:${r.etiqueta}`,
                base64: r.buffer.toString('base64'),
            });
        }

        if (!datosBase.texto_legible) {
            escaneadoSinTexto = true;
            // TIER 3 · PDF escaneado: el nombre del archivo suele ser basura (p. ej.
            // "(ebook - pdf) Título") y arrastra a las APIs a un libro equivocado. La única
            // fuente fiable es la imagen de esas páginas → OCR por visión (reusa los renders).
            const v = await ocrDesdeRenders(renders);
            if (v && (v.titulo || v.isbn)) {
                datosBase = fusionarOcr(datosBase, v);
                isbnDelArchivo = !!v.isbn;                   // ISBN leído del documento: fiable
                if (v.tipo_recurso) tipo_recurso = v.tipo_recurso;
                datosBase.alertas_agente = ["PDF escaneado identificado por OCR de visión; páginas guardadas como sidecars."];
            } else {
                datosBase.alertas_agente = ["PDF escaneado, OCR no concluyente: páginas guardadas como sidecars para revisión manual."];
            }
        }

    } else if (tipo === 'imagen') {
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
        formatos = ['papel'];
        tipo_recurso = datosBase.tipo_recurso || 'libro';
        // Cada imagen aportada es un activo local; la primera se marca como portada.
        rutas.forEach((r, i) => activos.push({
            tipo: i === 0 ? 'portada' : 'otra',
            origen: 'escaneo',
            rutaOrigen: r
        }));

    } else if (tipo === 'otro-formato') {
        // Puerta abierta: formato conocido sin lector propio aún (mobi/cbr/djvu/zip/rar).
        datosBase = metadatosDesdeNombre(rutas[0]);
        datosBase.alertas_agente = [`Formato "${path.extname(rutas[0])}" sin lector de contenido: catalogado por nombre + APIs.`];
        formatos = [FORMATO_POR_EXT[path.extname(rutas[0]).toLowerCase()]];
        tipo_recurso = 'libro';

    } else {
        throw new ErrorIdentificacion(`Tipo de archivo no soportado: ${path.basename(rutas[0])}`);
    }

    // TIER 2–4 · enriquecimiento conservador (APIs + IA solo para huecos)
    const documento = await enriquecerMetadatos(datosBase, {
        tipo_recurso,
        formatos,
        ubicacion: contexto.ubicacion,
        coleccion: contexto.coleccion,   // drop por carpeta: colección autoritativa
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

    return { documento, activos };
}
