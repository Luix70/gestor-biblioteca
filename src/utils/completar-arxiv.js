/**
 * COMPLETAR UN DOCUMENTO YA CATALOGADO CON SU FICHA DE ARXIV — motor compartido de `scripts/completar-arxiv.js` (y de
 * cualquier acción futura del panel). La ingesta hace lo mismo al entrar (lector-pdf → orquestador →
 * motor-enriquecimiento); esto arregla lo que entró antes (10-nov: 49 preprints titulados con la marca lateral de
 * arXiv, catalogados como números de revista con una cabecera falsa cada uno, sin autores y casi todos en CDU 000).
 *
 * Qué hace con cada documento (las reglas, en `planArxiv`):
 *   · TÍTULO: el de arXiv (lo puso el autor al subirlo) si el actual es un artefacto, está vacío o salió del nombre
 *     del fichero; uno puesto por otra vía y distinto se conserva.
 *   · AUTORES: los de arXiv con ancla (autoresConAncla): si comparten alguno se unen, si no se sustituyen (los
 *     actuales eran trozos del nombre del fichero: «Advanced determinant calculus» como autor).
 *   · TIPO: artículo, o libro si pasa de ARXIV_LIBRO_MIN_PAGINAS y no salió en ninguna revista (arxiv-id·tipoArxiv).
 *     Un documento con ISBN o tomo de obra no cambia de tipo. Al dejar de ser revista sale de su cabecera (y la
 *     cabecera falsa «arXiv:…», si se queda vacía, se borra) y pierde la clave/mes/nº de número.
 *   · Huecos: resumen (→ sinopsis), año, DOI de la revista, materias legibles de sus categorías.
 *   · IDIOMA: el del texto del propio PDF si se pudo leer; si no, el del título + resumen.
 *   · CDU: la de sus categorías (tabla determinista, rango «deducida») con aplicarCduConPrioridad: rellena un 000 y
 *     afina dentro de la rama; no pisa una CDU de más rango ni cambia de rama otra deducida que no sea débil.
 *   · CARPETA: a la de su tipo y CDU (reubicarPorCdu), con su portada e imágenes; sidecars e índice al día.
 *   · Artículo con DOI de revista: se cuelga de la cabecera de esa revista (Crossref), como en la ingesta (2f).
 * Todo con diario `deshacer[]` (origen «arxiv»). Una prueba en seco no escribe NADA (ni crea autores).
 */
import { ObjectId } from 'mongodb';
import { esTituloArtefacto, parsearNombre } from './parsear-nombre.js';
import { mismoTituloLibro } from './titulo-libro.js';
import { autoresConAncla } from './huecos-autoridad.js';
import { nombresDeAutores } from './isbn-ajeno.js';
import { resolverPersona } from './resolver-persona.js';
import { eliminarAutoresVacios } from './gestion-autores.js';
import { eliminarColeccionVacia } from './gestion-grupos.js';
import { resolverCabecera } from './colecciones.js';
import { buscarPorDOI } from './buscador-crossref.js';
import { validarISSN } from './identificadores.js';
import { idiomaDeTexto } from './idioma-texto.js';
import { aplicarCduConPrioridad, cduVacia, cduNormalizada, puedeSustituirCdu } from './prioridad-cdu.js';
import { regenerarSidecarsDoc } from './registro.js';
import { indexarDoc } from './indice-busqueda.js';
import { SEGMENTO_DE_TIPO } from './rutas.js';
import { extraerMetadatosPdf } from './lector-pdf.js';
import { carpetaDeDoc, archivoOriginal, reubicarPorCdu, aplicarCambio } from '../mantenimiento/util-mantenimiento.js';
import { arxivDeTitulo, arxivDeNombre, normalizarArxiv, cduDeArxiv, materiasDeArxiv, tipoArxiv } from './arxiv-id.js';

const ORIGEN = 'arxiv';
const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * El identificador arXiv que se conoce del documento SIN abrir el fichero: el ya guardado, el título (la marca de
 * arXiv como título) o el nombre del fichero. → { id, version, origen } o null.
 */
export function arxivDeDoc(doc) {
    const guardado = doc.arxiv?.id ? normalizarArxiv(doc.arxiv.id) : null;
    if (guardado) return { ...guardado, version: doc.arxiv.version ?? guardado.version, origen: 'ficha' };
    const delTitulo = arxivDeTitulo(doc.titulo);
    if (delTitulo) return { ...delTitulo, origen: 'título' };
    const delNombre = arxivDeNombre(doc.nombre_archivo);
    if (delNombre) return { ...delNombre, origen: 'nombre del fichero' };
    return null;
}

