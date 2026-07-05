// ── LECTOR DE LOMOS (numeración de una colección a partir de fotos de los cantos) ───────────────────
// Los números de colección se pierden a menudo en la ingesta. Esta utilidad recibe una o varias FOTOS de
// los LOMOS de los libros de una serie, alineados, y con VISIÓN identifica cada lomo (título + número de
// volumen impreso) y su rectángulo (bbox). Luego EMPAREJA cada lomo con un miembro de la colección por
// parecido de título, para proponer una renumeración (y, de paso, recortar el lomo como imagen del doc).
// La visión va por la rotación multi-proveedor de conVision (gratis→pago); es una acción manual del admin.
import { conVision, extraerJSON } from './vision.js';

const PROMPT_LOMOS = `Analiza esta foto de los LOMOS (cantos) de varios libros de una MISMA colección/serie, colocados en fila.
Identifica CADA lomo por separado, en ORDEN de lectura (de izquierda a derecha si están de pie uno junto a otro; de arriba abajo si están apilados en horizontal).
Para cada lomo devuelve un objeto con:
- "orden": posición 1..N en la fila.
- "titulo": el título del libro tal como se lee en el lomo (une los saltos de línea en un solo texto).
- "autor": autor si aparece en el lomo (o "").
- "numero": SOLO el número de volumen/tomo/colección impreso en el lomo (dígitos). Si el lomo NO muestra número, deja "".
- "texto": todo el texto legible del lomo (por si el título no basta para identificarlo).
- "bbox": el rectángulo que ocupa ese lomo en la imagen, en FRACCIONES 0..1: {"x":borde_izq,"y":borde_sup,"w":ancho,"h":alto}.
Responde EXCLUSIVAMENTE con JSON: {"lomos":[{...}]}. No inventes números: si no ves un número impreso, "numero":"".`;

// Normaliza un bbox devuelto por la IA a fracciones 0..1 {x,y,w,h}. Tolera escalas 0..1, 0..100 y 0..1000
// (Gemini suele dar 0..1000) y recorta a los límites de la imagen. Devuelve null si no es utilizable.
function normBbox(b) {
    if (!b || typeof b !== 'object') return null;
    const arr = [b.x, b.y, b.w, b.h].map(Number);
    if (arr.some((v) => !Number.isFinite(v))) return null;
    let [x, y, w, h] = arr;
    const mx = Math.max(x, y, w, h);
    const escala = mx > 1.5 ? (mx > 101 ? 1000 : 100) : 1;
    x /= escala; y /= escala; w /= escala; h /= escala;
    x = Math.min(Math.max(x, 0), 1);
    y = Math.min(Math.max(y, 0), 1);
    w = Math.min(Math.max(w, 0), 1 - x);
    h = Math.min(Math.max(h, 0), 1 - y);
    if (w <= 0.005 || h <= 0.005) return null;
    return { x, y, w, h };
}

/**
 * Lee los lomos de UNA imagen con visión.
 * @param {{base64:string, mimeType?:string}} imagen
 * @returns {Promise<Array<{orden:number,titulo:string,autor:string,numero:string,texto:string,bbox:object|null}>>}
 */
export async function leerLomosImagen(imagen) {
    const txt = await conVision({ prompt: PROMPT_LOMOS, imagenes: [imagen] });
    const j = extraerJSON(txt);
    const lomos = j && Array.isArray(j.lomos) ? j.lomos : [];
    return lomos
        .map((l, i) => ({
            orden: Number.isFinite(+l.orden) ? +l.orden : i + 1,
            titulo: String(l.titulo || '').replace(/\s+/g, ' ').trim(),
            autor: String(l.autor || '').trim(),
            numero: String(l.numero || '').replace(/[^0-9]/g, ''),
            texto: String(l.texto || '').replace(/\s+/g, ' ').trim(),
            bbox: normBbox(l.bbox),
        }))
        .filter((l) => l.titulo || l.numero || l.texto);
}

// ── Emparejado lomo ↔ miembro de la colección por parecido de título (solape de tokens) ──────────────
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g'); // marcas combinantes tras normalizar a NFD
function normT(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(RE_DIACRITICOS, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const PALABRAS_VACIAS = new Set(['de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'del', 'al', 'the', 'of', 'and', 'a', 'to', 'vol', 'tomo', 'volumen', 'parte']);
function tokens(s) {
    return new Set(normT(s).split(' ').filter((w) => w.length > 2 && !PALABRAS_VACIAS.has(w)));
}
// Solape sobre el conjunto MÁS PEQUEÑO: el lomo puede llevar menos texto que el título completo (o al revés).
function parecido(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    return inter / Math.min(A.size, B.size);
}

/**
 * Empareja greedy: calcula el parecido de cada (lomo, miembro), ordena de mayor a menor y asigna cada par
 * si ambos siguen libres y superan el umbral. Cada miembro y cada lomo se usan UNA vez. El texto del lomo
 * (título + texto suelto) se compara con el título del miembro.
 * @param {Array} lomos  salida de leerLomosImagen (con un campo `img` añadido por el llamador)
 * @param {Array<{_id, titulo}>} miembros
 * @param {number} umbral  parecido mínimo para aceptar el emparejamiento (0..1)
 */
export function emparejarLomos(lomos, miembros, umbral = 0.34) {
    const pares = [];
    lomos.forEach((l, li) => {
        const heno = `${l.titulo} ${l.texto}`;
        miembros.forEach((m, mi) => {
            const s = parecido(heno, m.titulo);
            if (s >= umbral) pares.push({ li, mi, s });
        });
    });
    pares.sort((a, b) => b.s - a.s);
    const lomoUsado = new Set(), miembroUsado = new Set();
    const asignacion = new Map(); // li -> {mi, s}
    for (const p of pares) {
        if (lomoUsado.has(p.li) || miembroUsado.has(p.mi)) continue;
        lomoUsado.add(p.li); miembroUsado.add(p.mi);
        asignacion.set(p.li, { mi: p.mi, s: p.s });
    }
    return { asignacion, lomoUsado, miembroUsado };
}
