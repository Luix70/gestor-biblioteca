/**
 * PORTADAS SOSPECHOSAS — qué hacer con los libros cuya portada es un ARTEFACTO (la misma imagen en libros
 * distintos: el banner de un grupo de ripeo, un «cover not available»…). scripts/detectar-portadas-artefacto.js
 * crea una SELECCIÓN por grupo; sobre ella (o sobre un documento desde su ficha) la acción «🖼️ Portada
 * sospechosa…» ofrece tres salidas:
 *
 *   · 'quitar'     — el documento se queda SIN portada. La imagen NO se borra del disco (solo deja de ser la
 *                    portada y sale del carrusel): anti-pérdida.
 *   · 'reextraer'  — otra portada del PROPIO fichero, OMITIENDO la sospechosa: la cubierta embebida si no es la
 *                    sospechosa; en un PDF, la siguiente página con contenido; si el fichero no da otra, la
 *                    portada remota por ISBN.
 *   · 'texto'      — la PRIMERA PÁGINA DE TEXTO: en un PDF, la primera página con capa de texto (portadilla);
 *                    en un EPUB sin cubierta, se COMPONE una página con el texto de su primera página (título,
 *                    autor…) con pdf-lib y se rasteriza con poppler (nada de navegador ni sharp: apto para el Atom).
 *
 * En los tres casos se CONSERVAN las demás imágenes del documento (solo cambia la portada) y se regeneran sus
 * sidecars. Además, si la portada la comparten 2+ documentos del lote, se REGISTRA como artefacto (sha y, si
 * salió de un PDF, la huella de esa página): la ingesta y la re-extracción la saltarán en adelante.
 *
 * Trabajo en 2º plano con progreso y cancelación (mismo patrón que la re-extracción de imágenes).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import { ObjectId } from 'mongodb';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { conectarDB } from '../database.js';
import { DIR_CDU, carpetaDeDoc, webDeDoc, archivoOriginal, escribirImagen } from '../mantenimiento/util-mantenimiento.js';
import { detectarTipo } from '../orquestador.js';
import { rasterizarPaginas, medirTinta } from './rasterizar-pdf.js';
import { rasterizarFrontalesPdf } from './ocr-pdf.js';
import { extraerMetadatosEpub } from './lector-epub.js';
import { leerMobi } from './lector-mobi.js';
import { bufferPortadaPorISBN } from './portadas-isbn.js';
import {
    cargarArtefactos, esImagenArtefacto, esHuellaArtefacto, shaImagen, registrarArtefacto,
    huellaInformativa, distanciaHuellas,
} from './portadas-artefacto.js';
import { indexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';

const execFileP = promisify(execFile);
const TINTA_MIN = Number(process.env.PDF_TINTA_MIN || 0.005);
const PAGINAS_SONDEO = 10;          // páginas del principio en las que se busca la portada/primera página de texto
const TEXTO_MIN_PAGINA = 40;        // caracteres para considerar que una página de PDF «tiene texto»

// ── Utilidades de disco ───────────────────────────────────────────────────────────────────────────────

/** Ruta absoluta de una imagen web del catálogo (/recursos/...). */
const rutaAbs = (web) => path.join(DIR_CDU, ...String(web || '').replace(/^\/recursos\//, '').split('/'));

/** SHA de la portada actual del documento (o null si no se puede leer). */
async function shaPortadaActual(doc) {
    if (!doc.portada) return null;
    try { return shaImagen(await fs.readFile(rutaAbs(doc.portada))); } catch { return null; }
}

/** Huella perceptiva de la PRIMERA página con contenido de un PDF (la que la extracción toma por portada). */
async function huellaPrimeraSignificativa(pdf) {
    const m = await medirTinta(pdf, [1, 2, 3, 4, 5, 6, 7, 8]).catch(() => new Map());
    for (let p = 1; p <= 8; p++) {
        const x = m.get(p);
        if (x && x.tinta >= TINTA_MIN) return { pagina: p, huella: x.huella };
    }
    return null;
}

// ── 1. Registro del artefacto a partir del LOTE ───────────────────────────────────────────────────────

/**
 * Registra como artefacto lo que COMPARTEN 2+ documentos del lote: el sha de su portada y, para los PDF, la
 * huella de su primera página con contenido. Una portada que solo tiene un documento no se registra (no hay
 * prueba de que sea un artefacto; la acción la omite igualmente en ESE documento).
 */
export async function registrarArtefactosDelLote(db, docs) {
    const porSha = new Map();
    const huellas = [];   // { id, huella }
    for (const d of docs) {
        const sha = await shaPortadaActual(d);
        if (sha) porSha.set(sha, [...(porSha.get(sha) || []), d._id]);
        const pdf = await archivoOriginal(carpetaDeDoc(d), d.nombre_archivo).catch(() => null);
        if (pdf && /\.pdf$/i.test(pdf)) {
            const h = await huellaPrimeraSignificativa(pdf);
            if (h && huellaInformativa(h.huella)) huellas.push({ id: d._id, huella: h.huella });
        }
    }
    let registrados = 0;
    for (const [sha, ids] of porSha) {
        if (ids.length < 2) continue;
        await registrarArtefacto(db, { sha, ejemplos: ids, origen: 'panel', nota: 'portada compartida (acción «Portada sospechosa»)' });
        registrados++;
    }
    // Huellas de página: se agrupan las que difieren ≤ 6 bits; un grupo con 2+ documentos es el artefacto.
    const usadas = new Set();
    for (let i = 0; i < huellas.length; i++) {
        if (usadas.has(i)) continue;
        const grupo = [i];
        for (let j = i + 1; j < huellas.length; j++) {
            if (!usadas.has(j) && distanciaHuellas(huellas[i].huella, huellas[j].huella) <= 6) grupo.push(j);
        }
        if (grupo.length < 2) continue;
        grupo.forEach((k) => usadas.add(k));
        await registrarArtefacto(db, { huella: huellas[i].huella, ejemplos: grupo.map((k) => huellas[k].id), origen: 'panel', nota: 'página de PDF compartida (acción «Portada sospechosa»)' });
        registrados++;
    }
    await cargarArtefactos({ forzar: true });
    return registrados;
}

// ── 2. Primera página de TEXTO ─────────────────────────────────────────────────────────────────────────

/** Nº de la primera página de un PDF con capa de texto (pdftotext), o null. */
async function primeraPaginaConTextoPdf(pdf) {
    for (let p = 1; p <= PAGINAS_SONDEO; p++) {
        try {
            const { stdout } = await execFileP('pdftotext', ['-f', String(p), '-l', String(p), '-layout', pdf, '-'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
            if (String(stdout).replace(/\s+/g, '').length >= TEXTO_MIN_PAGINA) return p;
        } catch { return null; }   // PDF ilegible o sin poppler
    }
    return null;
}

// Página de TÍTULO (portadilla) por su nombre de fichero: «titulo.xhtml» (ePubLibre), «title.xhtml»,
// «titlepage.xhtml», «portadilla.html»…
const RE_PORTADILLA = /(^|[\/_-])(titulo|title|titlepage|portadilla|halftitle)[^\/]*\.x?html?$/i;
const RE_INDICE = new RegExp(String.raw`(^|[\/_-])(toc|nav|contents|indice|index|sumario)[^\/]*\.x?html?$`, 'i');

/**
 * Bloques de texto de la PRIMERA PÁGINA de un EPUB, en orden de lectura (spine): [{ texto, nivel }] con nivel 1-3
 * para encabezados y 0 para párrafos. Prefiere la PORTADILLA (página de título: título, autor, editorial), que es
 * lo que mejor hace de portada; si no la hay, la primera página con texto (medido: en ePubLibre la primera con
 * texto es la SINOPSIS, que no sirve de portada). Se salta la página de cubierta (solo una imagen).
 */
export async function bloquesPrimeraPaginaEpub(ruta) {
    const zip = new AdmZip(await fs.readFile(ruta));
    const cont = zip.getEntry('META-INF/container.xml');
    if (!cont) return [];
    const opfPath = cheerio.load(cont.getData().toString('utf8'), { xmlMode: true })('rootfile').attr('full-path');
    const opf = opfPath && zip.getEntry(opfPath);
    if (!opf) return [];
    const $ = cheerio.load(opf.getData().toString('utf8').replace(/<(\/?)opf:/g, '<$1'), { xmlMode: true });
    const opfDir = path.posix.dirname(opfPath);
    const manifest = new Map();
    $('manifest > item').each((i, el) => manifest.set($(el).attr('id'), $(el).attr('href') || ''));

    const itemrefs = $('spine > itemref').map((i, el) => $(el).attr('idref')).get().slice(0, 10);
    // Primero la portadilla (si la hay entre las primeras páginas); después, en orden de lectura.
    const hrefs = itemrefs.map((id) => manifest.get(id)).filter((h) => h && /\.x?html?$/i.test(h.split('#')[0]));
    // Índices/tablas de contenido/navegación, al final: como portada no sirven (medido: «Table of Contents…»).
    const esIndice = (h) => RE_INDICE.test(h.split('#')[0]);
    const esPortadilla = (h) => RE_PORTADILLA.test(h.split('#')[0]);
    const orden = [
        ...hrefs.filter(esPortadilla),
        ...hrefs.filter((h) => !esPortadilla(h) && !esIndice(h)),
        ...hrefs.filter((h) => !esPortadilla(h) && esIndice(h)),
    ];
    for (const href of orden) {
        const entry = zip.getEntry(path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href.split('#')[0]))));
        if (!entry) continue;
        const $$ = cheerio.load(entry.getData().toString('utf8'));
        const bloques = [];
        $$('body').find('h1, h2, h3, h4, p, div').each((i, el) => {
            // Solo nodos «hoja» de texto: un div que contiene párrafos se ignora (sus hijos ya se recogen).
            if (el.tagName === 'div' && $$(el).find('p, h1, h2, h3, h4, div').length) return;
            const texto = $$(el).text().replace(/\s+/g, ' ').trim();
            if (!texto) return;
            const m = /^h([1-4])$/i.exec(el.tagName);
            bloques.push({ texto, nivel: m ? Math.min(3, Number(m[1])) : 0 });
        });
        const total = bloques.reduce((s, b) => s + b.texto.length, 0);
        if (total >= 15) return bloques;
    }
    return [];
}

/**
 * Deja solo los caracteres que las fuentes estándar de PDF (WinAnsi) saben pintar: el latín con acentos sí; lo
 * demás se intenta sin diacríticos y, si ni así, se sustituye por «?». (Un libro en griego o ruso saldría así
 * ilegible: para esos, mejor la portada remota o «Quitar portada».)
 */
function aWinAnsi(texto) {
    const extra = new Set(['‘', '’', '“', '”', '–', '—', '…', '€', '•', '«', '»', '¿', '¡']);
    let out = '';
    for (const ch of String(texto)) {
        if (ch.charCodeAt(0) <= 0xff || extra.has(ch)) { out += ch; continue; }
        const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
        out += base && base.charCodeAt(0) <= 0xff ? base : '?';
    }
    return out;
}

/** Parte `texto` en líneas que caben en `ancho` con la fuente y el tamaño dados. */
function lineasQueCaben(texto, fuente, tam, ancho) {
    const palabras = texto.split(' ');
    const lineas = [];
    let actual = '';
    for (const p of palabras) {
        const prueba = actual ? `${actual} ${p}` : p;
        if (fuente.widthOfTextAtSize(prueba, tam) <= ancho || !actual) actual = prueba;
        else { lineas.push(actual); actual = p; }
    }
    if (actual) lineas.push(actual);
    return lineas;
}

/**
 * Compone una PÁGINA (imagen JPEG) con los bloques de texto: encabezados centrados y en negrita, párrafos
 * justificados a la izquierda; hasta llenar la página. pdf-lib (JS puro) + pdftoppm (poppler, C).
 */
export async function imagenDeBloques(bloques) {
    const pdf = await PDFDocument.create();
    const pagina = pdf.addPage([420, 630]);   // proporción de libro (2:3)
    const normal = await pdf.embedFont(StandardFonts.TimesRoman);
    const negrita = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const MARGEN = 42, ANCHO = 420 - 2 * MARGEN;
    const TAM = { 1: 22, 2: 17, 3: 14, 0: 11 };
    // Altura total del texto: si cabe holgado (una portadilla: título, autor, editorial), se CENTRA en la página
    // y los párrafos cortos también se centran — parece una portada, no el arranque de un capítulo.
    let alto = 0;
    for (const b of bloques) {
        const tam = TAM[b.nivel] || 11;
        alto += lineasQueCaben(aWinAnsi(b.texto), b.nivel ? negrita : normal, tam, ANCHO).length * tam * 1.35 + (b.nivel ? 14 : 6);
    }
    const corto = alto < 630 - 2 * MARGEN;
    let y = corto ? (630 + alto) / 2 - 10 : 630 - MARGEN - 10;
    for (const b of bloques) {
        const fuente = b.nivel ? negrita : normal;
        const tam = TAM[b.nivel] || 11;
        for (const linea of lineasQueCaben(aWinAnsi(b.texto), fuente, tam, ANCHO)) {
            if (y < MARGEN + tam) break;
            const w = fuente.widthOfTextAtSize(linea, tam);
            const x = b.nivel || (corto && b.texto.length < 120) ? MARGEN + (ANCHO - w) / 2 : MARGEN;
            pagina.drawText(linea, { x, y, size: tam, font: fuente, color: rgb(0.1, 0.1, 0.1) });
            y -= tam * 1.35;
        }
        y -= b.nivel ? 14 : 6;
        if (y < MARGEN + 11) break;
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portada-texto-'));
    try {
        const ruta = path.join(dir, 'pagina.pdf');
        await fs.writeFile(ruta, await pdf.save());
        const renders = await rasterizarPaginas(ruta, { paginas: [1] });
        return renders[0]?.buffer || null;
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Imagen de la PRIMERA PÁGINA DE TEXTO del fichero del documento, o { motivo } si no hay manera. */
async function imagenPrimeraPaginaTexto(original, tipo) {
    if (tipo === 'pdf') {
        const p = await primeraPaginaConTextoPdf(original);
        if (!p) return { motivo: 'el PDF no tiene capa de texto en sus primeras páginas (escaneo): usa «Re-extraer»' };
        const r = await rasterizarPaginas(original, { paginas: [p] });
        return r[0]?.buffer ? { buffer: r[0].buffer, origen: `pdf-texto-p${p}` } : { motivo: 'no se pudo rasterizar la página' };
    }
    if (tipo === 'epub') {
        const bloques = await bloquesPrimeraPaginaEpub(original).catch(() => []);
        if (!bloques.length) return { motivo: 'el EPUB no tiene texto legible al principio' };
        const buffer = await imagenDeBloques(bloques).catch(() => null);
        return buffer ? { buffer, origen: 'epub-texto' } : { motivo: 'no se pudo componer la página' };
    }
    return { motivo: `«primera página de texto» solo sirve para PDF y EPUB (este es ${tipo || 'sin fichero'})` };
}

// ── 3. Re-extraer OMITIENDO la sospechosa ──────────────────────────────────────────────────────────────

async function imagenReextraida(doc, original, tipo, shaSospechosa) {
    const valida = (b) => Buffer.isBuffer(b) && b.length && !esImagenArtefacto(b) && shaImagen(b) !== shaSospechosa;
    if (tipo === 'pdf') {
        // Si la huella de la 1.ª página con contenido ya está registrada como artefacto, rasterizarFrontalesPdf la
        // salta sola; si no, la sospechosa ES esa página → se toma la SIGUIENTE.
        const h = await huellaPrimeraSignificativa(original);
        const yaSaltada = h && esHuellaArtefacto(h.huella);
        const renders = await rasterizarFrontalesPdf(original, doc.paginas || 0).catch(() => []);
        const candidatas = (yaSaltada ? renders : renders.slice(1)).filter((r) => r.pagina !== h?.pagina || yaSaltada);
        const r = candidatas.find((x) => valida(x.buffer));
        if (r) return { buffer: r.buffer, origen: `pdf-p${r.pagina}` };
    } else if (tipo === 'epub') {
        const cub = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64;
        const b = cub ? Buffer.from(cub, 'base64') : null;
        if (valida(b)) return { buffer: b, origen: 'epub-cubierta' };
    } else if (tipo === 'mobi') {
        const m = await leerMobi(original).catch(() => null);
        if (valida(m?.portada?.buf)) return { buffer: m.portada.buf, origen: 'mobi-cubierta' };
    }
    // Último recurso: la portada remota por ISBN (OpenLibrary + Amazon + Google Books).
    if (doc.isbn) {
        const b = await bufferPortadaPorISBN(doc.isbn).catch(() => null);
        if (valida(b)) return { buffer: b, origen: 'remota-isbn' };
    }
    return { motivo: original ? `el fichero (${tipo}) no da otra portada y no hay portada remota por ISBN` : 'sin fichero original ni portada remota por ISBN' };
}

// ── 4. Aplicar al documento (cambia SOLO la portada; conserva las demás imágenes) ──────────────────────

async function ponerPortada(db, doc, buffer, origen) {
    const carpeta = carpetaDeDoc(doc);
    const { web } = await escribirImagen(carpeta, webDeDoc(doc), buffer, 'portada');
    const resto = (doc.imagenes || []).filter((im) => im && im.ruta !== doc.portada).map((im) => ({ ...im, tipo: im.tipo === 'portada' ? 'otra' : im.tipo }));
    const imagenes = [{ ruta: web, tipo: 'portada', origen }, ...resto];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, {
        $set: { imagenes, portada: web, fecha_actualizacion: new Date() },
        $push: { alertas_agente: `Portada sospechosa sustituida (${origen}); la anterior sigue en disco.` },
    });
}

async function quitarPortada(db, doc) {
    const imagenes = (doc.imagenes || []).filter((im) => im && im.ruta !== doc.portada);
    await db.collection('biblioteca').updateOne({ _id: doc._id }, {
        $set: { imagenes, fecha_actualizacion: new Date() },
        $unset: { portada: '' },
        $push: { alertas_agente: 'Portada sospechosa retirada a mano (la imagen sigue en disco).' },
    });
}

/**
 * Trata la portada de UN documento según el `modo` ('quitar' | 'reextraer' | 'texto').
 * @returns {Promise<{ok:boolean, motivo?:string, origen?:string}>}
 */
export async function tratarPortadaSospechosa(db, doc, modo) {
    let origen = null;
    if (modo === 'quitar') {
        if (!doc.portada) return { ok: false, motivo: 'no tiene portada' };
        await quitarPortada(db, doc);
    } else {
        const original = await archivoOriginal(carpetaDeDoc(doc), doc.nombre_archivo).catch(() => null);
        const tipo = original ? detectarTipo(original) : null;
        const r = modo === 'texto'
            ? await imagenPrimeraPaginaTexto(original, tipo)
            : await imagenReextraida(doc, original, tipo, await shaPortadaActual(doc));
        if (!r.buffer) return { ok: false, motivo: r.motivo };
        await ponerPortada(db, doc, r.buffer, r.origen);
        origen = r.origen;
    }
    const act = await db.collection('biblioteca').findOne({ _id: doc._id });
    await regenerarSidecarsDoc(db, act, carpetaDeDoc(act)).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
    return { ok: true, origen };
}

// ── 5. LOTE en 2º plano ────────────────────────────────────────────────────────────────────────────────

let trabajo = { en_curso: false, total: 0, hechos: 0, ok: 0, fallidos: 0, titulo: '', cancelar: false, modo: null, registrados: 0, motivos: [] };
export function estadoPortadaSospechosa() { return { ...trabajo, motivos: trabajo.motivos.slice(-20) }; }
export function cancelarPortadaSospechosa() { if (trabajo.en_curso) trabajo.cancelar = true; return { ok: true }; }

export function lanzarPortadaSospechosa({ ids, modo } = {}) {
    if (!['quitar', 'reextraer', 'texto'].includes(modo)) return { ok: false, motivo: 'modo desconocido' };
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay un tratamiento de portadas en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(','))
        .map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    if (!lista.length) return { ok: false, motivo: 'no se recibió ningún documento válido' };
    trabajo = { en_curso: true, total: lista.length, hechos: 0, ok: 0, fallidos: 0, titulo: 'registrando la portada compartida…', cancelar: false, modo, registrados: 0, motivos: [] };
    (async () => {
        try {
            const db = await conectarDB();
            const col = db.collection('biblioteca');
            const docs = await col.find({ _id: { $in: lista } }).toArray();
            // Primero se registra lo que comparte el lote: así la re-extracción ya lo salta en todos.
            await cargarArtefactos();
            if (docs.length >= 2) trabajo.registrados = await registrarArtefactosDelLote(db, docs).catch(() => 0);
            for (const doc of docs) {
                if (trabajo.cancelar) break;
                trabajo.titulo = doc.titulo || '';
                try {
                    const r = await tratarPortadaSospechosa(db, doc, modo);
                    if (r.ok) trabajo.ok++;
                    else { trabajo.fallidos++; trabajo.motivos.push(`«${String(doc.titulo || doc._id).slice(0, 50)}»: ${r.motivo}`); }
                } catch (e) { trabajo.fallidos++; trabajo.motivos.push(`«${String(doc.titulo || doc._id).slice(0, 50)}»: ${e.message}`); }
                trabajo.hechos++;
            }
        } catch { /* el lote nunca tumba el servidor */ }
        finally { trabajo.en_curso = false; trabajo.titulo = ''; }
    })();
    return { ok: true, total: lista.length };
}
