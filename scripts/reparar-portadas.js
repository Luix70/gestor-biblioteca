#!/usr/bin/env node
/**
 * reparar-portadas.js — Localiza y REPARA documentos SIN portada o con IMÁGENES DE CARRUSEL ROTAS
 * (entradas de `imagenes[]` cuyo fichero NO existe en disco — típico de una ingesta interrumpida o de un
 * fallo al materializar las imágenes). Por cada documento afectado:
 *   1) QUITA del carrusel las imágenes cuyo fichero falta (sanea las referencias muertas);
 *   2) si la PORTADA falta o su fichero no existe, la re-resuelve:
 *        a) reusa la 1.ª imagen VÁLIDA que quede en el carrusel, o
 *        b) si no queda ninguna, EXTRAE la 1.ª página / cubierta del fichero original (PDF/EPUB/DjVu/cómic)
 *           con `resolverPortada` (rasterizado / cubierta embebida / remota por ISBN) → nueva portada.
 *
 * DRY-RUN por defecto (no toca nada): informa de lo que haría. `--ejecutar` aplica. `--id <id>` para uno solo.
 * Reutiliza las utilidades de mantenimiento (no reimplementa el mapeo a disco ni la resolución de portada).
 *
 * ⚠ Antes de `--ejecutar`: haz COPIA DE SEGURIDAD de la BD — escribe ficheros de portada y actualiza documentos.
 *
 * Uso:
 *   node scripts/reparar-portadas.js                    (dry-run, TODO el catálogo — auditoría completa, lenta)
 *   node scripts/reparar-portadas.js --sin-portada     (dry-run, solo los que NO tienen portada — rápido)
 *   node scripts/reparar-portadas.js --id <ObjectId>   (dry-run, un documento)
 *   node scripts/reparar-portadas.js --ejecutar        (aplica; combinable con --sin-portada / --id)
 *
 * Progreso: imprime una línea [i/N] por documento. Con `docker exec` AÑADE -t, si no Node bufferiza la salida
 * al no haber TTY y parece congelado: `docker exec -t gestor-biblioteca node scripts/reparar-portadas.js …`
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
// config.js siembra process.env (PATH_*, knobs) — se importa ANTES que los módulos que los leen.
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { detectarTipo } from '../src/orquestador.js';
import { carpetaDeDoc, webDeDoc, archivoOriginal, numeroPaginasPdf, escribirImagen } from '../src/mantenimiento/util-mantenimiento.js';
import { resolverPortada } from '../src/utils/resolver-portada.js';
import { extraerMetadatosEpub } from '../src/utils/lector-epub.js';
import { leerPaginaDjvu } from '../src/utils/djvu.js';
import { leerPaginaComic } from '../src/utils/comic-paginas.js';
import { leerMetadatosAudio } from '../src/utils/lector-audio.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const idArg = (() => { const i = process.argv.indexOf('--id'); return i >= 0 ? process.argv[i + 1] : null; })();
const patronArg = (() => { const i = process.argv.indexOf('--patron'); return i >= 0 ? process.argv[i + 1] : null; })();
// `--forzar`: RE-EXTRAE la portada aunque ya haya una válida. Hace falta cuando la portada existente es
// correcta como fichero pero MALA como imagen — el caso real: las láminas bitonales se extrajeron en negativo,
// se arreglaron dentro del cbz, y las portadas (jpg, ya derivadas) siguieron invertidas. Reusar una imagen del
// carrusel no vale entonces: hay que volver al fichero original, que ahora sí está bien.
const FORZAR = process.argv.includes('--forzar');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
// Mapea una ruta web (/recursos/…) al fichero en disco (mismo criterio que integridad.js).
const absDe = (web) => (web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null);
const existe = (p) => (p ? fs.access(p).then(() => true).catch(() => false) : Promise.resolve(false));
const urlPortadaOL = (isbn) => `https://covers.openlibrary.org/b/isbn/${String(isbn).replace(/[^0-9Xx]/g, '')}-L.jpg`;

const RE_IMG = /\.(jpe?g|png|webp)$/i;
const RE_NOMBRE_PORTADA = /(cover|folder|front|portada|car[áa]tula|caratula|album)/i;
// CONTRAportada/back/trasera NO son portada. Ojo: «contraportada» CONTIENE «portada», así que sin esta
// exclusión casaba como portada y, si pesaba más, GANABA — el libro se quedaba con la contracubierta de
// portada. Mismo criterio que audiolibro.js·clasificarImagen, que ya distinguía las dos caras.
const RE_NO_PORTADA = /(contra|back|trasera|reverso|spine|lomo)/i;
/**
 * Busca una imagen SUELTA en la carpeta del documento (recursiva, acotada) y devuelve su buffer.
 * Prefiere las que se llaman como una portada (cover/folder/front/portada…); si no, la MÁS GRANDE.
 * Descarta las miniaturas (<8 KB): son iconos y adornos, peor portada que ninguna.
 */
