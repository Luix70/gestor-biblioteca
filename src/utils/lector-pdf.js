import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'path';
import { extraerISSN, validarISBN, variantesISBN } from './identificadores.js';
import { parsearNombre } from './parsear-nombre.js';

const execFileP = promisify(execFile);

// Solo se extrae texto de las primeras/últimas páginas: ISBN/ISSN/título viven en las
// páginas iniciales (portada, créditos, colofón). Configurable por si hiciera falta.
const PAG_FRENTE = Number(process.env.PDF_PAGINAS_FRENTE || 15);
const PAG_FONDO  = Number(process.env.PDF_PAGINAS_FONDO  || 5);
const TIMEOUT    = 30000; // ms por llamada a poppler

/**
 * Extrae metadatos del PDF (título, autor, número de páginas) mediante pdfinfo.
 * Al ser un proceso externo, no consume heap de Node aunque el PDF sea enorme.
 */
async function pdfInfo(ruta) {
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: TIMEOUT });
        const campo = (nombre) => {
            const m = stdout.match(new RegExp(`^${nombre}:\\s*(.+)`, 'mi'));
            return m ? m[1].trim() : null;
        };
        return {
            title:  campo('Title'),
            author: campo('Author'),
            pages:  parseInt(campo('Pages') || '0') || 0,
        };
    } catch {
        return { title: null, author: null, pages: 0 };
    }
}

/**
 * Extrae texto de un rango de páginas usando pdftotext.
 * Devuelve cadena vacía ante cualquier error (PDF escaneado, cifrado, poppler ausente).
 * El texto va a stdout (-) y nunca toca el disco; el buffer máximo limita el uso de RAM.
 */
async function pdfText(ruta, desde, hasta) {
    if (desde > hasta) return '';
    try {
        const { stdout } = await execFileP(
            'pdftotext',
            ['-f', String(desde), '-l', String(hasta), '-nopgbrk', '-enc', 'UTF-8', ruta, '-'],
            { timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, // 8 MB: ~8000 pág de texto puro
        );
        return stdout;
    } catch {
        return '';
    }
}

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
 * Usa pdfinfo + pdftotext (poppler) en lugar de pdf.js/unpdf para evitar OOM en el NAS:
 * los procesos externos manejan su propia memoria y no saturan el heap de Node.
 * Marca `texto_legible=false` cuando el PDF es (probablemente) escaneado sin OCR,
 * para que el orquestador escale a visión/IA.
 */
export async function extraerMetadatosPdf(rutaArchivo) {
    const nombre = path.basename(rutaArchivo);
    try {
        // 1. Info-dict + número de páginas vía pdfinfo
        const info = await pdfInfo(rutaArchivo);

        const datos = {
            titulo:       info.title  || null,
            autores:      info.author ? [info.author] : [],
            isbn:         null,
            idioma:       null,
            año_edicion:  null,
            paginas:      info.pages  || null,
            texto_legible: false,
        };

        // 2. Texto de cabecera y pie (rango de páginas, no el libro entero)
        let texto = '';
        const total = info.pages;
        if (total > 0) {
            const hastaFrente = Math.min(PAG_FRENTE, total);
            texto += await pdfText(rutaArchivo, 1, hastaFrente);
            const desdeFondo = Math.max(hastaFrente + 1, total - PAG_FONDO + 1);
            if (desdeFondo <= total) {
                texto += await pdfText(rutaArchivo, desdeFondo, total);
            }
        } else {
            // pdfinfo no devolvió páginas (PDF cifrado/dañado): intentar las primeras
            texto = await pdfText(rutaArchivo, 1, PAG_FRENTE);
        }

        datos.texto_legible = texto.replace(/\s/g, '').length > 200;
        datos.issn = extraerISSN(texto);

        // 3. Pistas del nombre de archivo (revista fechada, ISBN en el nombre, etc.)
        const parsed = parsearNombre(nombre);
        if (!datos.titulo)         datos.titulo  = parsed.titulo;
        if (!datos.autores.length) datos.autores = parsed.autores;
        if (parsed.esFechada) {
            datos.año_edicion = parsed.año_edicion;
            datos.idioma      = parsed.idioma;
        }

        // ISBN: candidatos del texto + del nombre de archivo, ampliados a sus formas 10/13.
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
            titulo:        parsed.titulo,
            autores:       parsed.autores,
            año_edicion:   parsed.año_edicion || null,
            isbn:          candidatos.find(c => c.length === 13) || candidatos[0] || null,
            isbn_candidatos: candidatos,
            idioma:        parsed.idioma || null,
            texto_legible: false,
            _error:        e.message,
        };
    }
}
