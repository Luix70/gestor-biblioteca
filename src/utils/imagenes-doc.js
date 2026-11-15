/**
 * Gestión MANUAL de las imágenes (carrusel) de un documento desde la ficha: reordenar, eliminar, añadir
 * y reemplazar (resultado de editar en el cliente: rotar/recortar/perspectiva). Las imágenes nuevas/
 * editadas llegan en base64 (el navegador edita en un canvas; no hay sharp/SIMD en el NAS). Borrar/
 * reemplazar RECICLA el fichero viejo a la Papelera (recuperable). El ORDEN manda: la 1.ª es la portada.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { carpetaDeDoc, webDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { reciclar } from './papelera.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const MAX_BYTES = 25 * 1024 * 1024; // tope por imagen decodificada (defensa)

/**
 * Carga el documento con sus imágenes NORMALIZADAS: si `imagenes[]` está vacío pero tiene `portada`, la portada es la
 * primera (y única) imagen. Sin esto, una ficha con solo `portada` (74 medidas el 15-nov: libros HTML, audiolibros,
 * software, PDF antiguos) no dejaba quitar la portada («imagen no encontrada») y una imagen añadida no la sustituía.
 */
async function cargarDoc(db, id) {
    const _id = oid(id);
    const doc = _id ? await db.collection('biblioteca').findOne({ _id }) : null;
    if (doc && !(doc.imagenes || []).length && doc.portada) doc.imagenes = [{ ruta: doc.portada, tipo: 'portada', origen: 'previa' }];
    return doc;
}

/**
 * El fichero de una imagen, SOLO si es una imagen de la propia ficha: está directamente en la carpeta del documento.
 * Una imagen que vive dentro del contenido (la portada de un libro HTML en «…/images/cover.jpg», que es una página
 * del libro) no se recicla al quitarla de la ficha: es parte del libro. Antes se tomaba solo el NOMBRE del fichero
 * y se buscaba en la raíz de la carpeta, que podía ser otro fichero con el mismo nombre.
 */
function fsDe(doc, ruta) {
    const base = String(doc.ruta_base || '').replace(/\/+$/, '');
    const r = String(ruta || '');
    if (!base || !r.startsWith(base + '/')) return null;
    const resto = r.slice(base.length + 1);
    if (!resto || resto.includes('/')) return null;
    return path.join(carpetaDeDoc(doc), decodeURIComponent(resto));
}
// Recicla el fichero de una imagen de la ficha (no hace nada si no es suyo o ya no está).
async function reciclarImagen(doc, ruta, etiqueta) {
    const abs = fsDe(doc, ruta);
    if (abs) await reciclar([abs], etiqueta).catch(() => { /* fichero ya ausente */ });
}

// data URL o base64 puro → { buf, ext } (jpg|png|webp) o null.
function decodB64(b64) {
    if (!b64 || typeof b64 !== 'string') return null;
    const m = b64.match(/^data:image\/(jpe?g|png|webp);base64,(.+)$/i);
    const data = m ? m[2] : b64.replace(/^data:[^,]*,/, '');
    let buf; try { buf = Buffer.from(data, 'base64'); } catch { return null; }
    if (!buf.length || buf.length > MAX_BYTES) return null;
    const t = m ? m[1].toLowerCase() : 'jpeg';
    return { buf, ext: t === 'png' ? 'png' : t === 'webp' ? 'webp' : 'jpg' };
}

async function setImagenes(db, doc, imagenes, portada) {
    const upd = { $set: { imagenes, fecha_actualizacion: new Date() } };
    if (portada) upd.$set.portada = portada; else upd.$unset = { portada: '' };
    await db.collection('biblioteca').updateOne({ _id: doc._id }, upd);
    return { ok: true, imagenes, portada: portada || null };
}

// Reordenar: `orden` = lista de rutas en el nuevo orden. La 1.ª pasa a ser la portada.
export async function reordenarImagenes(db, id, orden = []) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const actuales = doc.imagenes || []; const porRuta = new Map(actuales.map(im => [im.ruta, im]));
    const nuevas = [];
    for (const r of orden) { const im = porRuta.get(r); if (im && !nuevas.includes(im)) nuevas.push(im); }
    for (const im of actuales) if (!nuevas.includes(im)) nuevas.push(im); // los no listados, al final
    if (!nuevas.length) return { ok: false, motivo: 'sin imágenes' };
    nuevas.forEach((im, i) => { im.tipo = i === 0 ? 'portada' : (im.tipo === 'portada' ? 'otra' : (im.tipo || 'otra')); });
    return setImagenes(db, doc, nuevas, nuevas[0].ruta);
}

