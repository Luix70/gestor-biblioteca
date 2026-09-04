/**
 * COTEJO POR IDENTIFICADOR (ISBN / ISSN): recopila TODA la información posible de nuestro Fichero local y de
 * las APIs para el ISBN (o ISSN) de un documento y la coteja campo a campo con la del documento, para poder
 * REEMPLAZAR lo que se elija por lo entrante. Al aplicar, encadena los efectos: un cambio de CDU MUEVE la
 * carpeta al árbol nuevo (vía editarDocumento·reubicarPorCdu) y SIEMPRE se regeneran los sidecars
 * registro.json/.marc.xml. Se puede investigar CON o SIN IA, y aplicar a ESTE documento o a TODOS los que
 * comparten el identificador.
 *
 *   · investigarIdentificador(db, doc, {usarIA}) → { ok, identificador, valor, actual, entrante, campos[], compartidos, fuentes }
 *   · aplicarCotejo(db, {docIds, campos}) → { ok, aplicados, reubicadas, fallidos, errores }
 *
 * Los VALORES entrantes se devuelven ya en el formato que espera editarDocumento (autores «;»-separados,
 * palabras_clave «,»-separadas, editorial/cdu por su valor), así que aplicar = pasar el subconjunto elegido
 * directamente a editarDocumento.
 */
import { ObjectId } from 'mongodb';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { resolverNombres, regenerarSidecarsDoc } from './registro.js';
import { editarDocumento } from './editar-doc.js';
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { variantesISBN } from './identificadores.js';
import { resolverCDU } from '../clasificador-cdu.js';

