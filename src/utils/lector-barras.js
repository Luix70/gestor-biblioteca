/**
 * Lectura del CÓDIGO DE BARRAS de la cubierta de un PDF, ENFOCADA por recorte.
 *
 * La visión (Gemini) lee mal un código de barras diminuto perdido en la página entera, pero lee
 * MUY bien un recorte ajustado y a alta resolución (comprobado). Por eso aquí: con poppler (C, sin
 * SIMD → apto para el Atom) se recortan a alta resolución las franjas donde suele vivir el código de
 * barras (esquina inferior y borde derecho de la cubierta + franja inferior de la contracubierta) y
 * se le pasan ESOS recortes a la visión. El trabajo de imagen pesado lo hace poppler; el OCR, la nube.
 *
 * 977 → ISSN (revista); 978/979 → ISBN (libro). El add-on EAN-2 (si es 1-12) se toma como MES.
 * Devuelve { issn?, isbn?, esRevista, mes_publicacion? } o null. El llamante lo invoca SOLO cuando aún
 * no hay identificador (acotado).
 */
import { conGemini } from './gemini.js';
import { tamanoPagina, rasterizarRecorte } from './rasterizar-pdf.js';
import { decodificarCodigoBarras } from './codigo-barras.js';

const ANCHO = Number(process.env.PDF_BARRAS_ANCHO || 2400); // px de ancho de página para los recortes
const MODELO = { model: 'gemini-2.5-flash', generationConfig: { responseMimeType: 'application/json' } };
const PROMPT = `Estas imágenes son RECORTES a alta resolución de las esquinas/franjas de la cubierta y la
contracubierta de una revista o libro, donde está el CÓDIGO DE BARRAS. Localiza el código de barras
EAN-13 y transcribe EXACTAMENTE sus 13 dígitos (los números impresos junto a las barras), SIN guiones.
El código de barras PUEDE ESTAR GIRADO (vertical / 90°): léelo en cualquier orientación. Si a su derecha
hay un pequeño add-on de 2 dígitos, transcríbelo aparte. Responde SOLO con JSON:
{"codigo_barras":"<13 dígitos o vacío>","add_on":"<2 dígitos o vacío>"}. NO inventes dígitos: si no hay
un código de barras legible en los recortes, deja ambos campos vacíos.`;

export async function leerCodigoBarrasPorVision(ruta, numPaginas) {
    const tam = await tamanoPagina(ruta);
    if (!tam) return null;
    const dpi = Math.max(72, Math.round(ANCHO * 72 / tam.anchoPts));
    const wpx = Math.round(tam.anchoPts / 72 * dpi), hpx = Math.round(tam.altoPts / 72 * dpi);
    const yb = Math.round(hpx * 0.72), xr = Math.round(wpx * 0.74);
    const ult = numPaginas && numPaginas > 1 ? numPaginas : null;

    const recortes = [
        { p: 1, x: 0,  y: yb, w: wpx,      h: hpx - yb },   // portada: franja inferior (barras horizontales)
        { p: 1, x: xr, y: 0,  w: wpx - xr, h: hpx },        // portada: franja derecha  (barras verticales)
    ];
    if (ult) recortes.push({ p: ult, x: 0, y: yb, w: wpx, h: hpx - yb }); // contraportada: franja inferior

    const imgs = [];
    for (const r of recortes) {
        const buf = await rasterizarRecorte(ruta, r.p, { dpi, x: r.x, y: r.y, w: r.w, h: r.h });
        if (buf && buf.length) imgs.push({ inlineData: { data: buf.toString('base64'), mimeType: 'image/jpeg' } });
    }
    if (!imgs.length) return null;

    let datos;
    try {
        const res = await conGemini(MODELO, (model) => model.generateContent([PROMPT, ...imgs]));
        datos = JSON.parse((res.response.text() || '{}').trim());
    } catch { return null; }

    const bc = decodificarCodigoBarras(datos.codigo_barras);
    if (!bc) return null;
    const add = String(datos.add_on || '').replace(/\D/g, '');
    const mes = add && Number(add) >= 1 && Number(add) <= 12 ? Number(add) : null;
    return { ...bc, mes_publicacion: mes };
}
