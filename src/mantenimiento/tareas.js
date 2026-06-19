import fs from 'fs/promises';
import path from 'path';
import { medirImagen } from '../utils/medir-imagen.js';
import { resolverPortada } from '../utils/resolver-portada.js';
import { rasterizarPaginas } from '../utils/rasterizar-pdf.js';
import { extraerMetadatosEpub } from '../utils/lector-epub.js';
import { carpetaDeDoc, webDeDoc, archivoOriginal, numeroPaginasPdf, escribirImagen, EXT_DOC, DIR_CDU, carpetaExiste, moverCarpetaConVerificacion } from './util-mantenimiento.js';
import { rutaCatalogo } from '../utils/rutas.js';
import { buscarEnBNE } from '../utils/buscador-bne.js';
import { buscarEnDNB } from '../utils/buscador-dnb.js';
import { resolverCDU } from '../clasificador-cdu.js';

const ANCHO_OBJETIVO = Number(process.env.PORTADA_ANCHO_OBJETIVO || 1000);

const tipoDeArchivo = (ruta) => {
    const ext = path.extname(ruta || '').toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    return EXT_DOC.includes(ext) ? 'otro-formato' : null;
};

const urlPortadaOpenLibrary = (isbn) =>
    `https://covers.openlibrary.org/b/isbn/${String(isbn).replace(/-/g, '')}-L.jpg?default=false`;

/**
 * REGISTRO DE TAREAS DE MANTENIMIENTO.
 * Cada tarea: { id, version, descripcion, aplica(doc), ejecutar(doc, ctx) -> cambio|null }.
 * 'cambio' = { set?, imagenesNuevas?, alertas?, carpetaNueva? }.
 *   carpetaNueva: si la tarea movió la carpeta CDU, indicar la ruta nueva para que
 *   aplicarCambio escriba registro.json en el sitio correcto.
 * Subir 'version' fuerza re-pasar la tarea por todos los documentos.
 * Las tareas se ejecutan EN ORDEN: re-clasificar-cdu va primera para que portada y
 * sidecars trabajen ya sobre la carpeta final.
 */
