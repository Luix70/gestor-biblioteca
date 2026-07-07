// Parser de nombres de archivo. Distingue:
//   - libros: "Título - Autor1- Autor2"  → autores
//   - revistas fechadas: "Título - <Mes>-<Mes> <Año>" → año_edicion + idioma (NO son autores)
//   - el nombre ES un ISBN (p. ej. "0071769234.pdf") → identificador, NO título

import { validarISBN } from './identificadores.js';

// Extensiones de ficheros de maquetación/composición/fuente que delatan un título-artefacto: el
// productor del PDF grabó como "Title" el nombre del fichero fuente (TeX/DVI, InDesign, Quark,
// Word…) en vez del título real. Caso real: "C:\TARANTOLABOOK.DVI" (Creator: DVIPSONE).
const EXT_ARTEFACTO = /\.(dvi|tex|aux|log|toc|idx|indd|idml|qx[dpb]|pmd|fm|cdr|ai|psd|docx?|rtf|odt|sxw|wpd|pages|pub|p65|ppt x?|key|sla)$/i;

/**
 * ¿El "título" es en realidad un ARTEFACTO del productor (ruta/nombre de fichero fuente, "Microsoft
 * Word - …", "untitled"…) y NO un título real? Conservador: solo señales inequívocas, para no
 * descartar títulos legítimos. Quien lo detecta debe caer al nombre de archivo o a la autoridad.
 */
