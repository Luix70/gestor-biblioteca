/**
 * Lector MOBI / AZW / AZW3 (Kindle/Mobipocket) SIN dependencias — PalmDB + cabecera MOBI/EXTH en JS puro
 * (apto para el Atom: nada nativo/SIMD). Extrae metadatos (título, autor(es), editorial, ISBN) y, best-effort,
 * la PORTADA embebida (registro de imagen apuntado por EXTH 201). DETECTA DRM (cifrado Mobipocket): un fichero
 * cifrado no se puede leer y el orquestador lo OMITE (→ testigo .noborrar en el Inbox, sin borrarlo).
 *
 * AZW = MOBI con envoltorio Amazon (mismo formato interno; sin DRM se lee igual). AZW3/KF8 lleva el texto en
 * HTML tipo EPUB, pero título/EXTH/portada se leen con esta misma cabecera. Con DRM de Kindle NO se puede
 * (requiere la clave del dispositivo) → se detecta y se omite.
 *
 * Formato de retorno: { drm:boolean, titulo, autores:string[], editorial, isbn, portada:{buf,ext}|null, error? }
 * Referencia del formato: https://wiki.mobileread.com/wiki/MOBI
 */
import fs from 'node:fs/promises';

// Firmas de imagen para localizar/validar el registro de portada (evita devolver basura si el offset falla).
const IMG_MAGIC = [
    { sig: [0xFF, 0xD8, 0xFF], ext: 'jpg' },
    { sig: [0x89, 0x50, 0x4E, 0x47], ext: 'png' },
    { sig: [0x47, 0x49, 0x46, 0x38], ext: 'gif' },
];
const magiaImagen = (buf) => {
    for (const m of IMG_MAGIC) if (buf.length >= m.sig.length && m.sig.every((b, i) => buf[i] === b)) return m.ext;
    return null;
};

// Texto EXTH/fullName: utf-8 (encoding 65001) o cp1252/latin1; se recortan NUL de relleno.
const decodificar = (buf, encoding) => {
    try { return buf.toString(encoding === 65001 ? 'utf8' : 'latin1').replace(/\0+$/, '').trim(); }
    catch { return buf.toString('latin1').replace(/\0+$/, '').trim(); }
};

/**
 * Lee un fichero MOBI/AZW/AZW3. Nunca lanza por contenido corrupto (devuelve { error }); solo relanza un
 * error de E/S al leer el fichero. `drm:true` ⇒ cifrado (no legible) — el llamante debe OMITIRLO.
 */
