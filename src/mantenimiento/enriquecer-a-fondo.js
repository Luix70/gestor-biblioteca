/**
 * ENRIQUECIMIENTO «A FONDO» de un documento: lee las PÁGINAS del propio fichero (portada/portadilla/
 * contraportada/créditos) con la visión multi-proveedor y una PLANTILLA rica, y consolida la mejor
 * información —autores/roles reales, sinopsis, identificadores— que las APIs externas NO tienen (p. ej.
 * libros con el autor puesto a la editorial «DK»). Dos fases separadas para poder ofrecer modo SUPERVISADO
 * sin efectos colaterales:
 *   · analizarAFondo(db, doc)  → visión + BALANCE (antes/después + fuente) + calidad + `propuesta` (valores
 *     por NOMBRE). NO escribe ni crea autores → seguro para previsualizar.
 *   · aplicarAFondo(db, doc, propuesta, campos) → resuelve nombres→personas y PERSISTE solo los `campos`
 *     elegidos; des-sella re-clasificar-cdu si procede.
 *   · enriquecerAFondo(db, doc, {aplicar}) → auto (campaña): analiza y, si MERECE LA PENA, aplica todo.
 * La visión va por rotación gratis→pago; el evaluador de calidad evita gastar donde no se saca nada.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { carpetaDeDoc } from './util-mantenimiento.js';
import { extraerConPlantilla } from '../utils/plantilla-vision.js';
import { esAutorPlaceholder } from '../utils/creditos-portada.js';
import { resolverPersona } from '../utils/resolver-persona.js';
import { separarAutores } from '../utils/autor-normalizar.js';
import { ROLES_VALIDOS } from '../utils/contribuciones.js';
import { validarISBN, variantesISBN } from '../utils/identificadores.js';
import { buscarMetadatosExternos } from '../utils/proveedor-metadatos.js';

// Lee las primeras imágenes GUARDADAS del documento (páginas clave: portada + créditos + contraportada).
async function leerImagenesDeDoc(doc, max = 6) {
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return [];
    const out = [];
    for (const im of (doc.imagenes || []).slice(0, max)) {
        try { out.push({ data: await fs.readFile(path.join(carpeta, path.basename(im.ruta))), mimeType: 'image/jpeg' }); }
        catch { /* falta el fichero */ }
    }
    return out;
}

async function nombreEditorial(db, doc) {
    if (!doc.editorial || typeof doc.editorial === 'string') return doc.editorial || null;
    const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
    return e ? e.nombre : null;
}
async function nombresAutores(db, doc) {
    const ids = (doc.autores || []).filter(Boolean);
    if (!ids.length) return [];
    const docs = await db.collection('autores').find({ _id: { $in: ids } }, { projection: { nombre: 1 } }).toArray();
    return docs.map((a) => a.nombre);
}

/**
 * FASE 1 — Analiza el documento con la visión y devuelve el balance + una `propuesta` (valores por NOMBRE)
 * con SOLO los cambios sensatos según el estado actual (rellenar huecos, sustituir autor placeholder…).
 * NO escribe nada ni crea autores.
 * @returns {Promise<{ok:boolean, motivo?:string, balance:Array, calidad:object, propuesta:object, reclasificar:boolean}>}
 */
