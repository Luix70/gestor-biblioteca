/**
 * COMICS A CBZ — para una carpeta dada, recorre sus SUBCARPETAS y allí donde encuentra una con MUCHAS imágenes
 * sueltas (> N, por defecto 10) crea un .cbz (zip STORE, sin recomprimir) con todas ellas, LO NOMBRA como la
 * subcarpeta, lo promueve a la carpeta principal y ELIMINA la subcarpeta de imágenes sueltas.
 *
 * SEGURIDAD (máxima del proyecto: no perder información):
 *   · El cbz se VERIFICA byte a byte (se reabre y se compara cada página con su original) ANTES de borrar nada.
 *     Si la verificación falla, NO se borra el origen y se avisa.
 *   · Solo se borra la subcarpeta si contiene ÚNICAMENTE imágenes (+ basura de sistema: Thumbs.db, .DS_Store…).
 *     Si tiene CUALQUIER otro contenido (ficheros no-imagen o subcarpetas), el cbz se crea igual pero la carpeta
 *     se CONSERVA y se avisa (revísala tú). Así nunca se pierde nada que no esté ya, idéntico, dentro del cbz.
 *   · DRY-RUN por defecto: enseña el plan sin tocar nada. Añade --ejecutar para hacerlo.
 *
 * Recorre en profundidad: una subcarpeta con > N imágenes se trata como un cómic (se empaqueta; no se entra en
 * sus subcarpetas). Las subcarpetas con ≤ N imágenes se siguen explorando hacia dentro. Todos los cbz van a la
 * CARPETA PRINCIPAL (la dada); ante un choque de nombre se añade « (2)», « (3)»… para no pisar ninguno.
 *
 * FORMATO: por defecto .cbz (zip). Con --pdf crea un .pdf en su lugar, EMBEBIENDO cada imagen SIN recomprimir
 * (embedJpg guarda el JPEG tal cual; embedPng es lossless) → la CALIDAD del escaneo se conserva EXACTA, sin OCR
 * (el PDF es solo un contenedor de las imágenes, como el cbz). En modo --pdf, una carpeta con imágenes que NO
 * sean JPG/PNG (webp, gif…) no se puede embeber sin recomprimir: se OMITE y se conserva (para esas, usa cbz).
 *
 * Uso:
 * VELOCIDAD: --concurrencia=N procesa N carpetas A LA VEZ (aprovecha los núcleos de la CPU; en el Atom del NAS
 * déjalo en 1, en un PC potente 4-8). --sin-verificar salta la comprobación byte a byte (deja solo el chequeo de
 * nº de páginas/entradas) → menos I/O; un pelín menos paranoico antes de borrar. Correr en un PC (o disco local)
 * es MUCHO más rápido que en el Atom del NAS.
 *
 *   node scripts/comics-a-cbz.js "<carpeta>"                 (DRY-RUN: solo informa; formato cbz)
 *   node scripts/comics-a-cbz.js "<carpeta>" --ejecutar      (crea los cbz y borra las carpetas puras)
 *   node scripts/comics-a-cbz.js "<carpeta>" --pdf --ejecutar        (crea .pdf en vez de .cbz)
 *   node scripts/comics-a-cbz.js "<carpeta>" --pdf --concurrencia=6 --sin-verificar --ejecutar   (rápido)
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { esImagenArchivo } from '../src/utils/criba-material.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const PDF = args.includes('--pdf');
const FORMATO = PDF ? 'pdf' : 'cbz';
const VERIFICAR = !args.includes('--sin-verificar'); // por defecto se verifica byte a byte antes de borrar
const CONCURRENCIA = Math.max(1, parseInt((args.find((a) => a.startsWith('--concurrencia=')) || '').split('=')[1] || '1', 10) || 1);
const MIN = Math.max(1, parseInt((args.find((a) => a.startsWith('--min=')) || '').split('=')[1] || '10', 10) || 10);
const RAIZ = args.find((a) => !a.startsWith('--'));
if (!RAIZ) {
    console.error('Uso: node scripts/comics-a-cbz.js "<carpeta>" [--min=10] [--pdf] [--concurrencia=N] [--sin-verificar] [--ejecutar]');
    process.exit(1);
}
// Solo JPG/PNG se pueden meter en un PDF SIN recomprimir (conservando calidad). Los demás formatos → solo cbz.
const embebiblePdf = (n) => /\.(jpe?g|png)$/i.test(n);

// Basura de sistema que NO cuenta como «contenido» (se puede borrar con la carpeta sin perder nada real).
const esBasura = (n) => /^(thumbs\.db|desktop\.ini|\.ds_store|\.directory)$/i.test(n) || n.startsWith('.');
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
// Orden NATURAL (1,2,…,10,11 — no 1,10,11,2), para que las páginas del cómic queden en orden.
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
// Nombre de fichero válido en Windows+Linux (sin caracteres prohibidos ni punto/espacio final).
const sanear = (n) => n.replace(/[/\\:*?"<>|]/g, '_').replace(/[ .]+$/, '').trim() || 'comic';
const existe = (p) => fs.access(p).then(() => true, () => false);

/**
 * Recorre `raiz` y devuelve las SUBCARPETAS que son cómics (> MIN imágenes directas). No entra en las que ya son
 * cómic. Cada candidato: { dir, imagenes:[nombres ordenados], puro:bool } (puro = solo imágenes + basura).
 */