export function esTituloArtefacto(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (EXT_ARTEFACTO.test(t)) return true;                         // termina en extensión de fichero fuente
    if (/\.(pdf|epub|mobi|azw3|fb2|djvu|cbr|cbz|cb7)$/i.test(t)) return true; // el "título" es un nombre de fichero (p. ej. "jan09-1.pdf")
    if (/[\\]/.test(t)) return true;                                // contiene barra invertida → es una ruta
    if (/^[a-z]:[\\/]?/i.test(t) && /\.[a-z0-9]{2,4}$/i.test(t)) return true; // "C:…algo.ext" (ruta Windows)
    if (/^microsoft\s+(word|powerpoint|excel|publisher)\b/i.test(t)) return true; // "Microsoft Word - documento1"
    if (/^(untitled|sin\s*t[íi]tulo|documento?\s*\d*|document\s*\d+|presentaci[óo]n\s*\d*)$/i.test(t)) return true;
    if (/https?:\/\//i.test(t)) return true;                        // un título no lleva una URL → artefacto
    // DOI como "título": los ficheros de Springer/editoriales se descargan con su DOI por nombre
    // («10.1007@978-3-319-38992-9», «10.1007/978-…», o URL-codificado «10.1007%40978-…»). Un DOI NO es un
    // título — hay que caer al Fichero/APIs por su ISBN (que va DENTRO del DOI). Caso real de este proyecto.
    if (/^10\.\d{3,}\s*[/@%]/.test(t)) return true;                 // DOI (10.<registrante>/… o @/%40)
    // El "título" es en realidad un ISBN con poco más (caso real de metadatos MOBI/AZW: alguien grabó el
    // ISBN del nombre como título, p. ej. «0393333590 (N)»). Un título real no es un ISBN → al ISBN/APIs.
    {
        const digitos = (t.match(/\d/g) || []).length;
        const letras = (t.match(/[a-záéíóúñü]/gi) || []).length;
        if (digitos >= 9 && letras <= 2 && /\d{9,13}/.test(t.replace(/[\s\-–—]/g, ''))) return true;
    }
    // El "título" EMPIEZA por un ISBN/id numérico largo (10-13 cifras) pegado por _/-/./espacio a un
    // fragmento del nombre de fichero («1568814739_Interactiverj», «9780470040010-title»): salió del NOMBRE,
    // no del contenido → hay que caer a la autoridad por ISBN. (Caso real de una lectura a fondo.)
    if (/^\d{9,13}[\s_.\-]/.test(t)) return true;
    // El "título" es un NOMBRE DE FICHERO: palabras.unidas.por.puntos SIN espacios (≥3 segmentos), típico de
    // un release («Oxford.Descartes.And.The.Puzzle.Of.Sensory.Representation»). No es un título → a la autoridad.
    if (!/\s/.test(t) && /^\S+(?:\.\S+){2,}$/.test(t)) return true;
    // Prefijo de campo del info-dict del PDF grabado como título: "Creator: …", "Producer: …".
    // Un título real NO empieza así. Caso real: "Creator:        Adobe InDesign CC 2014 (Windows)".
    if (/^\s*(?:creator|producer|created\s+by)\s*[:_]/i.test(t)) return true;
    // Marca del PRODUCTOR del PDF grabada como "título" (no es un título): herramientas de creación/
    // reparación/conversión. Casos reales: "Creator_ Advanced PDF Repair at http://www.datanumen.com/apdfr/",
    // "Creator_ PScript5.dll Version 5.2.2", "Adobe InDesign CC 2014", "Adobe Acrobat Pro 10.1.8".
    if (/\b(advanced\s+pdf\s+repair|datanumen|pscript\d?\.dll|acrobat\s+distiller|ghostscript|quartz\s*pdf|pdfcreator|primopdf|nitro\s*pro|dvipsone|dvips|pdftex|xetex|miktex|tex\s+output|aspose|itext|prince\s*xml|apache\s+fop|adobe\s+(?:indesign|acrobat|photoshop|illustrator|pagemaker|framemaker|distiller)|quark\s*xpress|calibre|wkhtmltopdf|microsoft\s+office\s+word)\b/i.test(t)) return true;
    return false;
}

/**
 * ¿El campo "autor" del info-dict del PDF es en realidad un metadato de PRODUCCIÓN (crédito de
 * composición tipográfica con fecha/hora, nombre de herramienta) y NO un autor real? Caso real:
 * "Pat Hufnagle (Sherman Typography) 893 1998 May 29 10:37:50". Conservador: solo señales claras.
 */
export function esAutorArtefacto(s) {
    const t = String(s || '').trim();
    if (!t) return false;
    if (/\d{1,2}:\d{2}/.test(t)) return true; // lleva una hora (HH:MM[:SS]) → sello de build
    // Prefijo de campo del info-dict del PDF grabado como "autor": "Creator: …", "Producer: …", "Created by:".
    // Un autor real NO empieza así. Caso real: el campo /Creator del PDF acabó como autor «Creator:».
    if (/^\s*(?:creator|producer|created\s+by|application)\s*[:_]/i.test(t)) return true;
    if (/\b(typesett|typograph|composici[óo]n|compositor|dvips|distiller|quark|indesign|pdftex|latex|acrobat|ghostscript|framemaker|pscript\d?\.dll|datanumen|advanced\s+pdf\s+repair|pdfcreator|wkhtmltopdf|calibre|aspose|itext)\b/i.test(t)) return true;
    // Trozos del NOMBRE DE ARCHIVO que NO son un autor (nombres tipo "ISBN - {avaxhome.ws} - 2013-11-09"):
    if (/^[\d\W]+$/.test(t)) return true;                        // solo dígitos/puntuación: "2013", "11", "09", "-"
    if (/^(?:19|20)\d{2}$/.test(t)) return true;                 // un año suelto
    if (/^\{.*\}$/.test(t)) return true;                         // marca de agua entre llaves: "{avaxhome.ws}"
    if (/(?:^|\b)(?:www\.|https?:\/\/)/i.test(t)) return true;   // URL / web
    if (/\.(?:ws|com|net|org|se|ru|io|co|info|to|cc|me|onion)\b/i.test(t)) return true; // dominio: "avaxhome.ws"
    // Una FRASE del texto capturada como "autor" (no un nombre): lleva palabras funcionales de PROSA que un
    // nombre nunca contiene, o es larguísima. Un nombre real es corto ("Apellido, Nombre [Medio]"). Caso real:
    // "There are even a few exercises for you, but they are so subtly presented that" (para ISBN 9780470040010).
    // OJO: una LISTA de varios autores unida por «&» o «;» ("Anderson, Poul & Asimov, Isaac & Gardner, Martin")
    // NO es prosa aunque sea larga → NO se marca (es multi-autor sin dividir, no basura).
    const esListaAutores = /[&;]/.test(t) || / y \b/i.test(t);
    if (!esListaAutores) {
        const palabras = t.split(/\s+/).filter(Boolean);
        if (palabras.length > 7) return true;                    // ningún NOMBRE (individual) tiene >7 palabras
        // Palabras inequívocas de PROSA (verbos/pronombres/conjunciones que no aparecen en un nombre, ni personal
        // ni corporativo). Se EXCLUYEN a propósito the/and/for/of/to (salen en autores corporativos: "University
        // of X", "Institute of Physics") y so (apellido coreano/chino).
        if (palabras.length >= 3 && /\b(you|your|they|we|are|were|was|is|been|have|has|had|will|would|but|because|when|while|which|that|this|there|here|not|with|from)\b/i.test(t)) return true;
    }
    return false;
}

const MESES = {
    fr: ['janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre', 'novembre', 'décembre', 'decembre', 'janv', 'févr', 'fevr', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'ene', 'feb', 'abr', 'ago', 'dic'],
    en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'apr', 'jun', 'jul', 'aug', 'sept', 'dec'],
};