export async function analizarAFondo(db, doc, { maxImagenes = 6 } = {}) {
    const vacio = { balance: [], calidad: { puntuacion: 0, merecePena: false, señales: [] }, propuesta: {}, reclasificar: false };

    // (1) VISIÓN a partir de las páginas del propio fichero (si tiene imágenes guardadas). Opcional.
    let vis = null, calidad = { puntuacion: 0, merecePena: false, señales: [] };
    const imagenes = await leerImagenesDeDoc(doc, maxImagenes);
    if (imagenes.length) {
        try { const r = await extraerConPlantilla(imagenes); vis = r.normalizado; calidad = r.calidad; }
        catch (e) { console.warn(`   ⚠️ a-fondo visión falló: ${e.message}`); }
    }

    // (2) BÚSQUEDA EXTERNA EXTENSA por ISBN/título (Fichero + OpenLibrary + Google Books + DNB/BnF). Best-effort.
    let ext = null;
    try {
        const isbns = doc.isbn ? variantesISBN(doc.isbn) : [];
        if (isbns.length || doc.titulo)
            ext = await buscarMetadatosExternos(doc.titulo || '', '', null, {
                isbnsArchivo: isbns, incluirSinopsis: !doc.sinopsis, incluirCdu: false, idioma: doc.idioma || null,
            });
    } catch (e) { console.warn(`   ⚠️ a-fondo búsqueda externa falló: ${e.message}`); }

    if (!vis && !ext) return { ok: false, motivo: 'no se obtuvieron datos (ni de las páginas ni de las APIs)', ...vacio, calidad };

    const [edNombre, autoresActuales] = await Promise.all([nombreEditorial(db, doc), nombresAutores(db, doc)]);
    const autorEsPlaceholder = !autoresActuales.length || autoresActuales.every((n) => esAutorPlaceholder(n, edNombre));

    const balance = [];
    const propuesta = {};
    const proponer = (campo, antes, despues, valor, fuente, extra = {}) => {
        propuesta[campo] = valor;
        balance.push({ campo, antes: antes ?? null, despues, fuente, ...extra });
    };
    const primero = (...vs) => vs.find((v) => v != null && v !== '' && !(Array.isArray(v) && !v.length));

    // AUTORES: sustituir SOLO si los actuales son placeholder/ausentes, y SOLO por autores REALES.
    // Nunca se pisa un autor bueno, y NUNCA se propone un placeholder como autor (p. ej. no cambiar
    // «Alan Moore» —ni ningún autor— por «Various»/«DK»): esos se descartan del valor propuesto.
    const desdeVis = (vis && vis.autores || []).filter((n) => !esAutorPlaceholder(n, edNombre));
    const desdeExt = (ext && ext.autores || []).filter((n) => !esAutorPlaceholder(n, edNombre));
    const autoresNuevos = desdeVis.length ? desdeVis : desdeExt;
    if (autorEsPlaceholder && autoresNuevos.length)
        proponer('autores', autoresActuales.join(', ') || '—', autoresNuevos.join(', '), autoresNuevos, desdeVis.length ? 'portadilla·IA' : 'Fichero/APIs');

    // CONTRIBUCIONES (roles): unir visión + APIs (la mención de la BNE también trae roles), si el doc no tenía.
    if (!doc.contribuciones || !doc.contribuciones.length) {
        const deVis = (vis && vis.contribuciones || []).filter((c) => ROLES_VALIDOS.includes(c.rol) && c.rol !== 'autor');
        const deExt = (ext && ext.contribuciones_nombres || []).filter((c) => ROLES_VALIDOS.includes(c.rol) && c.rol !== 'autor');
        const merged = []; const seen = new Set();
        for (const c of [...deExt, ...deVis]) { const k = `${c.nombre.toLowerCase()}|${c.rol}`; if (seen.has(k)) continue; seen.add(k); merged.push(c); }
        if (merged.length) proponer('contribuciones', '—', merged.map((c) => `${c.nombre} (${c.rol})`).join(' · '), merged, deVis.length ? 'portadilla·IA + APIs' : 'Fichero/APIs');
    }

    // SINOPSIS: SOLO si falta (anti-pérdida: nunca se reemplaza una existente). La de la visión es
    // parafraseada (anti-RECITATION); si no, la de las APIs.
    const sinNueva = primero(vis && vis.sinopsis && vis.sinopsis.length >= 60 ? vis.sinopsis : null, ext && ext.sinopsis);
    if (sinNueva && !doc.sinopsis)
        proponer('sinopsis', '—', '(nueva)', sinNueva, (vis && vis.sinopsis) ? 'portadilla·IA' : 'APIs');

    // ISBN (si falta): leído de la portada o de las APIs.
    if (!doc.isbn) {
        const validos = [...new Set([...((vis && vis.isbn) || []), ...(ext && ext.isbn ? [ext.isbn] : [])])].filter((x) => validarISBN(x));
        if (validos.length) proponer('isbn', '—', validos.join(', '), validos, (vis && vis.isbn && vis.isbn.length) ? 'portadilla·IA' : 'APIs');
    }

    // EDITORIAL / AÑO / IDIOMA ORIGINAL / PALABRAS CLAVE / DEWEY-LCC (para re-clasificar) — huecos, de las APIs.
    if (ext) {
        if (ext.editorial && !doc.editorial) proponer('editorial', '—', ext.editorial, ext.editorial, 'APIs');
        if (ext['año_edicion'] && !doc['año_edicion']) proponer('año_edicion', '—', ext['año_edicion'], ext['año_edicion'], 'APIs');
        if (ext.idioma_original && !doc.idioma_original) proponer('idioma_original', '—', ext.idioma_original, ext.idioma_original, 'APIs');
        if (ext.categorias?.length && !(doc.palabras_clave || []).length) proponer('palabras_clave', '—', ext.categorias.join(', '), ext.categorias, 'APIs');
        if (!doc.cdu && (ext.dewey || ext.lcc)) proponer('clasificacion', '—', [ext.dewey && `Dewey ${ext.dewey}`, ext.lcc && `LCC ${ext.lcc}`].filter(Boolean).join(' · '), { dewey: ext.dewey || null, lcc: ext.lcc || null }, 'APIs');
    } else if (vis) {
        if (vis.idioma_original && !doc.idioma_original) proponer('idioma_original', '—', vis.idioma_original, vis.idioma_original, 'portadilla·IA');
        if (vis.palabras_clave.length && !(doc.palabras_clave || []).length) proponer('palabras_clave', '—', vis.palabras_clave.join(', '), vis.palabras_clave, 'portadilla·IA');
        if (vis['año_edicion'] && !doc['año_edicion']) proponer('año_edicion', '—', vis['año_edicion'], vis['año_edicion'], 'portadilla·IA');
    }

    // Colección/obra: SUGERENCIA informativa (no se auto-agrupa para no romper colecciones/obras).
    const colN = primero(vis && vis.coleccion_nombre, ext && ext.coleccion_nombre);
    if (colN && !doc.coleccion) balance.push({ campo: 'coleccion (sugerencia)', antes: '—', despues: colN, fuente: 'IA/APIs', soloSugerencia: true });
    if (vis && vis.obra_titulo && !doc.obra) balance.push({ campo: 'obra (sugerencia)', antes: '—', despues: `${vis.obra_titulo}${vis.volumen_numero ? ' · vol ' + vis.volumen_numero : ''}`, fuente: 'portadilla·IA', soloSugerencia: true });

    // Calidad: si no hubo visión, puntúa por la riqueza de lo propuesto (para el veredicto merece-la-pena).
    if (!vis) {
        const n = Object.keys(propuesta).length;
        calidad = { puntuacion: Math.min(100, n * 18), merecePena: n >= 2, señales: Object.keys(propuesta) };
    }
    const reclasificar = !doc.cdu && (!!propuesta.autores || !!propuesta.sinopsis || !!propuesta.clasificacion);
    return { ok: true, balance, calidad, propuesta, reclasificar };
}

