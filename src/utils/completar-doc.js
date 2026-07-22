/**
 * COMPLETAR un documento YA catalogado — adjuntarle los ficheros que le faltaban: el PDF/EPUB de un audiolibro
 * que solo tenía audio, o los audios de un libro que solo tenía texto. Es la cara «a posteriori» de la ingesta:
 * la biblioteca real se completa por partes (primero aparece el audio, meses después el texto).
 *
 * Los ficheros se COPIAN a la carpeta del propio documento y se registran EN ÉL:
 *   · audio → `audios[]`  (playlist del reproductor de la ficha)
 *   · texto → `textos[]`  (selector del visor: PDF / EPUB / anexo…)
 *   · lo demás → se queda en la carpeta como material (visible en «🗂️ Archivos»), sin visor.
 * El árbol se protege con `ruta_fija` para que Integridad no pode lo añadido.
 *
 * `textos[]` es SIMÉTRICO a `audios[]` ({ruta,titulo,formato,orden}) y RETROCOMPATIBLE: `nombre_archivo` sigue
 * siendo el texto PRINCIPAL (el que abre el visor por defecto); al añadir un 2º texto se SIEMBRA `textos[]` con
 * el que ya había, para que el selector los ofrezca todos. El $jsonSchema está abierto → no requiere setup-mongo.
 *
 * PRINCIPIO: solo AÑADE. Nunca borra ni pisa un fichero existente (si el nombre choca, se renombra « (2)»).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { carpetaDeDoc, DIR_CDU, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { esAudio } from './lector-audio.js';
import { indexarDoc } from './indice-busqueda.js';

// Textos ABRIBLES en el visor de la ficha (los que sabe abrir `initLector`), ext → formato del $jsonSchema.
const FORMATO_TEXTO = {
    '.pdf': 'pdf', '.epub': 'epub', '.mobi': 'mobi', '.azw': 'mobi', '.azw3': 'mobi',
    '.djvu': 'djvu', '.djv': 'djvu', '.cbz': 'cbz', '.cbr': 'cbr', '.cb7': 'cb7', '.chm': 'chm',
    '.docx': 'docx', '.doc': 'doc',
};
const formatoDe = (n) => FORMATO_TEXTO[path.extname(n).toLowerCase()] || null;
const esTexto = (n) => !!formatoDe(n);

const webDe = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');
const tituloDe = (n) => path.basename(n, path.extname(n)).replace(/[_.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

/** Nombre libre en `dir`: NUNCA se pisa un fichero existente (solo añadimos). */
async function nombreLibre(dir, nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let destino = path.join(dir, nombre);
    for (let i = 2; await fs.access(destino).then(() => true, () => false); i++) destino = path.join(dir, `${base} (${i})${ext}`);
    return destino;
}

// Limpia una ruta RELATIVA subida (webkitRelativePath): quita «..», rutas absolutas y segmentos vacíos → nunca
// escribe fuera de la carpeta del documento. Devuelve la ruta con el separador del sistema.
function sanearRel(rel) {
    const partes = String(rel || '')
        .split(/[\\/]+/)
        .map((s) => s.trim())
        .filter((s) => s && s !== '.' && s !== '..');
    return partes.join(path.sep);
}
// Ruta libre PRESERVANDO subcarpetas: si «Software/bin/run.exe» ya existe, prueba «Software/bin/run (2).exe».
async function rutaLibrePreservando(base, rel) {
    const destino0 = path.join(base, rel);
    if (!(await fs.access(destino0).then(() => true, () => false))) return destino0;
    const ext = path.extname(rel);
    const sinExt = rel.slice(0, rel.length - ext.length);
    for (let i = 2; ; i++) {
        const d = path.join(base, `${sinExt} (${i})${ext}`);
        if (!(await fs.access(d).then(() => true, () => false))) return d;
    }
}

/**
 * ADJUNTAR MATERIAL VERBATIM a un documento YA catalogado: una CARPETA entera (software de ejemplo, datasets)
 * o un fichero suelto (un PDF con la crítica del libro), encontrados DESPUÉS de ingerir. Se copian a la carpeta
 * del documento CONSERVANDO su estructura de subcarpetas, y quedan visibles en «🗂️ Archivos» y en la sección
 * «📎 Material» de la ficha. A diferencia de `completarDoc` (que clasifica cada fichero como audio/texto/visor),
 * aquí NADA se interpreta: es material que ACOMPAÑA al libro, tal cual. Solo AÑADE; nunca pisa (renombra « (2)»).
 * @param items [{ ruta: <abs temporal>, rel: <ruta relativa que preserva la carpeta, p. ej. "Soft/bin/x.exe"> }]
 */
export async function adjuntarMaterial(db, id, { items = [] } = {}) {
    if (!ObjectId.isValid(String(id))) return { ok: false, motivo: 'id inválido' };
    if (!items.length) return { ok: false, motivo: 'no se recibió nada que adjuntar' };
    const bib = db.collection('biblioteca');
    const doc = await bib.findOne({ _id: new ObjectId(String(id)) });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return { ok: false, motivo: 'el documento no tiene carpeta (ruta_base) donde adjuntar' };
    await fs.mkdir(carpeta, { recursive: true });

    const topNuevos = new Set();   // elementos de primer nivel (carpeta o fichero) que se han añadido
    let copiados = 0;
    for (const it of items) {
        const rel = sanearRel(it.rel);
        if (!rel) continue;
        const destino = await rutaLibrePreservando(carpeta, rel);
        try {
            await fs.mkdir(path.dirname(destino), { recursive: true });
            await fs.copyFile(it.ruta, destino);
            copiados++;
            topNuevos.add(rel.split(path.sep)[0]);
        } catch (e) {
            console.warn(`[Adjuntar] no se pudo copiar «${rel}»: ${e.message}`);
        }
    }
    if (!copiados) return { ok: false, motivo: 'no se pudo copiar ningún fichero' };

    // `material_adjunto` es el CONTADOR de la sección «📎 Material» (lo fija también la ingesta transmedia). Se
    // SUMA el nº de elementos de primer nivel nuevos. `ruta_fija` + marcador = Integridad no lo poda y el
    // explorador de la ficha sube hasta la raíz y lo muestra.
    const material = (Number(doc.material_adjunto) || 0) + topNuevos.size;
    await bib.updateOne({ _id: doc._id }, { $set: { ruta_fija: true, material_adjunto: material, fecha_actualizacion: new Date() } });
    await fs.writeFile(path.join(carpeta, MARCA_RUTA_FIJA), `material adjunto: ${doc.titulo || doc._id}\n`).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => { /* índice best-effort */ });
    return { ok: true, _id: String(doc._id), copiados, elementos: topNuevos.size, material_adjunto: material };
}

