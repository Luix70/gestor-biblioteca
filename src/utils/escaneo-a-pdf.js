/**
 * ESCANEO DE PÁGINAS → PDF, en la ingesta (16-oct).
 *
 * Por qué: una carpeta de PÁGINAS escaneadas (un libro digitalizado: «Latina pg000.tif … pg083.tif», o el curso
 * «Latin Road» con su libro de texto, guía del profesor, ejercicios… en subcarpetas de JPG) no tenía buen camino:
 *   · el vigilante solo reconoce como imagen jpg/png/webp/heic → una carpeta de TIF no daba NINGUNA unidad y se
 *     quedaba en el Inbox para siempre, sin aviso (y Gemini no acepta TIF);
 *   · con JPG iba por la ruta del «libro FÍSICO fotografiado» (orquestador, Tier 3): TODAS las imágenes a una sola
 *     llamada de visión (82 en «Textbook»), formato «papel» y las páginas como imágenes sueltas: no se puede leer;
 *   · una carpeta con solo subcarpetas de imágenes no daba unidades (no hay imágenes directas ni documentos).
 * Un escaneo de páginas ES un libro digital: lo natural es UN PDF por libro, que entra por la ruta de siempre del
 * PDF escaneado (identificación con las primeras páginas, visor de PDF, portada, OCR).
 *
 * Qué se considera escaneo (`planEscaneo`): una carpeta SIN documentos ni audio cuyo árbol son solo imágenes (y
 * basura de sistema: Thumbs.db, .DS_Store…), con algún TIF o al menos ESCANEO_PDF_MIN_PAGINAS páginas. Un puñado de
 * fotos de un libro en papel (portada, contraportada, créditos) sigue yendo por la visión como siempre.
 *   · imágenes DIRECTAS (sin subcarpetas con imágenes) → «<carpeta>.pdf», un libro;
 *   · SUBCARPETAS → un PDF por cada subcarpeta de primer nivel con TODO su subárbol («Tests» + «Tests/TestAnswers»),
 *     y la carpeta queda con varios PDF → la regla de siempre la hace colección (o lo que diga la inspección).
 * Orden de las páginas: natural por nombre (pg2 < pg10); dentro de una parte, primero sus imágenes y luego sus
 * subcarpetas.
 *
 * SIN PÉRDIDA: un JPG se mete en el PDF con SUS MISMOS BYTES (DCTDecode, sin recomprimir); un TIF con `tiff2pdf`
 * (libtiff), que conserva la compresión (CCITT G4 de un escaneo bitonal, JPEG…) y trae todas sus páginas; un PNG lo
 * re-codifica pdf-lib sin pérdida. Se COMPRUEBA el nº de páginas del PDF antes de retirar nada, y los originales van
 * a la PAPELERA (restaurables), nunca se borran. Si algo falla (falta tiff2pdf, formato no soportado como webp/heic,
 * páginas que no cuadran) NO se toca nada y la carpeta sigue como estaba.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';
import { unirPdfs, paginasPdf } from './qpdf.js';
import { reciclar, reciclarCarpeta } from './papelera.js';

const ejecutar = promisify(execFile);

const MIN_PAGINAS = () => Number(process.env.ESCANEO_PDF_MIN_PAGINAS || 12);
const RE_IMAGEN = /\.(jpe?g|png|tiff?)$/i;
const RE_TIFF = /\.tiff?$/i;
// Imágenes que pdf-lib no sabe meter en un PDF: si las hay, la carpeta no se convierte (no se adivina).
const RE_IMAGEN_NO_SOPORTADA = /\.(webp|heic|heif|gif|bmp|avif)$/i;
// Basura de sistema que puede acompañar a un escaneo sin dejar de serlo.
const esBasura = (n) => n.startsWith('.') || /^(thumbs\.db|desktop\.ini|_guia\.json)$/i.test(n);

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Páginas de una carpeta, en orden de lectura: sus imágenes y luego, recursivo, las de sus subcarpetas. */
async function paginasDe(dir) {
  const ents = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => natural(a.name, b.name));
  const out = [];
  for (const e of ents) if (e.isFile() && RE_IMAGEN.test(e.name)) out.push(path.join(dir, e.name));
  for (const e of ents) if (e.isDirectory() && !esBasura(e.name)) out.push(...(await paginasDe(path.join(dir, e.name))));
  return out;
}

