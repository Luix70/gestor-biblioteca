import fs from 'fs/promises';
import path from 'path';
import { extraerMetadatosEpub } from './utils/lector-epub.js';
import { extraerMetadatosPdf } from './utils/lector-pdf.js';
import { analizarImagenesRecurso } from './agente.js';
import { optimizarImagenRecurso } from './procesador-imagenes.js';
import { enriquecerMetadatos } from './motor-enriquecimiento.js';
import { ErrorIdentificacion, ErrorInfraestructura } from './errores.js';

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

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

// Título/autores de respaldo a partir del nombre de archivo "Título - Autor1- Autor2.ext".
function metadatosDesdeNombre(ruta) {
    const base = path.basename(ruta, path.extname(ruta));
    const partes = base.split(' - ');
    const autores = partes.length > 1
        ? partes.slice(1).join(' - ').split(/\s*-\s*/).map(s => s.trim()).filter(Boolean)
        : [];
    return { titulo: partes[0].trim(), autores };
}

// Heurística: ¿el título parece el de una publicación periódica?
function pareceRevista(titulo) {
    return /n[úu]m(?:ero)?\.?\s*[\wIVXLC]+|a[ñn]o\s+[IVXLC0-9]+|revista|bolet[íi]n|índice literario/i.test(titulo || '');
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
    let datosBase, formatos, tipo_recurso;
    let activos = [];
    let escaneadoSinTexto = false;
    let isbnDelArchivo = false;

    if (tipo === 'epub') {
        // TIER 1 · metadatos nativos del EPUB
        datosBase = await extraerMetadatosEpub(rutas[0]);
        formatos = ['epub'];
        tipo_recurso = 'libro';
        const cubierta = datosBase.cubierta_base64 || datosBase.imagen_adicional;
        if (cubierta) activos.push({ tipo: 'portada', origen: 'epub', base64: cubierta });

    } else if (tipo === 'pdf') {
        // TIER 1 · capa de texto + info-dict
        datosBase = await extraerMetadatosPdf(rutas[0]);
        formatos = ['pdf'];
        tipo_recurso = pareceRevista(datosBase.titulo) ? 'revista' : 'libro';
        isbnDelArchivo = !!datosBase.isbn; // ISBN leído del propio PDF (fiable)
        if (!datosBase.texto_legible) {
            escaneadoSinTexto = true;
            datosBase.alertas_agente = ["PDF sin capa de texto (escaneado): identificación por título de archivo + APIs."];
        }
        // No podemos rasterizar el PDF (sin Ghostscript): la portada vendrá de fuentes remotas.

    } else if (tipo === 'imagen') {
        // TIER 3 · libro físico: visión multimodal sobre el grupo de imágenes
        const buffers = [];
        for (const r of rutas) {
            const bruto = await fs.readFile(r);
            buffers.push(await optimizarImagenRecurso(bruto));
        }
        try {
            datosBase = await analizarImagenesRecurso(buffers);
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
        ubicacion: contexto.ubicacion
    });

    // Si no hay portada local, usar candidatos remotos (OpenLibrary / Google Books).
    const tienePortadaLocal = activos.some(a => a.tipo === 'portada');
    if (!tienePortadaLocal && Array.isArray(documento._portadas_remotas)) {
        for (const cand of documento._portadas_remotas) {
            activos.push({ tipo: 'portada', origen: cand.origen, url: cand.url });
            break; // basta la primera como portada; el resto quedan como respaldo
        }
    }
    delete documento._portadas_remotas;

    // Regla conservadora: un PDF escaneado sin ISBN propio no puede darse por verificado;
    // cualquier coincidencia de API es una conjetura a partir de un título débil.
    if (escaneadoSinTexto && !isbnDelArchivo) {
        documento.estado_verificacion = 'pendiente';
        documento.alertas_agente.push("Identificación NO verificada (PDF escaneado, sin OCR): requiere revisión humana.");
    }

    // Identificación imposible: ni siquiera hay un título. El recurso debe ir a Cuarentena.
    if (!documento.titulo || !String(documento.titulo).trim()) {
        throw new ErrorIdentificacion(`No se pudo identificar ningún título para: ${path.basename(rutas[0])}`);
    }

    return { documento, activos };
}