// Nombre (o abreviatura, es/en/fr) de mes → número 1..12. Cubre TODAS las entradas de MESES más las
// formas plenas, para recuperar el MES de una revista fechada por nombre ("octubre 2015" → 10) — antes
// se perdía y dejaba el número de revista sin fecha completa. Exportado para los helpers de revistas.
export const MES_NUM = {
    enero: 1, ene: 1, january: 1, jan: 1, janvier: 1, janv: 1,
    febrero: 2, feb: 2, february: 2, 'février': 2, fevrier: 2, 'févr': 2, fevr: 2,
    marzo: 3, march: 3, mars: 3,
    abril: 4, abr: 4, april: 4, apr: 4, avril: 4, avr: 4,
    mayo: 5, may: 5, mai: 5,
    junio: 6, jun: 6, june: 6, juin: 6,
    julio: 7, jul: 7, july: 7, juillet: 7, juil: 7,
    agosto: 8, ago: 8, august: 8, aug: 8, 'août': 8, aout: 8,
    septiembre: 9, sep: 9, sept: 9, september: 9, septembre: 9,
    octubre: 10, oct: 10, october: 10, octobre: 10,
    noviembre: 11, nov: 11, november: 11, novembre: 11,
    diciembre: 12, dic: 12, december: 12, dec: 12, 'décembre': 12, decembre: 12, 'déc': 12,
};
/** Nombre/abreviatura de mes → número 1..12, o null si no se reconoce. */
export const mesANumero = (s) => (s ? (MES_NUM[String(s).toLowerCase()] ?? null) : null);

/**
 * Extrae editorial/colección de los corchetes iniciales al estilo ePubLibre/Lectulandia y
 * detecta la firma del formato:
 *   "[Catedra] [Letras Universales 10] Autor - Título [8092] (r1.0)"
 *   "[Ancora _ Delfin 467] Autor - Título [71431] (r1.0)"
 *   "Autor - Título [612] (r2.7)"
 * El corchete que ACABA en un número (árabe o romano en mayúsculas) es la colección + su
 * volumen; un corchete previo SIN número es la editorial. El " _ " se interpreta como " & ".
 *
 * @returns { coleccion_nombre, coleccion_numero, editorial, resto, esEpl } — resto = base sin
 *          los corchetes de cabecera ni la coletilla final "[id] (rX.X)"; esEpl = true si se
 *          reconoce el formato ePubLibre (orden Autor - Título).
 */