/** ¿El árbol son solo imágenes soportadas (y basura)? Devuelve el nº de imágenes, o null si hay otra cosa. */
async function soloImagenes(dir) {
  let n = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (esBasura(e.name)) continue;
    if (e.isDirectory()) {
      const m = await soloImagenes(path.join(dir, e.name));
      if (m === null) return null;
      n += m;
    } else if (RE_IMAGEN.test(e.name)) n++;
    else return null;   // un documento, audio, imagen no soportada…: no es (solo) un escaneo
  }
  return n;
}

/**
 * ¿Es `dir` un escaneo de páginas? null si no. Si sí:
 *   { tipo:'libro', destino, paginas[] }                       — imágenes directas → un PDF
 *   { tipo:'partes', partes:[{ nombre, carpeta, destino, paginas[] }] } — un PDF por subcarpeta
 */
export async function planEscaneo(dir) {
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
  const total = await soloImagenes(dir).catch(() => null);
  if (!total) return null;
  const hayTiff = (await paginasDe(dir)).some((p) => RE_TIFF.test(p));
  if (!hayTiff && total < MIN_PAGINAS()) return null;   // pocas fotos: libro en papel → visión, como siempre

  const subcarpetas = ents.filter((e) => e.isDirectory() && !esBasura(e.name)).sort((a, b) => natural(a.name, b.name));
  const directas = ents.filter((e) => e.isFile() && RE_IMAGEN.test(e.name));
  const nombre = path.basename(dir);

  // Sin subcarpetas con imágenes: un libro.
  if (!subcarpetas.length) {
    return { tipo: 'libro', destino: path.join(dir, `${nombre}.pdf`), paginas: await paginasDe(dir) };
  }
  // Con subcarpetas: un PDF por parte. Las imágenes sueltas de la raíz (si las hay) forman su propia parte.
  const partes = [];
  if (directas.length) {
    partes.push({ nombre, carpeta: null, destino: path.join(dir, `${nombre}.pdf`),
      paginas: directas.map((e) => path.join(dir, e.name)).sort(natural) });
  }
  for (const s of subcarpetas) {
    const carpeta = path.join(dir, s.name);
    const paginas = await paginasDe(carpeta);
    if (paginas.length) partes.push({ nombre: s.name, carpeta, destino: path.join(dir, `${s.name}.pdf`), paginas });
  }
  return partes.length ? { tipo: 'partes', partes } : null;
}

/** Densidad (ppp) de un JPEG si la declara su cabecera JFIF; si no, null. */
function dpiJpeg(bytes) {
  // APP0 «JFIF\0»: unidades en el byte 13 (1 = ppp, 2 = ppcm) y densidad X en 14-15.
  if (bytes.length > 18 && bytes[2] === 0xff && bytes[3] === 0xe0 && bytes.toString('latin1', 6, 10) === 'JFIF') {
    const unidades = bytes[13];
    const x = bytes.readUInt16BE(14);
    if (x > 0 && unidades === 1) return x;
    if (x > 0 && unidades === 2) return x * 2.54;
  }
  return null;
}

/** Una imagen JPG/PNG → PDF de una página (con sus mismos bytes en el caso del JPG). */
async function imagenAPdf(ruta, destino) {
  const bytes = await fs.readFile(ruta);
  const doc = await PDFDocument.create();
  const img = /\.png$/i.test(ruta) ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  // Tamaño de página por la densidad del escaneo (150 ppp si no la dice): así se imprime a su tamaño real.
  const dpi = (/\.png$/i.test(ruta) ? null : dpiJpeg(bytes)) || 150;
  const ancho = (img.width * 72) / dpi;
  const alto = (img.height * 72) / dpi;
  doc.addPage([ancho, alto]).drawImage(img, { x: 0, y: 0, width: ancho, height: alto });
  await fs.writeFile(destino, await doc.save());
}