export const TAREAS = [

    {
        id: 're-clasificar-cdu',
        version: 1,
        descripcion: 'Re-clasifica la CDU con el pipeline BNE→DNB→caché→IA y mueve los ficheros al nuevo árbol si cambió.',
        aplica: (_doc) => true,

        async ejecutar(doc, { db }) {
            const isbn = doc.isbn || null;

            // ── Paso 1: BNE (autoridad más fiable para fondos hispanos) ──────────────
            let cduNueva = null, cduAdicionales = [], fuente = null;
            if (isbn) {
                const recBNE = await buscarEnBNE(isbn);
                if (recBNE?.cdus?.length > 0) {
                    [cduNueva] = recBNE.cdus;
                    cduAdicionales = recBNE.cdus.slice(1);
                    fuente = 'BNE';
                }
            }

            // ── Paso 2: DNB → equivalencias_cdu cache/IA (si BNE no resolvió) ──────
            if (!cduNueva) {
                let dewey = doc.dewey || null;
                let lcc   = doc.lcc   || null;
                if (!dewey && !lcc && isbn) {
                    const infoDNB = await buscarEnDNB({ isbn });
                    if (infoDNB) { dewey = infoDNB.dewey; lcc = infoDNB.lcc; }
                }
                if (dewey || lcc) {
                    // Resolver autor: un único lookup indexado mejora la clasificación de ficción.
                    let autorNombre = null;
                    if (doc.autores?.length > 0) {
                        const autorDoc = await db.collection('autores')
                            .findOne({ _id: doc.autores[0] }, { projection: { nombre: 1 } });
                        if (autorDoc) autorNombre = autorDoc.nombre;
                    }
                    const { cdu, fuente: f } = await resolverCDU({
                        dewey, lcc,
                        categorias: doc.palabras_clave || [],
                        titulo: doc.titulo,
                        autor: autorNombre,
                        sinopsis: doc.sinopsis,
                    });
                    if (cdu && cdu !== '000') { cduNueva = cdu; fuente = `clasificador:${f}`; }
                }
            }

            // ── Sin resolución: mantener CDU actual ──────────────────────────────────
            if (!cduNueva) return null;

            // ── Misma CDU: solo actualizar adicionales si cambiaron ──────────────────
            if (cduNueva === doc.cdu) {
                const mismos = JSON.stringify(cduAdicionales) === JSON.stringify(doc.cdu_adicionales || []);
                if (mismos) return null;
                return { set: { cdu_adicionales: cduAdicionales } };
            }

            // ── CDU cambió: mover la carpeta ─────────────────────────────────────────
            const carpetaVieja = carpetaDeDoc(doc);
            const existeVieja  = await carpetaExiste(carpetaVieja);

            const rcNueva     = rutaCatalogo({ cdu: cduNueva, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id });
            const carpetaNueva = path.join(DIR_CDU, rcNueva.relativa);

            if (existeVieja && carpetaNueva !== carpetaVieja) {
                // Colisión: el destino ya existe (otro registro con el mismo CDU+ISBN)
                if (await carpetaExiste(carpetaNueva)) {
                    console.warn(`   ⚠️  re-clasificar-cdu: colisión en "${rcNueva.relativa}"; CDU actualizada en BD pero ficheros NO movidos.`);
                    const set = { cdu: cduNueva };
                    if (cduAdicionales.length) set.cdu_adicionales = cduAdicionales;
                    return { set, alertas: [`CDU actualizada a "${cduNueva}" [${fuente}]; carpeta destino ya existía — ficheros no movidos.`] };
                }

                // Archivos enlazados en la BD: basenames para verificación tras copia.
                const archivosEnBD = [
                    doc.portada   ? path.basename(doc.portada)   : null,
                    ...(doc.imagenes || []).map(im => path.basename(im.ruta)),
                ].filter(Boolean);

                await moverCarpetaConVerificacion(carpetaVieja, carpetaNueva, archivosEnBD);
            }

            // ── Recalcular todas las rutas internas que llevaban el prefijo viejo ────
            const rutaBaseVieja = webDeDoc(doc);      // '/recursos/old_cdu/libros/isbn'
            const rutaBaseNueva = rcNueva.web;         // '/recursos/new_cdu/libros/isbn'
            const remap = (p) => p && p.startsWith(rutaBaseVieja)
                ? rutaBaseNueva + p.slice(rutaBaseVieja.length)
                : p;

            const set = { cdu: cduNueva, ruta_base: rutaBaseNueva };
            if (cduAdicionales.length)    set.cdu_adicionales = cduAdicionales;
            if (doc.portada)              set.portada  = remap(doc.portada);
            if (doc.imagenes?.length)     set.imagenes = doc.imagenes.map(im => ({ ...im, ruta: remap(im.ruta) }));

            return {
                set,
                carpetaNueva: existeVieja ? carpetaNueva : null,
                alertas: [`CDU actualizada: "${doc.cdu}" → "${cduNueva}" [${fuente}]${existeVieja ? '; ficheros movidos.' : ' (sin carpeta — solo BD).'}`],
            };
        },
    },


    {
        id: 'completar-nombre-archivo',
        version: 1,
        descripcion: 'Rellena nombre_archivo con el nombre real del fichero en la carpeta CDU.',
        aplica: (doc) => !doc.nombre_archivo,
        async ejecutar(doc) {
            const carpeta = carpetaDeDoc(doc);
            const original = await archivoOriginal(carpeta);
            if (!original) return null;
            return { set: { nombre_archivo: path.basename(original) } };
        },
    },

    {
        id: 'revisar-portada',
        version: 1,
        descripcion: 'Si la portada falta o es de baja calidad, la re-resuelve (embebida / remota / rasterizado).',
        // No se tocan los libros escaneados (formato 'papel'): su portada es la foto auténtica
        // que escaneó el usuario; no la sustituimos por una imagen remota.
        aplica: (doc) => !(doc.formatos || []).includes('papel'),
        async ejecutar(doc) {
            const carpeta = carpetaDeDoc(doc);

            // 1. Medir la portada actual.
            let anchoActual = 0;
            if (doc.portada) {
                const buf = await fs.readFile(path.join(carpeta, path.basename(doc.portada))).catch(() => null);
                const m = buf && medirImagen(buf);
                if (m) anchoActual = m.width;
            }
            if (anchoActual >= ANCHO_OBJETIVO) return null; // ya es buena

            // 2. Reunir fuentes y re-resolver.
            const original = await archivoOriginal(carpeta);
            const tipo = tipoDeArchivo(original);
            let embebida = null, numPaginas = 2;
            if (tipo === 'epub') {
                embebida = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64 || null;
            } else if (tipo === 'pdf') {
                numPaginas = (await numeroPaginasPdf(original)) || 2;
            }
            const remotos = doc.isbn ? [{ origen: 'openlibrary', url: urlPortadaOpenLibrary(doc.isbn) }] : [];

            const { portada } = await resolverPortada({
                tipo: tipo || 'otro-formato',
                rutas: original ? [original] : [],
                numPaginas, embebidaBase64: embebida, remotos,
            });
            if (!portada || portada.ancho <= anchoActual) return null; // no mejora

            const buffer = Buffer.from(portada.base64, 'base64');

            // 3a. Ya había portada: se sobrescribe el mismo fichero (la ruta no cambia).
            if (doc.portada) {
                await fs.writeFile(path.join(carpeta, path.basename(doc.portada)), buffer);
                return { alertas: [`Portada mejorada por mantenimiento (${anchoActual || 0}→${portada.ancho}px).`] };
            }
            // 3b. No había: se crea y se referencia.
            const { web } = await escribirImagen(carpeta, webDeDoc(doc), buffer, 'portada');
            return {
                set: { portada: web },
                imagenesNuevas: [{ ruta: web, tipo: 'portada', origen: portada.origen }],
                alertas: [`Portada añadida por mantenimiento (${portada.ancho}px).`],
            };
        },
    },

    {
        id: 'generar-sidecars-pdf',
        version: 1,
        descripcion: 'Rasteriza y guarda las 5 primeras páginas + la última de los PDF que no las tengan.',
        aplica: (doc) => Array.isArray(doc.formatos) && doc.formatos.includes('pdf'),
        async ejecutar(doc) {
            const yaPdf = (doc.imagenes || []).filter(im => /^pdf:/.test(im.origen || '')).length;
            if (yaPdf >= 6) return null; // ya tiene el juego completo

            const carpeta = carpetaDeDoc(doc);
            const original = await archivoOriginal(carpeta);
            if (!original || tipoDeArchivo(original) !== 'pdf') return null;

            const numPaginas = (await numeroPaginasPdf(original)) || 5;
            const paginas = [1, 2, 3, 4, 5].filter(p => p <= numPaginas);
            if (numPaginas > 5) paginas.push(numPaginas);

            const renders = await rasterizarPaginas(original, { paginas, ancho: 1600 });
            if (!renders.length) return null; // sin poppler

            const existentes = new Set((doc.imagenes || []).map(im => im.origen));
            const web = webDeDoc(doc);
            const imagenesNuevas = [];
            for (const r of renders) {
                const origen = `pdf:${r.etiqueta}`;
                if (existentes.has(origen)) continue; // ya estaba
                const { web: rutaImg } = await escribirImagen(carpeta, web, r.buffer, r.etiqueta === 'portada' ? 'portada' : `pdfpag-${r.pagina}`);
                imagenesNuevas.push({ ruta: rutaImg, tipo: r.etiqueta === 'portada' ? 'portada' : 'otra', origen });
            }
            if (!imagenesNuevas.length) return null;
            return { imagenesNuevas, alertas: [`${imagenesNuevas.length} página(s) PDF añadidas como sidecar por mantenimiento.`] };
        },
    },
];
