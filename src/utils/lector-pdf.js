import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'path';
import { extraerISSN, validarISBN, variantesISBN } from './identificadores.js';
import { parsearNombre, esTituloArtefacto, esAutorArtefacto } from './parsear-nombre.js';
import { extraerISBNsConRol, parsearVolumen } from './multivolumen.js';
import { parsearBloqueCatalogacion } from './cip.js';

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
 * Texto de UNA página concreta (1-indexada). Útil para evaluar si la página 1 de un PDF es la
 * cubierta (poco/ningún texto) o ya la primera página de texto (el digitalizador extrajo la
 * cubierta a un fichero aparte). Cadena vacía ante cualquier error.
 */
export async function textoPagina(rutaArchivo, n) {
    return pdfText(rutaArchivo, n, n);
}

/**
 * Busca TODOS los ISBN-10/13 válidos en texto libre. Tolera prefijos "ISBN:", guiones y
 * espacios, y valida el dígito de control (un número de 13 cifras cualquiera NO es un ISBN).
 * Devuelve un array sin duplicados, ya normalizado.
 */
/**
 * Intenta extraer el número de issue del texto de la revista.
 * Patrones: "N°2", "Nº 3", "Issue 12", "Numéro 4", "Número 5".
 */
function extraerNumeroIssue(texto) {
    if (!texto) return null;
    const m = texto.match(/N[°º]\s*(\d+)|(?:issue|num[eé]ro?|n[úu]mero)\s*[#°º]?\s*(\d+)/i);
    return m ? parseInt(m[1] ?? m[2]) : null;
}

/**
 * ¿La capa de texto del PDF es UTILIZABLE (libro digital real) o basura (OCR ilegible / extracción rota)?
 * No basta la longitud: muchos escaneos traen una capa OCR larga pero ininteligible. Heurística por
 * idioma-agnóstica: exige una proporción alta de LETRAS (no símbolos sueltos) y suficientes PALABRAS
 * "de verdad" (≥4 letras con vocal). Conservadora: solo declara INUTILIZABLE lo claramente roto.
 */
function textoPdfUtil(texto) {
    const t = String(texto || '');
    if (t.replace(/\s/g, '').length < 200) return false;          // muy poco texto → no fiable
    const sinEsp = t.replace(/\s+/g, '');
    const letras = (t.match(/[A-Za-zÀ-ÿ]/g) || []).length;
    const alphaRatio = letras / Math.max(1, sinEsp.length);       // ¿son letras o símbolos/ruido?
    const palabras = t.match(/[A-Za-zÀ-ÿ]{2,}/g) || [];
    const reales = palabras.filter(w => w.length >= 4 && /[aeiouáéíóúàèìòùäëïöüy]/i.test(w)).length;
    return alphaRatio >= 0.6 && reales >= 40;                     // bastantes letras y palabras reales
}

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

        // Descartar títulos que son artefactos de metadatos mal formados: campo vacío, solo
        // espacio, el nombre de otro campo seguido de ":" (ej. "Subject:"), o un artefacto del
        // productor (ruta/nombre de fichero fuente "C:\X.DVI", "…​.indd", "Microsoft Word - …").
        // Si se descarta, más abajo se cae al título del NOMBRE DE ARCHIVO (mucho más fiable).
        const tituloInfo = info.title && !info.title.trim().endsWith(':') && info.title.trim().length > 1
            && !esTituloArtefacto(info.title) ? info.title.trim() : null;
        // Igual con el autor: descartar créditos de composición/sello de build (no es un autor).
        const autorInfo = info.author && !esAutorArtefacto(info.author) ? [info.author] : [];

        const datos = {
            titulo:       tituloInfo,
            autores:      autorInfo,
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
        // ¿Es texto UTILIZABLE (libro digital de verdad) o una capa OCR basura? No basta la longitud:
        // muchos escaneos traen una capa OCR ilegible. Si el texto no es usable, se tratará como ESCANEO.
        datos.texto_util = textoPdfUtil(texto);
        // PDF estructuralmente ILEGIBLE: pdfinfo no halló páginas (0) y no hay texto extraíble.
        // Un PDF válido (incl. escaneado) siempre tiene ≥1 página; 0 = xref/estructura dañada.
        // Se marca aquí, en el primer paso, para descartarlo a Cuarentena cuanto antes.
        if ((info.pages || 0) === 0 && !datos.texto_legible) datos.pdf_ilegible = true;
        datos.issn = extraerISSN(texto);

        // 3. Pistas del nombre de archivo (revista fechada, ISBN en el nombre, colección, etc.)
        const parsed = parsearNombre(nombre);
        if (!datos.titulo)         datos.titulo  = parsed.titulo;
        if (!datos.autores.length) datos.autores = parsed.autores;
        if (parsed.coleccion_nombre) {
            datos.coleccion_nombre = parsed.coleccion_nombre;
            if (parsed.coleccion_numero) datos.coleccion_numero = parsed.coleccion_numero;
        }
        if (parsed.editorial) datos.editorial = parsed.editorial; // editorial del corchete ePubLibre
        if (parsed.esFechada) {
            datos.esFechada       = true;
            datos.año_edicion     = parsed.año_edicion;
            datos.idioma          = parsed.idioma;
            if (parsed.mes_publicacion) datos.mes_publicacion = parsed.mes_publicacion;
        }

        // Número de issue extraído del texto (p. ej. "N°2", "Issue 12").
        const numIssue = extraerNumeroIssue(texto);
        if (numIssue) datos.numero_issue = numIssue;

        // ISBN con ROL (créditos de obra multivolumen): "(obra completa)" vs "(tomo I)".
        const isbnsRol = extraerISBNsConRol(texto);
        if (isbnsRol.length) datos.isbns_rol = isbnsRol;

        // BLOQUE CIP (Catalogación en Publicación): registro casi-MARC impreso en la página de
        // créditos. Aporta Dewey/LC (→ CDU SIN IA), ISBN(s) con rol, materias LCSH y autor/título
        // fiables, todo leído del propio fichero (fuente de archivo, máxima confianza).
        const cip = parsearBloqueCatalogacion(texto);
        if (cip) datos.cip = cip;

        // Número de tomo desde el NOMBRE DE ARCHIVO ("… Vol. 4 - S-Z"): fuente fiable y propia de
        // ESTE fichero. Imprescindible cuando un tomo se cataloga SUELTO (llegó/estabilizó antes que
        // los demás y la discriminación por carpeta no lo agrupa): así no se le asigna un número
        // ajeno. El prefijo da nombre a la obra sin el sufijo del tomo.
        const vol = parsearVolumen(nombre);
        if (vol) {
            datos.volumen_numero = vol.numero;
            if (vol.titulo)  datos.volumen_titulo = vol.titulo;
            if (vol.prefijo) datos.obra_titulo = vol.prefijo;
        }

        // ISBN: candidatos para BÚSQUEDA (cuerpo del texto + nombre + CIP), ampliados a 10/13. Se distingue
        // la PROCEDENCIA: un ISBN del CUERPO del texto es solo una PISTA (puede ser el de un libro anunciado
        // o reseñado DENTRO de una revista). Un ISBN PROPIO —el nombre de archivo ES un ISBN, va incrustado
        // en él, o procede del bloque CIP— es señal FUERTE de libro. El discriminador usa `isbn_propio`
        // (no el del cuerpo) para decidir "es libro", así un ISBN espurio no convierte una revista en libro.
        const candidatos = new Set();
        const propios = new Set();
        for (const x of extraerISBNs(texto)) for (const v of variantesISBN(x)) candidatos.add(v);                 // cuerpo → pista
        if (parsed.isbn) for (const v of variantesISBN(parsed.isbn)) { candidatos.add(v); propios.add(v); }       // el nombre ES un ISBN
        for (const x of extraerISBNs(nombre)) for (const v of variantesISBN(x)) { candidatos.add(v); propios.add(v); } // ISBN incrustado en el nombre
        for (const c of (cip?.isbns || [])) for (const v of variantesISBN(c.isbn || c)) { candidatos.add(v); propios.add(v); } // CIP
        datos.isbn_candidatos = [...candidatos];
        datos.isbn = datos.isbn_candidatos.find(c => c.length === 13) || datos.isbn_candidatos[0] || null;
        datos.isbn_propio = [...propios].find(c => c.length === 13) || [...propios][0] || null;

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
            pdf_ilegible:  true, // ni pdfinfo ni pdftotext pudieron leerlo → fichero dañado
            _error:        e.message,
        };
    }
}