function extraerColeccion(base) {
    const out = { coleccion_nombre: null, coleccion_numero: null, editorial: null, resto: base, esEpl: false };

    // Firma ePubLibre/Lectulandia: marca de revisión final "(rX.X)" (con o sin "[idEPL]" delante).
    const revMarker = /\s*\[\d+\]\s*\(r[\d.]+\)\s*$|\s*\(r[\d.]+\)\s*$/i;
    let resto = base;
    let firmaRev = false;
    if (revMarker.test(resto)) { firmaRev = true; resto = resto.replace(revMarker, '').trim(); }

    // Corchetes de cabecera.
    const cabecera = resto.match(/^(\s*\[[^\]]+\]\s*)+/);
    if (cabecera) {
        const corchetes = cabecera[0].match(/\[[^\]]+\]/g).map(b => b.slice(1, -1).trim());
        resto = resto.slice(cabecera[0].length).trim();
        for (const c of corchetes) {
            const limpio = c.replace(/\s+_\s+/g, ' & ').trim();
            // Número final: dígitos (1-4) o numeral romano en MAYÚSCULAS (evita falsos positivos).
            const m = limpio.match(/^(.*\S)\s+(\d{1,4}|[IVXLCDM]{1,7})$/);
            if (m) { out.coleccion_nombre = m[1].trim(); out.coleccion_numero = m[2]; }
            else if (!out.editorial) out.editorial = limpio; // corchete sin número → editorial
        }
    }

    // Es ePubLibre si hay marca de revisión o un corchete de colección con volumen (señal
    // fuerte). Un simple "[2023]" no basta (no produce coleccion_nombre) → no se confunde.
    out.esEpl = firmaRev || out.coleccion_nombre != null;

    // Si es ePubLibre, retira también un "[idEPL]" final que hubiera quedado sin (rX.X).
    if (out.esEpl) resto = resto.replace(/\s*\[\d+\]\s*$/, '').trim();

    out.resto = resto;
    return out;
}

/**
 * @returns { titulo, autores, año_edicion?, idioma?, esFechada, coleccion_nombre?, coleccion_numero?, editorial? }
 */
