/**
 * Lectura del IDENTIFICADOR de una revista/libro escaneado, ENFOCADA, en UNA sola llamada de visión:
 *   (a) el CÓDIGO DE BARRAS de la cubierta — recortes ajustados de las esquinas a alta resolución
 *       (poppler en C, sin SIMD → apto para el Atom; la visión lee bien un recorte enfocado), y
 *   (b) el ISSN IMPRESO en las páginas interiores (mancheta/créditos) — por si el código de barras de la
 *       cubierta es COMERCIAL (UPC), no un 977-ISSN. En revistas el EAN-13 empieza por 977 y codifica el
 *       ISSN; 978/979 → ISBN; cualquier otro EAN válido = comercial (entonces vale el ISSN impreso).
 *
 * Devuelve { issn?, isbn?, esRevista, mes_publicacion? } o null. El llamante lo invoca SOLO si falta el
 * identificador propio del tipo (revista→issn, libro→isbn).
 */
import { conVision, extraerJSON } from './vision.js';
import { tamanoPagina, rasterizarRecorte } from './rasterizar-pdf.js';
import { decodificarCodigoBarras } from './codigo-barras.js';
import { validarISSN, validarISBN } from './identificadores.js';
import { leerBarrasLocal } from './lector-barras-local.js';

const ANCHO = Number(process.env.PDF_BARRAS_ANCHO || 3000); // px de ancho de página equivalente (DPI alto)
const PROMPT = `Tienes RECORTES de la cubierta (donde está el CÓDIGO DE BARRAS) y algunas PÁGINAS INTERIORES
de una revista o libro. Devuelve SOLO un JSON con tres campos:
- "codigo_barras": los 13 dígitos del EAN-13 de la cubierta, SIN guiones ni espacios, leídos en CUALQUIER
  orientación (el código puede estar HORIZONTAL o GIRADO 90°/VERTICAL). Vacío si no lo ves. (En revistas
  empieza por 977 y codifica el ISSN; en libros por 978/979.)
- "add_on": el pequeño add-on de 2 dígitos a la derecha del código de barras, o vacío.
- "issn_impreso": si en las PÁGINAS INTERIORES (mancheta/créditos/staff) hay un ISSN IMPRESO (formato
  NNNN-NNNX, normalmente junto a la palabra "ISSN"), transcríbelo (con su guion); si no, vacío. Esto importa
  porque el código de barras de la cubierta puede ser COMERCIAL (un UPC de precio), NO el ISSN.
NO inventes nada: deja vacío lo que no veas con seguridad.`;

// Recortes candidatos (fracciones del lienzo de UNA página) donde suele estar el código de barras. Se
// aplican a la portada (pág. 1) y a la CONTRAportada (última página): en LIBROS el EAN del ISBN casi
// siempre va en la contracubierta, no en la portada.
function recortesDePagina(p) {
    return [
        { p, fx: 0.52, fy: 0.58, fw: 0.48, fh: 0.42 }, // esquina inferior DERECHA (horizontal + base de verticales)
        { p, fx: 0.00, fy: 0.66, fw: 0.45, fh: 0.34 }, // esquina inferior IZQUIERDA
        { p, fx: 0.68, fy: 0.20, fw: 0.32, fh: 0.80 }, // borde DERECHO alto (barras verticales)
    ];
}