// Campos cotejables (todos aplicables por editarDocumento). `label` para la UI; `leerDoc`/`leerDatos` extraen el
// valor ACTUAL (del doc, con nombres ya resueltos) y el ENTRANTE (de `datos` de buscarMetadatosExternos), ambos
// como STRING/valor listo para editarDocumento. Orden = el del cotejo en el panel.
const CAMPOS = [
    { campo: 'titulo', label: 'Título', leerDoc: (d) => d.titulo || null, leerDatos: (x) => x.titulo || null },
    { campo: 'subtitulo', label: 'Subtítulo', leerDoc: (d) => d.subtitulo || null, leerDatos: (x) => x.subtitulo || null },
    { campo: 'autores', label: 'Autores', leerDoc: (d, r) => (r.autores || []).join('; ') || null, leerDatos: (x) => (x.autores || []).join('; ') || null },
    { campo: 'editorial', label: 'Editorial', leerDoc: (d, r) => r.editorial || null, leerDatos: (x) => x.editorial || null },
    { campo: 'sinopsis', label: 'Sinopsis', leerDoc: (d) => d.sinopsis || null, leerDatos: (x) => x.sinopsis || null },
    { campo: 'año_edicion', label: 'Año', leerDoc: (d) => d['año_edicion'] ?? null, leerDatos: (x) => x['año_edicion'] ?? null },
    { campo: 'idioma', label: 'Idioma', leerDoc: (d) => d.idioma || null, leerDatos: (x) => x.idioma || null },
    { campo: 'paginas', label: 'Páginas', leerDoc: (d) => d.paginas ?? null, leerDatos: (x) => x.paginas_bne ?? null },
    { campo: 'cdu', label: 'CDU', leerDoc: (d) => d.cdu || null, leerDatos: (x) => x.cdu || null },
    { campo: 'dewey', label: 'Dewey', leerDoc: (d) => d.dewey || null, leerDatos: (x) => x.dewey || null },
    { campo: 'lcc', label: 'LCC', leerDoc: (d) => d.lcc || null, leerDatos: (x) => x.lcc || null },
    { campo: 'palabras_clave', label: 'Palabras clave', leerDoc: (d) => (d.palabras_clave || []).join(', ') || null, leerDatos: (x) => (x.categorias || []).join(', ') || null },
];

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** ¿Qué documentos comparten el identificador de `doc`? (para el alcance «todos los que lo comparten»). */
export async function docsQueComparten(db, doc) {
    const bib = db.collection('biblioteca');
    if (doc.isbn) {
        const vars = variantesISBN(doc.isbn);
        return (await bib.find({ isbn: { $in: vars.length ? vars : [doc.isbn] } }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    }
    if (doc.issn) return (await bib.find({ issn: doc.issn }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    return [doc._id];
}

/** Recopila la info entrante (Fichero + APIs, con o sin IA) y la coteja con la del documento. */
export async function investigarIdentificador(db, doc, { usarIA = false } = {}) {
    const identificador = doc.isbn ? 'isbn' : doc.issn ? 'issn' : null;
    const valor = doc.isbn || doc.issn || null;
    if (!valor) return { ok: false, motivo: 'el documento no tiene ISBN ni ISSN' };

    const isbnsArchivo = doc.isbn ? variantesISBN(doc.isbn) : [];
    let datos;
    try {
        datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
            incluirSinopsis: true, incluirCdu: true, isbnsArchivo, idioma: doc.idioma || null, sinIA: !usarIA,
        });
    } catch (e) { return { ok: false, motivo: `la consulta a las fuentes falló: ${e.message}` }; }

    const resueltos = await resolverNombres(db, doc);   // autores/editorial → nombres, para cotejar legible

    // CDU: derivarla también del Dewey/LCC del PROPIO documento (o de la autoridad) por el CROSSWALK determinista
    // (sin IA) o la IA (si usarIA). Antes la CDU entrante era SOLO `datos.cdu` (la que da el Fichero POR ISBN), así
    // que cuando el Fichero no tenía ese ISBN pero el doc SÍ traía un Dewey/LCC (del CIP), la CDU nunca cambiaba
    // en el cotejo sin IA. Ahora el crosswalk (ampliado, incl. literatura LCC P*) la resuelve de primeras.
    if (!datos.cdu) {
        const dw = doc.dewey || datos.dewey || null;
        const lc = doc.lcc || datos.lcc || null;
        if (dw || lc) {
            const rc = await resolverCDU({
                dewey: dw, lcc: lc, titulo: doc.titulo, autor: (resueltos.autores || [])[0] || null,
                sinopsis: doc.sinopsis, categorias: doc.palabras_clave || [], permitirIA: !!usarIA,
            }).catch(() => null);
            const cdu = rc && (typeof rc === 'string' ? rc : rc.cdu);
            if (cdu && cdu !== '000') datos.cdu = cdu;
        }
    }

    const campos = CAMPOS.map(({ campo, label, leerDoc, leerDatos }) => {
        const actual = leerDoc(doc, resueltos);
        const entrante = leerDatos(datos);
        const difiere = entrante != null && entrante !== '' && norm(actual) !== norm(entrante);
        return { campo, label, actual, entrante, difiere };
    });

    const compartidos = (await docsQueComparten(db, doc)).length;
    return {
        ok: true, identificador, valor, campos, compartidos,
        // Procedencia (qué fuentes respondieron) y si se usó IA, para mostrarlo en la UI.
        fuentes: datos.alertas || [], usarIA: !!usarIA,
    };
}

/**
 * Aplica el subconjunto de campos ENTRANTES elegidos a cada documento (via editarDocumento → maneja la
 * reubicación por CDU) y regenera sus sidecars. `campos` = { <campo>: <valor entrante> } ya en formato
 * editarDocumento. Devuelve el resumen.
 */
export async function aplicarCotejo(db, { docIds = [], campos = {} }) {
    const bib = db.collection('biblioteca');
    const ids = (Array.isArray(docIds) ? docIds : []).map((x) => (x instanceof ObjectId ? x : (ObjectId.isValid(x) ? new ObjectId(x) : null))).filter(Boolean);
    const claves = Object.keys(campos || {});
    if (!ids.length) return { ok: false, motivo: 'sin documentos' };
    if (!claves.length) return { ok: false, motivo: 'no has elegido ningún campo' };

    let aplicados = 0, reubicadas = 0, fallidos = 0, sidecars = 0;
    const errores = [];
    for (const _id of ids) {
        try {
            const r = await editarDocumento(db, String(_id), campos);   // reubica la carpeta si cambia la CDU
            if (!r.ok) { fallidos++; if (r.motivo) errores.push(r.motivo); continue; }
            aplicados++;
            if ((r.avisos || []).some((a) => /CDU →|movid|reubic/i.test(a))) reubicadas++;
            // Sidecars AL DÍA de inmediato (además de la campaña de fondo): parte de los «cambios encadenados».
            const doc = await bib.findOne({ _id });
            if (doc) { try { const s = await regenerarSidecarsDoc(db, doc, carpetaDeDoc(doc)); if (s.ok) sidecars++; } catch { /* la campaña lo recogerá */ } }
        } catch (e) { fallidos++; errores.push(e.message); }
    }
    return { ok: true, aplicados, reubicadas, sidecars, fallidos, errores: errores.slice(0, 3) };
}
