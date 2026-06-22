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
    if (/[\\]/.test(t)) return true;                                // contiene barra invertida → es una ruta
    if (/^[a-z]:[\\/]?/i.test(t) && /\.[a-z0-9]{2,4}$/i.test(t)) return true; // "C:…algo.ext" (ruta Windows)
    if (/^microsoft\s+(word|powerpoint|excel|publisher)\b/i.test(t)) return true; // "Microsoft Word - documento1"
    if (/^(untitled|sin\s*t[íi]tulo|documento?\s*\d*|document\s*\d+|presentaci[óo]n\s*\d*)$/i.test(t)) return true;
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
    if (/\b(typesett|typograph|composici[óo]n|compositor|dvips|distiller|quark|indesign|pdftex|latex|acrobat|ghostscript|framemaker)\b/i.test(t)) return true;
    return false;
}

const MESES = {
    fr: ['janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre', 'novembre', 'décembre', 'decembre', 'janv', 'févr', 'fevr', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'ene', 'feb', 'abr', 'ago', 'dic'],
    en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'apr', 'jun', 'jul', 'aug', 'sept', 'dec'],
};

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
            const autores = trabajo.slice(0, idx).split(/\s*&\s*/).map(s => s.trim()).filter(Boolean);
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

    // ¿Bloque de fecha "Mes[-Mes] Año" (señal fuerte de publicación periódica)?
    for (const [lang, meses] of Object.entries(MESES)) {
        const grupo = meses.join('|');
        const re = new RegExp(`(?:${grupo})[a-zà-ÿ]*(?:[-/\\s]+(?:${grupo})[a-zà-ÿ]*)?[\\s,.–-]*((?:19|20)\\d{2})`, 'i');
        const m = trabajo.match(re);
        if (m) {
            let titulo = trabajo.slice(0, m.index).replace(/[-–_\s]+$/, '').trim();
            if (!titulo) titulo = trabajo.replace(re, '').replace(/[-–_\s]+$/, '').trim();
            return { titulo, autores: [], año_edicion: parseInt(m[1]), idioma: lang, esFechada: true, mes_publicacion: null, ...colExtra };
        }
    }

    // Libro: separar título y autores por " - ".
    const partes = trabajo.split(' - ');
    const autores = partes.length > 1
        ? partes.slice(1).join(' - ').split(/\s*-\s*/).map(s => s.trim()).filter(Boolean)
        : [];
    return { titulo: partes[0].trim(), autores, esFechada: false, ...colExtra };
}
