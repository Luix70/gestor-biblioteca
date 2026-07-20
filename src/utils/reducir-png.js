/**
 * REDUCE UN PNG BITONAL/GRIS A UN ANCHO OBJETIVO, en JS puro (el Atom no tiene sharp ni ImageMagick).
 *
 * Para qué: las láminas de escaneo vienen a 6000+ px. Un PNG así, aunque comprimido pese poco, el navegador lo
 * descodifica a un BITMAP COMPLETO para pintarlo (6367×9328 ≈ 237 MB), y una PORTADA de ese tamaño en la
 * rejilla del catálogo deja la pestaña sin memoria. Este reductor genera una portada pequeña (≈1000 px) a
 * partir de la 1.ª página, de modo que el navegador ya no descodifica un monstruo.
 *
 * Alcance DELIBERADAMENTE estrecho: solo PNG en GRIS (tipoColor 0) o INDEXADO de 2 colores (tipoColor 3, que
 * es como quedan las láminas tras la corrección de polaridad). Es exactamente el material que causa el
 * problema (grabados bitonales). Un JPEG de cómic normal ronda los 1500 px y no da guerra; se deja intacto
 * (aquí no hay descodificador JPEG). Ante cualquier caso no contemplado devuelve null y el llamante conserva
 * el original: nunca se degrada por no saber tratar algo.
 */
import zlib from 'node:zlib';
import { FIRMA, chunk, leerChunks } from './png-polaridad.js';

