import fs from 'fs/promises';
import path from 'path';
import { extractText, getDocumentProxy } from 'unpdf';
import { extraerISSN } from './identificadores.js';
import { parsearNombre } from './parsear-nombre.js';

/**
 * Busca un ISBN-10 o ISBN-13 en texto libre. Tolera prefijos "ISBN:", guiones y espacios.
 * Devuelve preferentemente el ISBN-13.
 */
function extraerISBN(texto) {
    if (!texto) return null;
    const re = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])/g;
    const candidatos = [];
    let m;
    while ((m = re.exec(texto)) !== null) {
        const limpio = m[1].replace(/[-\s]/g, '');
        if (limpio.length === 10 || limpio.length === 13) candidatos.push(limpio);
    }
    return candidatos.find(c => c.length === 13) || candidatos[0] || null;
}

/**
 * Extrae metadatos de un PDF: info-dict, capa de texto e ISBN.
 * Marca `texto_legible=false` cuando el PDF es (probablemente) escaneado sin OCR,
 * para que el orquestador escale a visión/IA.
 */
export async function extraerMetadatosPdf(rutaArchivo) {
    const nombre = path.basename(rutaArchivo);
    try {
        const buffer = new Uint8Array(await fs.readFile(rutaArchivo));
        const pdf = await getDocumentProxy(buffer);

        const datos = {
            titulo: null,
            autores: [],
            isbn: null,
            idioma: null,
            año_edicion: null,
            paginas: pdf.numPages,
            texto_legible: false
        };

        // 1. Info-dict del PDF (Title / Author)
        try {
            const meta = await pdf.getMetadata();
            const info = meta && meta.info ? meta.info : {};
            if (info.Title && String(info.Title).trim()) datos.titulo = String(info.Title).trim();
            if (info.Author && String(info.Author).trim()) datos.autores = [String(info.Author).trim()];
        } catch { /* sin info-dict */ }

        // 2. Capa de texto (para ISBN y para detectar si está escaneado)
        let texto = '';
        try {
            const res = await extractText(pdf, { mergePages: true });
            texto = Array.isArray(res.text) ? res.text.join('\n') : (res.text || '');
        } catch { /* sin capa de texto */ }

        datos.texto_legible = texto.replace(/\s/g, '').length > 200;
        datos.isbn = extraerISBN(texto);
        datos.issn = extraerISSN(texto); // relevante para revistas/publicaciones periódicas

        // 3. Pistas del nombre de archivo. Si está fechado (revista), la fecha es el AÑO
        //    y el idioma del mes — nunca autores. Si no, separa título/autores (libro).
        const parsed = parsearNombre(nombre);
        if (!datos.titulo) datos.titulo = parsed.titulo;
        if (datos.autores.length === 0) datos.autores = parsed.autores;
        if (parsed.esFechada) {
            datos.año_edicion = parsed.año_edicion; // fecha del archivo, fiable para revistas
            datos.idioma = parsed.idioma;           // idioma inferido del nombre del mes
        }

        return datos;
    } catch (e) {
        // PDF ilegible: devolvemos lo mínimo viable para no romper la cadena
        const parsed = parsearNombre(nombre);
        return {
            titulo: parsed.titulo,
            autores: parsed.autores,
            año_edicion: parsed.año_edicion || null,
            isbn: null,
            idioma: parsed.idioma || null,
            texto_legible: false,
            _error: e.message
        };
    }
}