/**
 * Lo que dice el PROPIO PDF (hay que estar donde están los ficheros: el NAS): el identificador de la marca lateral de
 * la primera página y el idioma del texto. → { arxiv, idioma } (campos null si no se pudo leer).
 */
export async function arxivDeFichero(doc) {
    if (!/\.pdf$/i.test(String(doc.nombre_archivo || '')) && !(doc.formatos || []).includes('pdf')) return { arxiv: null, idioma: null };
    const ruta = await archivoOriginal(carpetaDeDoc(doc), doc.nombre_archivo).catch(() => null);
    if (!ruta || !/\.pdf$/i.test(ruta)) return { arxiv: null, idioma: null };
    const datos = await extraerMetadatosPdf(ruta).catch(() => null);
    return {
        arxiv: datos?.arxiv_id ? { id: datos.arxiv_id, version: datos.arxiv_version ?? null, origen: 'marca del PDF' } : null,
        idioma: datos?.idioma || null,
    };
}

/** ¿El título actual salió del nombre del fichero? (entonces el de arXiv es mejor) */
function tituloDelNombre(doc) {
    const t = String(doc.titulo || '').trim().toLowerCase();
    if (!t || !doc.nombre_archivo) return false;
    const base = String(doc.nombre_archivo).replace(/\.[^.]+$/, '').trim().toLowerCase();
    const delNombre = String(parsearNombre(doc.nombre_archivo).titulo || '').trim().toLowerCase();
    return t === base || t === delNombre;
}

/**
 * PLAN (puro): qué cambiaría en el documento con la ficha de arXiv.
 * @param opts.nombresAutores  nombres de los autores actuales (resueltos de sus ObjectId)
 * @param opts.idiomaFichero   idioma leído del texto del PDF, si se leyó
 * @param opts.version         versión del fichero (la de su marca/nombre), si se sabe
 * @returns {{ set, unset, cambios:Array<{campo,de,a}>, autores:string[]|null, tipo:string, salirDeCabecera:boolean, cdu:string|null }}
 */
export function planArxiv(doc, ficha, { nombresAutores = [], idiomaFichero = null, version = null } = {}) {
    const set = {};
    const unset = {};
    const cambios = [];
    const cambia = (campo, valor, etiqueta = valor) => {
        if (vacio(valor) || JSON.stringify(doc[campo]) === JSON.stringify(valor)) return;
        set[campo] = valor;
        cambios.push({ campo, de: doc[campo] ?? null, a: etiqueta });
    };

    // Título.
    const tituloDudoso = vacio(doc.titulo) || esTituloArtefacto(doc.titulo) || tituloDelNombre(doc);
    if (ficha.titulo && tituloDudoso && !mismoTituloLibro(doc.titulo || '', ficha.titulo)) cambia('titulo', ficha.titulo);

    // Autores (los nombres; se resuelven a personas al aplicar).
    let autores = null;
    const anc = autoresConAncla(nombresAutores, ficha.autores || []);
    if (anc.modo !== 'igual') {
        autores = anc.nombres;
        cambios.push({ campo: 'autores', de: nombresAutores.join('; ') || null, a: `${autores.join('; ')} (${anc.modo})` });
    }

    // Tipo: artículo o libro (un documento con ISBN o un tomo de obra se queda como está).
    let tipo = doc.tipo_recurso;
    if (!doc.isbn && !doc.obra) {
        tipo = tipoArxiv({ paginas: doc.paginas || ficha.paginas, enRevista: !!(ficha.journal_ref || ficha.doi) });
        cambia('tipo_recurso', tipo);
    }
    const eraRevista = doc.tipo_recurso === 'revista' && tipo !== 'revista';
    if (eraRevista) {
        for (const c of ['clave_numero', 'mes_publicacion', 'numero_issue', 'issn']) {
            if (!vacio(doc[c])) { unset[c] = ''; cambios.push({ campo: c, de: doc[c], a: null }); }
        }
    }
    // Fuera de la cabecera: la de un número de revista (ya no lo es) o una falsa con la marca de arXiv por nombre.
    const salirDeCabecera = !!doc.coleccion && (eraRevista || /^arxiv:/i.test(String(doc.coleccion_nombre || '')));
    if (salirDeCabecera) {
        unset.coleccion = '';
        unset.coleccion_nombre = '';
        cambios.push({ campo: 'coleccion', de: doc.coleccion_nombre || String(doc.coleccion), a: null });
    }

    // Huecos.
    if (vacio(doc.sinopsis)) cambia('sinopsis', ficha.sinopsis, '(resumen de arXiv)');
    // El año: el de la primera versión. Si era «revista», el que tenía salió de la fecha de la marca (la de la versión).
    if (ficha.año && (vacio(doc.año_edicion) || eraRevista)) cambia('año_edicion', ficha.año);
    if (vacio(doc.doi) && ficha.doi) cambia('doi', ficha.doi);
    const materias = materiasDeArxiv(ficha.categorias);
    if (materias.length) {
        const previas = Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [];
        const juntas = [...new Set([...previas, ...materias])];
        if (juntas.length > previas.length) cambia('palabras_clave', juntas, juntas.join(', '));
    }

    // Idioma: el del texto del PDF manda; si no se leyó, el del título + resumen (con menos palabras que un libro).
    const idioma = idiomaFichero || idiomaDeTexto(`${ficha.titulo || ''}. ${ficha.sinopsis || ''}`, { minimo: 8 });
    if (idioma) cambia('idioma', idioma);

    // La ficha de arXiv, para el enlace y las búsquedas por identificador.
    const arxiv = {
        id: ficha.id,
        ...(version ? { version } : {}),
        version_ultima: ficha.version,
        categorias: ficha.categorias,
        ...(ficha.comentario ? { comentario: ficha.comentario } : {}),
        ...(ficha.journal_ref ? { journal_ref: ficha.journal_ref } : {}),
        ...(ficha.fecha ? { fecha: ficha.fecha } : {}),
        url: ficha.url,
    };
    if (JSON.stringify(doc.arxiv) !== JSON.stringify(arxiv)) {
        set.arxiv = arxiv;
        if (!doc.arxiv) cambios.push({ campo: 'arxiv', de: null, a: `${ficha.id} [${(ficha.categorias || []).join(', ')}]` });
    }

    return { set, unset, cambios, autores, tipo, salirDeCabecera, cdu: cduDeArxiv(ficha.categorias) };
}