async function buscarCandidatos(raiz) {
    const out = [];
    const rec = async (d) => {
        let ents;
        try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        const imagenes = ents.filter((e) => e.isFile() && esImagenArchivo(e.name) && !esBasura(e.name)).map((e) => e.name);
        if (imagenes.length > MIN) {
            // EXTRAS = lo que NO es imagen ni basura (subcarpetas y ficheros varios). Si hay extras, la carpeta se
            // CONSERVA (no se borra) y se listan para que sepas QUÉ la retiene. Puro = sin extras → se podrá borrar.
            const extras = ents
                .filter((e) => e.isDirectory() || (e.isFile() && !esImagenArchivo(e.name) && !esBasura(e.name)))
                .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
            const pdfApto = imagenes.every(embebiblePdf); // ¿todas JPG/PNG? (para poder hacer PDF sin recomprimir)
            out.push({ dir: d, imagenes: imagenes.sort(natural), puro: extras.length === 0, extras, pdfApto });
            return; // es un cómic → no se entra en sus subcarpetas
        }
        for (const e of ents) if (e.isDirectory()) await rec(path.join(d, e.name));
    };
    // Se EXAMINAN LAS SUBCARPETAS de la raíz (la raíz es la carpeta principal, destino de los cbz — no se empaqueta).
    let raizEnts;
    try { raizEnts = await fs.readdir(raiz, { withFileTypes: true }); }
    catch (e) { console.error(`No se puede leer «${raiz}»: ${e.message}`); process.exit(1); }
    for (const e of raizEnts) if (e.isDirectory()) await rec(path.join(raiz, e.name));
    return out;
}

