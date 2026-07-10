/**
 * Decodificación de imágenes en base64 (data URL o base64 puro) que llegan del panel.
 *
 * Extraído de `gestion-autores.js` para compartirlo con `gestion-editoriales.js` (logo) sin duplicarlo.
 * Mismo criterio que `utils/imagenes-doc.js`: solo jpg/png/webp, con un tope de tamaño para que un pegado
 * accidental de un base64 enorme no tumbe el proceso ni engorde la BD.
 */
const MAX_IMAGEN_BYTES = 12 * 1024 * 1024;

/**
 * Formato REAL según los primeros bytes (magic bytes), NO según el `data:` que declara el cliente.
 * Motivo: `Buffer.from(x, 'base64')` es laxo y convierte casi cualquier texto en bytes, así que sin esta
 * comprobación una cadena cualquiera se escribiría en disco como un «.jpg» corrupto (y quedaría de portada
 * o de logo). Devuelve 'jpg' | 'png' | 'webp', o null si no es ninguna de las tres.
 */
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function firmaImagen(buf) {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(FIRMA_PNG)) return 'png';
    if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
    return null;
}

/** data URL o base64 puro → { buf, ext } (jpg|png|webp) o null si no es una imagen válida/aceptada. */
export function decodificarImagen(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    const m = b64.match(/^data:image\/(jpe?g|png|webp);base64,(.+)$/i);
    const data = m ? m[2] : b64.replace(/^data:[^,]*,/, '');
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { return null; }
    if (!buf.length || buf.length > MAX_IMAGEN_BYTES) return null;
    const ext = firmaImagen(buf); // manda el CONTENIDO, no la cabecera `data:` declarada
    return ext ? { buf, ext } : null;
}
