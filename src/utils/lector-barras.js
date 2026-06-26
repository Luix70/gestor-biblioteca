/**
 * Lectura del CÓDIGO DE BARRAS de la cubierta de un PDF, ENFOCADA por recorte.
 *
 * La visión (Gemini) lee mal un código de barras diminuto perdido en la página entera, pero lee MUY
 * bien un recorte AJUSTADO y a alta resolución (comprobado). Por eso, con poppler (C, sin SIMD → apto
 * para el Atom) se recortan a alta resolución las ESQUINAS donde vive el código de barras (inferior
 * izquierda/derecha y borde derecho de la cubierta + franja inferior de la contracubierta) y se le pasan
 * ESOS recortes a la visión con una orden ENFOCADA: "tu única tarea es leer el código de barras".
 *
 * En revistas el EAN-13 empieza por 977 y CODIFICA el ISSN (el dato clave para agrupar números de la
 * misma cabecera). 978/979 → ISBN. El add-on EAN-2 (si es 1-12) se toma como MES. Devuelve
 * { issn?, isbn?, esRevista, mes_publicacion? } o null. El llamante lo invoca SOLO si aún no hay id.
 */
import { conGemini } from './gemini.js';
import { tamanoPagina, rasterizarRecorte } from './rasterizar-pdf.js';
import { decodificarCodigoBarras } from './codigo-barras.js';

const ANCHO = Number(process.env.PDF_BARRAS_ANCHO || 3000); // px de ancho de página equivalente (DPI alto)
const MODELO = { model: 'gemini-2.5-flash', generationConfig: { responseMimeType: 'application/json' } };
const PROMPT = `Tu ÚNICA tarea es leer el CÓDIGO DE BARRAS de estas imágenes. Son recortes de las esquinas
de la cubierta/contracubierta de una REVISTA o libro, donde está el código de barras EAN-13.
En las revistas el código de barras EMPIEZA POR 977 y CODIFICA EL ISSN: es el dato MÁS IMPORTANTE.
El código puede estar HORIZONTAL o GIRADO 90° (VERTICAL): búscalo en CUALQUIER orientación y léelo.
Transcribe EXACTAMENTE sus 13 dígitos (los números impresos junto a las barras), SIN guiones ni espacios.
Si a su derecha hay un pequeño add-on de 2 dígitos, transcríbelo aparte.
Responde SOLO con JSON: {"codigo_barras":"<13 dígitos o vacío>","add_on":"<2 dígitos o vacío>"}.
NO inventes dígitos: si de verdad NO ves ningún código de barras en los recortes, deja los campos vacíos.`;

// Recortes candidatos (fracciones del lienzo) donde suele estar el código de barras de una revista.
function recortesPortada() {
    return [
        { p: 1, fx: 0.52, fy: 0.58, fw: 0.48, fh: 0.42 }, // esquina inferior DERECHA (horizontal + base de verticales)
        { p: 1, fx: 0.00, fy: 0.66, fw: 0.45, fh: 0.34 }, // esquina inferior IZQUIERDA
        { p: 1, fx: 0.68, fy: 0.20, fw: 0.32, fh: 0.80 }, // borde DERECHO alto (barras verticales)
    ];
}

export async function leerCodigoBarrasPorVision(ruta, numPaginas) {
    const tam = await tamanoPagina(ruta);
    if (!tam) { console.warn('[Barras] pdfinfo no dio el tamaño de página → se omite la lectura de barras.'); return null; }
    const dpi = Math.max(72, Math.round(ANCHO * 72 / tam.anchoPts));
    const wpx = Math.round(tam.anchoPts / 72 * dpi), hpx = Math.round(tam.altoPts / 72 * dpi);

    const fracc = recortesPortada();
    const ult = numPaginas && numPaginas > 1 ? numPaginas : null;
    if (ult) fracc.push({ p: ult, fx: 0.0, fy: 0.60, fw: 1.0, fh: 0.40 }); // contraportada: franja inferior

    const imgs = [];
    for (const r of fracc) {
        const buf = await rasterizarRecorte(ruta, r.p, {
            dpi, x: r.fx * wpx, y: r.fy * hpx, w: r.fw * wpx, h: r.fh * hpx,
        });
        if (buf && buf.length) imgs.push({ inlineData: { data: buf.toString('base64'), mimeType: 'image/jpeg' } });
    }
    console.log(`[Barras] ${imgs.length}/${fracc.length} recorte(s) de cubierta generados (dpi=${dpi}); consultando a la visión…`);
    if (!imgs.length) return null;

    let datos;
    try {
        const res = await conGemini(MODELO, (model) => model.generateContent([PROMPT, ...imgs]));
        datos = JSON.parse((res.response.text() || '{}').trim());
    } catch (e) {
        console.warn(`[Barras] visión falló: ${e.message}`);
        return null;
    }
    console.log(`[Barras] visión devolvió codigo_barras="${datos.codigo_barras || ''}" add_on="${datos.add_on || ''}"`);

    const bc = decodificarCodigoBarras(datos.codigo_barras);
    if (!bc) { console.log('[Barras] sin EAN-13 válido (977/978/979) en los recortes.'); return null; }
    const add = String(datos.add_on || '').replace(/\D/g, '');
    const mes = add && Number(add) >= 1 && Number(add) <= 12 ? Number(add) : null;
    return { ...bc, mes_publicacion: mes };
}
