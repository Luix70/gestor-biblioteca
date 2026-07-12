// ── RECUPERAR EL TÍTULO ORIGINAL (obras traducidas) ─────────────────────────────────────────────────────
// Backfill SIN IA para lo ya catalogado: abre el EPUB/PDF, lee la PÁGINA DE CRÉDITOS/copyright y extrae el
// «Título original:» (y, en antologías de relatos traducidos, TODOS los que aparezcan → titulos_originales).
// Es gratis y determinista: la etiqueta «Título original» solo figura en traducciones, así que el propio
// texto restringe a los libros que procede.  Complementa la captura en la ingesta (plantilla de visión) y en
// el Conformador; aquí recuperamos lo que ya estaba en disco.
//
// Debe correr donde estén los FICHEROS (el NAS, o local con el árbol CDU montado); los que no encuentre el
// fichero se saltan y se cuentan.
//
// DRY-RUN por defecto (no escribe): lista qué título original se pondría a cada libro.
//   node scripts/recuperar-titulo-original.js                 (informe)
//   node scripts/recuperar-titulo-original.js --limite 50     (informe, primeros N libros con fichero)
//   node scripts/recuperar-titulo-original.js --ejecutar       (aplica; BACKUP recomendado)
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { textoPagina } from '../src/utils/lector-pdf.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = parseInt((args[args.indexOf('--limite') + 1] || '0'), 10) || 0;
const PDF_PAGINAS = parseInt((args[args.indexOf('--pdf-paginas') + 1] || '8'), 10) || 8;

// Mojibake típico de EPUBs de la comunidad (Ã© → é). Solo si hay bytes del rango Ã (si no, se deja igual).
const repararMojibake = (s) => {
    if (!s || !/[\xC0-\xC6\xC3]/.test(s)) return s;
    try { const r = Buffer.from(s, 'latin1').toString('utf8'); return r.includes('�') ? s : r; } catch { return s; }
};