/** Escribe un .cbz (STORE) con las imágenes y lo VERIFICA byte a byte. { ok, paginas } | { ok:false, motivo }. */
async function escribirCbzVerificado(dir, imagenes, destino, verificar = true) {
    const zip = new AdmZip();
    const firmas = verificar ? new Map() : null;
    for (const nombre of imagenes) {
        let buf;
        try { buf = await fs.readFile(path.join(dir, nombre)); } catch { return { ok: false, motivo: `no se pudo leer «${nombre}»` }; }
        zip.addFile(nombre, buf);
        if (verificar) firmas.set(nombre, sha(buf));
    }
    zip.getEntries().forEach((e) => { e.header.method = 0; }); // 0 = STORED: un JPG ya está comprimido; sin quemar CPU
    zip.writeZip(destino);
    let leido;
    try { leido = new AdmZip(destino); } catch (e) { return { ok: false, motivo: `el cbz no abre: ${e.message}` }; }
    const ents = leido.getEntries();
    if (ents.length !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${ents.length}/${imagenes.length}` };
    if (verificar) for (const e of ents) if (firmas.get(e.entryName) !== sha(e.getData())) return { ok: false, motivo: `«${e.entryName}» no coincide byte a byte` };
    return { ok: true, paginas: ents.length };
}

// Escribe un .pdf EMBEBIENDO cada imagen SIN recomprimir (una página por imagen, a su tamaño en píxeles) y lo
// VERIFICA (se reabre y se cuentan las páginas). embedJpg guarda el JPEG original tal cual (lossless) y embedPng
// es lossless → la calidad del escaneo se conserva. pdf-lib se importa DINÁMICAMENTE: el modo cbz no lo necesita
// y, si falta (contenedor sin reconstruir), se avisa en claro. Solo JPG/PNG (los demás no se embeben sin recomprimir).
let _PDFDocument = null;
async function cargarPdfLib() {
    if (_PDFDocument) return _PDFDocument;
    try { ({ PDFDocument: _PDFDocument } = await import('pdf-lib')); }
    catch { console.error('\n⛔ Falta la dependencia «pdf-lib». Instálala (o reconstruye la imagen):\n   sudo docker exec gestor-biblioteca npm install pdf-lib\n'); process.exit(1); }
    return _PDFDocument;
}
async function escribirPdfVerificado(dir, imagenes, destino, verificar = true) {
    const PDFDocument = await cargarPdfLib();
    const doc = await PDFDocument.create();
    for (const nombre of imagenes) {
        if (!embebiblePdf(nombre)) return { ok: false, motivo: `«${nombre}» no es JPG/PNG (no se embebe sin recomprimir; usa cbz)` };
        let buf;
        try { buf = await fs.readFile(path.join(dir, nombre)); } catch { return { ok: false, motivo: `no se pudo leer «${nombre}»` }; }
        let img;
        try { img = /\.png$/i.test(nombre) ? await doc.embedPng(buf) : await doc.embedJpg(buf); }
        catch (e) { return { ok: false, motivo: `no se pudo embeber «${nombre}»: ${e.message}` }; }
        const pagina = doc.addPage([img.width, img.height]);   // página al TAMAÑO de la imagen (sin escalar)
        pagina.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const bytes = await doc.save();
    await fs.writeFile(destino, bytes);
    if (!verificar) return { ok: true, paginas: doc.getPageCount() };
    let re;
    try { re = await PDFDocument.load(bytes); } catch (e) { return { ok: false, motivo: `el pdf no abre: ${e.message}` }; }
    if (re.getPageCount() !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${re.getPageCount()}/${imagenes.length}` };
    return { ok: true, paginas: re.getPageCount() };
}

// Lee los datos de un PNG SIN decodificar los píxeles: cabecera (IHDR) + los bloques IDAT concatenados (el flujo
// zlib con el filtrado PNG) + la paleta (PLTE). Devuelve null si no es un PNG. Permite EMBEBER el PNG en el PDF
// tal cual (FlateDecode + predictor PNG 15), sin decodificarlo → lossless y sin gastar memoria en píxeles crudos.
function leerPng(buf) {
    const firma = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (buf.length < 8 || !firma.every((b, i) => buf[i] === b)) return null;
    let o = 8, ihdr = null, palette = null; const idat = [];
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o);
        const tipo = buf.toString('latin1', o + 4, o + 8);
        const data = buf.subarray(o + 8, o + 8 + len);
        if (tipo === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), bitDepth: data[8], colorType: data[9], interlace: data[12] };
        else if (tipo === 'PLTE') palette = Buffer.from(data);
        else if (tipo === 'IDAT') idat.push(Buffer.from(data));
        else if (tipo === 'IEND') break;
        o += 12 + len; // 4 (long) + 4 (tipo) + len (datos) + 4 (crc)
    }
    if (!ihdr || !idat.length) return null;
    return { ...ihdr, idat: Buffer.concat(idat), palette };
}

