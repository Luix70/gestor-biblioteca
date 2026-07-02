/**
 * SANEAR-CATÁLOGO — re-deriva el catálogo con el pipeline ACTUAL para deshacer el daño de ingestas
 * antiguas (carpetas con '#', portadas que faltan, cómics mal archivados como obra). Complementa a
 * integridad.js (que arregla la ESTRUCTURA: huérfanos, dups por hash, ramas muertas): sanear arregla
 * el CONTENIDO/colocación. NO PIERDE DATOS: mover = rename atómico / copia+verificación; lo que se
 * retira va a la Papelera; el re-ingreso copia ANTES a un staging y solo recicla la carpeta vieja.
 *
 * Tareas:
 *   T1 RE-HOME  (sin red): docs con caracteres rompe-URL (#, %, control) en ruta_base → mover a la ruta
 *      saneada (1 doc ↔ 1 carpeta), actualizar ruta_base/portada/imagenes y regenerar sidecars.
 *   T2 PORTADA  (sin red): docs con fichero presente pero SIN portada (o portada perdida) → re-extraer
 *      y materializar la cubierta (cómic/PDF).
 *   T3 RE-CLASIFICAR (solo con reclasificar=true; puede usar APIs/visión): cómics mal archivados como
 *      tomo de obra → re-ingerir EN SITIO por el pipeline (tipo/ruta/portada/naturaleza correctos).
 *
 * Dry-run por defecto. El panel lo lanza en 2º plano (lanzarSaneador / estadoSaneador).
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from './database.js';
import { carpetaDeDoc, moverCarpetaConVerificacion } from './mantenimiento/util-mantenimiento.js';
import { rutaCatalogo } from './utils/rutas.js';
import { resolverPortada } from './utils/resolver-portada.js';
import { extraerMetadatosComic } from './utils/lector-comic.js';
import { aRegistroLegible, escribirSidecars, resolverNombres } from './utils/registro.js';
import { eliminarDocumento } from './utils/reproceso.js';
import { ingestarRecurso } from './servicio-ingesta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const dirEnv = (env, def) => { const v = process.env[env] || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = dirEnv('PATH_CDU', 'CDU');

const RE_ROTO = new RegExp('[#%\\u0000-\\u001f]');             // rompe la URL de /recursos (#, %, control)
const EXT_PORTADA = new Set(['.cbz', '.cbr', '.cb7', '.pdf']); // de estos sé re-extraer cubierta sin red
const existe = (p) => p ? fs.access(p).then(() => true).catch(() => false) : Promise.resolve(false);
const absDe = (web) => (web && web.startsWith('/recursos/')) ? path.join(DIR_CDU, web.slice('/recursos/'.length)) : null;

const PROY = { titulo: 1, ruta_base: 1, nombre_archivo: 1, formatos: 1, portada: 1, imagenes: 1, cdu: 1,
    tipo_recurso: 1, isbn: 1, issn: 1, isbn_obra: 1, naturaleza: 1, obra: 1, obra_titulo: 1, coleccion: 1,
    'año_edicion': 1, mes_publicacion: 1, volumen_numero: 1, paginas: 1, autores: 1, editorial: 1,
    subtitulo: 1, sinopsis: 1, idioma: 1 };

// ── estado para el panel (un saneo a la vez) ──
let trabajo = { en_curso: false, fase: null, total: 0, hechos: 0, ts: null, informe: null, error: null };
export function estadoSaneador() { return { ...trabajo }; }

/** ¿La carpeta destino ya pertenece a OTRO documento? (lee su registro.json). */
async function ocupadaPorOtro(carpeta, miId) {
    try { const reg = JSON.parse(await fs.readFile(path.join(carpeta, 'registro.json'), 'utf8')); return !!reg._id && String(reg._id) !== String(miId); }
    catch { return false; }
}

function argsRuta(doc) {
    return { cdu: doc.cdu, tipo_recurso: doc.tipo_recurso, isbn: doc.isbn, issn: doc.issn, id: doc._id,
        'año_edicion': doc.año_edicion, mes_publicacion: doc.mes_publicacion, titulo: doc.titulo,
        obra: doc.obra ? (doc.isbn_obra || doc.obra_titulo || String(doc.obra)) : null, volumen_numero: doc.volumen_numero };
}

