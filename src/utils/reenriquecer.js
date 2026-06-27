/**
 * Re-enriquecimiento de UN documento desde la ficha del panel ("Enriquecedor"): vuelve a consultar las
 * APIs/IA con el ISBN (ancla fiable) o el título y MEJORA el registro:
 *   · rellena HUECOS (sinopsis, año, idioma, palabras clave, editorial, colección, dewey/lcc) — conservador,
 *   · y SOBRESCRIBE título/autor/editorial SOLO si el actual es BASURA (nombre de archivo, identificador,
 *     "código"), nunca un dato bueno.
 * Si cambia el título o faltaba la CDU, des-sella la tarea `re-clasificar-cdu` para que el Conformador
 * re-clasifique y mueva la carpeta con el dato ya bueno (el usuario puede dispararlo con el botón
 * "Conformador"). NO mueve ficheros. Comparte criterio con scripts/re-enriquecer-degradados.js.
 *
 * Devuelve { ok, cambios:[{campo,de,a}], reclasificar } o { ok:false, motivo }.
 */
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { resolverColeccion } from './colecciones.js';
import { variantesISBN, validarISBN, validarISSN } from './identificadores.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');

/** ¿El título es en realidad basura (nombre de archivo, identificador o un código)? */
function tituloNoFiable(doc) {
    const t = doc.titulo || '';
    if (!t.trim()) return true;
    if (validarISBN(t) || validarISSN(t)) return true;
    if (doc.nombre_archivo && norm(t) === norm(doc.nombre_archivo)) return true;
    if (!/\s/.test(t) && /\d/.test(t) && /[_\-.]/.test(t) && t.length > 8) return true;
    return false;
}

async function resolverAutores(db, nombres) {
    const out = [];
    for (const n of nombres) {
        const ex = await db.collection('autores').findOne({ nombre: n });
        out.push(ex ? ex._id : (await db.collection('autores').insertOne({ nombre: n })).insertedId);
    }
    return out;
}
async function resolverEditorial(db, nombre) {
    const ex = await db.collection('editoriales').findOne({ nombre });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

export async function reenriquecerDoc(db, doc) {
    const col = db.collection('biblioteca');
    const isbnVar = doc.isbn ? variantesISBN(doc.isbn) : [];

    let datos;
    try {
        datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
            incluirSinopsis: !doc.sinopsis, incluirCdu: !doc.cdu, isbnsArchivo: isbnVar, idioma: doc.idioma || null,
        });
    } catch (e) { return { ok: false, motivo: `la consulta a las fuentes falló: ${e.message}` }; }

    const garbage = tituloNoFiable(doc);
    const set = {};
    const cambios = [];
    const anota = (campo, de, a) => cambios.push({ campo, de: de ?? null, a });

    // Título/autor/editorial: solo si el actual es basura (nunca pisa un dato bueno).
    if (garbage && datos.titulo && datos.titulo !== doc.titulo) { set.titulo = datos.titulo; anota('titulo', doc.titulo, datos.titulo); }
    if (garbage && datos.editorial) { set.editorial = await resolverEditorial(db, datos.editorial); anota('editorial', null, datos.editorial); }
    if (garbage && datos.autores?.length) { set.autores = await resolverAutores(db, datos.autores); anota('autores', null, datos.autores.join(', ')); }

    // Huecos (solo si faltan).
    if (datos.sinopsis && !doc.sinopsis) { set.sinopsis = datos.sinopsis; anota('sinopsis', null, '(añadida)'); }
    if (datos.año_edicion && !doc.año_edicion) { set.año_edicion = datos.año_edicion; anota('año_edicion', null, datos.año_edicion); }
    if (datos.idioma && !doc.idioma) { set.idioma = datos.idioma; anota('idioma', null, datos.idioma); }
    if (datos.categorias?.length && !(doc.palabras_clave?.length)) { set.palabras_clave = datos.categorias; anota('palabras_clave', null, datos.categorias.join(', ')); }
    if (datos.coleccion_nombre && !doc.coleccion) {
        const edId = set.editorial || (typeof doc.editorial !== 'string' ? doc.editorial : null);
        const { _id } = await resolverColeccion(db, datos.coleccion_nombre, edId);
        set.coleccion = _id; set.coleccion_nombre = datos.coleccion_nombre;
        if (datos.coleccion_numero) set.coleccion_numero = String(datos.coleccion_numero);
        anota('coleccion', null, datos.coleccion_nombre);
    }
    if (datos.dewey && !doc.dewey) { set.dewey = datos.dewey; anota('dewey', null, datos.dewey); }
    if (datos.lcc && !doc.lcc) { set.lcc = datos.lcc; anota('lcc', null, datos.lcc); }

    // Re-clasificar la CDU si cambió el título o faltaba la CDU (y hay base para deducirla).
    const reclasificar = !!set.titulo || (!doc.cdu && !!(datos.cdu || datos.dewey || datos.lcc || set.dewey || set.lcc));

    if (Object.keys(set).length === 0 && !reclasificar) return { ok: true, cambios: [], resumen: 'sin mejora disponible' };

    if (reclasificar) {
        set['mantenimiento.re-clasificar-cdu'] = 0;
        set.mantenimiento_firma = 'pendiente-re-enriquecido';
    }
    set.fecha_actualizacion = new Date();
    set.alertas_agente = [...(doc.alertas_agente || []), 'Re-enriquecido manualmente desde la ficha.'];
    await col.updateOne({ _id: doc._id }, { $set: set });
    return { ok: true, cambios, reclasificar };
}
