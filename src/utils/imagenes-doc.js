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

async function cargarDoc(db, id) { const _id = oid(id); return _id ? db.collection('biblioteca').findOne({ _id }) : null; }
const fsDe = (doc, ruta) => path.join(carpetaDeDoc(doc), path.basename(String(ruta || '')));

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
    try { await reciclar([fsDe(doc, ruta)], 'imagen-ficha'); } catch { /* fichero ya ausente */ }
    const nuevas = (doc.imagenes || []).filter(x => x.ruta !== ruta);
    if (nuevas.length) nuevas[0].tipo = 'portada';
    return setImagenes(db, doc, nuevas, nuevas[0] ? nuevas[0].ruta : null);
}

// Añadir una imagen nueva (base64) al final del carrusel.
export async function anadirImagen(db, id, base64) {
    const doc = await cargarDoc(db, id); if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const d = decodB64(base64); if (!d) return { ok: false, motivo: 'imagen inválida' };
    const carpeta = carpetaDeDoc(doc); await fs.mkdir(carpeta, { recursive: true });
    const nombre = `otra-${Date.now()}.${d.ext}`;
    await fs.writeFile(path.join(carpeta, nombre), d.buf);
    const web = `${webDeDoc(doc)}/${nombre}`;
    const nuevas = [...(doc.imagenes || []), { ruta: web, tipo: (doc.imagenes && doc.imagenes.length) ? 'otra' : 'portada', origen: 'manual' }];
    return setImagenes(db, doc, nuevas, doc.portada || web);
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
    try { await reciclar([fsDe(doc, ruta)], 'imagen-editada'); } catch { /* el viejo ya no está */ }
    const nuevas = (doc.imagenes || []).map(x => x.ruta === ruta ? { ...x, ruta: web } : x);
    return setImagenes(db, doc, nuevas, doc.portada === ruta ? web : (doc.portada || null));
}