/**
 * FASE 2 — Aplica los `campos` elegidos de una `propuesta` (resuelve nombres→personas y persiste).
 * @param {string[]} campos  subconjunto de claves de `propuesta` a aplicar (por defecto, todas).
 * @returns {Promise<{ok:boolean, aplicados:string[]}>}
 */
export async function aplicarAFondo(db, doc, propuesta = {}, campos = null, { reclasificar = false } = {}) {
    const elegidos = Array.isArray(campos) && campos.length ? campos : Object.keys(propuesta);
    const set = {};
    const aplicados = [];

    if (elegidos.includes('autores') && Array.isArray(propuesta.autores)) {
        const ids = []; const vistos = new Set();
        for (const bruto of propuesta.autores)
            for (const nombre of separarAutores(bruto)) {
                const r = await resolverPersona(db, nombre);
                if (r && !vistos.has(String(r._id))) { vistos.add(String(r._id)); ids.push(r._id); }
            }
        if (ids.length) { set.autores = ids; aplicados.push('autores'); }
    }
    if (elegidos.includes('contribuciones') && Array.isArray(propuesta.contribuciones)) {
        const out = []; const vistos = new Set();
        for (const c of propuesta.contribuciones) {
            if (!ROLES_VALIDOS.includes(c.rol) || c.rol === 'autor') continue;
            const r = await resolverPersona(db, c.nombre);
            if (!r) continue;
            const clave = `${String(r._id)}|${c.rol}`;
            if (vistos.has(clave)) continue;
            vistos.add(clave);
            out.push({ persona: r._id, rol: c.rol });
        }
        if (out.length) { set.contribuciones = out; aplicados.push('contribuciones'); }
    }
    if (elegidos.includes('sinopsis') && propuesta.sinopsis) { set.sinopsis = propuesta.sinopsis; aplicados.push('sinopsis'); }
    if (elegidos.includes('isbn') && Array.isArray(propuesta.isbn) && propuesta.isbn.length) {
        const validos = propuesta.isbn.filter((x) => validarISBN(x));
        if (validos.length) {
            set.isbn = validos[0];
            const extra = validos.slice(1).map((isbn) => ({ isbn, rol: 'otra' }));
            if (extra.length) set.isbns_alternativos = [...(doc.isbns_alternativos || []), ...extra];
            aplicados.push('isbn');
        }
    }
    if (elegidos.includes('idioma_original') && propuesta.idioma_original) { set.idioma_original = propuesta.idioma_original; aplicados.push('idioma_original'); }
    if (elegidos.includes('palabras_clave') && Array.isArray(propuesta.palabras_clave) && propuesta.palabras_clave.length) { set.palabras_clave = propuesta.palabras_clave; aplicados.push('palabras_clave'); }
    if (elegidos.includes('año_edicion') && propuesta['año_edicion']) { set['año_edicion'] = propuesta['año_edicion']; aplicados.push('año_edicion'); }
    // EDITORIAL (nombre → ObjectId, check-then-create). Solo si el doc no tenía (anti-pérdida).
    if (elegidos.includes('editorial') && propuesta.editorial && !doc.editorial) {
        const nombre = String(propuesta.editorial).trim();
        const ex = await db.collection('editoriales').findOne({ nombre });
        set.editorial = ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
        aplicados.push('editorial');
    }
    // CLASIFICACIÓN: guarda Dewey/LCC (para que re-clasificar-cdu deduzca la CDU) si faltaba la CDU.
    if (elegidos.includes('clasificacion') && propuesta.clasificacion && !doc.cdu) {
        if (propuesta.clasificacion.dewey && !doc.dewey) set.dewey = String(propuesta.clasificacion.dewey).trim();
        if (propuesta.clasificacion.lcc && !doc.lcc) set.lcc = String(propuesta.clasificacion.lcc).trim();
        if (set.dewey || set.lcc) aplicados.push('clasificacion');
    }

    if (!aplicados.length) return { ok: true, aplicados: [] };

    if (reclasificar && !doc.cdu && (set.autores || set.sinopsis || set.dewey || set.lcc)) {
        set['mantenimiento.re-clasificar-cdu'] = 0;
        set.mantenimiento_firma = 'pendiente-a-fondo';
    }
    set.fecha_actualizacion = new Date();
    set.alertas_agente = [...(doc.alertas_agente || []), `Enriquecido a fondo (visión): ${aplicados.join(', ')}.`];
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
    return { ok: true, aplicados };
}

/**
 * AUTO (campaña): analiza y, si MERECE LA PENA, aplica TODO lo propuesto.
 * @returns {Promise<{ok:boolean, motivo?:string, balance:Array, calidad:object, aplicado:boolean}>}
 */
export async function enriquecerAFondo(db, doc, { aplicar = false, maxImagenes = 6 } = {}) {
    const a = await analizarAFondo(db, doc, { maxImagenes });
    if (!a.ok) return { ...a, aplicado: false };
    let aplicado = false;
    if (aplicar && a.calidad.merecePena && Object.keys(a.propuesta).length) {
        await aplicarAFondo(db, doc, a.propuesta, null, { reclasificar: a.reclasificar });
        aplicado = true;
    }
    return { ok: true, balance: a.balance, calidad: a.calidad, aplicado, reclasificar: a.reclasificar };
}
