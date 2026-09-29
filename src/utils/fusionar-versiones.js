/**
 * FUSIONAR VERSIONES — un libro catalogado varias veces (mismo ISBN, mismo formato, mismo título; ficheros
 * ligeramente distintos: otro escaneo, otra conversión, una revisión) pasa a ser UN documento.
 *
 * Decisión del usuario (2026-09-29): se CONSERVAN TODOS LOS FICHEROS y solo se fusiona solo lo SEGURO; el resto va a
 * selecciones para revisar a mano.
 *
 *   · PRINCIPAL: el que más trabajo tuyo lleva (valoración, CDU manual, notas…), después el más completo, el fichero
 *     más grande y, a igualdad, el más antiguo (conserva su id: enlaces, etiquetas NFC).
 *   · DATOS: el principal HEREDA todo lo que le falte de los demás (sinopsis, materias, contribuciones, año,
 *     páginas…); nunca se pisa lo que ya tiene.
 *   · FICHEROS: los de las otras versiones se MUEVEN a la carpeta del principal y quedan en `versiones[]` (nombre,
 *     hash, tamaño, páginas, documento de origen). Sus hashes se siguen reconociendo si vuelven por el Inbox.
 *   · REFERENCIAS: selecciones, fichas de lectura y el inventario de su colección pasan a apuntar al principal; el
 *     id retirado queda en `redirecciones` (la ficha lo abre en el principal: enlaces y NFC siguen valiendo).
 *   · LO DEMÁS de la carpeta retirada (imágenes derivadas, sidecars) va a la Papelera; las imágenes añadidas a mano
 *     pasan al carrusel del principal.
 *
 * SEGURO (reglas del usuario) = mismo ISBN, los MISMOS formatos (un EPUB y un PDF nunca se fusionan), mismo título,
 * ninguno tomo de una obra ni con distinto nº de colección (tomos de una colección comparten portada), sin indicios
 * de TOMO distinto en el nombre/título, sin ISBN provisional/dudoso, páginas conocidas en todos y a ±2, TAMAÑO de
 * fichero parecido (±25 %: un escaneo a otra resolución se conserva como documento aparte) y como mucho 5 versiones
 * (más suele ser un ISBN compartido). TÍTULOS DISTINTOS con el mismo ISBN no son versiones: el ISBN está mal.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal } from '../mantenimiento/util-mantenimiento.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { reciclarCarpeta } from './papelera.js';
import { indexarDoc, desindexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';

const MAX_SEGURO = 5;      // versiones por grupo para fusionar solo
const TOL_PAGINAS = 2;     // diferencia de páginas admitida
const TOL_TAMANO = 0.25;   // diferencia de tamaño de fichero admitida (fracción del mayor)

// ── Clasificar un grupo ────────────────────────────────────────────────────────────────────────────────

const RE_DIAC = new RegExp(String.raw`[̀-ͯ]`, 'g');
/** Título principal comparable (sin subtítulo, acentos ni signos). */
const tituloBase = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIAC, '')
    .split(/\s[:.\-–—(]\s?|:\s/)[0].replace(/[^a-z0-9]/g, '');
const mismoTitulo = (a, b) => {
    const x = tituloBase(a), y = tituloBase(b);
    if (!x || !y) return false;
    const n = Math.min(15, x.length, y.length);
    return x.slice(0, n) === y.slice(0, n);
};
// Indicio de TOMO/volumen en el nombre de fichero o el título («Vol. 3», «Tomo II», «Book 2», «Part 1»).
const RE_TOMO = new RegExp(String.raw`\b(?:vol(?:ume|umen)?|tomo|t|book|libro|part|parte|band)\.?\s*(\d{1,3}|[ivxlc]{1,6})\b`, 'i');
const tomoDe = (d) => {
    const m = RE_TOMO.exec(`${d.titulo || ''} ${d.nombre_archivo || ''}`);
    return m ? m[1].toLowerCase() : null;
};

/** Los formatos de un documento, como texto comparable («epub+pdf»). */
const formatosDe = (d) => [...new Set(d.formatos || [])].sort().join('+');

/**
 * ¿Qué es este grupo (mismo ISBN y formato principal)? `tamanos` = Map id→bytes del fichero de cada uno.
 * @returns {{ clase: 'seguro'|'revisar'|'isbn-compartido', motivo: string }}
 */
export function clasificarGrupo(docs, { tamanos = null } = {}) {
    const titulos = docs.map((d) => d.titulo);
    if (!titulos.every((t) => mismoTitulo(t, titulos[0]))) {
        return { clase: 'isbn-compartido', motivo: 'títulos distintos con el mismo ISBN: el ISBN está mal en alguno' };
    }
    if (new Set(docs.map(formatosDe)).size > 1) return { clase: 'revisar', motivo: 'formatos distintos (no se fusionan)' };
    if (docs.some((d) => d.obra)) return { clase: 'revisar', motivo: 'alguno es tomo de una obra' };
    // Solo cuenta si hay DOS números distintos: que uno tenga nº de colección y el otro no, no dice nada.
    const numsCol = new Set(docs.map((d) => String(d.coleccion_numero || '').trim()).filter(Boolean));
    if (numsCol.size > 1) return { clase: 'revisar', motivo: 'distinto nº de colección (¿tomos de una colección?)' };
    if (docs.length > MAX_SEGURO) return { clase: 'revisar', motivo: `${docs.length} versiones: posible ISBN compartido` };
    if (docs.some((d) => d.isbn_provisional || d.isbn_dudoso)) return { clase: 'revisar', motivo: 'ISBN provisional o dudoso' };
    const tomos = new Set(docs.map(tomoDe).filter(Boolean));
    if (tomos.size > 1 || (tomos.size === 1 && docs.some((d) => !tomoDe(d)))) return { clase: 'revisar', motivo: 'posibles tomos distintos' };
    const pags = docs.map((d) => parseInt(d.paginas, 10));
    if (pags.some((p) => !p)) return { clase: 'revisar', motivo: 'páginas desconocidas en alguno' };
    if (Math.max(...pags) - Math.min(...pags) > TOL_PAGINAS) return { clase: 'revisar', motivo: `páginas distintas (${Math.min(...pags)}–${Math.max(...pags)})` };
    if (tamanos) {
        const t = docs.map((d) => tamanos.get(String(d._id)));
        if (t.some((x) => !x)) return { clase: 'revisar', motivo: 'falta el fichero de alguno' };
        const mayor = Math.max(...t), menor = Math.min(...t);
        if ((mayor - menor) / mayor > TOL_TAMANO) {
            return { clase: 'revisar', motivo: `tamaños muy distintos (${(menor / 1048576).toFixed(1)}–${(mayor / 1048576).toFixed(1)} MB: ¿otra resolución?)` };
        }
    }
    return { clase: 'seguro', motivo: 'mismo ISBN, formatos, título, páginas y tamaño' };
}

/** Grupos de documentos con el mismo ISBN y el mismo formato principal (2 o más). */
export async function gruposDeVersiones(db, { isbn = null } = {}) {
    const match = { isbn: isbn || { $exists: true, $nin: [null, ''] }, tipo_recurso: 'libro' };
    return db.collection('biblioteca').aggregate([
        { $match: match },
        { $project: { isbn: 1, titulo: 1, paginas: 1, obra: 1, nombre_archivo: 1, isbn_provisional: 1, isbn_dudoso: 1, fecha_ingreso: 1,
            formatos: 1, coleccion_numero: 1, ruta_base: 1, f: { $arrayElemAt: ['$formatos', 0] } } },
        { $group: { _id: { isbn: '$isbn', f: '$f' }, docs: { $push: '$$ROOT' } } },
        { $match: { 'docs.1': { $exists: true } } },
    ], { allowDiskUse: true }).toArray();
}

/** Map id → tamaño en bytes del fichero de cada documento (null si no está). */
export async function tamanosDe(docs) {
    const m = new Map();
    for (const d of docs) {
        const f = d.nombre_archivo ? await archivoOriginal(carpetaDeDoc(d), d.nombre_archivo).catch(() => null) : null;
        const st = f ? await fs.stat(f).catch(() => null) : null;
        m.set(String(d._id), st ? st.size : null);
    }
    return m;
}

// ── Elegir el principal ────────────────────────────────────────────────────────────────────────────────

const vacio = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const CAMPOS_COMPLETITUD = ['sinopsis', 'autores', 'editorial', 'paginas', 'año_edicion', 'portada', 'dewey', 'lcc', 'subtitulo', 'palabras_clave', 'contribuciones'];

function puntosPrincipal(d, tamano) {
    const humano = (d.valoracion ? 3 : 0) + (d.cdu_manual ? 3 : 0) + (d.notas ? 2 : 0)
        + ((d.imagenes || []).some((im) => im?.origen === 'manual') ? 1 : 0) + (d.dimensiones_medidas ? 1 : 0);
    const completo = CAMPOS_COMPLETITUD.filter((c) => !vacio(d[c])).length
        + (d.estado_verificacion === 'completado' ? 2 : 0) + (/^0+$/.test(String(d.cdu || '0')) ? 0 : 1);
    return [humano, completo, tamano || 0, -(new Date(d.fecha_ingreso || 0).getTime())];
}

// ── Fusionar ───────────────────────────────────────────────────────────────────────────────────────────

// Campos que NO se heredan: identidad y ficheros del propio documento, estado interno de mantenimiento.
const NO_HEREDAR = new Set(['_id', 'ruta_base', 'nombre_archivo', 'hash_contenido', 'hash_fecha', 'hash_mtime', 'hash_tamano',
    'hashes_anteriores', 'imagenes', 'portada', 'fecha_ingreso', 'fecha_actualizacion', 'mantenimiento', 'mantenimiento_firma',
    'campanas', 'alertas_agente', 'versiones', 'sidecars_fecha', 'ediciones_candidatas', 'ediciones_candidatas_fecha',
    'archivos_originales', 'audios', 'ruta_fija', 'estado_verificacion', 'formatos', 'recuperar_isbn_intentos',
    'recuperar_isbn_ultimo_intento', 'edicion_ultimo_intento', 'textos']);

/** Nombre libre en `dir` para `nombre` (si ya existe: «X (versión 2).pdf», «X (versión 3).pdf»…). */
async function nombreLibre(dir, nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    for (let k = 1; k < 100; k++) {
        const cand = k === 1 ? nombre : `${base} (versión ${k})${ext}`;
        try { await fs.access(path.join(dir, cand)); } catch { return cand; }
    }
    return `${base} (versión ${Date.now()})${ext}`;
}

/** Mueve un fichero (rename; entre volúmenes, copia verificada + borrado). */
async function mover(origen, destino) {
    try { await fs.rename(origen, destino); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
    await fs.copyFile(origen, destino);
    const [a, b] = await Promise.all([fs.stat(origen), fs.stat(destino)]);
    if (a.size !== b.size) throw new Error('copia incompleta');
    await fs.rm(origen, { force: true });
}

/**
 * Fusiona los documentos `ids` en uno. Devuelve { ok, principal, retirados, versiones, motivo? }.
 * `aplicar=false` → solo dice qué haría.
 */
export async function fusionarDocumentos(db, ids, { aplicar = true } = {}) {
    const col = db.collection('biblioteca');
    const docs = await col.find({ _id: { $in: ids.map((x) => (typeof x === 'string' ? new ObjectId(x) : x)) } }).toArray();
    if (docs.length < 2) return { ok: false, motivo: 'hacen falta al menos dos documentos' };
    if (new Set(docs.map(formatosDe)).size > 1) return { ok: false, motivo: 'tienen formatos distintos (un EPUB y un PDF no se fusionan)' };

    // Fichero de cada uno (para el tamaño y para moverlo).
    const fichero = new Map();
    for (const d of docs) {
        const f = d.nombre_archivo ? await archivoOriginal(carpetaDeDoc(d), d.nombre_archivo).catch(() => null) : null;
        const st = f ? await fs.stat(f).catch(() => null) : null;
        fichero.set(String(d._id), st ? { ruta: f, tamano: st.size } : null);
    }
    const orden = [...docs].sort((a, b) => {
        const pa = puntosPrincipal(a, fichero.get(String(a._id))?.tamano), pb = puntosPrincipal(b, fichero.get(String(b._id))?.tamano);
        for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
    });
    const principal = orden[0];
    const otros = orden.slice(1);
    const resumen = { ok: true, principal: { id: String(principal._id), titulo: principal.titulo }, retirados: otros.map((d) => String(d._id)), versiones: [] };
    if (!aplicar) return resumen;

    const carpetaP = carpetaDeDoc(principal);
    if (!carpetaP) return { ok: false, motivo: 'el principal no tiene carpeta' };
    await fs.mkdir(carpetaP, { recursive: true });

    const set = {};
    const union = { palabras_clave: new Set(principal.palabras_clave || []) };
    let contribuciones = [...(principal.contribuciones || [])];
    const versiones = [...(principal.versiones || [])];
    // Selector de textos del visor (`textos[]`): el principal primero y cada versión después, para poder abrirlas
    // desde la ficha.
    const textos = [...(principal.textos || [])];
    const formatoDe = (n) => path.extname(n).slice(1).toLowerCase();
    if (!textos.length && principal.nombre_archivo && principal.ruta_base) {
        textos.push({ ruta: `${principal.ruta_base}/${principal.nombre_archivo}`, titulo: `Principal${principal.paginas ? ` · ${principal.paginas} págs.` : ''}`, formato: formatoDe(principal.nombre_archivo), orden: 1 });
    }
    const imagenesExtra = [];
    const alertas = [];

    for (const o of otros) {
        // 1) Datos: lo que al principal le falte.
        for (const [k, v] of Object.entries(o)) {
            if (NO_HEREDAR.has(k) || vacio(v)) continue;
            if (k === 'palabras_clave') { for (const x of v) union.palabras_clave.add(x); continue; }
            if (k === 'contribuciones') {
                for (const c of v) if (!contribuciones.some((x) => String(x.persona) === String(c.persona) && x.rol === c.rol)) contribuciones.push(c);
                continue;
            }
            if (vacio(principal[k]) && vacio(set[k])) set[k] = v;
        }
        // 2) Fichero → carpeta del principal, como versión.
        const f = fichero.get(String(o._id));
        if (f) {
            const hashO = o.hash_contenido || await calcularHashArchivo(f.ruta).catch(() => null);
            if (hashO && hashO === principal.hash_contenido) {
                alertas.push(`Versión ${o._id}: fichero IDÉNTICO al principal (no se duplica).`);
            } else {
                const destinoNombre = await nombreLibre(carpetaP, o.nombre_archivo);
                await mover(f.ruta, path.join(carpetaP, destinoNombre));
                const st = await fs.stat(path.join(carpetaP, destinoNombre)).catch(() => null);
                versiones.push({
                    nombre_archivo: destinoNombre, hash_contenido: hashO || null, tamano: st?.size || f.tamano,
                    paginas: o.paginas || null, titulo: o.titulo || null, doc_origen: o._id,
                    fecha_ingreso: o.fecha_ingreso || null, fecha_fusion: new Date(),
                });
                resumen.versiones.push(destinoNombre);
                textos.push({
                    ruta: `${principal.ruta_base}/${destinoNombre}`,
                    titulo: `Versión ${versiones.length + 1}${o.paginas ? ` · ${o.paginas} págs.` : ''}${st?.size ? ` · ${(st.size / 1048576).toFixed(1)} MB` : ''}`,
                    formato: formatoDe(destinoNombre), orden: textos.length + 1, version: true,
                });
            }
        } else alertas.push(`Versión ${o._id}: sin fichero en disco (solo se heredan sus datos).`);
        // 3) Imágenes añadidas A MANO: al carrusel del principal (las derivadas se regeneran; van a la Papelera).
        for (const im of (o.imagenes || []).filter((x) => x?.origen === 'manual')) {
            const orig = path.join(carpetaDeDoc(o), path.basename(im.ruta));
            const nombre = await nombreLibre(carpetaP, path.basename(im.ruta));
            try {
                await fs.copyFile(orig, path.join(carpetaP, nombre));
                imagenesExtra.push({ ...im, ruta: `${principal.ruta_base}/${nombre}`, tipo: 'otra' });
            } catch { /* la imagen no está: nada que conservar */ }
        }
        // 4) Referencias → principal.
        await db.collection('selecciones').updateMany({ docs: o._id }, { $addToSet: { docs: principal._id } });
        await db.collection('selecciones').updateMany({ docs: o._id }, { $pull: { docs: o._id } });
        await db.collection('fichas_lectura').updateMany({ ambito: 'documento', ref: o._id }, { $set: { ref: principal._id } });
        if (o.coleccion) {
            await db.collection('colecciones').updateOne({ _id: o.coleccion }, { $pull: { numeros: { _id: o._id }, numeros_sin_fecha: o._id } });
        }
        await db.collection('redirecciones').updateOne({ _id: o._id }, { $set: { a: principal._id, motivo: 'fusión de versiones', fecha: new Date() } }, { upsert: true });
        // Si otros documentos redirigían a este, ahora al principal.
        await db.collection('redirecciones').updateMany({ a: o._id }, { $set: { a: principal._id } });
        // 5) Retirar el documento; su carpeta (ya sin el fichero) a la Papelera.
        await col.deleteOne({ _id: o._id });
        await desindexarDoc(o._id).catch(() => {});
        const carpetaO = carpetaDeDoc(o);
        if (carpetaO && path.resolve(carpetaO) !== path.resolve(carpetaP)) {
            const otroUsa = await col.findOne({ ruta_base: o.ruta_base }, { projection: { _id: 1 } });
            if (!otroUsa) await reciclarCarpeta(carpetaO, `fusion-${principal._id}`, path.basename(path.dirname(carpetaO))).catch(() => null);
        }
    }

    if (union.palabras_clave.size > (principal.palabras_clave || []).length) set.palabras_clave = [...union.palabras_clave];
    if (contribuciones.length > (principal.contribuciones || []).length) set.contribuciones = contribuciones;
    set.versiones = versiones;
    if (textos.length > 1) set.textos = textos;
    set.fecha_actualizacion = new Date();
    if (otros.some((o) => o.estado_verificacion === 'completado') && principal.estado_verificacion !== 'completado') set.estado_verificacion = 'completado';
    const update = {
        $set: set,
        $push: { alertas_agente: { $each: [`Fusionadas ${otros.length} versión(es) del mismo libro (mismo ISBN y formato): ${otros.map((o) => o._id).join(', ')}. Sus ficheros se conservan como versiones.`, ...alertas] } },
    };
    if (imagenesExtra.length) update.$push.imagenes = { $each: imagenesExtra };
    await col.updateOne({ _id: principal._id }, update);
    const act = await col.findOne({ _id: principal._id });
    await regenerarSidecarsDoc(db, act, carpetaP).catch(() => {});
    await indexarDoc(db, principal._id).catch(() => {});
    return resumen;
}

// ── LOTE en 2º plano (acción «🔗 Fusionar versiones» sobre una selección) ────────────────────────────────

let trabajo = { en_curso: false, fase: '', resultado: null, error: null };
export function estadoFusion() { return { ...trabajo }; }

/** Fusiona los documentos elegidos en el panel (los que tú has decidido que son el mismo libro). */
export function lanzarFusion({ ids } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay una fusión en curso' };
    const lista = (Array.isArray(ids) ? ids : String(ids || '').split(',')).map((x) => String(x).trim()).filter((x) => ObjectId.isValid(x));
    if (lista.length < 2) return { ok: false, motivo: 'elige al menos dos documentos' };
    trabajo = { en_curso: true, fase: 'fusionando', resultado: null, error: null };
    (async () => {
        try { trabajo.resultado = await fusionarDocumentos(await conectarDB(), lista); }
        catch (e) { trabajo.error = e.message; }
        finally { trabajo.en_curso = false; }
    })();
    return { ok: true, total: lista.length };
}