/** T1 — mueve la carpeta del doc a la ruta SANEADA (sin '#'/%/control) y actualiza la BD + sidecars. */
async function reHome(db, doc) {
    const col = db.collection('biblioteca');
    let rc = rutaCatalogo(argsRuta(doc));
    if (rc.web === doc.ruta_base) return false;                 // ya estaba limpia
    let destAbs = path.join(DIR_CDU, rc.relativa);
    if (await existe(destAbs) && await ocupadaPorOtro(destAbs, doc._id)) {
        rc = rutaCatalogo({ ...argsRuta(doc), discriminador: String(doc._id).slice(-6) });
        destAbs = path.join(DIR_CDU, rc.relativa);
    }
    const oldAbs = absDe(doc.ruta_base) || carpetaDeDoc(doc);
    if (!(await existe(oldAbs))) return false;                  // sin carpeta en disco → asunto de integridad
    const archivosBD = [doc.portada && path.basename(doc.portada), ...((doc.imagenes || []).map(i => path.basename(i.ruta)))].filter(Boolean);
    await moverCarpetaConVerificacion(oldAbs, destAbs, archivosBD); // rename atómico / copia+verifica (sin pérdida)

    const set = { ruta_base: rc.web };
    if (doc.portada) set.portada = doc.portada.replace(doc.ruta_base, rc.web);
    if (Array.isArray(doc.imagenes)) set.imagenes = doc.imagenes.map(i => ({ ...i, ruta: String(i.ruta).replace(doc.ruta_base, rc.web) }));
    await col.updateOne({ _id: doc._id }, { $set: set });
    try {
        const docF = { ...doc, ...set };
        const { autores, editorial, contribuciones } = await resolverNombres(db, docF);
        await escribirSidecars(destAbs, aRegistroLegible(docF, { autores, editorial, contribuciones }));
    } catch { /* sidecars best-effort */ }
    return true;
}

/** T2 — re-extrae y materializa la cubierta de un doc que la perdió (cómic/PDF). */
async function recuperarPortada(db, doc) {
    const carpeta = absDe(doc.ruta_base) || carpetaDeDoc(doc);
    const file = (carpeta && doc.nombre_archivo) ? path.join(carpeta, doc.nombre_archivo) : null;
    if (!file || !(await existe(file))) return false;
    const ext = path.extname(doc.nombre_archivo).toLowerCase();
    let embebida = null, tipo = 'otro';
    if (['.cbz', '.cbr', '.cb7'].includes(ext)) { embebida = (await extraerMetadatosComic(file)).cubierta_base64 || null; tipo = 'comic'; }
    else if (ext === '.pdf') tipo = 'pdf';
    else return false;
    const { portada } = await resolverPortada({ tipo, rutas: [file], numPaginas: doc.paginas || 2, embebidaBase64: embebida });
    if (!portada) return false;
    await fs.writeFile(path.join(carpeta, 'portada-1.jpg'), Buffer.from(portada.base64, 'base64'));
    const ruta = `${doc.ruta_base}/portada-1.jpg`;
    const imagenes = [{ ruta, tipo: 'portada', origen: portada.origen }, ...((doc.imagenes || []).filter(im => im.ruta !== ruta))];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: { portada: ruta, imagenes } });
    return true;
}

