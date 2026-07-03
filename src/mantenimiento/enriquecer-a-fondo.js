/**
 * ENRIQUECIMIENTO «A FONDO» de un documento: lee las PÁGINAS del propio fichero (portada/portadilla/
 * contraportada/créditos) con la visión multi-proveedor y una PLANTILLA rica, y consolida la mejor
 * información —autores/roles reales, sinopsis, identificadores, colección/obra— que las APIs externas NO
 * tienen (p. ej. libros con el autor puesto a la editorial «DK»). Construye un BALANCE (antes/después + de
 * dónde sale cada dato) y, si la extracción MERECE LA PENA, lo aplica (conservador con los datos buenos ya
 * existentes; agresivo solo con los placeholder/huecos). Si cambia/faltaba la CDU, des-sella re-clasificar
 * para que el Conformador re-archive la carpeta.
 *
 * Se usa como CAMPAÑA de fondo (auto, al reposo, con umbral merecePena) y —en el futuro— desde un botón
 * supervisado en la ficha. La visión va por rotación gratis→pago; el evaluador de calidad evita gastar en
 * documentos donde no se saca nada.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { carpetaDeDoc } from './util-mantenimiento.js';
import { extraerConPlantilla } from '../utils/plantilla-vision.js';
import { esAutorPlaceholder } from '../utils/creditos-portada.js';
import { resolverPersona } from '../utils/resolver-persona.js';
import { separarAutores } from '../utils/autor-normalizar.js';
import { ROLES_VALIDOS } from '../utils/contribuciones.js';
import { variantesISBN, validarISBN } from '../utils/identificadores.js';

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

// Nombre de la editorial del doc (para detectar «autor == editorial»).
async function nombreEditorial(db, doc) {
    if (!doc.editorial || typeof doc.editorial === 'string') return doc.editorial || null;
    const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
    return e ? e.nombre : null;
}

// Nombres actuales de los autores del doc (para saber si son placeholder).
async function nombresAutores(db, doc) {
    const ids = (doc.autores || []).filter(Boolean);
    if (!ids.length) return [];
    const docs = await db.collection('autores').find({ _id: { $in: ids } }, { projection: { nombre: 1 } }).toArray();
    return docs.map((a) => a.nombre);
}

/**
 * Enriquece a fondo UN documento.
 * @param {*} db
 * @param {*} doc  documento de biblioteca
 * @param {{aplicar?:boolean, maxImagenes?:number}} opts  aplicar=false → solo balance (modo supervisado).
 * @returns {Promise<{ok:boolean, motivo?:string, balance:Array, calidad:object, aplicado:boolean}>}
 */