/** Un TIF (de una o varias páginas) → PDF con tiff2pdf (libtiff), sin recomprimir. */
async function tiffAPdf(ruta, destino) {
  try {
    await ejecutar('tiff2pdf', ['-o', destino, ruta], { timeout: 120000, maxBuffer: 1 << 22 });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('falta tiff2pdf (paquete libtiff-tools en la imagen Docker)');
    throw new Error(`tiff2pdf no pudo con «${path.basename(ruta)}»: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

/**
 * Une `paginas` (en ese orden) en el PDF `destino`. Verifica que el resultado tiene al menos una página por imagen
 * (un TIF puede traer varias). Devuelve { ok, paginas } o { ok:false, motivo }. No toca los originales.
 */
export async function imagenesAPdf(paginas, destino) {
  if (!paginas.length) return { ok: false, motivo: 'sin páginas' };
  if (paginas.some((p) => RE_IMAGEN_NO_SOPORTADA.test(p))) return { ok: false, motivo: 'hay imágenes en un formato que no se puede meter en un PDF' };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'escaneo-'));
  try {
    const sueltos = [];
    let esperadas = 0;
    for (const [i, p] of paginas.entries()) {
      const pdf = path.join(tmp, `${String(i).padStart(5, '0')}.pdf`);
      if (RE_TIFF.test(p)) await tiffAPdf(p, pdf);
      else await imagenAPdf(p, pdf);
      esperadas += (await paginasPdf(pdf)) || 1;
      sueltos.push(pdf);
    }
    if (sueltos.length === 1) await fs.copyFile(sueltos[0], destino);
    else {
      const r = await unirPdfs(sueltos, destino);
      if (!r.ok) return { ok: false, motivo: r.motivo };
    }
    const n = await paginasPdf(destino);
    if (!n || n !== esperadas || n < paginas.length) {
      await fs.rm(destino, { force: true });
      return { ok: false, motivo: `el PDF salió con ${n ?? '?'} páginas y se esperaban ${esperadas}` };
    }
    return { ok: true, paginas: n };
  } catch (e) {
    await fs.rm(destino, { force: true }).catch(() => {});
    return { ok: false, motivo: e.message };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Ejecuta el plan: fabrica los PDF y, SOLO si todos salieron bien, manda los originales a la Papelera. Si una parte
 * falla, se deshace lo fabricado (se borran los PDF nuevos) y la carpeta queda exactamente como estaba.
 * @returns {Promise<{ ok:boolean, pdfs?:Array<{nombre:string, paginas:number}>, motivo?:string }>}
 */
export async function materializarEscaneo(dir, plan) {
  const partes = plan.tipo === 'libro'
    ? [{ nombre: path.basename(dir), carpeta: null, destino: plan.destino, paginas: plan.paginas }]
    : plan.partes;
  for (const p of partes) {
    if (await fs.access(p.destino).then(() => true, () => false)) return { ok: false, motivo: `ya existe «${path.basename(p.destino)}»` };
  }
  const hechos = [];
  for (const p of partes) {
    const r = await imagenesAPdf(p.paginas, p.destino);
    if (!r.ok) {
      for (const h of hechos) await fs.rm(h.destino, { force: true }).catch(() => {});
      return { ok: false, motivo: `«${p.nombre}»: ${r.motivo}` };
    }
    hechos.push({ ...p, n: r.paginas });
  }
  // Todo fabricado y verificado: originales a la Papelera (las partes, con su carpeta entera; las sueltas, juntas).
  const etiqueta = `escaneo-${path.basename(dir)}`.slice(0, 60);
  for (const h of hechos) {
    if (h.carpeta) await reciclarCarpeta(h.carpeta, etiqueta);
    else await reciclar(h.paginas, etiqueta);
  }
  return { ok: true, pdfs: hechos.map((h) => ({ nombre: path.basename(h.destino), paginas: h.n })) };
}