/** Deshace el filtrado por línea de un raster de 1 byte/píxel (gris u índice de 8 bits). */
function desfiltrar(datos, bytesPorFila, alto, bpp) {
    const fuera = Buffer.alloc(bytesPorFila * alto);
    const previa = Buffer.alloc(bytesPorFila);
    let p = 0;
    for (let y = 0; y < alto; y++) {
        const filtro = datos[p++];
        const fila = fuera.subarray(y * bytesPorFila, (y + 1) * bytesPorFila);
        datos.copy(fila, 0, p, p + bytesPorFila);
        p += bytesPorFila;
        for (let x = 0; x < bytesPorFila; x++) {
            const a = x >= bpp ? fila[x - bpp] : 0;
            const b = previa[x];
            const c = x >= bpp ? previa[x - bpp] : 0;
            let v = fila[x];
            if (filtro === 1) v += a;
            else if (filtro === 2) v += b;
            else if (filtro === 3) v += (a + b) >> 1;
            else if (filtro === 4) {
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            fila[x] = v & 0xff;
        }
        fila.copy(previa);
    }
    return fuera;
}

/**
 * Devuelve una función `luminancia(x, y)` (0..255) sobre el raster ya desfiltrado, según el tipo de PNG.
 * Solo se resuelven los casos declarados; para el resto se devuelve null (el llamante no toca la imagen).
 */
function lectorLuminancia({ crudo, ancho, alto, profundidad, tipoColor, paleta }) {
    // Gris de 8 bits: un byte por píxel = el propio valor.
    if (tipoColor === 0 && profundidad === 8) {
        return (x, y) => crudo[y * ancho + x];
    }
    // Gris o indexado de MENOS de 8 bits (típico: 1 bit): los píxeles van empaquetados en el byte.
    if ((tipoColor === 0 || tipoColor === 3) && profundidad < 8) {
        const bytesPorFila = Math.ceil((ancho * profundidad) / 8);
        const masc = (1 << profundidad) - 1;
        const porByte = 8 / profundidad;
        const valor = (x, y) => {
            const byte = crudo[y * bytesPorFila + Math.floor(x / porByte)];
            const desp = 8 - profundidad - (x % porByte) * profundidad;
            return (byte >> desp) & masc;
        };
        if (tipoColor === 0) {
            // Gris: se escala el valor al rango 0..255 (con 1 bit, 0→0 y 1→255).
            const factor = 255 / masc;
            return (x, y) => Math.round(valor(x, y) * factor);
        }
        // Indexado: el valor es un índice a la paleta; se toma su luminancia.
        return (x, y) => {
            const i = valor(x, y) * 3;
            return (paleta[i] * 299 + paleta[i + 1] * 587 + paleta[i + 2] * 114) / 1000 | 0;
        };
    }
    // Indexado de 8 bits.
    if (tipoColor === 3 && profundidad === 8) {
        return (x, y) => {
            const i = crudo[y * ancho + x] * 3;
            return (paleta[i] * 299 + paleta[i + 1] * 587 + paleta[i + 2] * 114) / 1000 | 0;
        };
    }
    return null;
}

/** Codifica un raster gris de 8 bits (1 byte/píxel) como PNG, filtro 0 por línea. */
function codificarGris8(pixeles, ancho, alto) {
    const crudo = Buffer.alloc((ancho + 1) * alto);
    for (let y = 0; y < alto; y++) {
        crudo[y * (ancho + 1)] = 0;   // filtro None
        pixeles.copy(crudo, y * (ancho + 1) + 1, y * ancho, (y + 1) * ancho);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(ancho, 0);
    ihdr.writeUInt32BE(alto, 4);
    ihdr[8] = 8;   // profundidad
    ihdr[9] = 0;   // tipoColor: gris
    // 10,11,12 = compresión/filtro/entrelazado = 0
    const idat = zlib.deflateSync(crudo, { level: 9 });
    return Buffer.concat([FIRMA, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Reduce `buf` (PNG gris/indexado) a un ancho máximo por PROMEDIADO EN CAJA (nítido y sin dependencias).
 * @returns {Buffer|null} PNG gris de 8 bits reducido, o null si no aplica / no se pudo (conserva el original).
 */
export function reducirPngBuffer(buf, { anchoMax = 1000 } = {}) {
    const chunks = leerChunks(buf);
    if (!chunks) return null;
    const ihdr = chunks.find((c) => c.tipo === 'IHDR');
    if (!ihdr || ihdr.datos.length < 13) return null;

    const ancho = ihdr.datos.readUInt32BE(0);
    const alto = ihdr.datos.readUInt32BE(4);
    const profundidad = ihdr.datos[8];
    const tipoColor = ihdr.datos[9];
    const entrelazado = ihdr.datos[12];
    if (entrelazado !== 0) return null;             // Adam7 no se contempla (pdfimages no lo genera)
    if (ancho <= anchoMax) return null;             // ya es pequeño: nada que hacer

    const paletaChunk = chunks.find((c) => c.tipo === 'PLTE');
    const paleta = paletaChunk ? paletaChunk.datos : null;
    if (tipoColor === 3 && !paleta) return null;

    let crudo;
    try { crudo = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.tipo === 'IDAT').map((c) => c.datos))); }
    catch { return null; }

    // Desfiltrar cuando el filtrado trabaja sobre bytes de 8 bits (gris/indexado de 8 bits). En 1 bit los
    // filtros también son por byte, pero el lector de sub-8-bits accede al raster tal cual; por eso solo se
    // desfiltra el caso de 8 bits, donde bpp=1 byte.
    if (profundidad === 8) {
        crudo = desfiltrar(crudo, ancho, alto, 1);
    } else {
        // sub-8-bit: hay que desfiltrar por FILA (bytesPorFila) para leer bien los píxeles empaquetados.
        const bpf = Math.ceil((ancho * profundidad) / 8);
        crudo = desfiltrar(crudo, bpf, alto, 1);
    }

    const lum = lectorLuminancia({ crudo, ancho, alto, profundidad, tipoColor, paleta });
    if (!lum) return null;

    const escala = anchoMax / ancho;
    const nAncho = Math.max(1, Math.round(ancho * escala));
    const nAlto = Math.max(1, Math.round(alto * escala));
    const sx = ancho / nAncho, sy = alto / nAlto;
    const salida = Buffer.alloc(nAncho * nAlto);

    // Promedio en caja: cada píxel de salida es la media de su celda en el original. Nítido para línea b/n y
    // barato (una pasada por los píxeles de origen).
    for (let oy = 0; oy < nAlto; oy++) {
        const y0 = Math.floor(oy * sy), y1 = Math.min(alto, Math.floor((oy + 1) * sy) || y0 + 1);
        for (let ox = 0; ox < nAncho; ox++) {
            const x0 = Math.floor(ox * sx), x1 = Math.min(ancho, Math.floor((ox + 1) * sx) || x0 + 1);
            let suma = 0, n = 0;
            for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { suma += lum(x, y); n++; }
            salida[oy * nAncho + ox] = n ? (suma / n) | 0 : 0;
        }
    }
    return codificarGris8(salida, nAncho, nAlto);
}