/**
 * Adjunta `ficheros` (ya subidos a un temporal) al documento `id`.
 * @param ficheros  [{ ruta: <abs del temporal>, nombre: <nombre original> }]
 * @param naturaleza 'audiolibro' → reclasifica a audiolibro; 'libro' → deja de serlo; null → no toca.
 */
export async function completarDoc(db, id, { ficheros = [], naturaleza = null } = {}) {
    if (!ObjectId.isValid(String(id))) return { ok: false, motivo: 'id inválido' };
    if (!ficheros.length) return { ok: false, motivo: 'no se recibió ningún fichero' };

    const bib = db.collection('biblioteca');
    const doc = await bib.findOne({ _id: new ObjectId(String(id)) });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return { ok: false, motivo: 'el documento no tiene carpeta (ruta_base) donde adjuntar' };
    await fs.mkdir(carpeta, { recursive: true });

    // Estado actual: se AMPLÍA, nunca se pisa.
    const audios = [...(doc.audios || [])];
    const textos = [...(doc.textos || [])];
    // Siembra retrocompatible: el texto principal que ya tenía el doc entra el PRIMERO en `textos[]`, para que
    // el selector del visor lo siga ofreciendo junto a los nuevos.
    if (!textos.length && doc.nombre_archivo && doc.ruta_base && esTexto(doc.nombre_archivo)) {
        textos.push({
            ruta: `${doc.ruta_base}/${doc.nombre_archivo}`,
            titulo: tituloDe(doc.nombre_archivo),
            formato: formatoDe(doc.nombre_archivo),
            orden: 1,
        });
    }

    const anadidos = { audio: 0, texto: 0, material: 0 };
    for (const f of ficheros) {
        const nombre = path.basename(f.nombre || f.ruta || '');
        if (!nombre) continue;
        const destino = await nombreLibre(carpeta, nombre);
        try {
            await fs.copyFile(f.ruta, destino);
        } catch (e) {
            console.warn(`[Completar] no se pudo copiar «${nombre}»: ${e.message}`);
            continue;
        }
        const web = webDe(destino);
        const nomFinal = path.basename(destino);
        if (esAudio(nomFinal)) { audios.push({ ruta: web, titulo: tituloDe(nomFinal), orden: audios.length + 1 }); anadidos.audio++; }
        else if (esTexto(nomFinal)) { textos.push({ ruta: web, titulo: tituloDe(nomFinal), formato: formatoDe(nomFinal), orden: textos.length + 1 }); anadidos.texto++; }
        else anadidos.material++;   // sin visor: se queda como material en la carpeta («🗂️ Archivos»)
    }
    if (!anadidos.audio && !anadidos.texto && !anadidos.material)
        return { ok: false, motivo: 'no se pudo copiar ningún fichero' };

    // `formatos` (enum del $jsonSchema): unión de lo que ya había + audio + el formato de cada texto.
    const formatos = new Set(doc.formatos || []);
    if (anadidos.audio) formatos.add('audio');
    for (const t of textos) if (t.formato) formatos.add(t.formato);

    const set = { formatos: [...formatos], ruta_fija: true, fecha_actualizacion: new Date() };
    if (audios.length) set.audios = audios.map((a, i) => ({ ...a, orden: i + 1 }));
    if (textos.length) set.textos = textos.map((t, i) => ({ ...t, orden: i + 1 }));
    // Si el doc no tenía texto principal (audiolibro puro) y ahora sí, el 1º pasa a abrir el visor.
    if (!doc.nombre_archivo && textos.length) set.nombre_archivo = path.basename(textos[0].ruta);
    // Destino elegido en el diálogo: el audio puede o no convertir la obra en audiolibro (un manual con audio
    // de apoyo NO es un audiolibro; una novela leída sí). Si no se pide nada, la naturaleza no se toca.
    if (naturaleza === 'audiolibro') set.naturaleza = 'audiolibro';
    else if (naturaleza === 'libro' && doc.naturaleza === 'audiolibro') set.naturaleza = null;

    await bib.updateOne({ _id: doc._id }, { $set: set });
    // Marcador del árbol preservado: el explorador de la ficha sube hasta él y muestra TODO lo adjuntado, e
    // Integridad deja de considerar «huérfanos» los ficheros nuevos de la carpeta.
    await fs.writeFile(path.join(carpeta, MARCA_RUTA_FIJA), `completado: ${doc.titulo || doc._id}\n`).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => { /* índice best-effort */ });

    return {
        ok: true, _id: String(doc._id), anadidos,
        audios: audios.length, textos: textos.length, formatos: [...formatos],
        naturaleza: set.naturaleza !== undefined ? set.naturaleza : (doc.naturaleza || null),
    };
}
