/**
 * EXTRACCIÓN DE ISBN desde el propio fichero, SIN IA ni red — parte PURA (sin BD) compartida por la ingesta de
 * colecciones (`transmedia.js`), el motor de re-identificación (`reidentificar-doc.js`) y su acción/backfill.
 *
 * Confianza del ISBN (misma política que el orquestador, para NO colgar un ISBN equivocado):
 *   · EPUB → dc:identifier del OPF (propio del libro) → se confía.
 *   · MOBI/AZW → registro EXTH (propio) → se confía.
 *   · PDF → el ISBN PROPIO (nombre-es-ISBN / DOI / bloque CIP) se confía; un candidato del CUERPO del texto
 *     solo se acepta si CORROBORA por título contra el Fichero (`corroborarISBNporTitulo`).
 *   · Nombre de archivo → un ISBN incrustado en el nombre se trata como propio.
 */
import path from 'node:path';
import { extraerMetadatosPdf, extraerISBNs } from './lector-pdf.js';
import { extraerMetadatosEpub } from './lector-epub.js';
import { leerMobi } from './lector-mobi.js';
import { corroborarISBNporTitulo } from './buscador-local.js';
import { validarISBN } from './identificadores.js';

// Tipo por extensión — sin importar el orquestador (evita ciclos y peso; solo estos formatos dan un ISBN de
// texto/metadatos barato). Devuelve null para djvu/cbz/… (no soportados aquí).
export function tipoLibro(abs) {
    const ext = path.extname(abs || '').toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    if (['.mobi', '.azw', '.azw3', '.prc'].includes(ext)) return 'mobi';
    return null;
}

// El primer ISBN VÁLIDO de un texto (nombre de archivo), o null.
function isbnDeTexto(texto) {
    for (const x of extraerISBNs(String(texto || ''))) { const v = validarISBN(x); if (v) return v; }
    return null;
}

/**
 * Extrae el ISBN (y de paso título/autores/editorial del propio fichero) SIN IA ni red. Devuelve
 * { isbn, titulo, autores, editorial } con lo que haya (todos opcionales). Best-effort: nunca lanza.
 */
export async function isbnDesdeArchivo(abs, { nombre = '', tituloRef = '' } = {}) {
    const tipo = tipoLibro(abs);
    const base = path.basename(nombre || abs || '');
    // Un ISBN incrustado en el NOMBRE es propio (autoritativo), como en la ingesta.
    const isbnNombre = isbnDeTexto(base);
    if (!tipo) return { isbn: isbnNombre, titulo: null, autores: [], editorial: null };

    try {
        if (tipo === 'epub') {
            const m = await extraerMetadatosEpub(abs);
            return { isbn: validarISBN(m?.isbn) || isbnNombre, titulo: m?.titulo || null, autores: m?.autores || [], editorial: m?.editorial || null };
        }
        if (tipo === 'mobi') {
            const m = await leerMobi(abs);
            return { isbn: validarISBN(m?.isbn) || isbnNombre, titulo: m?.titulo || null, autores: m?.autores || [], editorial: m?.editorial || null };
        }
        // PDF: propio (nombre/DOI/CIP) directo; candidato del cuerpo solo si corrobora por título.
        const d = await extraerMetadatosPdf(abs);
        let isbn = validarISBN(d?.isbn_propio) || isbnNombre;
        if (!isbn && d?.isbn_candidatos?.length) {
            const ref = d.titulo || tituloRef || base;
            isbn = await corroborarISBNporTitulo({ candidatos: d.isbn_candidatos, titulo: ref }).catch(() => null);
        }
        // OJO: el título del info-dict de un PDF es POCO FIABLE (a menudo un artefacto: «Keywords: …», el nombre
        // del fichero fuente, etc.) → NO se devuelve como título autoritativo (solo se usó arriba como referencia
        // para corroborar). El título bueno vendrá de la autoridad (Fichero/APIs por ISBN). En EPUB/MOBI sí es
        // fiable (OPF/EXTH). Los autores del info-dict ya vienen filtrados de artefactos por extraerMetadatosPdf.
        return { isbn: isbn || null, titulo: null, autores: d?.autores || [], editorial: null };
    } catch {
        return { isbn: isbnNombre, titulo: null, autores: [], editorial: null };
    }
}
