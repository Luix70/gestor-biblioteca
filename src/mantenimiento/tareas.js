import fs from 'fs/promises';
import path from 'path';
import { medirImagen } from '../utils/medir-imagen.js';
import { resolverPortada } from '../utils/resolver-portada.js';
import { rasterizarPaginas } from '../utils/rasterizar-pdf.js';
import { extraerMetadatosEpub } from '../utils/lector-epub.js';
import { carpetaDeDoc, webDeDoc, archivoOriginal, numeroPaginasPdf, escribirImagen, EXT_DOC } from './util-mantenimiento.js';

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
 * 'cambio' = { set?, imagenesNuevas?, alertas? }. Subir 'version' fuerza re-pasar la tarea
 * por todos los documentos. Añadir una tarea futura = agregar un objeto a este array.
 */
export const TAREAS = [
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
        aplica: () => true,
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