async function imagenSueltaEnCarpeta(carpeta, nivel = 3) {
    if (!carpeta || nivel < 0) return null;
    let ents;
    try { ents = await fs.readdir(carpeta, { withFileTypes: true }); } catch { return null; }
    const candidatas = [];
    for (const e of ents) {
        if (e.name.startsWith('.') || e.name.startsWith('@')) continue;
        const p = path.join(carpeta, e.name);
        if (e.isDirectory()) { const sub = await imagenSueltaEnCarpeta(p, nivel - 1); if (sub) return sub; continue; }
        if (!RE_IMG.test(e.name)) continue;
        const st = await fs.stat(p).catch(() => null);
        if (st && st.size >= 8 * 1024)
            candidatas.push({ p, size: st.size, portada: RE_NOMBRE_PORTADA.test(e.name) && !RE_NO_PORTADA.test(e.name) });
    }
    if (!candidatas.length) return null;
    candidatas.sort((a, b) => (b.portada - a.portada) || (b.size - a.size));
    return await fs.readFile(candidatas[0].p).catch(() => null);
}

// Extrae un buffer JPEG de la 1.ª página/cubierta del fichero ORIGINAL (según su tipo). null si no se puede.
async function portadaDelFichero(doc, carpeta) {
    // AUDIOLIBRO: no tiene fichero-documento (su contenido son las pistas), así que archivoOriginal no
    // encuentra nada y se daba por «irreparable». Pero la carátula va EMBEBIDA en los propios mp3 (ID3/APIC) y
    // `leerMetadatosAudio` ya la devuelve. Se prueban las primeras pistas: la carátula suele estar en todas,
    // pero no siempre en la primera.
    // Se miran TODAS las pistas (tope de seguridad 40), no solo las primeras: la carátula no siempre está en
    // la pista 1 — en un audiolibro de 23 la puede llevar solo alguna. La ingesta ya hacía esto
    // (`agregarMetadatos` → `validas.find(p => p.portada)`), así que reparar debe mirar igual de lejos; con un
    // tope de 5 se perdían carátulas que SÍ estaban. Leer el ID3 es barato (parseFile no escanea el audio).
    const pistas = Array.isArray(doc.audios) ? doc.audios : [];
    for (const a of pistas.slice(0, 40)) {
        const abs = absDe(a?.ruta);
        if (!abs || !(await existe(abs))) continue;
        const meta = await leerMetadatosAudio(abs).catch(() => null);
        if (meta?.portada?.buffer?.length) return meta.portada.buffer;
    }

    const original = await archivoOriginal(carpeta);
    if (!original) {
        // ÚLTIMO RECURSO (sin fichero-documento: audiolibros y demás): buscar una IMAGEN SUELTA en la carpeta,
        // RECURSIVAMENTE. Los rips de audiolibro suelen traer cover.jpg/folder.jpg junto a las pistas, y aquí
        // las pistas viven en una SUBCARPETA (…/VSI - Hinduism/VSI - Hinduism/01…mp3), así que un vistazo al
        // primer nivel no la ve. Se prefiere un nombre de portada; si no, la imagen más grande.
        return await imagenSueltaEnCarpeta(carpeta);
    }
    const tipo = detectarTipo(original);
    // DjVu / cómic: la 1.ª página YA es un JPEG (leerPaginaDjvu/Comic) → se usa directamente (evita pdftoppm).
    if (tipo === 'djvu') { const p = await leerPaginaDjvu(original, 0).catch(() => null); return p?.buffer || null; }
    if (tipo === 'comic') { const p = await leerPaginaComic(original, 0).catch(() => null); return p?.buffer || null; }
    // PDF / EPUB / otros: resolverPortada (rasteriza la 1.ª página, o cubierta embebida del EPUB, o remota por ISBN).
    let embebida = null, numPaginas = 2;
    if (tipo === 'epub') embebida = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64 || null;
    else if (tipo === 'pdf') numPaginas = (await numeroPaginasPdf(original)) || 2;
    const remotos = doc.isbn ? [{ origen: 'openlibrary', url: urlPortadaOL(doc.isbn) }] : [];
    const { portada } = await resolverPortada({ tipo: tipo || 'otro-formato', rutas: [original], numPaginas, embebidaBase64: embebida, remotos }).catch(() => ({}));
    return portada ? Buffer.from(portada.base64, 'base64') : null;
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');
    // Sin filtro se revisa el catálogo ENTERO (16k+ docs), comprobando en disco todas las imágenes de cada uno:
    // es la auditoría completa, pero tarda muchísimo. `--sin-portada` va directo a los que NO tienen portada —
    // que es el caso típico tras una operación (p. ej. separar carpetas compartidas deja las portadas a null
    // para re-extraerlas). Órdenes de magnitud más rápido y hace exactamente lo que hace falta.
    const soloSinPortada = process.argv.includes('--sin-portada');
    const filtro = idArg
        ? { _id: new ObjectId(idArg) }
        : patronArg ? { nombre_archivo: { $regex: patronArg, $options: 'i' } }
        : soloSinPortada ? { $or: [{ portada: null }, { portada: { $exists: false } }, { portada: '' }] } : {};

    // `--forzar` sin acotar re-extraería la portada de TODO el catálogo (16k+ documentos, rasterizando cada
    // uno). Eso no se hace por accidente: hay que decir a cuáles.
    if (FORZAR && !idArg && !patronArg) {
        console.error('⛔ --forzar necesita acotar el conjunto: usa --id <ObjectId> o --patron "<regex>".');
        process.exit(1);
    }
    const proj = {
        titulo: 1, portada: 1, imagenes: 1, ruta_base: 1, cdu: 1, tipo_recurso: 1, isbn: 1, issn: 1, formatos: 1,
        nombre_archivo: 1, audios: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1, año_edicion: 1, mes_publicacion: 1,
    };
    // Snapshot de ids primero (el trabajo por-doc es lento: rasteriza; evita CursorNotFound de Atlas).
    const ids = (await col.find(filtro, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    console.log(`${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${ids.length} documento(s) a revisar${idArg ? ` (id ${idArg})` : ''}\n`);

    const st = { revisados: 0, conImagenesRotas: 0, sinPortada: 0, reusadas: 0, extraidas: 0, irreparables: 0, docsTocados: 0 };
    for (const _id of ids) {
        const doc = await col.findOne({ _id }, { projection: proj });
        if (!doc) continue;
        st.revisados++;
        const carpeta = carpetaDeDoc(doc);
        const imgs = Array.isArray(doc.imagenes) ? doc.imagenes : [];

        // 1) Imágenes válidas vs rotas (fichero ausente en disco).
        const validas = [], rotas = [];
        for (const im of imgs) {
            const disco = absDe(im.ruta) || (im.ruta ? path.join(carpeta, path.basename(im.ruta)) : null);
            (await existe(disco)) ? validas.push(im) : rotas.push(im);
        }
        // 2) ¿La portada actual es válida (referenciada Y su fichero existe)?
        const portadaDisco = doc.portada ? (absDe(doc.portada) || path.join(carpeta, path.basename(doc.portada))) : null;
        const portadaOk = !!doc.portada && (await existe(portadaDisco));

        if (!FORZAR && !rotas.length && portadaOk) continue; // nada que reparar

        const set = {};
        if (rotas.length) { st.conImagenesRotas++; set.imagenes = validas; }

        let accion = '', motivo = '';
        if (FORZAR || !portadaOk) {
            if (!portadaOk) st.sinPortada++;
            // Al FORZAR no se reusa nada del carrusel: esas imágenes son precisamente las que están mal.
            // Se vuelve al fichero original, que es el que se ha corregido.
            const reusar = FORZAR ? null : (validas.find((im) => im.tipo === 'portada') || validas[0]);
            if (reusar) {
                set.portada = reusar.ruta;
                accion = 'reusar';
            } else if (!(await archivoOriginal(carpeta)) && !(doc.audios || []).length && !(await imagenSueltaEnCarpeta(carpeta))) {
                // No hay NADA de donde sacarla: ni fichero-documento, ni pistas de audio, ni una imagen suelta
                // en su carpeta. Esto sí es genuinamente irreparable.
                accion = 'irreparable';
                motivo = 'no hay fichero original, ni pistas de audio, ni ninguna imagen en su carpeta';
            } else if (EJECUTAR) {
                const buf = await portadaDelFichero(doc, carpeta);
                if (Buffer.isBuffer(buf) && buf.length) {
                    const { web } = await escribirImagen(carpeta, webDeDoc(doc), buf, 'portada');
                    set.portada = web;
                    const resto = FORZAR ? validas.filter((im) => im.ruta !== doc.portada) : validas;
                    set.imagenes = [{ ruta: web, tipo: 'portada', origen: 'reparacion' }, ...resto];
                    accion = 'extraer';
                } else {
                    // SÍ había de dónde sacarla (fichero o pistas) pero la extracción no dio imagen. Es un
                    // motivo MUY distinto del anterior y hay que decirlo: si no, un fallo del extractor se
                    // confunde con «no hay fichero» y se persigue el problema equivocado.
                    accion = 'irreparable';
                    motivo = (doc.audios || []).length
                        ? `${doc.audios.length} pista(s) de audio: ninguna trae carátula ID3 y no hay imagen suelta en su carpeta`
                        : 'hay fichero original, pero no se pudo extraer una imagen de él';
                }
            } else {
                accion = 'extraer'; // dry-run: hay fichero → se PODRÍA extraer la 1.ª página
            }
            if (accion === 'reusar') st.reusadas++;
            else if (accion === 'extraer') st.extraidas++;
            else st.irreparables++;
        }

        const marca = `${!portadaOk || FORZAR ? '🖼️ ' : ''}${rotas.length ? `🧹${rotas.length} ` : ''}`;
        const cola = set.portada
            ? ` → portada (${accion === 'extraer' ? 'extraída de la 1.ª página' : 'reusada'}): ${path.basename(String(set.portada))}`
            : accion === 'extraer' ? ' → se extraería la portada de su fichero (ejecuta con --ejecutar)'
            // Al FORZAR también hay que decir por qué NO se pudo: si no, un documento con portada válida
            // que falla al re-extraer no imprimiría nada y parecería que ha ido bien.
            : (!portadaOk || FORZAR ? ` → SIN reparar: ${motivo || 'no tiene imágenes válidas ni fichero original'}` : '');
        // Contador i/N: rasterizar la 1.ª página de un PDF tarda segundos, así que sin saber cuánto queda el
        // proceso PARECE colgado. Se escribe por stdout directamente (no console.log) por si algún import
        // trajera consola-timestamp, que silencia las líneas sin marcador de titular.
        const pos = `[${String(st.revisados).padStart(String(ids.length).length)}/${ids.length}]`;
        process.stdout.write(`${pos} ${marca}${doc._id} · ${(doc.titulo || '(sin título)').slice(0, 60)}${cola}\n`);

        if (EJECUTAR && Object.keys(set).length) {
            await col.updateOne({ _id }, { $set: set });
            st.docsTocados++;
        }
    }

    console.log(`\n=== RESUMEN (${EJECUTAR ? 'APLICADO' : 'dry-run'}) ===`);
    console.log(`  revisados            : ${st.revisados}`);
    console.log(`  con imágenes rotas   : ${st.conImagenesRotas}  (referencias muertas saneadas)`);
    console.log(`  sin portada válida   : ${st.sinPortada}`);
    console.log(`     · reusando imagen : ${st.reusadas}`);
    console.log(`     · extrayendo pág. : ${st.extraidas}`);
    console.log(`     · irreparables    : ${st.irreparables}  (sin imágenes válidas ni fichero original)`);
    console.log(`  documentos tocados   : ${st.docsTocados}`);
    if (!EJECUTAR) console.log('\n▶ Ejecuta con --ejecutar para aplicar (haz COPIA DE SEGURIDAD de la BD antes).');
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