export async function leerMobi(ruta) {
    const data = await fs.readFile(ruta);
    if (data.length < 78) return { drm: false, error: 'fichero demasiado corto' };

    // --- Lista de registros PalmDB (cabecera de 78 bytes + N entradas de 8) ---
    const numRegistros = data.readUInt16BE(76);
    if (!numRegistros || 78 + numRegistros * 8 > data.length) return { drm: false, error: 'cabecera PalmDB inválida' };
    const offsets = [];
    for (let i = 0; i < numRegistros; i++) offsets.push(data.readUInt32BE(78 + i * 8));
    offsets.push(data.length); // centinela para delimitar el último registro
    const registro = (i) => data.subarray(offsets[i], offsets[i + 1]);

    const r0 = registro(0);
    if (r0.length < 16) return { drm: false, error: 'registro 0 corto' };

    // --- PalmDOC header: tipo de CIFRADO en los bytes 12..13 (0=ninguno, 1/2=DRM Mobipocket/Kindle) ---
    if (r0.readUInt16BE(12) !== 0) return { drm: true };

    let titulo = '', autores = [], editorial = '', isbn = '', portada = null, encoding = 1252;

    // --- Cabecera MOBI (magic "MOBI" en el offset 16 del registro 0) ---
    if (r0.length >= 20 && r0.toString('ascii', 16, 20) === 'MOBI') {
        encoding = r0.readUInt32BE(28);
        const mobiLen = r0.readUInt32BE(20);
        // Título completo: (offset, longitud) desde el inicio del registro 0.
        const fnOff = r0.readUInt32BE(84);
        const fnLen = r0.readUInt32BE(88);
        if (fnOff && fnLen && fnOff + fnLen <= r0.length) titulo = decodificar(r0.subarray(fnOff, fnOff + fnLen), encoding);

        // --- EXTH (presente si el bit 6 de las flags en 0x80 está activo) ---
        const exthFlags = r0.length >= 132 ? r0.readUInt32BE(128) : 0;
        let coverOffset = -1;
        if (exthFlags & 0x40) {
            const exthStart = 16 + mobiLen;
            if (r0.length >= exthStart + 12 && r0.toString('ascii', exthStart, exthStart + 4) === 'EXTH') {
                const nRec = r0.readUInt32BE(exthStart + 8);
                let p = exthStart + 12;
                for (let i = 0; i < nRec && p + 8 <= r0.length; i++) {
                    const tipo = r0.readUInt32BE(p);
                    const len = r0.readUInt32BE(p + 4);
                    if (len < 8 || p + len > r0.length) break;
                    const val = r0.subarray(p + 8, p + len);
                    if (tipo === 100) { const a = decodificar(val, encoding); if (a) autores.push(a); }        // author
                    else if (tipo === 101 && !editorial) editorial = decodificar(val, encoding);              // publisher
                    else if (tipo === 104 && !isbn) isbn = decodificar(val, encoding).replace(/[^0-9Xx]/g, ''); // isbn
                    else if (tipo === 503 && !titulo) titulo = decodificar(val, encoding);                    // updated title
                    else if (tipo === 201 && val.length === 4) coverOffset = val.readUInt32BE(0);             // cover offset
                    p += len;
                }
            }
        }

        // --- Portada (best-effort): registro (primera-imagen + coverOffset), validado por firma ---
        if (coverOffset >= 0 && coverOffset < 0xFFFFFFFF) {
            let primeraImagen = -1;
            for (let i = 1; i < numRegistros; i++) {
                if (magiaImagen(registro(i))) { primeraImagen = i; break; }
            }
            if (primeraImagen >= 0) {
                const idx = primeraImagen + coverOffset;
                if (idx > 0 && idx < numRegistros) {
                    const rr = registro(idx);
                    const ext = magiaImagen(rr);
                    if (ext) portada = { buf: Buffer.from(rr), ext };
                }
            }
        }
    } else {
        // Sin cabecera MOBI reconocible: el nombre PalmDB (32 bytes) sirve de título tentativo.
        titulo = decodificar(data.subarray(0, 32), 1252);
    }

    autores = [...new Set(autores.map((a) => a.trim()).filter(Boolean))];
    return { drm: false, titulo: titulo || '', autores, editorial: editorial || '', isbn: isbn || '', portada };
}

/**
 * Enumera TODAS las imágenes EMBEBIDAS de un MOBI/AZW/AZW3 (portada + figuras): recorre los registros PalmDB
 * y devuelve los que empiezan por una firma de imagen (JPEG/PNG/GIF). Para el «Extraer del documento» del
 * panel (mobi es texto reflowable: no hay «páginas», pero sí imágenes embebidas). No lanza por contenido
 * corrupto. `drm:true` ⇒ cifrado (no legible).
 * @returns {{ drm:boolean, total:number, imagenes:{buf:Buffer, ext:string}[] }}
 */
export async function leerImagenesMobi(ruta, { max = 60, minBytes = 256 } = {}) {
    const data = await fs.readFile(ruta);
    const vacio = { drm: false, total: 0, imagenes: [] };
    if (data.length < 78) return vacio;
    const numRegistros = data.readUInt16BE(76);
    if (!numRegistros || 78 + numRegistros * 8 > data.length) return vacio;
    const offsets = [];
    for (let i = 0; i < numRegistros; i++) offsets.push(data.readUInt32BE(78 + i * 8));
    offsets.push(data.length);
    const registro = (i) => data.subarray(offsets[i], offsets[i + 1]);
    const r0 = registro(0);
    if (r0.length >= 16 && r0.readUInt16BE(12) !== 0) return { drm: true, total: 0, imagenes: [] }; // cifrado

    const imagenes = [];
    for (let i = 1; i < numRegistros && imagenes.length < max; i++) {
        const rr = registro(i);
        if (rr.length < minBytes) continue;             // descarta restos minúsculos (íconos 1×1, basura)
        const ext = magiaImagen(rr);
        if (ext) imagenes.push({ buf: Buffer.from(rr), ext });
    }
    return { drm: false, total: imagenes.length, imagenes };
}

