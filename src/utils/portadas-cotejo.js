/**
 * PORTADAS AL COTEJAR. Igual que el cotejo por ISBN trae título, autores o editorial, trae también la CUBIERTA:
 * reúne las candidatas de todas las fuentes (las de SU ISBN —Fichero, OpenLibrary, Amazon, Google Books— y las de su
 * título y autor —OpenLibrary, Apple Books—, que pueden ser de otra edición) y las guarda en el documento
 * (`portadas_candidatas`) para que la ficha las ofrezca: un clic y esa pasa a ser la portada.
 *
 * Solo una se pone SOLA, y solo si es de su ISBN, vertical, y la portada actual está claramente mal y no la eligió
 * una persona:
 *   · el documento no tiene portada;
 *   · la actual es APAISADA (una figura o un banner: el CHM de «Nanotechnology» tenía por portada una figura de
 *     1000×741 porque el lector cogía «la imagen más grande»);
 *   · la actual es MUY PEQUEÑA (la mitad de ancho o menos: la miniatura de 76×113 de un CHM de Safari).
 * La anterior NUNCA se borra: queda en el carrusel como una imagen más.
 *
 * Consumidores: el motor de re-identificación (`reidentificar-doc·reidentificarDoc`: «🔎 Extraer ISBN», la campaña
 * «Recuperar ISBN» y su script) y el botón «🖼️ Buscar portadas» de la ficha.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { portadasCandidatas, descargarImagen } from './portadas-isbn.js';
import { anadirImagenBuffer } from './imagenes-doc.js';
import { medirImagen } from './medir-imagen.js';
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';

const MAX_CANDIDATAS = 12;

/** ¿Tiene forma de cubierta? (más alta que ancha) */
const esVertical = (c) => !!c && c.alto > c.ancho * 1.1;

/** Medidas de la portada actual del documento, leyendo su fichero; null si no hay o no se puede medir. */
async function medirPortadaActual(doc) {
    if (!doc.portada) return null;
    const buf = await fs.readFile(path.join(carpetaDeDoc(doc), path.basename(doc.portada))).catch(() => null);
    const m = buf ? medirImagen(buf) : null;
    return m ? { ancho: m.width, alto: m.height } : null;
}

/**
 * ¿Por qué sustituir SOLA la portada actual por `mejor` (candidata de su ISBN)? Devuelve el motivo, o null si no se
 * toca. Exportada para probarla sin red ni disco.
 * @param actual  { ancho, alto } de la portada actual, o null si no se pudo medir
 */
export function motivoParaSustituir(doc, actual, mejor) {
    if (!mejor || !esVertical(mejor)) return null;
    if (!doc.portada) return 'no tenía portada';
    const imagen = (doc.imagenes || []).find((im) => im.ruta === doc.portada);
    if (imagen?.origen === 'manual') return null;                  // la eligió una persona: no se discute
    // Sin medidas no se sabe si está mal (el fichero puede estar en otro disco): no se toca.
    if (!actual) return null;
    if (actual.ancho > actual.alto * 1.05) return `la anterior era apaisada (${actual.ancho}×${actual.alto}): una figura o un banner, no una cubierta`;
    if (actual.ancho * 2 <= mejor.ancho) return `la anterior era muy pequeña (${actual.ancho}×${actual.alto})`;
    return null;
}

/**
 * Busca las portadas candidatas del documento, las guarda y, si procede, pone sola la mejor de su ISBN.
 * @param opts.isbn        ISBN del documento (el recién resuelto)
 * @param opts.titulo      título para la búsqueda por título (opcional)
 * @param opts.autor       primer autor (opcional)
 * @param opts.portadaUrl  URL de cubierta que ya dio la autoridad (el Fichero), si la hay
 * @param opts.aplicar     false = solo buscar (no escribe nada)
 * @param opts.ponerSola   false = solo guardar las candidatas, sin sustituir la portada
 * @returns {Promise<{ candidatas: Array, aplicada: null|{fuente, ancho, alto, motivo}, imagenes?, portada?, alerta? }>}
 *   `alerta` ya está añadida a `alertas_agente` en la base; se devuelve para quien vaya a reescribir esa lista.
 */
export async function cotejarPortadas(db, doc, { isbn = null, titulo = '', autor = '', portadaUrl = null, aplicar = true, ponerSola = true } = {}) {
    const candidatas = await portadasCandidatas({ isbn, titulo, autor, portadaUrl, max: MAX_CANDIDATAS }).catch(() => []);
    const resultado = { candidatas, aplicada: null };
    if (!aplicar || !candidatas.length) return resultado;   // sin candidatas se conserva la lista anterior (pudo ser la red)

    await db.collection('biblioteca').updateOne({ _id: doc._id }, {
        $set: { portadas_candidatas: candidatas, portadas_candidatas_fecha: new Date() },
    });
    if (!ponerSola) return resultado;

    // La mejor de SU ISBN con forma de cubierta (las de título pueden ser de otra edición: esas solo se ofrecen).
    const mejor = candidatas.find((c) => c.por === 'isbn' && esVertical(c));
    const motivo = motivoParaSustituir(doc, await medirPortadaActual(doc), mejor);
    if (!motivo) return resultado;

    const img = await descargarImagen(mejor.url);
    if (!img || !esVertical(img)) return resultado;          // lo descargado no es lo que se midió: no se arriesga
    const r = await anadirImagenBuffer(db, doc._id, img.buf, { formato: img.formato, comoPortada: true, origen: `remota:${mejor.fuente}` });
    if (!r?.ok) return resultado;
    resultado.alerta = `Portada por ISBN (${mejor.fuente}, ${img.ancho}×${img.alto}): ${motivo}.${doc.portada ? ' La anterior sigue en el carrusel.' : ''}`;
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $push: { alertas_agente: resultado.alerta } });
    resultado.aplicada = { fuente: mejor.fuente, ancho: img.ancho, alto: img.alto, motivo };
    resultado.imagenes = r.imagenes;
    resultado.portada = r.portada;
    return resultado;
}

/**
 * Pone como PORTADA una de las candidatas guardadas (la elegida en la ficha). Solo URLs de la lista del propio
 * documento: el servidor no descarga direcciones que le lleguen de fuera. Queda como elegida por una persona
 * (`origen: 'manual'`), así que nada automático la sustituye después.
 */
export async function elegirPortadaCandidata(db, doc, url) {
    const candidata = (doc.portadas_candidatas || []).find((c) => c.url === url);
    if (!candidata) return { ok: false, motivo: 'esa portada no está entre las candidatas del documento' };
    const img = await descargarImagen(candidata.url);
    if (!img) return { ok: false, motivo: `no se pudo descargar la portada de ${candidata.fuente}` };
    return anadirImagenBuffer(db, doc._id, img.buf, { formato: img.formato, comoPortada: true, origen: 'manual' });
}
