/**
 * PORTADAS ARTEFACTO — imágenes que NO son la cubierta de ningún libro y se cuelan como portada: el banner que un
 * grupo de ripeo mete como página 1 de todos sus PDF (caso real: «We Trip The Light Fantastic», el mismo en
 * «Beer», «Deadly Connections» y «G. E. Moore's Ethical Theory» — la cubierta real estaba en la página 2), un
 * «cover not available», el logo de un maquetador…
 *
 * Cómo se reconocen: la MISMA imagen como portada de libros DISTINTOS no puede ser la cubierta de ninguno. El
 * registro (colección `portadas_artefacto`) guarda dos huellas por artefacto:
 *   · `sha`    — SHA-256 exacto del fichero de imagen (cubiertas embebidas en EPUB/MOBI, portadas remotas…);
 *   · `huella` — dHash perceptivo (64 bits) de la PÁGINA de PDF, calculado sobre la miniatura gris que ya se hace
 *               para detectar páginas en blanco. Reconoce la misma página aunque se rasterice a otro tamaño o
 *               calidad (el JPEG final cambia de bytes; la huella no). Coincide si difieren ≤ UMBRAL bits.
 * Lo alimenta scripts/detectar-portadas-artefacto.js. Lo consultan la extracción de páginas de PDF
 * (rasterizar-pdf · rasterizarSignificativas, que salta la página artefacto como salta las en blanco) y la
 * re-extracción de imágenes (descarta una cubierta embebida artefacto y cae a la portada remota por ISBN).
 *
 * Best-effort: si la base no responde, no hay artefactos conocidos (nunca rompe la extracción).
 */
import crypto from 'node:crypto';
import { conectarDB } from '../database.js';

const COLECCION = 'portadas_artefacto';
const UMBRAL_BITS = Number(process.env.PORTADA_ARTEFACTO_UMBRAL || 6);
const REFRESCO_MS = 10 * 60 * 1000;

let cache = { huellas: [], shas: new Set(), cargado: 0 };

/** Carga (o refresca cada 10 min) el registro en memoria. Nunca lanza. */
export async function cargarArtefactos({ forzar = false } = {}) {
    if (!forzar && cache.cargado && Date.now() - cache.cargado < REFRESCO_MS) return cache;
    try {
        const db = await conectarDB();
        const filas = await db.collection(COLECCION).find({ activo: { $ne: false } }, { projection: { huella: 1, sha: 1 } }).toArray();
        cache = {
            huellas: filas.map((f) => f.huella).filter(Boolean),
            shas: new Set(filas.flatMap((f) => [f.sha, ...(f.shas || [])]).filter(Boolean)),
            cargado: Date.now(),
        };
    } catch { cache.cargado = Date.now(); /* sin base: sin artefactos conocidos */ }
    return cache;
}

/** ¿Tiene la huella información suficiente? (ni casi todo ceros ni casi todo unos) */
export function huellaInformativa(huella) {
    if (!huella || huella.length !== 16) return false;
    const unos = distanciaHuellas(huella, '0000000000000000');
    return unos >= 12 && unos <= 52;
}

/** Bits distintos entre dos huellas hex de 64 bits. */
export function distanciaHuellas(a, b) {
    if (!a || !b || a.length !== b.length) return 64;
    let d = 0;
    for (let i = 0; i < a.length; i++) {
        let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
        while (x) { d += x & 1; x >>= 1; }
    }
    return d;
}

/** ¿Es esta huella de página la de un artefacto conocido? (usa la caché: llama antes a cargarArtefactos) */
export function esHuellaArtefacto(huella) {
    if (!huella) return false;
    return cache.huellas.some((h) => distanciaHuellas(h, huella) <= UMBRAL_BITS);
}

export const shaImagen = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** ¿Es esta imagen (bytes) un artefacto conocido? */
export function esImagenArtefacto(buf) {
    return !!(buf && buf.length && cache.shas.has(shaImagen(buf)));
}

/**
 * dHash de una imagen PGM binaria (P5, 8 bits) — la miniatura gris de pdftoppm. Se reduce a una rejilla 9×8 por
 * promedio de bloques y cada bit dice si una celda es más clara que la de su derecha. Devuelve 16 hex (64 bits) o
 * null si el PGM no se entiende.
 */
export function huellaPGM(buf) {
    if (!buf || buf.length < 16) return null;
    let pos = 0;
    const esEsp = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    const token = () => {
        while (pos < buf.length) {
            if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; }
            else if (esEsp(buf[pos])) pos++;
            else break;
        }
        let s = '';
        while (pos < buf.length && !esEsp(buf[pos]) && buf[pos] !== 0x23) { s += String.fromCharCode(buf[pos]); pos++; }
        return s;
    };
    if (token() !== 'P5') return null;
    const w = parseInt(token(), 10), h = parseInt(token(), 10), maxv = parseInt(token(), 10);
    if (!w || !h || !maxv || maxv > 255) return null;
    pos++;
    const px = buf.subarray(pos, pos + w * h);
    if (px.length < w * h) return null;
    const CW = 9, CH = 8;
    const celdas = new Array(CW * CH).fill(0);
    for (let cy = 0; cy < CH; cy++) {
        const y0 = Math.floor(cy * h / CH), y1 = Math.max(y0 + 1, Math.floor((cy + 1) * h / CH));
        for (let cx = 0; cx < CW; cx++) {
            const x0 = Math.floor(cx * w / CW), x1 = Math.max(x0 + 1, Math.floor((cx + 1) * w / CW));
            let suma = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { suma += px[y * w + x]; n++; }
            celdas[cy * CW + cx] = n ? suma / n : 0;
        }
    }
    let bits = '';
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW - 1; cx++) bits += celdas[cy * CW + cx] > celdas[cy * CW + cx + 1] ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
}

/**
 * Registra (o amplía) un artefacto. `huella` (página de PDF) y/o `sha` (imagen exacta). `ejemplos` = documentos en
 * los que se vio. Idempotente: el _id es la huella si la hay, si no el sha.
 */
export async function registrarArtefacto(db, { huella = null, sha = null, ejemplos = [], origen = 'auto', nota = null }) {
    // Una huella con casi todos los bits iguales es la de una página casi LISA (medido: «0000000000000000» en una
    // página casi en blanco): casaría con cualquier otra página lisa. No se registra; esas ya se descartan por tinta.
    if (huella && !huellaInformativa(huella)) huella = null;
    const _id = huella || sha;
    if (!_id) return null;
    const set = { activo: true, origen, fecha: new Date() };
    if (huella) set.huella = huella;
    if (nota) set.nota = nota;
    const update = { $set: set, $addToSet: { ejemplos: { $each: ejemplos.slice(0, 20) } } };
    if (sha) update.$addToSet.shas = sha;
    if (sha && !huella) set.sha = sha;
    await db.collection(COLECCION).updateOne({ _id }, update, { upsert: true });
    cache.cargado = 0;   // que la próxima consulta recargue
    return _id;
}
