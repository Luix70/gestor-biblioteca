/**
 * POLARIDAD DE LAS LÁMINAS BITONALES EXTRAÍDAS DE UN PDF.
 *
 * `pdfimages` saca la imagen TAL COMO ESTÁ ALMACENADA en el PDF, sin interpretar la semántica de la página.
 * En un *stencil* (ImageMask, que es como vienen los grabados escaneados en blanco y negro) el bit 0 significa
 * «pinta aquí», no «blanco»; al volcarlo a PNG en escala de grises —donde 0 es negro— sale el NEGATIVO. Medido
 * en una lámina real de la Encyclopédie: 85,1% de píxeles negros, cuando un grabado sobre papel es justo lo
 * contrario. Todos los tomos salieron en negativo salvo el que el usuario había convertido a JPG por su cuenta.
 *
 * ¿Por qué no dejar que poppler RENDERICE la página (que sí respeta la semántica)? Porque es cinco veces más
 * lento: 7,0 s por lámina frente a 1,46 s extrayendo. Con 2.225 láminas eso son horas de más, y en el Atom del
 * NAS bastante peor. Se extrae rápido y se corrige aquí.
 *
 * LA CORRECCIÓN NO RECOMPRIME NADA. Un PNG de 1 bit en escala de grises se convierte en uno INDEXADO con una
 * paleta de dos entradas invertida (índice 0 → blanco, índice 1 → negro). Los datos de imagen (IDAT) se quedan
 * byte a byte como estaban: solo se reescribe la cabecera y se inserta la paleta. Es instantáneo y sin pérdida.
 */
import zlib from 'node:zlib';
import fs from 'node:fs/promises';

export const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// CRC32 propio: `zlib.crc32` no existe en Node 18, que es lo que corre en el NAS.
const TABLA_CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

export function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = TABLA_CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** Un chunk PNG completo: longitud + tipo + datos + CRC(tipo+datos). */
export function chunk(tipo, datos) {
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
    const out = Buffer.alloc(cuerpo.length + 8);
    out.writeUInt32BE(datos.length, 0);
    cuerpo.copy(out, 4);
    out.writeUInt32BE(crc32(cuerpo), cuerpo.length + 4);
    return out;
}

/** Recorre los chunks de un PNG. Devuelve null si no lo es. */
export function leerChunks(buf) {
    if (buf.length < 8 || !buf.subarray(0, 8).equals(FIRMA)) return null;
    const chunks = [];
    let p = 8;
    while (p + 8 <= buf.length) {
        const len = buf.readUInt32BE(p);
        const tipo = buf.subarray(p + 4, p + 8).toString('ascii');
        if (p + 12 + len > buf.length) return null;   // truncado
        chunks.push({ tipo, datos: buf.subarray(p + 8, p + 8 + len), inicio: p, fin: p + 12 + len });
        p += 12 + len;
        if (tipo === 'IEND') break;
    }
    return chunks;
}

/**
 * Deshace los filtros por línea del PNG y cuenta los bits a 1.
 *
 * En escala de grises de 1 bit, 1 = BLANCO. Los filtros trabajan sobre BYTES y con profundidad menor de 8 la
 * distancia entre píxeles es 1 byte, lo que simplifica Sub/Average/Paeth.
 */