/** T3 — re-ingiere el fichero del doc EN SITIO por el pipeline actual (sin pérdida: staging + Papelera). */
async function reIngerirEnSitio(db, doc) {
    const carpeta = absDe(doc.ruta_base) || carpetaDeDoc(doc);
    const file = (carpeta && doc.nombre_archivo) ? path.join(carpeta, doc.nombre_archivo) : null;
    if (!file || !(await existe(file))) return { ok: false, motivo: 'sin fichero' };
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sanear-'));
    const staged = path.join(tmp, doc.nombre_archivo);
    try {
        await fs.copyFile(file, staged);                       // copia ANTES de tocar nada
        await eliminarDocumento(db, doc);                       // borra doc + desvincula + recicla carpeta vieja (Papelera)
        const r = await ingestarRecurso({ rutas: [staged], contexto: {} }); // re-cataloga limpio
        return { ok: !!r && !r.error };
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Diagnostica (y, con ejecutar=true, sanea) el catálogo. Devuelve un informe estructurado.
 * @param {{ejecutar?:boolean, reclasificar?:boolean, limite?:number, onProgress?:Function}} opts
 */
export async function sanearCatalogo({ ejecutar = false, reclasificar = false, limite = Infinity, onProgress = null } = {}) {
    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const docs = await col.find({}, { projection: PROY }).limit(Number.isFinite(limite) ? limite : 0).toArray();
    onProgress?.({ total: docs.length });

    const D = { rehome: 0, portada: 0, reclasificar: 0 };
    const H = { rehome: 0, portada: 0, reclasificar: 0, errores: 0 };
    const M = { rehome: [], portada: [], reclasificar: [] };
    const muestra = (k, doc) => { if (M[k].length < 12) M[k].push({ id: String(doc._id), titulo: doc.titulo || null, ruta: doc.ruta_base || null }); };

    let hechos = 0;
    for (const doc of docs) {
        const esReclass = doc.naturaleza === 'comic' && !!doc.obra;        // cómic mal archivado como obra
        const esRehome = RE_ROTO.test(doc.ruta_base || '');
        const ext = doc.nombre_archivo ? path.extname(doc.nombre_archivo).toLowerCase() : '';
        const carpeta = absDe(doc.ruta_base);
        const portValida = !!doc.portada && await existe(absDe(doc.portada));
        const fileExiste = !!(doc.nombre_archivo && carpeta && await existe(path.join(carpeta, doc.nombre_archivo)));
        const esPortada = !portValida && fileExiste && EXT_PORTADA.has(ext);

        if (esReclass) { D.reclasificar++; muestra('reclasificar', doc); }
        if (esRehome) { D.rehome++; muestra('rehome', doc); }
        if (esPortada) { D.portada++; muestra('portada', doc); }

        if (ejecutar) {
            try {
                if (esReclass && reclasificar) {
                    const r = await reIngerirEnSitio(db, doc); r.ok ? H.reclasificar++ : H.errores++;
                } else {
                    if (esRehome && await reHome(db, doc)) H.rehome++;
                    // tras re-home la ruta cambió: recargar el doc para recuperar la portada en el sitio nuevo
                    if (esPortada) { const d2 = esRehome ? (await col.findOne({ _id: doc._id }, { projection: PROY })) : doc; if (d2 && await recuperarPortada(db, d2)) H.portada++; }
                }
            } catch (e) { H.errores++; console.warn(`   ⚠️  sanear ${doc._id}: ${e.message}`); }
            await new Promise(r => setTimeout(r, (esReclass && reclasificar) ? 800 : 40)); // ritmo (re-ingesta cede más)
        }
        hechos++; onProgress?.({ hechos });
    }
    return { ts: new Date().toISOString(), ejecutar, reclasificar, total: docs.length, diagnostico: D, hecho: ejecutar ? H : null, muestras: M };
}

/** Lanza el saneo en SEGUNDO PLANO (para el panel). Devuelve de inmediato; progreso en estadoSaneador(). */
export function lanzarSaneador({ reclasificar = false } = {}) {
    if (trabajo.en_curso) return { ok: false, motivo: 'ya hay un saneo en curso' };
    trabajo = { en_curso: true, fase: 'saneando', total: 0, hechos: 0, ts: new Date().toISOString(), informe: null, error: null, reclasificar: !!reclasificar };
    (async () => {
        try {
            const inf = await sanearCatalogo({ ejecutar: true, reclasificar, onProgress: (p) => { if (p.total != null) trabajo.total = p.total; if (p.hechos != null) trabajo.hechos = p.hechos; } });
            trabajo.informe = inf;
        } catch (e) { trabajo.error = e.message; }
        finally { trabajo.en_curso = false; trabajo.fase = 'hecho'; }
    })();
    return { ok: true };
}