// Ancho/alto/nº de componentes de un JPEG (del marcador SOF). Sin dependencias. null si no es un JPEG legible.
function dimensionesJpeg(buf) {
    if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // SOI
    let o = 2;
    while (o + 9 < buf.length) {
        if (buf[o] !== 0xFF) { o++; continue; }        // resincroniza ante bytes de relleno
        const m = buf[o + 1];
        if (m === 0xD8 || m === 0xD9 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { o += 2; continue; } // sin longitud
        const len = buf.readUInt16BE(o + 2);
        // SOF0..SOF15 (baseline/progressive/…) salvo DHT(C4), JPG(C8), DAC(CC): traen alto/ancho/componentes.
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
            return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7), comp: buf[o + 9] };
        }
        o += 2 + len;
    }
    return null;
}

// Prepara el objeto imagen PDF de UN fichero (JPEG o PNG) SIN decodificar los píxeles → memoria mínima, lossless:
//   · JPEG → /DCTDecode con los bytes del JPEG tal cual (calidad exacta). 1 comp→gris, 3→RGB (CMYK → fallback).
//   · PNG  → /FlateDecode + predictor PNG 15 con los IDAT tal cual (el PDF deshace el filtrado). Gris(0)/RGB(2)/
//            paleta(3); entrelazado o con alfa (4/6) → fallback a pdf-lib.
// Devuelve { w, h, dict, datos } (datos = bytes a escribir en el stream) o { fallback, motivo }.
function objetoImagen(buf, nombre) {
    if (/\.png$/i.test(nombre)) {
        const p = leerPng(buf);
        if (!p) return { fallback: true, motivo: `«${nombre}» PNG no legible` };
        if (p.interlace !== 0) return { fallback: true, motivo: `«${nombre}» PNG entrelazado` };
        let colors, cs;
        if (p.colorType === 0) { colors = 1; cs = '/DeviceGray'; }
        else if (p.colorType === 2) { colors = 3; cs = '/DeviceRGB'; }
        else if (p.colorType === 3 && p.palette) { colors = 1; cs = `[ /Indexed /DeviceRGB ${p.palette.length / 3 - 1} < ${p.palette.toString('hex')} > ]`; }
        else return { fallback: true, motivo: `«${nombre}» PNG colorType ${p.colorType} (alfa/paleta sin PLTE)` };
        const dict = `/Width ${p.w} /Height ${p.h} /ColorSpace ${cs} /BitsPerComponent ${p.bitDepth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${p.bitDepth} /Columns ${p.w} >> /Length ${p.idat.length}`;
        return { w: p.w, h: p.h, dict, datos: p.idat };
    }
    const d = dimensionesJpeg(buf);
    if (!d) return { fallback: true, motivo: `«${nombre}» no es un JPEG legible` };
    if (d.comp !== 1 && d.comp !== 3) return { fallback: true, motivo: `«${nombre}» JPEG de ${d.comp} componentes (CMYK)` };
    const cs = d.comp === 1 ? '/DeviceGray' : '/DeviceRGB';
    const dict = `/Width ${d.w} /Height ${d.h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${buf.length}`;
    return { w: d.w, h: d.h, dict, datos: buf };
}

/**
 * Escribe un .pdf EN STREAMING embebiendo cada imagen (JPEG o PNG) SIN recomprimir → calidad EXACTA, sin OCR, y
 * UNA imagen en memoria a la vez → soporta libros escaneados enormes sin agotar la RAM (a diferencia de pdf-lib,
 * que decodifica y acumula todo: «Array buffer allocation failed»). Verifica byte a byte releyendo cada imagen
 * del fichero. Un formato/variante no soportado (JPEG CMYK, PNG con alfa o entrelazado) → { fallback:true } (pdf-lib).
 */
