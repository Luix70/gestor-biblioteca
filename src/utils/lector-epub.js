import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';
import { validarISBN } from './identificadores.js';
import { esTituloArtefacto } from './parsear-nombre.js';

const RE_PORTADA = /cover|portada|caratula|cubierta|frontcover/i;
const RE_RUIDO = /logo|ex_?libris|fuente|epl|brand|banner|sello/i;
const esImagenHref = (href, mt) => (mt && mt.startsWith('image/')) || /\.(jpe?g|png|gif|webp)$/i.test(href || '');

/**
 * ISBN desde Dublin Core. Recorre TODOS los dc:identifier pero solo acepta los marcados como
 * ISBN (scheme con 'isbn' o valor 'urn:isbn:'), y SIEMPRE valida el dígito de control. Esto
 * capta variantes (scheme en minúsculas, urn:isbn:, sin scheme con prefijo) y, sobre todo,
 * descarta los UUID: su hexadecimal contiene tiradas de 10 dígitos que parecen un ISBN-10.
 */
export function extraerIsbnDublinCore($, metadata) {
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

/**
 * Extrae la serie/colección del OPF. Soporta dos convenciones:
 *   - Calibre (EPUB2/3):  <meta name="calibre:series" content="…"> + calibre:series_index
 *   - EPUB3:              <meta property="belongs-to-collection" id="x">…</meta>
 *                         + <meta refines="#x" property="group-position">N</meta>
 * Normaliza el índice "10.0" → "10". Devuelve { nombre, numero } (ambos pueden ser null).
 */
// Códigos MARC relator (opf:role / EPUB3 meta property="role") → rol canónico del sistema.
const MARC_A_ROL = {
    trl: 'traductor',
    ill: 'ilustrador', pht: 'ilustrador', drm: 'ilustrador', art: 'ilustrador',
    edt: 'editor', edc: 'editor', edm: 'editor',
    aui: 'prologuista', win: 'prologuista', wpr: 'prologuista', aft: 'prologuista', wst: 'prologuista',
    ann: 'anotador',
    com: 'compilador', cmp: 'compilador',
};
// Contribuidores (traductor/ilustrador/editor/…) del OPF: dc:contributor con su rol MARC. EPUB2 usa el
// atributo `opf:role="trl"`; EPUB3 lo refina con <meta refines="#id" property="role">trl</meta>. Devuelve
// [{nombre, rol}] con NOMBRES CRUDOS (el llamador aplica repararMojibake). Fuente de archivo = fiable.
export function extraerContribucionesEpub($, metadata) {
    const out = [];
    metadata.find('dc\\:contributor').each((i, el) => {
        const $el = $(el);
        const nombre = ($el.attr('opf:file-as') || $el.text() || '').trim();
        if (!nombre) return;
        let code = ($el.attr('opf:role') || '').trim().toLowerCase();
        if (!code) {
            const id = $el.attr('id');
            if (id) code = (metadata.find(`meta[refines="#${id}"][property="role"]`).first().text() || '').trim().toLowerCase();
        }
        const rol = MARC_A_ROL[code];
        if (rol) out.push({ nombre, rol });
    });
    return out;
}

export function extraerSerieEpub($, metadata) {
    const normNum = (v) => {
        if (!v) return null;
        const s = String(v).trim();
        return s.replace(/\.0+$/, '') || null; // "10.0" → "10"; deja romanos/otros intactos
    };

    let nombre = $('meta[name="calibre:series"]').attr('content') || null;
    let numero = normNum($('meta[name="calibre:series_index"]').attr('content'));

    if (!nombre) {
        const bt = metadata.find('meta[property="belongs-to-collection"]').first();
        if (bt && bt.length) {
            nombre = bt.text().trim() || null;
            const id = bt.attr('id');
            if (id && !numero) {
                const pos = metadata.find(`meta[refines="#${id}"][property="group-position"]`).first().text().trim();
                if (pos) numero = normNum(pos);
            }
        }
    }
    return { nombre: nombre ? String(nombre).trim() : null, numero };
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

const esImagenEntry = (entry) => !!(entry && !entry.isDirectory && /\.(jpe?g|png|gif|webp)$/i.test(entry.entryName));
const extDeNombre = (n) => (/\.png$/i.test(n) ? 'png' : /\.gif$/i.test(n) ? 'gif' : /\.webp$/i.test(n) ? 'webp' : 'jpg');

/**
 * Entry de la CUBIERTA DECLARADA por alguna convención OPF (en orden de FIABILIDAD), o null. Se devuelve la
 * PRIMERA que resuelva a una imagen real —no la más grande—: la convención más fiable manda.
 *   1. EPUB3: item con properties="cover-image".
 *   2. EPUB2: <meta name="cover" content="ID"> → item[id="ID"] (ID puede llevar un punto, «cover.jpg»: por eso
 *      selector de atributo, NO $('#'+id), que interpreta el punto como clase CSS y nunca casa).
 *   3. Guía: <reference type="cover"> (suele apuntar a un XHTML con la imagen dentro).
 *   4. Heurística: primer item-imagen cuyo id/href sugiera portada (y no sea un logo/ex_libris).
 */
function coberturaDeclarada(zip, $, opfDir) {
    let e = entradaPorHref(zip, opfDir, $('manifest > item[properties~="cover-image"]').attr('href'));
    if (esImagenEntry(e)) return e;

    const coverId = $('meta[name="cover"]').attr('content');
    if (coverId) {
        const it = $('manifest > item[id="' + coverId.replace(/"/g, '\\"') + '"]').first();
        const href = it.attr('href');
        e = esImagenHref(href, it.attr('media-type')) ? entradaPorHref(zip, opfDir, href) : (href ? imagenDesdeXhtml(zip, opfDir, href) : null);
        if (esImagenEntry(e)) return e;
    }

    const refHref = $('reference[type="cover"]').attr('href');
    if (refHref) { e = esImagenHref(refHref) ? entradaPorHref(zip, opfDir, refHref) : imagenDesdeXhtml(zip, opfDir, refHref); if (esImagenEntry(e)) return e; }

    let hit = null;
    $('manifest > item').each((i, el) => {
        if (hit) return;
        const href = $(el).attr('href'); const id = $(el).attr('id') || '';
        if (esImagenHref(href, $(el).attr('media-type')) && RE_PORTADA.test(id + ' ' + href) && !RE_RUIDO.test(id + ' ' + href)) {
            const cand = entradaPorHref(zip, opfDir, href); if (esImagenEntry(cand)) hit = cand;
        }
    });
    return hit;
}

/**
 * Imágenes del EPUB EN ORDEN DE APARICIÓN (orden de LECTURA): la cubierta declarada primero, luego las imágenes
 * referenciadas por los XHTML en el orden del SPINE (y dentro de cada XHTML, en orden de documento) y, por
 * último, cualquier imagen del manifest que no hubiera aparecido. Deduplicadas. Es lo correcto para EXTRAER
 * imágenes a mano (antes salían desordenadas o —para epub— ni salían) y para elegir la portada: la cubierta
 * suele ser la 1.ª imagen del libro.
 *
 * PEREZOSO (clave en el NAS, RAM escasa): devuelve [{ entry, ext, nombre, size }] con la ENTRY del zip SIN
 * decodificar — el llamador hace `entry.getData()` SOLO de la que necesita (una portada, o la miniatura N), en
 * vez de cargar decenas de imágenes en memoria de golpe.
 */
export function imagenesEnOrdenEpub(zip, $, opfPath, { max = 120, minBytes = 256 } = {}) {
    const opfDir = path.posix.dirname(opfPath);
    const man = new Map();
    $('manifest > item').each((i, el) => { const id = $(el).attr('id'); if (id) man.set(id, { href: $(el).attr('href') || '', media: ($(el).attr('media-type') || '').toLowerCase() }); });
    const vistas = new Set();
    const salida = [];
    const addEntry = (entry) => {
        if (salida.length >= max || !esImagenEntry(entry) || vistas.has(entry.entryName) || entry.header.size < minBytes) return;
        vistas.add(entry.entryName);
        salida.push({ entry, ext: extDeNombre(entry.entryName), nombre: path.posix.basename(entry.entryName), size: entry.header.size });
    };

    addEntry(coberturaDeclarada(zip, $, opfDir));   // la cubierta declarada, primero
    // SPINE = orden de lectura. Cada itemref → un XHTML (o una imagen directa); dentro del XHTML, los <img> en orden.
    $('spine > itemref').each((i, el) => {
        if (salida.length >= max) return;
        const it = man.get($(el).attr('idref'));
        if (!it || !it.href) return;
        if (it.media.startsWith('image/')) { addEntry(entradaPorHref(zip, opfDir, it.href)); return; }
        const entry = entradaPorHref(zip, opfDir, it.href);
        if (!entry) return;
        let $$; try { $$ = cheerio.load(entry.getData().toString('utf8'), { xmlMode: true }); } catch { return; }
        const xhtmlDir = path.posix.dirname(path.posix.join(opfDir, it.href.split('#')[0]));
        $$('img, image').each((j, im) => {
            const src = $$(im).attr('src') || $$(im).attr('xlink:href') || $$(im).attr('href');
            if (src) { try { addEntry(zip.getEntry(path.posix.normalize(path.posix.join(xhtmlDir, decodeURIComponent(src.split('#')[0]))))); } catch { /* href raro */ } }
        });
    });
    // Resto de imágenes del manifest (por si alguna no está referenciada en el spine).
    $('manifest > item').each((i, el) => { if (salida.length >= max) return; const href = $(el).attr('href'); if (esImagenHref(href, ($(el).attr('media-type') || '').toLowerCase())) addEntry(entradaPorHref(zip, opfDir, href)); });
    return salida;
}

/**
 * Cubierta del EPUB: la DECLARADA por convención (fiable); si no hay ninguna, la PRIMERA imagen sustancial en
 * ORDEN DE APARICIÓN (la cubierta suele ser la 1.ª imagen del libro). Antes se cogía la MÁS GRANDE, que en un
 * libro ilustrado (SPQR y sus fotos) es una foto interior, no la portada. Devuelve base64 o null.
 */
function extraerCubiertaEpub(zip, $, opfPath) {
    const declarada = coberturaDeclarada(zip, $, path.posix.dirname(opfPath));
    if (declarada) return declarada.getData().toString('base64');
    const orden = imagenesEnOrdenEpub(zip, $, opfPath, { max: 1, minBytes: 8 * 1024 });
    return orden.length ? orden[0].entry.getData().toString('base64') : null;
}

/**
 * Abre un EPUB de disco y devuelve sus imágenes EN ORDEN DE APARICIÓN (misma forma que `leerImagenesMobi`:
 * { drm, total, imagenes:[{buf, ext}] }). Para la extracción MANUAL de imágenes / elección de portada en la
 * ficha, que hasta ahora solo funcionaba con MOBI. Nunca lanza.
 */
export async function leerImagenesEpub(ruta, { max = 120, minBytes = 256 } = {}) {
    try {
        const zip = new AdmZip(await fs.readFile(ruta));
        const cont = zip.getEntry('META-INF/container.xml');
        if (!cont) return { drm: false, total: 0, imagenes: [] };
        const opfPath = cheerio.load(cont.getData().toString('utf8'), { xmlMode: true })('rootfile').attr('full-path');
        const opf = opfPath && zip.getEntry(opfPath);
        if (!opf) return { drm: false, total: 0, imagenes: [] };
        const $ = cheerio.load(opf.getData().toString('utf8'), { xmlMode: true });
        const imagenes = imagenesEnOrdenEpub(zip, $, opfPath, { max, minBytes });
        return { drm: false, total: imagenes.length, imagenes };
    } catch { return { drm: false, total: 0, imagenes: [] }; }
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

    // Repara el "mojibake" habitual en metadatos EPUB de ePubLibre/Lectulandia: el OPF fue
    // generado con una herramienta que grabó los bytes UTF-8 como si fueran Latin-1 y luego
    // los re-codificó como UTF-8, dejando "Ã©" en vez de "é". La reparación re-interpreta
    // cada carácter JS como un byte Latin-1 y vuelve a decodificar como UTF-8.
    // Solo se aplica si el resultado no contiene caracteres de sustitución (U+FFFD),
    // lo que indicaría que el original ya era UTF-8 correcto.
    function repararMojibake(str) {
        if (!str || typeof str !== 'string') return str;
        if (!/[\xC0-\xC6\xC3]/.test(str)) return str; // sin Ã-range → casi seguro limpio
        try {
            const reparado = Buffer.from(str, 'latin1').toString('utf8');
            return reparado.includes('�') ? str : reparado;
        } catch { return str; }
    }

    // Limpia HTML/entidades de un texto (las descripciones EPUB suelen traer <p>…</p>).
    function limpiarTexto(t) {
        if (!t) return null;
        const limpio = repararMojibake(t)
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

            // Colección/serie: fuente estructurada fiable. Calibre escribe calibre:series /
            // calibre:series_index; EPUB3 usa belongs-to-collection + group-position.
            const serie = extraerSerieEpub($, metadata);

            // 2. Extracción de metadatos básicos
            const metadatos = {
                titulo: repararMojibake(metadata.find('dc\\:title').first().text().trim()),
                autores: metadata.find('dc\\:creator').map((i, el) => {
                    const normalizado = $(el).attr('opf:file-as');
                    return repararMojibake(normalizado ? normalizado.trim() : $(el).text().trim());
                }).get(),
                isbn: extraerIsbnDublinCore($, metadata),
                editorial: repararMojibake(metadata.find('dc\\:publisher').first().text().trim()) || null,
                idioma: metadata.find('dc\\:language').first().text().trim().substring(0, 2).toLowerCase() || 'es',
                sinopsis: limpiarTexto(metadata.find('dc\\:description').text()),
                año_edicion: parseInt(metadata.find('dc\\:date').first().text().substring(0, 4)) || null,
                palabras_clave: metadata.find('dc\\:subject')
                    .map((i, el) => repararMojibake($(el).text().trim())).get()
                    .flatMap(s => s.split(',').map(x => x.trim()))
                    .filter(Boolean),
                coleccion_nombre: serie.nombre ? repararMojibake(serie.nombre) : null,
                coleccion_numero: serie.numero || null,
                cubierta_base64: null // Reservado para la imagen que enviaremos a Gemini
            };

            // Contribuidores (traductor/ilustrador/editor/…) del OPF — fuente de archivo, fiable. Se
            // resuelven a personas en motor-catalogo (contribuciones_nombres → contribuciones[persona,rol]).
            const contribs = extraerContribucionesEpub($, metadata).map(c => ({ nombre: repararMojibake(c.nombre), rol: c.rol }));
            if (contribs.length) metadatos.contribuciones_nombres = contribs;

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

            // Título-artefacto del OPF (p. ej. dc:title = "…​.indd" o "Untitled"): descartarlo para
            // caer al nombre de archivo, mucho más fiable.
            if (metadatos.titulo && esTituloArtefacto(metadatos.titulo)) delete metadatos.titulo;

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
                idioma: 'es',
                recurso_ilegible: true // ZIP/OPF dañado: no se pudo abrir el EPUB → fichero defectuoso
            });
        }
    });
}