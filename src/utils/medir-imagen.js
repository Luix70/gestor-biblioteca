/**
 * Mide el tamaño de una imagen leyendo solo sus cabeceras (sin decodificar ni dependencias
 * nativas: seguro en el Atom). Soporta JPEG, PNG, GIF y WEBP. Sirve para descartar portadas
 * degeneradas (el GIF 1x1 que OpenLibrary devuelve como marcador) y para preferir la más ancha.
 *
 * @returns {{ formato: string, width: number, height: number } | null}
 */
export function medirImagen(buffer) {
    if (!buffer || buffer.length < 16) return null;

    // --- PNG: firma 89 50 4E 47, IHDR con width/height en BE a partir del offset 16 ---
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return { formato: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    // --- GIF: "GIF8", width/height en LE en los offsets 6 y 8 ---
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
        return { formato: 'gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }

    // --- JPEG: recorrer marcadores hasta un SOF (Start Of Frame) con las dimensiones ---
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let off = 2;
        while (off + 9 < buffer.length) {
            if (buffer[off] !== 0xff) { off++; continue; }
            const marcador = buffer[off + 1];
            // SOF0..SOF15 contienen el tamaño; se excluyen DHT(C4), JPG(C8) y DAC(CC).
            if (marcador >= 0xc0 && marcador <= 0xcf &&
                marcador !== 0xc4 && marcador !== 0xc8 && marcador !== 0xcc) {
                return { formato: 'jpeg', height: buffer.readUInt16BE(off + 5), width: buffer.readUInt16BE(off + 7) };
            }
            // Marcadores sin carga útil (RSTn, SOI, EOI): avanzar 2 bytes.
            if (marcador === 0xd8 || marcador === 0xd9 || (marcador >= 0xd0 && marcador <= 0xd7)) { off += 2; continue; }
            const longitud = buffer.readUInt16BE(off + 2); // incluye los 2 bytes de la longitud
            off += 2 + longitud;
        }
        return null;
    }

    // --- WEBP: "RIFF"...."WEBP" + sub-chunk VP8 / VP8L / VP8X ---
    if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const tipo = buffer.toString('ascii', 12, 16);
        if (tipo === 'VP8X') {
            return { formato: 'webp', width: (buffer.readUIntLE(24, 3) & 0xffffff) + 1, height: (buffer.readUIntLE(27, 3) & 0xffffff) + 1 };
        }
        if (tipo === 'VP8L') {
            const b = buffer.readUInt32LE(21);
            return { formato: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
        }
        if (tipo === 'VP8 ') {
            return { formato: 'webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        }
    }

    return null;
}
