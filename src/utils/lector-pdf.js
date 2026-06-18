import fs from 'fs/promises';
import path from 'path';
import { extractText, getDocumentProxy } from 'unpdf';
import { extraerISSN, validarISBN, variantesISBN } from './identificadores.js';
import { parsearNombre } from './parsear-nombre.js';

/**
 * Busca TODOS los ISBN-10/13 válidos en texto libre. Tolera prefijos "ISBN:", guiones y
 * espacios, y valida el dígito de control (un número de 13 cifras cualquiera NO es un ISBN).
 * Devuelve un array sin duplicados, ya normalizado.
 */
function extraerISBNs(texto) {
    if (!texto) return [];
    const re = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])/g;
    const out = new Set();
    let m;
    while ((m = re.exec(texto)) !== null) {
        const v = validarISBN(m[1]);
        if (v) out.add(v);
    }
    return [...out];
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
        datos.issn = extraerISSN(texto); // relevante para revistas/publicaciones periódicas

        // 3. Pistas del nombre de archivo. Si está fechado (revista), la fecha es el AÑO
        //    y el idioma del mes — nunca autores. Si no, separa título/autores (libro).
        //    El nombre también puede SER un ISBN (parsed.isbn) → es un identificador, no título.
        const parsed = parsearNombre(nombre);
        if (!datos.titulo) datos.titulo = parsed.titulo;
        if (datos.autores.length === 0) datos.autores = parsed.autores;
        if (parsed.esFechada) {
            datos.año_edicion = parsed.año_edicion; // fecha del archivo, fiable para revistas
            datos.idioma = parsed.idioma;           // idioma inferido del nombre del mes
        }

        // ISBN: candidatos del texto + del nombre de archivo, ampliados a sus formas 10/13.
        // Un libro suele estar indexado por solo una de sus variantes/ediciones; recolectamos
        // todas para que el buscador pruebe cada una (evita 404 como en case 14).
        const candidatos = new Set();
        for (const x of extraerISBNs(texto)) for (const v of variantesISBN(x)) candidatos.add(v);
        if (parsed.isbn) for (const v of variantesISBN(parsed.isbn)) candidatos.add(v);
        datos.isbn_candidatos = [...candidatos];
        datos.isbn = datos.isbn_candidatos.find(c => c.length === 13) || datos.isbn_candidatos[0] || null;

        return datos;
    } catch (e) {
        // PDF ilegible: devolvemos lo mínimo viable para no romper la cadena
        const parsed = parsearNombre(nombre);
        const candidatos = parsed.isbn ? variantesISBN(parsed.isbn) : [];
        return {
            titulo: parsed.titulo,
            autores: parsed.autores,
            año_edicion: parsed.año_edicion || null,
            isbn: candidatos.find(c => c.length === 13) || candidatos[0] || null,
            isbn_candidatos: candidatos,
            idioma: parsed.idioma || null,
            texto_legible: false,
            _error: e.message
        };
    }
}
