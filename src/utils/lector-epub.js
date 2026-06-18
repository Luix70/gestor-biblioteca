import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { validarISBN } from './identificadores.js';

const RE_PORTADA = /cover|portada|caratula|cubierta|frontcover/i;
const RE_RUIDO = /logo|ex_?libris|fuente|epl|brand|banner|sello/i;
const esImagenHref = (href, mt) => (mt && mt.startsWith('image/')) || /\.(jpe?g|png|gif|webp)$/i.test(href || '');

/**
 * ISBN desde Dublin Core. Recorre TODOS los dc:identifier pero solo acepta los marcados como
 * ISBN (scheme con 'isbn' o valor 'urn:isbn:'), y SIEMPRE valida el dígito de control. Esto
 * capta variantes (scheme en minúsculas, urn:isbn:, sin scheme con prefijo) y, sobre todo,
 * descarta los UUID: su hexadecimal contiene tiradas de 10 dígitos que parecen un ISBN-10.
 */
function extraerIsbnDublinCore($, metadata) {
    let isbn = null;
    metadata.find('dc\\:identifier').each((i, el) => {
        if (isbn) return;
        const scheme = ($(el).attr('opf:scheme') || $(el).attr('scheme') || '').toLowerCase();
        const val = $(el).text().trim();
        const esCandidato = scheme.includes('isbn') || /isbn/i.test(val);
        if (!esCandidato) return;
        const candidato = validarISBN(val.replace(/.*isbn:?/i, '')); // quita 'urn:isbn:'/'ISBN:' y valida
        if (candidato) isbn = candidato;
    });
    return isbn;
}

/** Resuelve un href (relativo al OPF) a una entrada del zip, tolerando #fragment, ?query y %xx. */
function entradaPorHref(zip, opfDir, href) {
    if (!href) return null;
    const limpio = decodeURIComponent(href.split('#')[0].split('?')[0]);
    return zip.getEntry(path.posix.normalize(path.posix.join(opfDir, limpio)));
}

/** Saca la imagen referenciada dentro de una página XHTML de cubierta (<img src> o <image xlink:href>). */
function imagenDesdeXhtml(zip, opfDir, href) {
    const entry = entradaPorHref(zip, opfDir, href);
    if (!entry) return null;
    const $$ = cheerio.load(entry.getData().toString('utf8'), { xmlMode: true });
    const src = $$('img').attr('src') || $$('image').attr('xlink:href') || $$('image').attr('href');
    if (!src) return null;
    const xhtmlDir = path.posix.dirname(path.posix.join(opfDir, href.split('#')[0]));
    return zip.getEntry(path.posix.normalize(path.posix.join(xhtmlDir, decodeURIComponent(src))));
}

/**
 * Extrae la cubierta del EPUB probando, en orden de fiabilidad, varias convenciones y eligiendo
 * la imagen MÁS GRANDE (la más legible). Devuelve base64 o null.
 *   1. EPUB3: item con properties="cover-image".
 *   2. EPUB2: <meta name="cover" content="ID"> → item[id="ID"]  (ID puede tener un punto, p. ej.
 *      "cover.jpg": por eso se usa selector de atributo y NO $('#'+id), que interpreta el punto
 *      como clase CSS y nunca casa — era el bug que perdía la cubierta).
 *   3. Guía: <reference type="cover"> (suele apuntar a un XHTML con la imagen dentro).
 *   4. Heurística: item imagen cuyo id/href sugiera portada (y no sea un logo/ex_libris).
 */