/**
 * Completa un documento con su ficha de arXiv. `aplicar:false` = en seco (devuelve el plan, no escribe nada).
 * @returns {Promise<{ estado:'aplicado'|'seco'|'sin-cambios', cambios, avisos:string[], cdu?:object }>}
 */
export async function completarDesdeArxiv(db, doc, ficha, { aplicar = false, idiomaFichero = null, version = null } = {}) {
    const bib = db.collection('biblioteca');
    const nombresAutores = await nombresDeAutores(db, doc.autores || []);
    const plan = planArxiv(doc, ficha, { nombresAutores, idiomaFichero, version });
    const avisos = [];
    const cduArxiv = plan.cdu;
    if (!aplicar) {
        // La misma decisión que tomará aplicarCduConPrioridad (solo depende de la CDU actual y de su fuente).
        if (cduArxiv) {
            const nueva = cduNormalizada(cduArxiv, doc);
            if (puedeSustituirCdu(doc, nueva, 'arxiv')) plan.cambios.push({ campo: 'cdu', de: doc.cdu || null, a: nueva });
            else if (nueva !== doc.cdu) avisos.push(`CDU ${nueva} de sus categorías no aplicada: la actual (${doc.cdu}) tiene prioridad o es más precisa`);
        }
        return { estado: plan.cambios.length ? 'seco' : 'sin-cambios', cambios: plan.cambios, avisos };
    }

    // 1. Autores → personas (aquí sí: se crean las que falten).
    const set = { ...plan.set, fecha_actualizacion: new Date() };
    let autoresQuitados = [];
    if (plan.autores) {
        const ids = [];
        for (const n of plan.autores) {
            const p = await resolverPersona(db, n).catch(() => null);
            if (p?._id && !ids.some((x) => String(x) === String(p._id))) ids.push(p._id);
        }
        if (ids.length) {
            set.autores = ids;
            autoresQuitados = (doc.autores || []).filter((a) => !ids.some((x) => String(x) === String(a)));
        }
    }

    // 2. La ficha, con el diario para deshacer.
    const antes = {};
    for (const c of [...Object.keys(plan.set), ...Object.keys(plan.unset), 'autores', 'estado_verificacion', 'cdu', 'ruta_base']) antes[c] = doc[c] ?? null;
    const resumen = plan.cambios.map((c) => c.campo).join(', ');
    const update = {
        $set: set,
        $push: {
            deshacer: { fecha: new Date(), origen: ORIGEN, antes },
            alertas_agente: `Completado con su ficha de arXiv ${ficha.id} (${resumen}).`,
        },
    };
    if (Object.keys(plan.unset).length) update.$unset = plan.unset;
    await bib.updateOne({ _id: doc._id }, update);

    // 3. Fuera de la cabecera de revista; la cabecera falsa «arXiv:…», si queda vacía, se borra.
    if (plan.salirDeCabecera) {
        const colCol = db.collection('colecciones');
        await colCol.updateOne({ _id: doc.coleccion }, { $pull: { numeros: { _id: doc._id }, numeros_sin_fecha: doc._id } });
        const c = await colCol.findOne({ _id: doc.coleccion }, { projection: { nombre: 1 } });
        const enObras = await db.collection('obras').countDocuments({ coleccion: doc.coleccion }, { limit: 1 });
        if (c && /^arxiv:/i.test(c.nombre || '') && !enObras) {
            const r = await eliminarColeccionVacia(db, doc.coleccion);
            if (r.ok) avisos.push(`cabecera falsa «${c.nombre}» borrada`);
        }
    }

    // 4. Artículo de una revista: a la cabecera de esa revista, por el DOI (como la ingesta, motor-catalogo 2f).
    let actual = await bib.findOne({ _id: doc._id });
    if (actual.tipo_recurso === 'articulo' && actual.doi && !actual.coleccion) {
        const cr = await buscarPorDOI(actual.doi).catch(() => null);
        const issn = cr?.issn?.map((x) => validarISSN(x)).find(Boolean) || null;
        if (cr && (cr.revista || issn)) {
            const { _id } = await resolverCabecera(db, { nombre: cr.revista || null, issn, tipo: 'revista' });
            if (_id) {
                const cita = {};
                if (cr.volumen) cita.volumen = cr.volumen;
                if (cr.numero) cita.numero = cr.numero;
                if (cr.paginas) cita.paginas = cr.paginas;
                await bib.updateOne({ _id: doc._id }, {
                    $set: { coleccion: _id, ...(cr.revista ? { coleccion_nombre: cr.revista } : {}), ...(Object.keys(cita).length ? { articulo: { ...(actual.articulo || {}), ...cita } } : {}) },
                });
                avisos.push(`en la revista «${cr.revista || issn}»`);
            }
        }
    }

    // 5. CDU de sus categorías, con la prioridad de siempre (mueve la carpeta si se aplica).
    actual = await bib.findOne({ _id: doc._id });
    let cdu = null;
    if (cduArxiv) {
        cdu = await aplicarCduConPrioridad(db, actual, cduArxiv, 'arxiv').catch((e) => ({ aplicada: false, motivo: e.message }));
        if (!cdu.aplicada) avisos.push(`CDU ${cduArxiv} no aplicada: ${cdu.motivo}`);
    }

    // 6. La carpeta, a la de su tipo (si la CDU no la movió ya).
    actual = await bib.findOne({ _id: doc._id });
    const seg = SEGMENTO_DE_TIPO[actual.tipo_recurso] || 'libros';
    if (actual.ruta_base && !actual.obra && !actual.ruta_fija && !String(actual.ruta_base).includes(`/${seg}/`)) {
        const reub = await reubicarPorCdu(actual, actual.cdu, { recolocar: true }).catch((e) => ({ error: e.message }));
        if (reub?.set?.ruta_base) {
            await aplicarCambio(bib, actual, reub.carpetaNueva || carpetaDeDoc({ ...actual, ...reub.set }),
                { set: reub.set, alertas: [`Carpeta recolocada en «${seg}» (arXiv).`, ...(reub.alertas || [])] });
        } else {
            avisos.push(`carpeta no recolocada${reub?.error ? `: ${reub.error}` : ' (¿sin carpeta en este disco?)'}`);
        }
    }

    // 7. Identificado del todo (título, autores y CDU de verdad) → completado. Sidecars, índice y autores-artefacto
    //    que se han quedado sin libros.
    actual = await bib.findOne({ _id: doc._id });
    if (actual.estado_verificacion === 'pendiente' && actual.titulo && (actual.autores || []).length && !cduVacia(actual.cdu)) {
        await bib.updateOne({ _id: doc._id }, { $set: { estado_verificacion: 'completado' } });
        actual.estado_verificacion = 'completado';
    }
    await regenerarSidecarsDoc(db, actual, carpetaDeDoc(actual)).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
    if (autoresQuitados.length) {
        const r = await eliminarAutoresVacios(db, autoresQuitados.map((a) => new ObjectId(String(a)))).catch(() => null);
        if (r?.borrados) avisos.push(`${r.borrados} autor(es)-artefacto sin libros borrados`);
    }
    return { estado: 'aplicado', cambios: plan.cambios, avisos, cdu };
}