// Eliminar una imagen: recicla su fichero y la quita del carrusel (recoloca la portada si hacía falta).
export async function eliminarImagen(db, id, ruta) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if (!(doc.imagenes || []).some(x => x.ruta === ruta)) return { ok: false, motivo: 'imagen no encontrada' };
    await reciclarImagen(doc, ruta, 'imagen-ficha');
    const nuevas = (doc.imagenes || []).filter(x => x.ruta !== ruta);
    if (nuevas.length) nuevas[0].tipo = 'portada';
    return setImagenes(db, doc, nuevas, nuevas[0] ? nuevas[0].ruta : null);
}

// Núcleo compartido: escribe el buffer de una imagen en la carpeta del doc y la inserta en el carrusel.
// `comoPortada` = true → va la 1.ª (portada) y la portada anterior baja a 'otra' (las demás se conservan);
// false → va al final. `origen` queda en la imagen ('manual' = la puso una persona: nada automático la sustituye).
// Devuelve el resultado de setImagenes.
async function escribirImagen(db, doc, d, comoPortada, origen = 'manual') {
    const carpeta = carpetaDeDoc(doc); await fs.mkdir(carpeta, { recursive: true });
    const nombre = `${comoPortada ? 'portada' : 'otra'}-${Date.now()}.${d.ext}`;
    await fs.writeFile(path.join(carpeta, nombre), d.buf);
    const web = `${webDeDoc(doc)}/${nombre}`;
    const previas = doc.imagenes || [];
    if (comoPortada) {
        // La entrante = portada; la portada previa (y cualquier otra marcada) baja a 'otra'; NINGUNA se borra.
        const resto = previas.map(im => ({ ...im, tipo: im.tipo === 'portada' ? 'otra' : (im.tipo || 'otra') }));
        return setImagenes(db, doc, [{ ruta: web, tipo: 'portada', origen }, ...resto], web);
    }
    const nuevas = [...previas, { ruta: web, tipo: previas.length ? 'otra' : 'portada', origen }];
    return setImagenes(db, doc, nuevas, doc.portada || web);
}

// Añadir una imagen que ya está en memoria (una portada descargada): mismo núcleo que `anadirImagen`.
// `formato` = el de medirImagen ('jpeg' | 'png' | 'webp'…).
export async function anadirImagenBuffer(db, id, buf, { formato = 'jpeg', comoPortada = false, origen = 'manual' } = {}) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if (!buf?.length || buf.length > MAX_BYTES) return { ok: false, motivo: 'imagen inválida' };
    const ext = formato === 'png' ? 'png' : formato === 'webp' ? 'webp' : 'jpg';
    return escribirImagen(db, doc, { buf, ext }, comoPortada === true, origen);
}

// Añadir una imagen nueva (base64) al carrusel. Por defecto al FINAL; con {comoPortada:true} la coloca
// la PRIMERA (portada), conservando las imágenes previas.
export async function anadirImagen(db, id, base64, opts = {}) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const d = decodB64(base64); if (!d) return { ok: false, motivo: 'imagen inválida' };
    return escribirImagen(db, doc, d, opts.comoPortada === true);
}

// Asignar la MISMA imagen de portada a una SELECCIÓN de documentos: en cada uno la imagen entrante pasa a ser
// la PORTADA (la 1.ª del carrusel) SIN borrar las imágenes que ya tuvieran (la portada anterior queda como una
// más). Escribe una copia del fichero en la carpeta de cada documento. Decodifica el base64 una sola vez.
export async function anadirPortadaLote(db, ids, base64) {
    const d = decodB64(base64); if (!d) return { ok: false, motivo: 'imagen inválida' };
    let aplicados = 0, fallidos = 0; const errores = [];
    for (const id of (Array.isArray(ids) ? ids : [])) {
        try {
            const doc = await cargarDoc(db, id);
            if (!doc) { fallidos++; continue; }
            await escribirImagen(db, doc, d, true);
            aplicados++;
        } catch (e) { fallidos++; errores.push(e.message); }
    }
    return { ok: true, aplicados, fallidos, errores: errores.slice(0, 3) };
}

// Reemplazar una imagen por su versión EDITADA (rotada/recortada/con perspectiva): escribe un fichero
// NUEVO (evita problemas de caché del navegador) y recicla el viejo.
export async function reemplazarImagen(db, id, ruta, base64) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if (!(doc.imagenes || []).some(x => x.ruta === ruta)) return { ok: false, motivo: 'imagen no encontrada' };
    const d = decodB64(base64); if (!d) return { ok: false, motivo: 'imagen inválida' };
    const carpeta = carpetaDeDoc(doc); await fs.mkdir(carpeta, { recursive: true });
    const nombre = `edit-${Date.now()}.${d.ext}`;
    await fs.writeFile(path.join(carpeta, nombre), d.buf);
    const web = `${webDeDoc(doc)}/${nombre}`;
    await reciclarImagen(doc, ruta, 'imagen-editada');
    const nuevas = (doc.imagenes || []).map(x => x.ruta === ruta ? { ...x, ruta: web } : x);
    return setImagenes(db, doc, nuevas, doc.portada === ruta ? web : (doc.portada || null));
}