function extraerCubiertaEpub(zip, $, opfPath) {
    const opfDir = path.posix.dirname(opfPath);
    const candidatas = [];
    const add = (entry) => { if (entry && /\.(jpe?g|png|gif|webp)$/i.test(entry.entryName)) candidatas.push(entry); };

    add(entradaPorHref(zip, opfDir, $('manifest > item[properties~="cover-image"]').attr('href')));

    const coverId = $('meta[name="cover"]').attr('content');
    if (coverId) {
        const it = $('manifest > item[id="' + coverId.replace(/"/g, '\\"') + '"]').first();
        const href = it.attr('href');
        if (esImagenHref(href, it.attr('media-type'))) add(entradaPorHref(zip, opfDir, href));
        else if (href) add(imagenDesdeXhtml(zip, opfDir, href));
    }

    const refHref = $('reference[type="cover"]').attr('href');
    if (refHref) add(esImagenHref(refHref) ? entradaPorHref(zip, opfDir, refHref) : imagenDesdeXhtml(zip, opfDir, refHref));

    $('manifest > item').each((i, el) => {
        const href = $(el).attr('href'); const id = $(el).attr('id') || '';
        if (esImagenHref(href, $(el).attr('media-type')) && RE_PORTADA.test(id + ' ' + href) && !RE_RUIDO.test(id + ' ' + href)) {
            add(entradaPorHref(zip, opfDir, href));
        }
    });

    let mejor = null;
    for (const e of candidatas) if (!mejor || e.header.size > mejor.header.size) mejor = e;
    return mejor ? mejor.getData().toString('base64') : null;
}

/**
 * Módulo atómico: Extrae metadatos y cubiertas de un archivo EPUB.
 * Lee el EPUB como Buffer para máxima compatibilidad.
 */
export async function extraerMetadatosEpub(rutaArchivo) {
    // Añadir esta función auxiliar dentro de extraerMetadatosEpub
    function buscarPaginaCreditos(zip) {
        const archivos = zip.getEntries();
        // Buscamos patrones de nombres comunes para créditos
        const patronCreditos = /cred[i|y]ts|colophon|credits|info/i;
        
        for (const entry of archivos) {
            if (patronCreditos.test(entry.entryName)) {
                // Si es imagen, la extraemos como base64
                if (entry.entryName.match(/\.(jpg|jpeg|png)$/i)) {
                    return entry.getData().toString('base64');
                }
            }
        }
        return null;
    }

    // Limpia HTML/entidades de un texto (las descripciones EPUB suelen traer <p>…</p>).
    function limpiarTexto(t) {
        if (!t) return null;
        const limpio = t
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
            .replace(/\s+/g, ' ')
            .trim();
        return limpio || null;
    }

    return new Promise(async (resolve) => {
        try {
            const fileBuffer = await fs.readFile(rutaArchivo);
            const zip = new AdmZip(fileBuffer);

            // 1. Localizar contenedor y OPF
            const containerEntry = zip.getEntry("META-INF/container.xml");
            if (!containerEntry) throw new Error("Falta META-INF/container.xml");

            const $container = cheerio.load(containerEntry.getData().toString("utf8"), { xmlMode: true });
            const opfPath = $container("rootfile").attr("full-path");
            if (!opfPath) throw new Error("No se encontró la ruta del rootfile");

            const opfEntry = zip.getEntry(opfPath);
            if (!opfEntry) throw new Error(`Falta el archivo OPF en: ${opfPath}`);

            const opfXml = opfEntry.getData().toString("utf8");
            const $ = cheerio.load(opfXml, { xmlMode: true });
            const metadata = $('metadata');

            // 2. Extracción de metadatos básicos
            const metadatos = {
                titulo: metadata.find('dc\\:title').first().text().trim(),
                autores: metadata.find('dc\\:creator').map((i, el) => {
                    const normalizado = $(el).attr('opf:file-as');
                    return normalizado ? normalizado.trim() : $(el).text().trim();
                }).get(),
                isbn: extraerIsbnDublinCore($, metadata),
                editorial: metadata.find('dc\\:publisher').first().text().trim() || null,
                idioma: metadata.find('dc\\:language').first().text().trim().substring(0, 2).toLowerCase() || 'es',
                sinopsis: limpiarTexto(metadata.find('dc\\:description').text()),
                año_edicion: parseInt(metadata.find('dc\\:date').first().text().substring(0, 4)) || null,
                palabras_clave: metadata.find('dc\\:subject')
                    .map((i, el) => $(el).text().trim()).get()
                    .flatMap(s => s.split(',').map(x => x.trim()))
                    .filter(Boolean),
                cubierta_base64: null // Reservado para la imagen que enviaremos a Gemini
            };

            // 3. Cubierta: extracción robusta (varias convenciones; elige la imagen más grande).
            metadatos.cubierta_base64 = extraerCubiertaEpub(zip, $, opfPath);

            // 3b. Si no hay cubierta declarada, intentamos la página de créditos como imagen adicional.
            if (!metadatos.cubierta_base64) {
                metadatos.imagen_adicional = buscarPaginaCreditos(zip);
            }

            // 4. Limpieza para evitar violaciones de esquema en MongoDB
            Object.keys(metadatos).forEach(key => {
                const val = metadatos[key];
                if (val === null || val === '' || Number.isNaN(val) ||
                   (Array.isArray(val) && val.length === 0)) {
                    delete metadatos[key];
                }
            });

            // Fallback obligatorio para el título
            if (!metadatos.titulo) {
                metadatos.titulo = path.basename(rutaArchivo, '.epub');
            }

            resolve(metadatos);

        } catch (error) {
            console.warn(`⚠️ [Lector EPUB] Estructura ilegible en ${path.basename(rutaArchivo)}: ${error.message}`);
            resolve({
                titulo: path.basename(rutaArchivo, '.epub'),
                autores: [],
                idioma: 'es'
            });
        }
    });
}