export function parsearNombre(nombreArchivo) {
    const base = String(nombreArchivo).replace(/\.[^.]+$/, '');

    // ¿El nombre del archivo ES en sí un ISBN válido? Entonces NO es un título: es un
    // identificador para consultar las APIs (el título real lo aportarán ellas).
    const isbnNombre = validarISBN(base);
    if (isbnNombre) {
        return { titulo: null, autores: [], isbn: isbnNombre, esFechada: false };
    }

    // Corchetes de cabecera (editorial/colección al estilo ePubLibre). Devuelve también el
    // 'resto' del nombre ya sin esos corchetes ni la coletilla "[id] (rX.X)".
    const col = extraerColeccion(base);
    const colExtra = {};
    if (col.coleccion_nombre) colExtra.coleccion_nombre = col.coleccion_nombre;
    if (col.coleccion_numero) colExtra.coleccion_numero = col.coleccion_numero;
    if (col.editorial)        colExtra.editorial = col.editorial;
    const trabajo = col.resto || base;

    // ePubLibre: el orden es "Autor[ & Autor2] - Título" (al revés que el formato genérico).
    // Los autores van en cabecera separados por " & "; el título es todo lo posterior al
    // primer " - " (tolera guiones dentro del título).
    if (col.esEpl) {
        const idx = trabajo.indexOf(' - ');
        if (idx >= 0) {
            const autores = trabajo.slice(0, idx).split(/\s*&\s*/).map(s => s.trim()).filter(Boolean).filter(a => !esAutorArtefacto(a));
            const titulo = trabajo.slice(idx + 3).trim();
            return { titulo, autores, esFechada: false, ...colExtra };
        }
        return { titulo: trabajo.trim(), autores: [], esFechada: false, ...colExtra };
    }

    // Prefijo de fecha ISO: "2017-10-01 Direction Espagne" o "2017-10 Title"
    // Señal inequívoca de publicación periódica (el SO añade esta fecha para ordenar).
    const isoPrefix = trabajo.match(/^((?:19|20)\d{2})[-_](\d{2})(?:[-_]\d{2})?\s+(.+)/);
    if (isoPrefix) {
        return {
            titulo: isoPrefix[3].trim(),
            autores: [],
            año_edicion: parseInt(isoPrefix[1]),
            mes_publicacion: parseInt(isoPrefix[2]),
            idioma: null,
            esFechada: true,
            ...colExtra,
        };
    }

    // Sufijo de fecha ISO al FINAL del nombre: "Fotogramas 2014-01", "Paranormal 2010-12",
    // "NationalGeographic201503". Patrón MUY común al nombrar números de revista; el nombre que da el
    // curador es autoridad para la fecha del número. Exige AÑO-MES (mes 01-12): un año SUELTO no basta
    // (un libro suele acabar en año y NO es periódico) — así no se clasifican libros como revista.
    const isoSuffix = trabajo.match(/^(.*?)[\s._-]*((?:19|20)\d{2})[-_.]?(0[1-9]|1[0-2])(?:[-_.]\d{2})?$/);
    if (isoSuffix && isoSuffix[1].replace(/[-–_\s.]+$/, '').trim().length >= 2) {
        return {
            titulo: isoSuffix[1].replace(/[-–_\s.]+$/, '').trim(),
            autores: [],
            año_edicion: parseInt(isoSuffix[2]),
            mes_publicacion: parseInt(isoSuffix[3]),
            idioma: null,
            esFechada: true,
            ...colExtra,
        };
    }

    // ¿Bloque de fecha "Mes[-Mes] Año" (señal fuerte de publicación periódica)?
    for (const [lang, meses] of Object.entries(MESES)) {
        const grupo = meses.join('|');
        // Capturamos el PRIMER mes (m[1]) además del año (m[2]) para no perder el mes ("octubre 2015").
        const re = new RegExp(`(${grupo})[a-zà-ÿ]*(?:[-/\\s]+(?:${grupo})[a-zà-ÿ]*)?[\\s,.–-]*((?:19|20)\\d{2})`, 'i');
        const m = trabajo.match(re);
        if (m) {
            let titulo = trabajo.slice(0, m.index).replace(/[-–_\s]+$/, '').trim();
            if (!titulo) titulo = trabajo.replace(re, '').replace(/[-–_\s]+$/, '').trim();
            return { titulo, autores: [], año_edicion: parseInt(m[2]), idioma: lang, esFechada: true, mes_publicacion: mesANumero(m[1]), ...colExtra };
        }
    }

    // Libro: separar título y autores por " - ".
    const partes = trabajo.split(' - ');
    const tituloCand = partes[0].trim();
    // Si el "título" del nombre es en realidad un IDENTIFICADOR (un ISBN suelto) o un ARTEFACTO (DOI,
    // ruta…), el nombre es «<id> - ruido - fecha» y NO contiene ni título ni autores fiables: se deja
    // vacío para que los aporte el ISBN/autoridad (principio «identificar primero, el nombre es el ÚLTIMO
    // recurso»). Se extrae el ISBN incrustado si lo hay. Caso real: «1461474213 - {avaxhome.ws} - 2013-11-09».
    const isbnTitulo = validarISBN(tituloCand.replace(/[^0-9Xx]/g, ''));
    if (isbnTitulo || esTituloArtefacto(tituloCand)) {
        return { titulo: null, autores: [], ...(isbnTitulo ? { isbn: isbnTitulo } : {}), esFechada: false, ...colExtra };
    }
    // Autores tras el 1er " - ", descartando los que sean ARTEFACTO (números, fechas, marcas de agua…).
    const autores = (partes.length > 1
        ? partes.slice(1).join(' - ').split(/\s*-\s*/).map(s => s.trim()).filter(Boolean)
        : []).filter(a => !esAutorArtefacto(a));
    return { titulo: tituloCand, autores, esFechada: false, ...colExtra };
}