export async function leerCodigoBarrasPorVision(ruta, numPaginas, rendersInternos = []) {
    const tam = await tamanoPagina(ruta);
    if (!tam) { console.warn('[Barras] pdfinfo no dio el tamaño de página → se omite la lectura de barras.'); return null; }
    const dpi = Math.max(72, Math.round(ANCHO * 72 / tam.anchoPts));
    const wpx = Math.round(tam.anchoPts / 72 * dpi), hpx = Math.round(tam.altoPts / 72 * dpi);

    const imagenes = [];
    const bufsPortada = [];
    // (a) Recortes para el código de barras: la CUBIERTA (pág. 1) y también la CONTRACUBIERTA (última
    //     página) — en los LIBROS el EAN del ISBN suele estar en la contracubierta, no en la portada.
    const ult = numPaginas && numPaginas > 1 ? numPaginas : null;
    const zonas = [...recortesDePagina(1), ...(ult ? recortesDePagina(ult).slice(0, 2) : [])];
    for (const r of zonas) {
        const buf = await rasterizarRecorte(ruta, r.p, { dpi, x: r.fx * wpx, y: r.fy * hpx, w: r.fw * wpx, h: r.fh * hpx });
        if (buf && buf.length) { bufsPortada.push(buf); imagenes.push({ base64: buf.toString('base64'), mimeType: 'image/jpeg' }); }
    }
    const recortes = imagenes.length;

    // PASO PREVIO SIN IA: leer el EAN localmente (zxing) de los recortes de cubierta. Si sale un 977/978/979
    // claro, devolvemos sin gastar una llamada de visión. (Si el código es COMERCIAL o no se lee, seguimos a
    // la visión, que además mira el ISSN IMPRESO en el interior.)
    const localPdf = await leerBarrasLocal(bufsPortada);
    if (localPdf) {
        const bc = decodificarCodigoBarras(localPdf.codigo_barras);
        if (bc && (bc.issn || bc.isbn)) {
            const mes = localPdf.add_on && Number(localPdf.add_on) >= 1 && Number(localPdf.add_on) <= 12 ? Number(localPdf.add_on) : null;
            console.log(`[Barras] EAN leído LOCALMENTE sin IA: ${bc.issn || bc.isbn}.`);
            return { issn: bc.issn || null, isbn: bc.isbn || null, esRevista: !!bc.issn, mes_publicacion: mes };
        }
    }
    // (b) Páginas INTERIORES (mancheta/créditos) para el ISSN impreso: reusar renders ya hechos (2ª-5ª,
    //     ni la portada ni la contraportada). Hasta 3, sin re-rasterizar.
    const interiores = (rendersInternos || [])
        .filter(r => r && r.buffer && r.pagina > 1 && r.pagina !== ult)
        .slice(0, 3);
    for (const r of interiores) imagenes.push({ base64: r.buffer.toString('base64'), mimeType: 'image/jpeg' });

    console.log(`[Barras] ${recortes} recorte(s) de cubierta + ${interiores.length} página(s) interior(es) (dpi=${dpi}); consultando a la visión…`);
    if (!imagenes.length) return null;

    let datos;
    try {
        datos = extraerJSON(await conVision({ prompt: PROMPT, imagenes })) || {};
    } catch (e) {
        console.warn(`[Barras] visión falló: ${e.message}`);
        return null;
    }
    console.log(`[Barras] visión: codigo_barras="${datos.codigo_barras || ''}" add_on="${datos.add_on || ''}" issn_impreso="${datos.issn_impreso || ''}"`);

    const bc = decodificarCodigoBarras(datos.codigo_barras); // {issn|isbn|comercial}|null
    let issn = bc?.issn || null;
    const isbn = bc?.isbn || null;
    // Código de barras COMERCIAL (o ausente) → el ISSN viene del impreso en el interior.
    if (!issn && datos.issn_impreso) {
        const v = validarISSN(datos.issn_impreso);
        if (v) { issn = v; console.log(`[Barras] ISSN impreso en el interior: ${v}${bc?.comercial ? ' (el código de barras de cubierta era comercial)' : ''}.`); }
    }
    if (!issn && !isbn) {
        if (bc?.comercial) console.log('[Barras] código de barras COMERCIAL (no ISSN) y sin ISSN impreso legible.');
        else console.log('[Barras] sin EAN-13 ISSN/ISBN ni ISSN impreso en los recortes.');
        return null;
    }
    const add = String(datos.add_on || '').replace(/\D/g, '');
    const mes = add && Number(add) >= 1 && Number(add) <= 12 ? Number(add) : null;
    return { issn, isbn, esRevista: !!issn, mes_publicacion: mes };
}

