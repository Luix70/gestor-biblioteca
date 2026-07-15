/**
 * Recuperación del TÍTULO ORIGINAL (y de un indicio de IDIOMA ORIGINAL) de obras traducidas, leyendo la
 * PÁGINA DE CRÉDITOS/copyright del propio fichero (EPUB/PDF), SIN IA. La etiqueta «Título original:» solo
 * figura en traducciones, así que el propio texto restringe a los libros que procede.
 *
 * Compartido por `scripts/recuperar-titulo-original.js` (backfill puntual) y por la campaña de mantenimiento
 * (Conformador), para que ambos usen exactamente el mismo parser. Ver [[minimize-ai-ingestion]]: es gratis.
 */
import fs from 'node:fs/promises';
import AdmZip from 'adm-zip';
import { textoRango } from './lector-pdf.js';

const PDF_PAGINAS = Number(process.env.TITULO_ORIGINAL_PDF_PAGINAS) || 8;

// Mojibake típico de EPUBs de la comunidad (Ã© → é). Solo si hay bytes del rango Ã (si no, se deja igual).
const repararMojibake = (s) => {
    if (!s || !/[\xC0-\xC6\xC3]/.test(s)) return s;
    try { const r = Buffer.from(s, 'latin1').toString('utf8'); return r.includes('�') ? s : r; } catch { return s; }
};

