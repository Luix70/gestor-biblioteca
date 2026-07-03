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
import { validarISBN } from '../utils/identificadores.js';

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
    const imagenes = await leerImagenesDeDoc(doc, maxImagenes);
    if (!imagenes.length) return { ok: false, motivo: 'el documento no tiene imágenes que leer', ...vacio };

    let normalizado, calidad;
    try { ({ normalizado, calidad } = await extraerConPlantilla(imagenes)); }
    catch (e) { return { ok: false, motivo: `visión falló: ${e.message}`, ...vacio }; }
    if (!normalizado) return { ok: false, motivo: 'la visión no devolvió datos', ...vacio, calidad };

    const [edNombre, autoresActuales] = await Promise.all([nombreEditorial(db, doc), nombresAutores(db, doc)]);
    const autorEsPlaceholder = !autoresActuales.length || autoresActuales.every((n) => esAutorPlaceholder(n, edNombre));

    const balance = [];
    const propuesta = {};
    const FUENTE = 'portadilla·IA';
    const proponer = (campo, antes, despues, valor, extra = {}) => {
        propuesta[campo] = valor;
        balance.push({ campo, antes: antes ?? null, despues, fuente: FUENTE, ...extra });
    };

    // AUTORES: sustituir solo si los actuales son placeholder (o no hay) y la visión trae autores.
    if (autorEsPlaceholder && normalizado.autores.length)
        proponer('autores', autoresActuales.join(', ') || '—', normalizado.autores.join(', '), normalizado.autores);

    // CONTRIBUCIONES (roles): añadir si el doc no tenía ninguna.
    const contribs = (normalizado.contribuciones || []).filter((c) => ROLES_VALIDOS.includes(c.rol) && c.rol !== 'autor');
    if ((!doc.contribuciones || !doc.contribuciones.length) && contribs.length)
        proponer('contribuciones', '—', contribs.map((c) => `${c.nombre} (${c.rol})`).join(' · '), contribs);

    // SINOPSIS: rellenar si falta o es mucho más corta (la de la visión es parafraseada → sin RECITATION).
    if (normalizado.sinopsis && normalizado.sinopsis.length >= 60 && (!doc.sinopsis || doc.sinopsis.length < normalizado.sinopsis.length / 2))
        proponer('sinopsis', doc.sinopsis ? '(existente, más corta)' : '—', '(nueva, parafraseada)', normalizado.sinopsis);

    // ISBN: si el doc no tiene, proponer los VÁLIDOS leídos.
    if (!doc.isbn) {
        const validos = (normalizado.isbn || []).filter((x) => validarISBN(x));
        if (validos.length) proponer('isbn', '—', validos.join(', '), validos);
    }

    // Huecos simples.
    if (normalizado.idioma_original && !doc.idioma_original) proponer('idioma_original', '—', normalizado.idioma_original, normalizado.idioma_original);
    if (normalizado.palabras_clave.length && !(doc.palabras_clave || []).length) proponer('palabras_clave', '—', normalizado.palabras_clave.join(', '), normalizado.palabras_clave);
    if (normalizado['año_edicion'] && !doc['año_edicion']) proponer('año_edicion', '—', normalizado['año_edicion'], normalizado['año_edicion']);

    // Colección/obra: SUGERENCIA informativa (no se auto-agrupa para no romper colecciones/obras).
    if (normalizado.coleccion_nombre && !doc.coleccion) balance.push({ campo: 'coleccion (sugerencia)', antes: '—', despues: `${normalizado.coleccion_nombre}${normalizado.coleccion_numero ? ' · nº ' + normalizado.coleccion_numero : ''}`, fuente: FUENTE, soloSugerencia: true });
    if (normalizado.obra_titulo && !doc.obra) balance.push({ campo: 'obra (sugerencia)', antes: '—', despues: `${normalizado.obra_titulo}${normalizado.volumen_numero ? ' · vol ' + normalizado.volumen_numero : ''}`, fuente: FUENTE, soloSugerencia: true });

    const reclasificar = !doc.cdu && (!!propuesta.autores || !!propuesta.sinopsis);
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

    if (!aplicados.length) return { ok: true, aplicados: [] };

    if (reclasificar && !doc.cdu && (set.autores || set.sinopsis)) {
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
