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
 *   node scripts/comics-a-cbz.js "<carpeta>"                 (DRY-RUN: solo informa; formato cbz)
 *   node scripts/comics-a-cbz.js "<carpeta>" --ejecutar      (crea los cbz y borra las carpetas puras)
 *   node scripts/comics-a-cbz.js "<carpeta>" --pdf --ejecutar        (crea .pdf en vez de .cbz)
 *   node scripts/comics-a-cbz.js "<carpeta>" --min=20 --pdf --ejecutar   (umbral distinto)
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
const MIN = Math.max(1, parseInt((args.find((a) => a.startsWith('--min=')) || '').split('=')[1] || '10', 10) || 10);
const RAIZ = args.find((a) => !a.startsWith('--'));
if (!RAIZ) {
    console.error('Uso: node scripts/comics-a-cbz.js "<carpeta>" [--min=10] [--pdf] [--ejecutar]');
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
            // Puro = ni subcarpetas ni ficheros que no sean imagen/basura → se podrá borrar tras verificar el cbz.
            const puro = !ents.some((e) => e.isDirectory()) &&
                !ents.some((e) => e.isFile() && !esImagenArchivo(e.name) && !esBasura(e.name));
            const pdfApto = imagenes.every(embebiblePdf); // ¿todas JPG/PNG? (para poder hacer PDF sin recomprimir)
            out.push({ dir: d, imagenes: imagenes.sort(natural), puro, pdfApto });
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
async function escribirCbzVerificado(dir, imagenes, destino) {
    const zip = new AdmZip();
    const firmas = new Map();
    for (const nombre of imagenes) {
        let buf;
        try { buf = await fs.readFile(path.join(dir, nombre)); } catch { return { ok: false, motivo: `no se pudo leer «${nombre}»` }; }
        zip.addFile(nombre, buf);
        firmas.set(nombre, sha(buf));
    }
    zip.getEntries().forEach((e) => { e.header.method = 0; }); // 0 = STORED: un JPG ya está comprimido; sin quemar CPU
    zip.writeZip(destino);
    let leido;
    try { leido = new AdmZip(destino); } catch (e) { return { ok: false, motivo: `el cbz no abre: ${e.message}` }; }
    const ents = leido.getEntries();
    if (ents.length !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${ents.length}/${imagenes.length}` };
    for (const e of ents) if (firmas.get(e.entryName) !== sha(e.getData())) return { ok: false, motivo: `«${e.entryName}» no coincide byte a byte` };
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
async function escribirPdfVerificado(dir, imagenes, destino) {
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
    let re;
    try { re = await PDFDocument.load(bytes); } catch (e) { return { ok: false, motivo: `el pdf no abre: ${e.message}` }; }
    if (re.getPageCount() !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${re.getPageCount()}/${imagenes.length}` };
    return { ok: true, paginas: re.getPageCount() };
}

async function main() {
    const raiz = path.resolve(RAIZ);
    console.log(`\nCómics a ${FORMATO.toUpperCase()}  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]  · carpeta: ${raiz}  · umbral: > ${MIN} imágenes` +
        (PDF ? '  · PDF sin recomprimir (calidad intacta, sin OCR)' : ''));
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se crea ni se borra nada.\n'); else console.log('');

    const candidatos = await buscarCandidatos(raiz);
    if (!candidatos.length) { console.log('No hay subcarpetas con más de ' + MIN + ' imágenes. Nada que hacer.'); process.exit(0); }
    console.log(`Subcarpetas de cómic encontradas: ${candidatos.length}\n`);

    let creados = 0, borradas = 0, conservadas = 0, fallidos = 0, omitidas = 0;
    for (let i = 0; i < candidatos.length; i++) {
        const c = candidatos[i];
        const nombre = path.basename(c.dir);
        const rel = path.relative(raiz, c.dir) || nombre;
        const marca = `[${i + 1}/${candidatos.length}]`;
        // En PDF, una carpeta con imágenes NO-JPG/PNG no se puede embeber sin recomprimir → se omite (usa cbz).
        const noAptaPdf = PDF && !c.pdfApto;
        // Destino en la carpeta PRINCIPAL, con el nombre de la subcarpeta y sufijo si ya existe (no pisar ninguno).
        let destino = path.join(raiz, `${sanear(nombre)}.${FORMATO}`);
        for (let n = 2; await existe(destino); n++) destino = path.join(raiz, `${sanear(nombre)} (${n}).${FORMATO}`);

        if (!EJECUTAR) {
            if (noAptaPdf) { console.log(`${marca} «${rel}» (${c.imagenes.length} img) · ⚠ OMITIDA en --pdf (tiene imágenes que no son JPG/PNG; conviértela a cbz)`); continue; }
            console.log(`${marca} «${rel}» (${c.imagenes.length} img) → ${path.basename(destino)}` +
                (c.puro ? '  · se borrará la carpeta' : '  · ⚠ carpeta CONSERVADA (tiene contenido no-imagen/subcarpetas)'));
            continue;
        }

        if (noAptaPdf) { console.log(`${marca} ⚠ «${rel}» OMITIDA en --pdf (imágenes no JPG/PNG) — usa cbz`); omitidas++; continue; }
        const r = PDF ? await escribirPdfVerificado(c.dir, c.imagenes, destino) : await escribirCbzVerificado(c.dir, c.imagenes, destino);
        if (!r.ok) {
            console.error(`${marca} ✖ «${rel}»: ${r.motivo} — NO se toca la carpeta`);
            fallidos++;
            continue;
        }
        creados++;
        // Borrado SEGURO: el fichero ya está VERIFICADO (cbz: byte a byte; pdf: reabre y cuenta las páginas, con
        // las imágenes embebidas SIN recomprimir). Solo se borra si la carpeta es PURA (imágenes + basura); si
        // tiene otro contenido, se conserva para que la revises.
        if (c.puro) {
            await fs.rm(c.dir, { recursive: true, force: true });
            borradas++;
            console.log(`${marca} ✔ ${path.basename(destino)} (${r.paginas} pág) · carpeta «${rel}» borrada`);
        } else {
            conservadas++;
            console.log(`${marca} ✔ ${path.basename(destino)} (${r.paginas} pág) · ⚠ carpeta «${rel}» CONSERVADA (contenido no-imagen)`);
        }
    }

    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    if (!EJECUTAR) {
        const aptas = PDF ? candidatos.filter((c) => c.pdfApto) : candidatos;
        const noPdf = PDF ? candidatos.length - aptas.length : 0;
        console.log(`  A empaquetar (${FORMATO}): ${aptas.length}  (puras que se borrarían: ${aptas.filter((c) => c.puro).length}, conservadas: ${aptas.filter((c) => !c.puro).length})` +
            (noPdf ? `  · omitidas por no ser JPG/PNG: ${noPdf}` : ''));
        console.log('  (simulación) Nada tocado. Re-ejecuta con --ejecutar.');
    } else {
        console.log(`  ${FORMATO.toUpperCase()} creados: ${creados} · carpetas borradas: ${borradas} · conservadas: ${conservadas} · fallidos: ${fallidos}` +
            (omitidas ? ` · omitidas (no JPG/PNG): ${omitidas}` : ''));
    }
    process.exit(0);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