// HTML → texto CONSERVANDO SALTOS DE LÍNEA (para poder leer «Título original:» línea a línea).
const htmlAtexto = (html) =>
    String(html || '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
        .replace(/[ \t ]+/g, ' ');

// Texto de la parte relevante de un EPUB (front-matter: portadilla + créditos). Junta los documentos de
// contenido hasta un tope de tamaño; con eso basta para la etiqueta «Título original».
async function textoEpub(ruta) {
    const zip = new AdmZip(await fs.readFile(ruta));
    const entradas = zip.getEntries().filter((e) => /\.(x?html?|xml)$/i.test(e.entryName) && !/nav|toc|ncx/i.test(e.entryName));
    let out = '';
    for (const e of entradas) {
        out += '\n' + htmlAtexto(e.getData().toString('utf8'));
        if (out.length > 120000) break; // suficiente para créditos; evita cargar el libro entero
    }
    return repararMojibake(out);
}

async function textoPdf(ruta) {
    // UNA sola llamada de rango [1..PDF_PAGINAS]: poppler recorta al total del doc (sin tantear página a
    // página, que en PDFs cortos generaba errores «rango fuera de límites» repetidos en el log).
    return await textoRango(ruta, 1, PDF_PAGINAS).catch(() => '');
}

/** Texto de la página de créditos del fichero (auto-detecta EPUB/PDF por extensión). '' ante cualquier error. */
export async function textoCreditos(ruta) {
    try {
        return /\.epub$/i.test(ruta) ? await textoEpub(ruta) : await textoPdf(ruta);
    } catch { return ''; }
}

// Limpia el título original capturado: recorta colas de año / traducción / copyright y comillas de borde.
function limpiarOriginal(s) {
    let t = repararMojibake(String(s || '')).replace(/\s+/g, ' ').trim();
    t = t.replace(/^["'«»“”\-–—:.\s]+/, '').replace(/["'«»“”]+$/, '').trim();
    t = t.split(/\s*[,;([]\s*(?:1[5-9]\d\d|20\d\d)\b/)[0];                              // corta en «, 1843»/«(1843»
    t = t.split(/\b(?:traducci[óo]n|traducido|translated|©|copyright|publicad|first published|originally published)\b/i)[0];
    return t.replace(/[\s,;:.\-–—]+$/, '').trim();
}

// Etiqueta «Título original» en varias lenguas: romance (título/titre/titolo + original[es]) e inglés
// («original title», orden inverso). El corpus es mayormente español (ePubLibre), pero no cuesta nada.
const ETIQ = '(?:(?:t[íi]tulos?|titre|titolo)\\s+origina\\w*|original\\s+titles?)';
const RE_ETIQUETA = new RegExp(ETIQ, 'i');
const RE_INLINE = new RegExp(ETIQ + '\\s*[:.]\\s*(.+)', 'i');   // «Título original: X» (X en la misma línea)
const RE_SOLO = new RegExp(ETIQ + '\\s*[:.]?\\s*$', 'i');        // «Título original:» (X en la línea siguiente)

/** Extrae 0..N títulos originales del texto de créditos (varios en antologías de relatos traducidos). */
export function titulosOriginales(texto, tituloDoc = '') {
    const lineas = String(texto || '').split(/\r?\n/).map((l) => l.trim());
    const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const fuera = norm(tituloDoc);
    const out = [];
    const vistos = new Set();
    const anadir = (bruto) => {
        const t = limpiarOriginal(bruto);
        if (!t || t.length < 2 || t.length > 200) return;
        if (norm(t) === fuera) return;                 // idéntico al título → no aporta
        if (!/[a-zA-Z]/.test(t)) return;               // sin letras → ruido
        const k = norm(t);
        if (vistos.has(k)) return;
        vistos.add(k); out.push(t);
    };
    for (let i = 0; i < lineas.length; i++) {
        if (!RE_ETIQUETA.test(lineas[i])) continue;
        const m = lineas[i].match(RE_INLINE);
        if (m) { anadir(m[1]); continue; }
        if (RE_SOLO.test(lineas[i])) {                 // etiqueta sola → el título está en la línea siguiente
            const sig = lineas.slice(i + 1).find((l) => l);
            if (sig) anadir(sig);
        }
    }
    return out;
}

// Idioma ORIGINAL por indicio de texto: «traducción del inglés», «translated from the French»… → ISO 639-1.
const IDIOMAS = {
    ingl: 'en', english: 'en', frances: 'fr', français: 'fr', francais: 'fr', french: 'fr', aleman: 'de',
    alemán: 'de', deutsch: 'de', german: 'de', italiano: 'it', italian: 'it', portugues: 'pt', portugués: 'pt',
    portuguese: 'pt', ruso: 'ru', russian: 'ru', japones: 'ja', japonés: 'ja', japanese: 'ja', chino: 'zh',
    chinese: 'zh', griego: 'el', greek: 'el', latin: 'la', latín: 'la', catalan: 'ca', català: 'ca', neerland: 'nl',
    holandes: 'nl', dutch: 'nl', sueco: 'sv', swedish: 'sv', noruego: 'no', danes: 'da', polaco: 'pl',
};
/** Indicio de idioma original en el texto de créditos («traducido del <idioma>»); null si no hay señal clara. */
export function idiomaOriginalDeTexto(texto) {
    const m = String(texto || '').match(/tradu(?:c(?:ci[óo]n|ido))\s+(?:de[l]?|from(?:\s+the)?)\s+([a-záéíóúñ]+)/i)
        || String(texto || '').match(/translated\s+from(?:\s+the)?\s+([a-z]+)/i);
    if (!m) return null;
    const palabra = m[1].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    for (const k of Object.keys(IDIOMAS)) if (palabra.startsWith(k.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return IDIOMAS[k];
    return null;
}

/**
 * Recupera del FICHERO (créditos) el título original (y un indicio de idioma original), SIN IA.
 * @returns {Promise<{titulo_original:string|null, titulos_originales:string[], idioma_original:string|null}>}
 */
export async function recuperarOriginalesDeFichero(ruta, tituloDoc = '') {
    const texto = await textoCreditos(ruta);
    if (!texto) return { titulo_original: null, titulos_originales: [], idioma_original: null };
    const titulos = titulosOriginales(texto, tituloDoc);
    return {
        titulo_original: titulos[0] || null,
        titulos_originales: titulos.length > 1 ? titulos : [],
        idioma_original: idiomaOriginalDeTexto(texto),
    };
}