// HTML → texto CONSERVANDO SALTOS DE LÍNEA (para poder leer «Título original:» línea a línea).
const htmlAtexto = (html) =>
    String(html || '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote)\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
        .replace(/[ \t ]+/g, ' ');

// Texto de la parte relevante de un EPUB (front-matter: portadilla + créditos). Junta los documentos de
// contenido hasta un tope de tamaño; con eso basta para la etiqueta «Título original».
async function textoEpub(ruta) {
    const zip = new AdmZip(await fs.readFile(ruta));
    const entradas = zip.getEntries().filter((e) => /\.(x?html?|xml)$/i.test(e.entryName) && !/nav|toc|ncx/i.test(e.entryName));
    let out = '';
    for (const e of entradas) {
        out += '\n' + htmlAtexto(e.getData().toString('utf8'));
        if (out.length > 120000) break; // suficiente para créditos; evita cargar el libro entero
    }
    return repararMojibake(out);
}

async function textoPdf(ruta) {
    let out = '';
    for (let n = 1; n <= PDF_PAGINAS; n++) {
        const t = await textoPagina(ruta, n).catch(() => '');
        if (t) out += '\n' + t;
    }
    return out;
}

// Limpia el título original capturado: recorta colas de año / traducción / copyright y comillas de borde.
function limpiarOriginal(s) {
    let t = repararMojibake(String(s || '')).replace(/\s+/g, ' ').trim();
    t = t.replace(/^["'«»“”\-–—:.\s]+/, '').replace(/["'«»“”]+$/, '').trim();
    t = t.split(/\s*[,;([]\s*(?:1[5-9]\d\d|20\d\d)\b/)[0];                              // corta en «, 1843»/«(1843»
    t = t.split(/\b(?:traducci[óo]n|traducido|translated|©|copyright|publicad|first published|originally published)\b/i)[0];
    return t.replace(/[\s,;:.\-–—]+$/, '').trim();
}

// Etiqueta «Título original» en varias lenguas: romance (título/titre/titolo + original[es], mismo orden) e
// inglés («original title», orden inverso). El corpus es mayormente español (ePubLibre), pero no cuesta nada.
const ETIQ = '(?:(?:t[íi]tulos?|titre|titolo)\\s+origina\\w*|original\\s+titles?)';
const RE_ETIQUETA = new RegExp(ETIQ, 'i');
const RE_INLINE = new RegExp(ETIQ + '\\s*[:.]\\s*(.+)', 'i');   // «Título original: X» (X en la misma línea)
const RE_SOLO = new RegExp(ETIQ + '\\s*[:.]?\\s*$', 'i');        // «Título original:» (X en la línea siguiente)

// Extrae 0..N títulos originales del texto de créditos (varios en antologías de relatos traducidos).
function titulosOriginales(texto, tituloDoc) {
    const lineas = String(texto || '').split(/\r?\n/).map((l) => l.trim());
    const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
    const fuera = norm(tituloDoc);
    const out = [];
    const vistos = new Set();
    const anadir = (bruto) => {
        const t = limpiarOriginal(bruto);
        if (!t || t.length < 2 || t.length > 200) return;
        if (norm(t) === fuera) return;                 // idéntico al título → no aporta
        if (!/[a-zA-Z]/.test(t)) return;               // sin letras → ruido
        const k = norm(t);
        if (vistos.has(k)) return;
        vistos.add(k); out.push(t);
    };
    for (let i = 0; i < lineas.length; i++) {
        if (!RE_ETIQUETA.test(lineas[i])) continue;
        const m = lineas[i].match(RE_INLINE);
        if (m) { anadir(m[1]); continue; }
        if (RE_SOLO.test(lineas[i])) {                 // etiqueta sola → el título está en la línea siguiente
            const sig = lineas.slice(i + 1).find((l) => l);
            if (sig) anadir(sig);
        }
    }
    return out;
}

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const cur = bib.find(
        { tipo_recurso: 'libro', titulo_original: { $exists: false }, formatos: { $in: ['epub', 'pdf'] } },
        { projection: { titulo: 1, nombre_archivo: 1, ruta_base: 1, cdu: 1, formatos: 1, isbn: 1, issn: 1, 'año_edicion': 1, mes_publicacion: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1 } },
    );

    let nEscaneados = 0, nSinFichero = 0, nConOriginal = 0, nAplicados = 0, nErrores = 0;
    for await (const doc of cur) {
        if (LIMITE && nEscaneados >= LIMITE) break;
        const carpeta = carpetaDeDoc(doc);
        const ruta = path.join(carpeta, doc.nombre_archivo || '');
        let existe = true;
        try { await fs.access(ruta); } catch { existe = false; }
        if (!doc.nombre_archivo || !existe) { nSinFichero++; continue; }
        nEscaneados++;

        let texto = '';
        try {
            const esEpub = /\.epub$/i.test(doc.nombre_archivo) || (doc.formatos || []).includes('epub');
            texto = esEpub ? await textoEpub(ruta) : await textoPdf(ruta);
        } catch (e) { nErrores++; continue; }

        const originales = titulosOriginales(texto, doc.titulo);
        if (!originales.length) continue;
        nConOriginal++;

        const uno = originales.length === 1;
        const etiqueta = uno ? `«${originales[0]}»` : `[${originales.map((o) => `«${o}»`).join(', ')}]`;
        console.log(`  «${String(doc.titulo || '').slice(0, 60)}»  →  ${etiqueta}`);

        if (EJECUTAR) {
            const set = { titulo_original: originales[0], fecha_actualizacion: new Date() };
            if (!uno) set.titulos_originales = originales;
            await bib.updateOne({ _id: doc._id }, { $set: set });
            nAplicados++;
        }
    }

    console.log(`\nLibros escaneados (con fichero): ${nEscaneados}`);
    console.log(`Sin fichero accesible (saltados): ${nSinFichero}`);
    console.log(`Con título original detectado: ${nConOriginal}${nErrores ? ` · errores de lectura: ${nErrores}` : ''}`);
    if (EJECUTAR) console.log(`Aplicados: ${nAplicados}`);
    else console.log('\n(dry-run) No se ha escrito nada. Relanza con --ejecutar para aplicar. ⚠ Haz BACKUP antes.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
