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
 *   node scripts/reparar-portadas.js                 (dry-run, todo el catálogo)
 *   node scripts/reparar-portadas.js --id <ObjectId> (dry-run, un documento)
 *   node scripts/reparar-portadas.js --ejecutar      (aplica)
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

const EJECUTAR = process.argv.includes('--ejecutar');
const idArg = (() => { const i = process.argv.indexOf('--id'); return i >= 0 ? process.argv[i + 1] : null; })();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
// Mapea una ruta web (/recursos/…) al fichero en disco (mismo criterio que integridad.js).
const absDe = (web) => (web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null);
const existe = (p) => (p ? fs.access(p).then(() => true).catch(() => false) : Promise.resolve(false));
const urlPortadaOL = (isbn) => `https://covers.openlibrary.org/b/isbn/${String(isbn).replace(/[^0-9Xx]/g, '')}-L.jpg`;

// Extrae un buffer JPEG de la 1.ª página/cubierta del fichero ORIGINAL (según su tipo). null si no se puede.
async function portadaDelFichero(doc, carpeta) {
    const original = await archivoOriginal(carpeta);
    if (!original) return null; // sin fichero (p. ej. 'papel' con las fotos perdidas) → no se puede extraer
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
    const filtro = idArg ? { _id: new ObjectId(idArg) } : {};
    const proj = {
        titulo: 1, portada: 1, imagenes: 1, ruta_base: 1, cdu: 1, tipo_recurso: 1, isbn: 1, issn: 1, formatos: 1,
        nombre_archivo: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1, año_edicion: 1, mes_publicacion: 1,
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

        if (!rotas.length && portadaOk) continue; // nada que reparar

        const set = {};
        if (rotas.length) { st.conImagenesRotas++; set.imagenes = validas; }

        let accion = '';
        if (!portadaOk) {
            st.sinPortada++;
            const reusar = validas.find((im) => im.tipo === 'portada') || validas[0];
            if (reusar) {
                set.portada = reusar.ruta;
                accion = 'reusar';
            } else if (!(await archivoOriginal(carpeta))) {
                accion = 'irreparable'; // sin imágenes válidas y sin fichero → no hay de dónde sacar portada
            } else if (EJECUTAR) {
                const buf = await portadaDelFichero(doc, carpeta);
                if (Buffer.isBuffer(buf) && buf.length) {
                    const { web } = await escribirImagen(carpeta, webDeDoc(doc), buf, 'portada');
                    set.portada = web;
                    set.imagenes = [{ ruta: web, tipo: 'portada', origen: 'reparacion' }, ...validas];
                    accion = 'extraer';
                } else accion = 'irreparable';
            } else {
                accion = 'extraer'; // dry-run: hay fichero → se PODRÍA extraer la 1.ª página
            }
            if (accion === 'reusar') st.reusadas++;
            else if (accion === 'extraer') st.extraidas++;
            else st.irreparables++;
        }

        const marca = `${!portadaOk ? '🖼️ ' : ''}${rotas.length ? `🧹${rotas.length} ` : ''}`;
        const cola = set.portada
            ? ` → portada (${accion === 'extraer' ? 'extraída de la 1.ª página' : 'reusada'}): ${path.basename(String(set.portada))}`
            : (!portadaOk ? ' → SIN reparar (sin imágenes ni fichero)' : '');
        console.log(`${marca}${doc._id} · ${(doc.titulo || '(sin título)').slice(0, 60)}${cola}`);

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