function proporcionDeBlanco(datos, ancho, alto) {
    const bytesPorFila = Math.ceil(ancho / 8);
    const esperado = (bytesPorFila + 1) * alto;
    if (datos.length < esperado) return null;   // no cuadra: mejor no tocar la imagen

    const previa = Buffer.alloc(bytesPorFila);
    const fila = Buffer.alloc(bytesPorFila);
    let unos = 0;
    let p = 0;
    for (let y = 0; y < alto; y++) {
        const filtro = datos[p++];
        datos.copy(fila, 0, p, p + bytesPorFila);
        p += bytesPorFila;
        for (let x = 0; x < bytesPorFila; x++) {
            const a = x >= 1 ? fila[x - 1] : 0;   // izquierda
            const b = previa[x];                  // arriba
            const c = x >= 1 ? previa[x - 1] : 0; // diagonal
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
        // Bits a 1 de la fila, descontando el relleno del final (el ancho rara vez es múltiplo de 8).
        for (let x = 0; x < bytesPorFila; x++) {
            let v = fila[x];
            if (x === bytesPorFila - 1 && ancho % 8) v &= 0xff << (8 - (ancho % 8));
            while (v) { unos += v & 1; v >>= 1; }
        }
        fila.copy(previa);
    }
    return unos / (ancho * alto);
}

/**
 * Corrige, si hace falta, la polaridad de un PNG bitonal recién extraído de un PDF.
 *
 * Solo actúa sobre PNG de 1 bit en escala de grises (lo que produce `pdfimages` con un stencil); cualquier
 * otra cosa se deja intacta. La decisión es por CONTENIDO, no por el tipo declarado en el PDF: un stencil
 * puede traer un `Decode` que ya invierta, y entonces girarlo otra vez lo estropearía. Una página escaneada
 * —texto o grabado sobre papel— es abrumadoramente blanca; si sale mayoritariamente negra, está en negativo.
 *
 * @returns {Promise<boolean>} true si se corrigió.
 */
export async function corregirPolaridadPng(ruta, opciones = {}) {
    let buf;
    try { buf = await fs.readFile(ruta); } catch { return false; }
    const corregido = corregirPolaridadBuffer(buf, opciones);
    if (!corregido) return false;
    await fs.writeFile(ruta, corregido);
    return true;
}

/**
 * Igual que `corregirPolaridadPng` pero EN MEMORIA: devuelve el PNG corregido, o null si no había que tocarlo.
 *
 * Existe para poder arreglar láminas que ya están DENTRO de un cbz sin volver a convertir los PDF originales
 * (que es cosa de horas): se abre el cbz, se pasan sus PNG por aquí y se reescribe. Ver `scripts/corregir-
 * polaridad-cbz.js`.
 */
export function corregirPolaridadBuffer(buf, { umbral = 0.45 } = {}) {
    const chunks = leerChunks(buf);
    if (!chunks) return null;
    const ihdr = chunks.find((c) => c.tipo === 'IHDR');
    if (!ihdr || ihdr.datos.length < 13) return null;

    const ancho = ihdr.datos.readUInt32BE(0);
    const alto = ihdr.datos.readUInt32BE(4);
    const profundidad = ihdr.datos[8];
    const tipoColor = ihdr.datos[9];
    const entrelazado = ihdr.datos[12];
    // Solo el caso que nos ocupa. El entrelazado (Adam7) reorganiza las líneas y aquí no se contempla:
    // `pdfimages` no lo genera, y ante la duda es mejor no tocar la imagen que estropearla.
    if (profundidad !== 1 || tipoColor !== 0 || entrelazado !== 0) return null;

    const idat = chunks.filter((c) => c.tipo === 'IDAT').map((c) => c.datos);
    if (!idat.length) return null;

    let crudo;
    try { crudo = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
    const blanco = proporcionDeBlanco(crudo, ancho, alto);
    if (blanco === null || blanco >= umbral) return null;   // ya está bien (o no se puede afirmar que no)

    // INVERSIÓN SIN RECOMPRIMIR: de gris de 1 bit a indexado con la paleta al revés.
    // En gris, 0 = negro y 1 = blanco; con esta paleta, el índice 0 pinta blanco y el 1 pinta negro.
    const nuevoIhdr = Buffer.from(ihdr.datos);
    nuevoIhdr[9] = 3;                                                  // tipo de color: indexado
    const paleta = Buffer.from([255, 255, 255, 0, 0, 0]);              // 0 → blanco · 1 → negro

    const partes = [FIRMA, chunk('IHDR', nuevoIhdr), chunk('PLTE', paleta)];
    for (const c of chunks) {
        if (c.tipo === 'IHDR') continue;
        partes.push(buf.subarray(c.inicio, c.fin));                    // el resto, tal cual (IDAT incluido)
    }
    return Buffer.concat(partes);
}


/**
 * Invierte un PNG de 1 bit en gris SIN mirar el contenido (a diferencia de `corregirPolaridadBuffer`, que
 * decide por la proporción de blanco). Para las láminas MUY densas —un frontispicio recargado de tinta— la
 * heurística falla: la página correcta ya es oscura, así que hay que poder forzar la vuelta a mano.
 * Devuelve el PNG invertido, o null si no es un PNG de 1 bit en gris que se pueda tratar así.
 */
export function invertirPngBuffer(buf) {
    const chunks = leerChunks(buf);
    if (!chunks) return null;
    const ihdr = chunks.find((c) => c.tipo === 'IHDR');
    if (!ihdr || ihdr.datos.length < 13) return null;
    const profundidad = ihdr.datos[8];
    const tipoColor = ihdr.datos[9];
    const entrelazado = ihdr.datos[12];
    if (profundidad !== 1 || (tipoColor !== 0 && tipoColor !== 3) || entrelazado !== 0) return null;

    // Gris de 1 bit → indexado con la paleta al revés (0→blanco, 1→negro), IDAT intactos. Si YA es indexado
    // (una corrección previa), basta con voltear su paleta de dos entradas.
    if (tipoColor === 0) {
        const nuevoIhdr = Buffer.from(ihdr.datos);
        nuevoIhdr[9] = 3;
        const paleta = Buffer.from([255, 255, 255, 0, 0, 0]);
        const partes = [FIRMA, chunk('IHDR', nuevoIhdr), chunk('PLTE', paleta)];
        for (const c of chunks) { if (c.tipo !== 'IHDR') partes.push(buf.subarray(c.inicio, c.fin)); }
        return Buffer.concat(partes);
    }
    const plte = chunks.find((c) => c.tipo === 'PLTE');
    if (!plte || plte.datos.length < 6) return null;
    const nuevaPaleta = Buffer.from(plte.datos);
    // intercambia las dos primeras entradas (índice 0 ↔ 1)
    for (let k = 0; k < 3; k++) { const t = nuevaPaleta[k]; nuevaPaleta[k] = nuevaPaleta[3 + k]; nuevaPaleta[3 + k] = t; }
    const partes = [FIRMA];
    for (const c of chunks) {
        if (c.tipo === 'PLTE') partes.push(chunk('PLTE', nuevaPaleta));
        else partes.push(buf.subarray(c.inicio, c.fin));
    }
    return Buffer.concat(partes);
}