// Descompresión PalmDOC (LZ77) de un registro de texto MOBI. Con guardas para no salirse de rango si el
// registro está corrupto (nunca lanza).
function descomprimirPalmDoc(buf) {
    const out = [];
    let i = 0;
    while (i < buf.length) {
        const c = buf[i++];
        if (c === 0) out.push(0);
        else if (c <= 8) { for (let j = 0; j < c && i < buf.length; j++) out.push(buf[i++]); } // literales
        else if (c <= 0x7f) out.push(c);                                                        // ASCII directo
        else if (c <= 0xbf) {                                                                   // back-reference
            if (i >= buf.length) break;
            const c2 = buf[i++];
            const dist = (((c << 8) | c2) >> 3) & 0x7ff;
            const len = (c2 & 7) + 3;
            const start = out.length - dist;
            if (start < 0 || dist === 0) break;
            for (let j = 0; j < len; j++) out.push(out[start + j] ?? 32);
        } else { out.push(32); out.push(c ^ 0x80); }                                            // espacio + carácter
    }
    return Buffer.from(out);
}

/**
 * HTML (best-effort) del comienzo de un MOBI/AZW/AZW3, para RASTERIZAR una «página» conservando la
 * ESTRUCTURA (encabezados, negrita/cursiva, párrafos) — el navegador lo pinta con foreignObject. Descomprime
 * los registros de texto (PalmDOC / sin comprimir), retira lo no renderizable (script/style/head/img externas)
 * y conserva las etiquetas de estructura. `noSoportado:true` si la compresión es HUFF/CDIC (no trivial) o KF8.
 * `drm:true` ⇒ cifrado.
 * @returns {{ drm:boolean, html:string, noSoportado?:boolean }}
 */
export async function leerTextoMobi(ruta, { maxChars = 4000 } = {}) {
    const data = await fs.readFile(ruta);
    const nada = { drm: false, html: '' };
    if (data.length < 78) return nada;
    const numRegistros = data.readUInt16BE(76);
    if (!numRegistros || 78 + numRegistros * 8 > data.length) return nada;
    const offsets = [];
    for (let i = 0; i < numRegistros; i++) offsets.push(data.readUInt32BE(78 + i * 8));
    offsets.push(data.length);
    const registro = (i) => data.subarray(offsets[i], offsets[i + 1]);
    const r0 = registro(0);
    if (r0.length < 16) return nada;
    if (r0.readUInt16BE(12) !== 0) return { drm: true, html: '' };      // cifrado
    const compresion = r0.readUInt16BE(0);                              // 1=ninguna, 2=PalmDOC, 17480=HUFF/CDIC
    const numRegTexto = r0.readUInt16BE(8);
    if (compresion !== 1 && compresion !== 2) return { drm: false, html: '', noSoportado: true };
    const encoding = (r0.length >= 32 && r0.toString('ascii', 16, 20) === 'MOBI') ? r0.readUInt32BE(28) : 1252;

    const bufs = [];
    let bytes = 0;
    for (let i = 1; i <= Math.min(numRegTexto, numRegistros - 1) && bytes < maxChars * 4; i++) {
        const rr = compresion === 2 ? descomprimirPalmDoc(registro(i)) : Buffer.from(registro(i));
        bufs.push(rr); bytes += rr.length;
    }
    const raw = Buffer.concat(bufs).toString(encoding === 65001 ? 'utf8' : 'latin1');
    // Conserva la estructura (h1-6/p/b/i/…); quita lo no renderizable y las imágenes (referencian recindex://).
    let html = raw
        .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<\/?(html|body|meta|link|base|title)[^>]*>/gi, ' ')
        .replace(/<img[^>]*>/gi, '')
        .replace(/<\/?mbp:[^>]*>/gi, ' ')
        .replace(/<a\b[^>]*>/gi, '<span>').replace(/<\/a>/gi, '</span>') // enlaces → texto (no navegan en una imagen)
        .trim();
    // Recorta a ~maxChars sin cortar en medio de una etiqueta (el DOMParser del cliente cerrará lo que quede).
    if (html.length > maxChars) {
        const g = html.indexOf('>', maxChars);
        html = html.slice(0, g > 0 && g - maxChars < 300 ? g + 1 : maxChars);
    }
    return { drm: false, html };
}