const PROMPT_IMGS = `Tienes varias PÁGINAS (portada, créditos, contraportada) de un CÓMIC, libro o revista. Busca su
IDENTIFICADOR y devuelve SOLO un JSON con estos campos (deja vacío lo que no veas con seguridad; NO inventes):
- "codigo_barras": los 13 dígitos del EAN-13 (cubierta/contraportada), SIN guiones ni espacios, leídos en
  CUALQUIER orientación (horizontal o GIRADO 90°/vertical). (977→ISSN de revista; 978/979→ISBN de libro.)
- "add_on": el pequeño add-on de 2 dígitos a la derecha del código de barras, o vacío.
- "isbn_impreso": un ISBN IMPRESO en los créditos/colofón (10 o 13 cifras, normalmente junto a "ISBN"),
  transcrito con sus guiones. Útil cuando el código de barras no se lee bien.
- "issn_impreso": un ISSN IMPRESO (formato NNNN-NNNX, junto a "ISSN"), o vacío.`;

/**
 * Lee el IDENTIFICADOR (código de barras EAN-13, o ISBN/ISSN impreso) a partir de un puñado de PÁGINAS ya
 * extraídas como imágenes (p. ej. las 5 primeras + la última de un cómic). UNA sola llamada de visión.
 * @param {Array<{base64:string, mimeType?:string}>} muestras
 * @returns {Promise<{issn:?string,isbn:?string,esRevista:boolean,mes_publicacion:?number}|null>}
 */
export async function leerIdentificadorDeImagenes(muestras) {
    const imagenes = (muestras || []).filter(m => m && m.base64).map(m => ({ base64: m.base64, mimeType: m.mimeType || 'image/jpeg' }));
    if (!imagenes.length) return null;
    // PASO PREVIO SIN IA: leer el EAN localmente (zxing) de las páginas de muestra.
    const localImg = await leerBarrasLocal(imagenes.map(m => Buffer.from(m.base64, 'base64')));
    if (localImg) {
        const bc = decodificarCodigoBarras(localImg.codigo_barras);
        if (bc && (bc.issn || bc.isbn)) {
            const mes = localImg.add_on && Number(localImg.add_on) >= 1 && Number(localImg.add_on) <= 12 ? Number(localImg.add_on) : null;
            console.log(`[Barras/img] EAN leído LOCALMENTE sin IA: ${bc.issn || bc.isbn}.`);
            return { issn: bc.issn || null, isbn: bc.isbn || null, esRevista: !!bc.issn && !bc.isbn, mes_publicacion: mes };
        }
    }
    console.log(`[Barras/img] ${imagenes.length} página(s) de muestra → consultando a la visión…`);
    let datos;
    try {
        datos = extraerJSON(await conVision({ prompt: PROMPT_IMGS, imagenes })) || {};
    } catch (e) { console.warn(`[Barras/img] visión falló: ${e.message}`); return null; }
    console.log(`[Barras/img] codigo_barras="${datos.codigo_barras || ''}" isbn_impreso="${datos.isbn_impreso || ''}" issn_impreso="${datos.issn_impreso || ''}"`);

    const bc = decodificarCodigoBarras(datos.codigo_barras);
    let issn = bc?.issn || null, isbn = bc?.isbn || null;
    if (!isbn && datos.isbn_impreso) { const v = validarISBN(datos.isbn_impreso); if (v) { isbn = v; console.log(`[Barras/img] ISBN impreso: ${v}.`); } }
    if (!issn && datos.issn_impreso) { const v = validarISSN(datos.issn_impreso); if (v) { issn = v; console.log(`[Barras/img] ISSN impreso: ${v}.`); } }
    if (!issn && !isbn) { console.log('[Barras/img] sin identificador legible en las páginas.'); return null; }
    const add = String(datos.add_on || '').replace(/\D/g, '');
    const mes = add && Number(add) >= 1 && Number(add) <= 12 ? Number(add) : null;
    return { issn, isbn, esRevista: !!issn && !isbn, mes_publicacion: mes };
}