async function escribirPdfStream(dir, imagenes, destino, verificar = true) {
    const N = imagenes.length;
    const offsets = {};                 // nº de objeto → offset en bytes (para la tabla xref)
    const imgs = [];                    // { offset, len, sha, nombre } de cada imagen embebida (solo si se verifica)
    const fh = await fs.open(destino, 'w');
    let pos = 0;
    const wr = async (data) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'latin1'); await fh.write(b); pos += b.length; };
    try {
        await wr('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
        offsets[1] = pos; await wr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        offsets[2] = pos;
        const kids = Array.from({ length: N }, (_, i) => `${5 + 3 * i} 0 R`).join(' ');
        await wr(`2 0 obj\n<< /Type /Pages /Kids [ ${kids} ] /Count ${N} >>\nendobj\n`);
        for (let i = 0; i < N; i++) {
            const nombre = imagenes[i];
            const buf = await fs.readFile(path.join(dir, nombre));
            const im = objetoImagen(buf, nombre);
            if (im.fallback) { await fh.close(); await fs.rm(destino, { force: true }); return { ok: false, motivo: im.motivo, fallback: true }; }
            const imgN = 3 + 3 * i, conN = 4 + 3 * i, pagN = 5 + 3 * i;
            offsets[imgN] = pos;
            await wr(`${imgN} 0 obj\n<< /Type /XObject /Subtype /Image ${im.dict} >>\nstream\n`);
            if (verificar) imgs.push({ offset: pos, len: im.datos.length, sha: sha(im.datos), nombre });
            await wr(im.datos);
            await wr('\nendstream\nendobj\n');
            const contenido = `q\n${im.w} 0 0 ${im.h} 0 0 cm\n/Im Do\nQ\n`;
            offsets[conN] = pos;
            await wr(`${conN} 0 obj\n<< /Length ${contenido.length} >>\nstream\n${contenido}endstream\nendobj\n`);
            offsets[pagN] = pos;
            await wr(`${pagN} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${im.w} ${im.h}] /Resources << /XObject << /Im ${imgN} 0 R >> >> /Contents ${conN} 0 R >>\nendobj\n`);
        }
        const size = 3 + 3 * N;                 // mayor nº de objeto + 1
        const xref = pos;
        let tabla = `xref\n0 ${size}\n0000000000 65535 f \n`;
        for (let n = 1; n < size; n++) tabla += String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n';
        await wr(tabla);
        await wr(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    } catch (e) { await fh.close().catch(() => {}); return { ok: false, motivo: `error al escribir: ${e.message}` }; }
    await fh.close();
    // VERIFICACIÓN byte a byte (salvo --sin-verificar): se relee la región de cada imagen en el fichero (una a
    // una → sin OOM) y se compara. Sin verificar, se confía en la escritura (nº de páginas garantizado por construcción).
    if (verificar) {
        const rfh = await fs.open(destino, 'r');
        try {
            for (const f of imgs) {
                const buf = Buffer.alloc(f.len);
                await rfh.read(buf, 0, f.len, f.offset);
                if (sha(buf) !== f.sha) return { ok: false, motivo: `«${f.nombre}» no coincide byte a byte en el pdf` };
            }
        } finally { await rfh.close(); }
    }
    return { ok: true, paginas: N };
}

/**
 * ¿El fichero destino YA existe y CORRESPONDE a esta carpeta? (reanudación tras una interrupción). cbz: mismas
 * páginas exactas (mismos nombres). pdf: mismo nº de páginas. Si coincide, la corrida anterior ya lo empaquetó
 * (se cortó antes de borrar la carpeta) → no hay que rehacerlo. Un fichero parcial/corrupto o de OTRO cómic con
 * el mismo nombre NO coincide → se tratará aparte (sufijo). Nunca borra nada: solo informa.
 */
async function yaEmpaquetado(destino, c) {
    if (!(await existe(destino))) return false;
    try {
        if (PDF) {
            // Cuenta páginas por los objetos «/Type /Page» (no «/Pages») — sin pdf-lib, sirve tanto para los PDF
            // en streaming como para los de pdf-lib. Un PDF de otro cómic con el mismo nombre tendrá otro nº.
            const txt = (await fs.readFile(destino)).toString('latin1');
            const paginas = (txt.match(/\/Type\s*\/Page(?![s])/g) || []).length;
            return paginas === c.imagenes.length;
        }
        const nombres = new Set(new AdmZip(destino).getEntries().map((e) => e.entryName));
        return nombres.size === c.imagenes.length && c.imagenes.every((n) => nombres.has(n));
    } catch { return false; } // corrupto/parcial → no cuenta como ya empaquetado
}

// Pool de concurrencia: procesa `items` con hasta `n` en vuelo a la vez, llamando a fn(item). JS es de un solo
// hilo (async), así que los contadores compartidos se incrementan sin condiciones de carrera entre awaits.
async function enParalelo(items, n, fn) {
    let i = 0;
    const worker = async () => { while (i < items.length) { const j = i++; await fn(items[j]); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
}

async function main() {
    const raiz = path.resolve(RAIZ);
    console.log(`\nCómics a ${FORMATO.toUpperCase()}  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]  · carpeta: ${raiz}  · umbral: > ${MIN} imágenes` +
        (PDF ? '  · PDF sin recomprimir (calidad intacta, sin OCR)' : '') +
        (CONCURRENCIA > 1 ? `  · concurrencia: ${CONCURRENCIA}` : '') + (!VERIFICAR ? '  · SIN verificación byte a byte' : ''));
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se crea ni se borra nada.\n'); else console.log('');

    process.stdout.write('Explorando el árbol… ');
    const candidatos = await buscarCandidatos(raiz);
    process.stdout.write('hecho.\n');
    if (!candidatos.length) { console.log('No hay subcarpetas con más de ' + MIN + ' imágenes. Nada que hacer.'); process.exit(0); }
    console.log(`Subcarpetas de cómic encontradas: ${candidatos.length}\n`);

    // Motivo por el que una carpeta se CONSERVA (no se borra): sus «extras» (subcarpetas y ficheros no-imagen).
    const porQueConserva = (c) => `contiene: ${c.extras.slice(0, 5).join(', ')}${c.extras.length > 5 ? `… (+${c.extras.length - 5})` : ''}`;

    // ── PRE-PASE (SECUENCIAL): decide la ACCIÓN y RESERVA un destino ÚNICO para cada carpeta. Se hace aquí, antes
    // de la fase concurrente, para que dos carpetas del mismo nombre no compitan por el mismo fichero (carrera). ──
    const reservados = new Set(); // rutas destino ya reservadas (en minúsculas) → nombres únicos con concurrencia
    const acciones = [];
    for (const c of candidatos) {
        const nombre = path.basename(c.dir);
        const rel = path.relative(raiz, c.dir) || nombre;
        if (PDF && !c.pdfApto) { acciones.push({ c, rel, tipo: 'omitir' }); continue; }
        const base = path.join(raiz, `${sanear(nombre)}.${FORMATO}`);
        // REANUDAR: el fichero base ya existe y corresponde a esta carpeta (corrida anterior interrumpida antes de
        // borrar). Solo el PRIMERO con ese nombre lo reclama (evita doble-reanudar de dos carpetas homónimas).
        if (!reservados.has(base.toLowerCase()) && (await yaEmpaquetado(base, c))) {
            reservados.add(base.toLowerCase());
            acciones.push({ c, rel, tipo: 'reanudar', destino: base });
            continue;
        }
        // Destino libre: base o sufijo « (n)», evitando el disco Y lo ya reservado en este pre-pase.
        let destino = base, n = 2;
        while (reservados.has(destino.toLowerCase()) || (await existe(destino))) destino = path.join(raiz, `${sanear(nombre)} (${n++}).${FORMATO}`);
        reservados.add(destino.toLowerCase());
        acciones.push({ c, rel, tipo: 'empaquetar', destino });
    }

    // ── DRY-RUN: imprime el plan ──
    if (!EJECUTAR) {
        acciones.forEach((a, i) => {
            const marca = `[${i + 1}/${acciones.length}]`;
            if (a.tipo === 'omitir') console.log(`${marca} «${a.rel}» (${a.c.imagenes.length} img) · ⚠ OMITIDA en --pdf (imágenes que no son JPG/PNG; usa cbz)`);
            else if (a.tipo === 'reanudar') console.log(`${marca} «${a.rel}» · ↩ YA empaquetada en ${path.basename(a.destino)} — se ${a.c.puro ? 'borraría la carpeta' : 'CONSERVARÍA (' + porQueConserva(a.c) + ')'}`);
            else console.log(`${marca} «${a.rel}» (${a.c.imagenes.length} img) → ${path.basename(a.destino)}` + (a.c.puro ? '  · se borrará la carpeta' : `  · ⚠ carpeta CONSERVADA (${porQueConserva(a.c)})`));
        });
        const emp = acciones.filter((a) => a.tipo === 'empaquetar');
        console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
        console.log(`  A empaquetar (${FORMATO}): ${emp.length}  (borrarían carpeta: ${emp.filter((a) => a.c.puro).length}, conservarían: ${emp.filter((a) => !a.c.puro).length}) · reanudar: ${acciones.filter((a) => a.tipo === 'reanudar').length}` +
            (acciones.some((a) => a.tipo === 'omitir') ? ` · omitidas (no JPG/PNG): ${acciones.filter((a) => a.tipo === 'omitir').length}` : ''));
        console.log('  (simulación) Nada tocado. Re-ejecuta con --ejecutar.');
        process.exit(0);
    }

    // ── EJECUTAR (con concurrencia) ──
    let creados = 0, borradas = 0, conservadas = 0, fallidos = 0, omitidas = 0, reanudados = 0, hechos = 0;
    const total = acciones.length;
    // BORRADO SEGURO: el fichero está verificado (o al menos con el nº de páginas correcto). Solo se borra la
    // carpeta si es PURA (imágenes + basura); si tiene extras, se CONSERVA y se dice QUÉ la retiene. Devuelve la línea.
    const terminar = async (c, rel, destino, paginas, verbo) => {
        if (c.puro) { await fs.rm(c.dir, { recursive: true, force: true }); borradas++; return `${verbo} ${path.basename(destino)} (${paginas} pág) · carpeta «${rel}» borrada`; }
        conservadas++;
        return `${verbo} ${path.basename(destino)} (${paginas} pág) · ⚠ carpeta «${rel}» CONSERVADA (${porQueConserva(c)})`;
    };
    const procesar = async (a) => {
        const { c, rel, destino, tipo } = a;
        let linea;
        if (tipo === 'omitir') { omitidas++; linea = `⚠ «${rel}» OMITIDA en --pdf (imágenes no JPG/PNG) — usa cbz`; }
        else if (tipo === 'reanudar') { reanudados++; linea = await terminar(c, rel, destino, c.imagenes.length, '↩'); }
        else {
            // PDF: escritor en STREAMING (JPEG y PNG, sin OOM ni pdf-lib). Solo una variante rara (JPEG CMYK, PNG
            // con alfa/entrelazado) cae a pdf-lib (en memoria; poco frecuente y pequeño). CBZ: adm-zip.
            let r;
            if (!PDF) r = await escribirCbzVerificado(c.dir, c.imagenes, destino, VERIFICAR);
            else {
                r = await escribirPdfStream(c.dir, c.imagenes, destino, VERIFICAR);
                if (!r.ok && r.fallback) r = await escribirPdfVerificado(c.dir, c.imagenes, destino, VERIFICAR);
            }
            if (!r.ok) { fallidos++; linea = `✖ «${rel}»: ${r.motivo} — NO se toca la carpeta`; }
            else { creados++; linea = await terminar(c, rel, destino, r.paginas, '✔'); }
        }
        console.log(`[${++hechos}/${total}] ${linea}`);
    };
    await enParalelo(acciones, CONCURRENCIA, procesar);

    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    console.log(`  ${FORMATO.toUpperCase()} creados: ${creados} · carpetas borradas: ${borradas} · conservadas: ${conservadas} · fallidos: ${fallidos}` +
        (reanudados ? ` · reanudados: ${reanudados}` : '') + (omitidas ? ` · omitidas (no JPG/PNG): ${omitidas}` : ''));
    if (conservadas) console.log('  ⚠ Carpetas CONSERVADAS: revisa su contenido no-imagen (arriba se lista qué tiene cada una); el fichero ya se creó.');
    process.exit(0);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