export async function enriquecerAFondo(db, doc, { aplicar = false, maxImagenes = 6 } = {}) {
    const imagenes = await leerImagenesDeDoc(doc, maxImagenes);
    if (!imagenes.length) return { ok: false, motivo: 'el documento no tiene imágenes que leer', balance: [], calidad: { puntuacion: 0, merecePena: false, señales: [] }, aplicado: false };

    let normalizado, calidad;
    try {
        ({ normalizado, calidad } = await extraerConPlantilla(imagenes));
    } catch (e) {
        return { ok: false, motivo: `visión falló: ${e.message}`, balance: [], calidad: { puntuacion: 0, merecePena: false, señales: [] }, aplicado: false };
    }
    if (!normalizado) return { ok: false, motivo: 'la visión no devolvió datos', balance: [], calidad, aplicado: false };

    const [edNombre, autoresActuales] = await Promise.all([nombreEditorial(db, doc), nombresAutores(db, doc)]);
    const autorEsPlaceholder = !autoresActuales.length || autoresActuales.every((n) => esAutorPlaceholder(n, edNombre));

    const balance = [];
    const set = {};
    const FUENTE = 'portadilla·IA';
    const anota = (campo, antes, despues, fuente = FUENTE) => balance.push({ campo, antes: antes ?? null, despues, fuente });

    // ── AUTORES: se sustituyen SOLO si los actuales son placeholder (o no hay) y la visión trae autores.
    if (autorEsPlaceholder && normalizado.autores.length) {
        const ids = [];
        const vistos = new Set();
        for (const bruto of normalizado.autores) {
            for (const nombre of separarAutores(bruto)) {
                const r = await resolverPersona(db, nombre);
                if (r && !vistos.has(String(r._id))) { vistos.add(String(r._id)); ids.push(r._id); }
            }
        }
        if (ids.length) { set.autores = ids; anota('autores', autoresActuales.join(', ') || '—', normalizado.autores.join(', ')); }
    }

    // ── CONTRIBUCIONES (roles): se añaden si el doc no tenía ninguna.
    if ((!doc.contribuciones || !doc.contribuciones.length) && normalizado.contribuciones.length) {
        const contribs = [];
        const vistos = new Set();
        for (const c of normalizado.contribuciones) {
            if (!ROLES_VALIDOS.includes(c.rol) || c.rol === 'autor') continue;
            const r = await resolverPersona(db, c.nombre);
            if (!r) continue;
            const clave = `${String(r._id)}|${c.rol}`;
            if (vistos.has(clave)) continue;
            vistos.add(clave);
            contribs.push({ persona: r._id, rol: c.rol });
        }
        if (contribs.length) { set.contribuciones = contribs; anota('contribuciones', '—', normalizado.contribuciones.map((c) => `${c.nombre} (${c.rol})`).join(' · ')); }
    }

    // ── SINOPSIS: se rellena si falta (la de la visión es parafraseada → sin RECITATION).
    if (normalizado.sinopsis && normalizado.sinopsis.length >= 60 && (!doc.sinopsis || doc.sinopsis.length < normalizado.sinopsis.length / 2)) {
        set.sinopsis = normalizado.sinopsis; anota('sinopsis', doc.sinopsis ? '(existente)' : '—', '(nueva, parafraseada)');
    }

    // ── ISBN: si el doc no tiene, fija el primero VÁLIDO; añade los demás como alternativos.
    if (!doc.isbn && normalizado.isbn.length) {
        const validos = normalizado.isbn.filter((x) => validarISBN(x));
        if (validos.length) {
            set.isbn = validos[0]; anota('isbn', '—', validos.join(', '));
            const extra = validos.slice(1).map((isbn) => ({ isbn, rol: 'otra' }));
            if (extra.length) set.isbns_alternativos = [...(doc.isbns_alternativos || []), ...extra];
        }
    }

    // ── Huecos simples (idioma original, palabras clave, año).
    if (normalizado.idioma_original && !doc.idioma_original) { set.idioma_original = normalizado.idioma_original; anota('idioma_original', '—', normalizado.idioma_original); }
    if (normalizado.palabras_clave.length && !(doc.palabras_clave || []).length) { set.palabras_clave = normalizado.palabras_clave; anota('palabras_clave', '—', normalizado.palabras_clave.join(', ')); }
    if (normalizado['año_edicion'] && !doc['año_edicion']) { set['año_edicion'] = normalizado['año_edicion']; anota('año_edicion', '—', normalizado['año_edicion']); }

    // ── Colección/obra: se REGISTRAN en el balance como sugerencia (no se auto-agrupan para no romper la
    //    integridad de colecciones/obras; su asignación queda para el modo supervisado o una acción aparte).
    if (normalizado.coleccion_nombre && !doc.coleccion) balance.push({ campo: 'coleccion (sugerencia)', antes: '—', despues: `${normalizado.coleccion_nombre}${normalizado.coleccion_numero ? ' · nº ' + normalizado.coleccion_numero : ''}`, fuente: FUENTE, soloSugerencia: true });
    if (normalizado.obra_titulo && !doc.obra) balance.push({ campo: 'obra (sugerencia)', antes: '—', despues: `${normalizado.obra_titulo}${normalizado.volumen_numero ? ' · vol ' + normalizado.volumen_numero : ''}`, fuente: FUENTE, soloSugerencia: true });

    // Si faltaba la CDU y ahora hay base (título/autores/sinopsis mejores), des-sellar re-clasificar-cdu.
    const reclasificar = !doc.cdu && (set.autores || set.sinopsis || set.titulo);

    const aplicable = Object.keys(set).length > 0;
    let aplicado = false;
    if (aplicar && calidad.merecePena && aplicable) {
        if (reclasificar) { set['mantenimiento.re-clasificar-cdu'] = 0; set.mantenimiento_firma = 'pendiente-a-fondo'; }
        set.fecha_actualizacion = new Date();
        set.alertas_agente = [...(doc.alertas_agente || []), `Enriquecido a fondo (visión): ${balance.filter((b) => !b.soloSugerencia).map((b) => b.campo).join(', ')}.`];
        await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
        aplicado = true;
    }

    return { ok: true, balance, calidad, aplicado, reclasificar };
}
