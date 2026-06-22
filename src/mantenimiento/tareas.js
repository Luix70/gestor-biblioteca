import fs from 'fs/promises';
import path from 'path';
import { medirImagen } from '../utils/medir-imagen.js';
import { resolverPortada } from '../utils/resolver-portada.js';
import { rasterizarPaginas } from '../utils/rasterizar-pdf.js';
import { extraerMetadatosEpub } from '../utils/lector-epub.js';
import { carpetaDeDoc, webDeDoc, archivoOriginal, numeroPaginasPdf, escribirImagen, EXT_DOC, DIR_CDU, carpetaExiste, moverCarpetaConVerificacion, restaurarOriginalSiFalta } from './util-mantenimiento.js';
import { arbolCDU } from '../utils/cdu-arbol.js';
import { buscarEnBNE } from '../utils/buscador-bne.js';
import { buscarEnDNB } from '../utils/buscador-dnb.js';
import { resolverCDU } from '../clasificador-cdu.js';
import { calcularHashArchivo } from '../utils/hash-archivo.js';
import { parsearNombre, esTituloArtefacto } from '../utils/parsear-nombre.js';
import { resolverColeccion } from '../utils/colecciones.js';
import { buscarMetadatosExternos } from '../utils/proveedor-metadatos.js';
import { validarISBN, validarISSN, variantesISBN } from '../utils/identificadores.js';
import { aRegistroLegible, escribirSidecars, resolverNombres } from '../utils/registro.js';
import { describirCDU } from '../utils/descripcion-cdu.js';

const ANCHO_OBJETIVO = Number(process.env.PORTADA_ANCHO_OBJETIVO || 1000);

const tipoDeArchivo = (ruta) => {
    const ext = path.extname(ruta || '').toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    return EXT_DOC.includes(ext) ? 'otro-formato' : null;
};

const urlPortadaOpenLibrary = (isbn) =>
    `https://covers.openlibrary.org/b/isbn/${String(isbn).replace(/-/g, '')}-L.jpg?default=false`;

// ── Detección de documentos "degradados" (ingestados con APIs caídas) ──────────────────────
const normTit = (s) => String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');

/** ¿El título es en realidad basura (nombre de archivo, identificador, artefacto o un código)? */
function tituloNoFiable(doc) {
    const t = doc.titulo || '';
    if (!t.trim()) return true;
    if (validarISBN(t) || validarISSN(t)) return true;
    if (esTituloArtefacto(t)) return true; // "C:\X.DVI", "…​.indd", "Microsoft Word - …", "Untitled"
    if (doc.nombre_archivo && normTit(t) === normTit(doc.nombre_archivo)) return true;
    if (!/\s/.test(t) && /\d/.test(t) && /[_\-.]/.test(t) && t.length > 8) return true; // "code-like"
    return false;
}

/** ¿El documento parece degradado y merece re-enriquecerse? (requiere ISBN como ancla). */
function esDegradado(doc) {
    if (!doc.isbn) return false;
    const cduMala = ['00', '0', '000'].includes(String(doc.cdu || ''));
    const apisCaidas = (doc.alertas_agente || []).some(a => /inalcanzable/i.test(a));
    const pendiente = doc.estado_verificacion === 'pendiente';
    return tituloNoFiable(doc) || cduMala || apisCaidas || pendiente;
}

async function resolverAutoresRef(db, nombres) {
    const out = [];
    for (const n of nombres) {
        const ex = await db.collection('autores').findOne({ nombre: n });
        out.push(ex ? ex._id : (await db.collection('autores').insertOne({ nombre: n })).insertedId);
    }
    return out;
}
async function resolverEditorialRef(db, nombre) {
    const ex = await db.collection('editoriales').findOne({ nombre });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

/**
 * REGISTRO DE TAREAS DE MANTENIMIENTO.
 * Cada tarea: { id, version, descripcion, aplica(doc), ejecutar(doc, ctx) -> cambio|null }.
 * 'cambio' = { set?, imagenesNuevas?, alertas?, carpetaNueva? }.
 *   carpetaNueva: si la tarea movió la carpeta CDU, indicar la ruta nueva para que
 *   aplicarCambio escriba registro.json en el sitio correcto.
 * Subir 'version' fuerza re-pasar la tarea por todos los documentos.
 * Las tareas se ejecutan EN ORDEN. La cadena importa:
 *   restaurar-original (devuelve el .epub/.pdf a la carpeta si faltaba) → re-enriquecer-degradados
 *   (arregla el título) → re-clasificar-cdu (re-clasifica con el título ya bueno y mueve la carpeta,
 *   llevándose el original ya restaurado) → completar-hash-contenido (ya hay fichero que hashear)
 *   → … → regenerar-registros (reescribe los sidecars legibles al final).
 */
export const TAREAS = [

    {
        id: 'restaurar-original',
        version: 1,
        descripcion: 'Si a la carpeta le falta el .epub/.pdf, lo restaura desde Reintentos/Cuarentena/_ER Room antes de que las demás tareas trabajen sobre la carpeta.',
        // No aplica a escaneos ('papel': solo imágenes) ni a docs sin carpeta.
        aplica: (doc) => !!doc.ruta_base && !(doc.formatos || []).includes('papel'),
        async ejecutar(doc) {
            const carpeta = carpetaDeDoc(doc);
            let entradas;
            try { entradas = await fs.readdir(carpeta); } catch { return null; }
            if (entradas.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()))) return null; // ya tiene original

            const nombres = [doc.nombre_archivo, ...(doc.archivos_originales || [])].filter(Boolean);
            const r = await restaurarOriginalSiFalta(carpeta, nombres);
            if (!r) return null; // no localizado: las demás tareas siguen con lo disponible (ISBN)
            return { alertas: [`Original restaurado por mantenimiento (${path.basename(r.origen)}).`] };
        },
    },

    {
        id: 'corregir-titulo-artefacto',
        version: 1,
        descripcion: 'Título-artefacto (C:\\…\\x.dvi, "…​.indd", "Microsoft Word - …", "Untitled") SIN ISBN: lo sustituye por el del nombre de archivo; si el nombre ES un ISBN, lo fija para que re-enriquecer-degradados (que corre después) busque el título real por autoridad en la MISMA pasada.',
        // Solo sin ISBN: los que SÍ tienen ISBN los arregla re-enriquecer-degradados (autoridad).
        aplica: (doc) => esTituloArtefacto(doc.titulo || '') && !doc.isbn && !!doc.nombre_archivo,
        async ejecutar(doc) {
            const p = parsearNombre(doc.nombre_archivo);
            const set = {};
            if (p.isbn) set.isbn = p.isbn;                                   // nombre que ES un ISBN
            else if (p.titulo && !esTituloArtefacto(p.titulo)) set.titulo = p.titulo;
            if (!set.titulo && !set.isbn) return null;
            return { set, alertas: [set.titulo
                ? `Título-artefacto "${doc.titulo}" corregido desde el nombre de archivo: "${set.titulo}".`
                : `ISBN ${set.isbn} recuperado del nombre de archivo (título "${doc.titulo}" pendiente de re-enriquecer).`] };
        },
    },

    {
        id: 're-enriquecer-degradados',
        version: 2,
        descripcion: 'Documentos con ISBN pero metadata pobre (lote con APIs caídas) o título-artefacto: re-busca por ISBN y sobrescribe título/autores/editorial basura; cae al nombre de archivo si la autoridad no responde; rellena huecos.',
        aplica: (doc) => esDegradado(doc),
        async ejecutar(doc, { db }) {
            const isbnVar = variantesISBN(doc.isbn);
            if (!isbnVar.length) return null;

            let datos;
            try {
                // CDU la resuelve re-clasificar-cdu (que corre justo después con el título ya bueno).
                datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
                    incluirSinopsis: true, incluirCdu: false, isbnsArchivo: isbnVar, idioma: doc.idioma || null,
                });
            } catch { datos = {}; }

            const garbage = tituloNoFiable(doc);
            const set = {};
            // Sobrescribe SOLO si el título actual es basura (sabemos que el registro es degradado):
            // autoridad (mejor) y, si no respondió, el título del NOMBRE DE ARCHIVO (siempre disponible).
            if (garbage && datos.titulo)        set.titulo    = datos.titulo;
            else if (garbage && doc.nombre_archivo) {
                const p = parsearNombre(doc.nombre_archivo);
                if (p.titulo && !esTituloArtefacto(p.titulo)) set.titulo = p.titulo;
            }
            if (garbage && datos.editorial)     set.editorial = await resolverEditorialRef(db, datos.editorial);
            if (garbage && datos.autores?.length) set.autores  = await resolverAutoresRef(db, datos.autores);
            // Huecos (rellenar si faltan).
            if (datos.sinopsis && !doc.sinopsis)        set.sinopsis = datos.sinopsis;
            if (datos.año_edicion && !doc.año_edicion)  set.año_edicion = datos.año_edicion;
            if (datos.idioma && !doc.idioma)            set.idioma = datos.idioma;
            if (datos.categorias?.length && !(doc.palabras_clave?.length)) set.palabras_clave = datos.categorias;
            if (datos.coleccion_nombre && !doc.coleccion) {
                const ed = set.editorial || (typeof doc.editorial !== 'string' ? doc.editorial : null);
                const { _id } = await resolverColeccion(db, datos.coleccion_nombre, ed);
                set.coleccion = _id; set.coleccion_nombre = datos.coleccion_nombre;
                if (datos.coleccion_numero) set.coleccion_numero = String(datos.coleccion_numero);
            }

            if (Object.keys(set).length === 0) return null;
            return { set, alertas: ['Metadatos re-enriquecidos desde ISBN (lote degradado).'] };
        },
    },

    {
        id: 're-clasificar-cdu',
        version: 2,
        descripcion: 'Re-clasifica la CDU con el pipeline BNE→DNB→caché→IA y mueve los ficheros al nuevo árbol si cambió.',
        // Los tomos de una obra multivolumen NO se re-clasifican por separado: comparten la CDU de
        // la obra (un solo classmark). Su ruta va por <cdu>/obras/… y este movimiento no la entiende.
        aplica: (doc) => !doc.obra,

        async ejecutar(doc, { db }) {
            const isbn = doc.isbn || null;

            // ── Paso 1: BNE (autoridad más fiable para fondos hispanos) ──────────────
            let cduNueva = null, cduAdicionales = [], fuente = null;
            if (isbn) {
                const recBNE = await buscarEnBNE(isbn);
                if (recBNE?.cdus?.length > 0) {
                    [cduNueva] = recBNE.cdus;
                    cduAdicionales = recBNE.cdus.slice(1);
                    fuente = 'BNE';
                }
            }

            // ── Paso 2: DNB → equivalencias_cdu cache/IA (si BNE no resolvió) ──────
            if (!cduNueva) {
                let dewey = doc.dewey || null;
                let lcc   = doc.lcc   || null;
                if (!dewey && !lcc && isbn) {
                    const infoDNB = await buscarEnDNB({ isbn });
                    if (infoDNB) { dewey = infoDNB.dewey; lcc = infoDNB.lcc; }
                }
                if (dewey || lcc) {
                    // Resolver autor: un único lookup indexado mejora la clasificación de ficción.
                    let autorNombre = null;
                    if (doc.autores?.length > 0) {
                        const autorDoc = await db.collection('autores')
                            .findOne({ _id: doc.autores[0] }, { projection: { nombre: 1 } });
                        if (autorDoc) autorNombre = autorDoc.nombre;
                    }
                    const { cdu, fuente: f } = await resolverCDU({
                        dewey, lcc,
                        categorias: doc.palabras_clave || [],
                        titulo: doc.titulo,
                        autor: autorNombre,
                        sinopsis: doc.sinopsis,
                    });
                    if (cdu && cdu !== '000') { cduNueva = cdu; fuente = `clasificador:${f}`; }
                }
            }

            // ── Sin resolución: mantener CDU actual ──────────────────────────────────
            if (!cduNueva) return null;

            // ── Misma CDU: solo actualizar adicionales si cambiaron ──────────────────
            if (cduNueva === doc.cdu) {
                const mismos = JSON.stringify(cduAdicionales) === JSON.stringify(doc.cdu_adicionales || []);
                if (mismos) return null;
                return { set: { cdu_adicionales: cduAdicionales } };
            }

            // ── CDU cambió: mover la carpeta ─────────────────────────────────────────
            const carpetaVieja = carpetaDeDoc(doc);
            const existeVieja  = await carpetaExiste(carpetaVieja);

            // La ruta nueva sustituye SOLO la parte CDU (lo anterior a libros/revistas) por el
            // árbol nuevo <clase>/<division>/<cdu>, conservando tipo + resto (isbn/discriminador,
            // o issn/año-mes en revistas). Robusto tanto si la ruta vieja es plana como en árbol.
            //   vieja: /recursos/<…cdu…>/<tipo>/<resto...>
            //   nueva: /recursos/<clase>/<division>/<cdu>/<tipo>/<resto...>
            const rutaBaseVieja = webDeDoc(doc);
            const segsViejos    = rutaBaseVieja.replace(/^\/recursos\//, '').split('/');
            const iTipo         = segsViejos.findIndex(s => s === 'libros' || s === 'revistas');
            const resto         = iTipo >= 0 ? segsViejos.slice(iTipo) : segsViejos.slice(-2);
            const segsNuevos    = [...arbolCDU(cduNueva).segmentos, ...resto];
            const rutaBaseNueva = '/recursos/' + segsNuevos.join('/');
            const relativaNueva = segsNuevos.join('/');
            const carpetaNueva  = path.join(DIR_CDU, ...segsNuevos);

            if (existeVieja && carpetaNueva !== carpetaVieja) {
                // Colisión: el destino ya existe (otro registro con el mismo CDU+ISBN)
                if (await carpetaExiste(carpetaNueva)) {
                    console.warn(`   ⚠️  re-clasificar-cdu: colisión en "${relativaNueva}"; CDU actualizada en BD pero ficheros NO movidos.`);
                    const set = { cdu: cduNueva };
                    if (cduAdicionales.length) set.cdu_adicionales = cduAdicionales;
                    return { set, alertas: [`CDU actualizada a "${cduNueva}" [${fuente}]; carpeta destino ya existía — ficheros no movidos.`] };
                }

                // Archivos enlazados en la BD: basenames para verificación tras copia.
                const archivosEnBD = [
                    doc.portada   ? path.basename(doc.portada)   : null,
                    ...(doc.imagenes || []).map(im => path.basename(im.ruta)),
                ].filter(Boolean);

                await moverCarpetaConVerificacion(carpetaVieja, carpetaNueva, archivosEnBD);
            }

            // ── Recalcular todas las rutas internas que llevaban el prefijo viejo ────
            const remap = (p) => p && p.startsWith(rutaBaseVieja)
                ? rutaBaseNueva + p.slice(rutaBaseVieja.length)
                : p;

            const set = { cdu: cduNueva, ruta_base: rutaBaseNueva };
            if (cduAdicionales.length)    set.cdu_adicionales = cduAdicionales;
            if (doc.portada)              set.portada  = remap(doc.portada);
            if (doc.imagenes?.length)     set.imagenes = doc.imagenes.map(im => ({ ...im, ruta: remap(im.ruta) }));

            return {
                set,
                carpetaNueva: existeVieja ? carpetaNueva : null,
                alertas: [`CDU actualizada: "${doc.cdu}" → "${cduNueva}" [${fuente}]${existeVieja ? '; ficheros movidos.' : ' (sin carpeta — solo BD).'}`],
            };
        },
    },


    {
        id: 'describir-cdu',
        version: 1,
        descripcion: 'Asegura la descripción bilingüe (ES/EN, extensa) del CDU del documento en cdu_descripciones (IA, cacheada).',
        aplica: (doc) => !!doc.cdu,
        async ejecutar(doc, { db }) {
            await describirCDU(db, doc.cdu); // cacheado y best-effort; no modifica el libro
            return null;
        },
    },

    {
        id: 'completar-obra-por-isbn',
        version: 1,
        descripcion: 'Resuelve la obra multivolumen por su ISBN de obra (set): fija el TÍTULO de autoridad (mejor que el nombre de la carpeta del drop) y una DESCRIPCIÓN general. Una sola vez por obra.',
        // Solo tomos de obra. Modifica la OBRA (no el tomo); el primer tomo que la resuelva la rellena.
        aplica: (doc) => !!doc.obra && doc.volumen_numero != null,
        async ejecutar(doc, { db }) {
            const obra = await db.collection('obras').findOne({ _id: doc.obra });
            if (!obra || obra.resuelta_isbn || !obra.isbn_obra) return null; // ya resuelta, o sin ancla
            let datos;
            try {
                datos = await buscarMetadatosExternos(obra.titulo || '', '', null, {
                    incluirSinopsis: true, incluirCdu: false, isbnsArchivo: variantesISBN(obra.isbn_obra),
                });
            } catch { return null; }

            const set = {};
            // El ISBN de obra es la autoridad del título: prevalece sobre el nombre de la carpeta
            // (que suele traer ruido: "… Vol 1-3 (2003); OCR …"). La dedup de obra es por isbn_obra,
            // así que renombrar es seguro (no rompe el enlace de los tomos).
            if (datos.titulo)   set.titulo = datos.titulo;
            if (datos.sinopsis) set.descripcion = datos.sinopsis;
            if (!set.titulo && !set.descripcion) return null; // nada (API caída): otro tomo reintentará

            set.resuelta_isbn = true; // marca: no repetir el lookup en los demás tomos
            await db.collection('obras').updateOne({ _id: obra._id }, { $set: set });
            const partes = [set.titulo && 'título', set.descripcion && 'descripción'].filter(Boolean);
            return { alertas: [`Obra resuelta por su ISBN de obra (${partes.join(' + ')})${set.titulo ? `: "${set.titulo}"` : ''}.`] };
        },
    },

    {
        id: 'completar-hash-contenido',
        version: 1,
        descripcion: 'Calcula y guarda el SHA-256 del fichero original (identidad de contenido 1:1) y avisa de duplicados exactos preexistentes.',
        // Solo recursos de un único fichero: los libros escaneados (papel = varias imágenes)
        // no tienen un "original" único que hashear. Se omite si ya tiene hash.
        aplica: (doc) => !doc.hash_contenido && !(doc.formatos || []).includes('papel'),
        async ejecutar(doc, { db }) {
            const carpeta = carpetaDeDoc(doc);
            let docsEnCarpeta;
            try {
                const entradas = await fs.readdir(carpeta);
                docsEnCarpeta = entradas.filter(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
            } catch {
                return null; // sin carpeta legible
            }
            if (docsEnCarpeta.length === 0) return null;
            // Carpeta multi-documento: pendiente de reingesta; hashear sería ambiguo.
            if (docsEnCarpeta.length > 1) {
                return { alertas: [`Carpeta con ${docsEnCarpeta.length} documentos: pendiente de reingesta (hash no calculado).`] };
            }

            const original = path.join(carpeta, docsEnCarpeta[0]);
            const hash = await calcularHashArchivo(original);

            // ¿Otro documento ya tiene este hash? → copia exacta preexistente en la biblioteca.
            const otro = await db.collection('biblioteca').findOne(
                { hash_contenido: hash, _id: { $ne: doc._id } },
                { projection: { _id: 1, titulo: 1 } }
            );

            const set = { hash_contenido: hash };
            if (!doc.nombre_archivo) set.nombre_archivo = docsEnCarpeta[0]; // de paso, fija el nombre
            const alertas = [];
            if (otro) {
                alertas.push(`Contenido idéntico (hash) al documento ${otro._id} ("${otro.titulo}"): duplicado exacto preexistente — revisar.`);
            }
            return { set, alertas };
        },
    },

    {
        id: 'completar-coleccion',
        version: 1,
        descripcion: 'Detecta la colección/volumen en el nombre de archivo (estilo ePubLibre) y la registra en colecciones.',
        aplica: (doc) => !doc.coleccion && !!doc.nombre_archivo,
        async ejecutar(doc, { db }) {
            const p = parsearNombre(doc.nombre_archivo);
            if (!p.coleccion_nombre) return null;
            const edId = (doc.editorial && typeof doc.editorial !== 'string') ? doc.editorial : null;
            const { _id, creada } = await resolverColeccion(db, p.coleccion_nombre, edId);
            const set = { coleccion: _id, coleccion_nombre: p.coleccion_nombre };
            if (p.coleccion_numero) set.coleccion_numero = String(p.coleccion_numero);
            const alertas = creada ? [`Nueva colección registrada: ${p.coleccion_nombre}`] : [];
            return { set, alertas };
        },
    },

    {
        id: 'completar-nombre-archivo',
        version: 1,
        descripcion: 'Rellena nombre_archivo con el nombre real del fichero en la carpeta CDU.',
        aplica: (doc) => !doc.nombre_archivo,
        async ejecutar(doc) {
            const carpeta = carpetaDeDoc(doc);
            const original = await archivoOriginal(carpeta);
            if (!original) return null;
            return { set: { nombre_archivo: path.basename(original) } };
        },
    },

    {
        id: 'revisar-portada',
        version: 1,
        descripcion: 'Si la portada falta o es de baja calidad, la re-resuelve (embebida / remota / rasterizado).',
        // No se tocan los libros escaneados (formato 'papel'): su portada es la foto auténtica
        // que escaneó el usuario; no la sustituimos por una imagen remota.
        aplica: (doc) => !(doc.formatos || []).includes('papel'),
        async ejecutar(doc) {
            const carpeta = carpetaDeDoc(doc);

            // 1. Medir la portada actual.
            let anchoActual = 0;
            if (doc.portada) {
                const buf = await fs.readFile(path.join(carpeta, path.basename(doc.portada))).catch(() => null);
                const m = buf && medirImagen(buf);
                if (m) anchoActual = m.width;
            }
            if (anchoActual >= ANCHO_OBJETIVO) return null; // ya es buena

            // 2. Reunir fuentes y re-resolver.
            const original = await archivoOriginal(carpeta);
            const tipo = tipoDeArchivo(original);
            let embebida = null, numPaginas = 2;
            if (tipo === 'epub') {
                embebida = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64 || null;
            } else if (tipo === 'pdf') {
                numPaginas = (await numeroPaginasPdf(original)) || 2;
            }
            const remotos = doc.isbn ? [{ origen: 'openlibrary', url: urlPortadaOpenLibrary(doc.isbn) }] : [];

            const { portada } = await resolverPortada({
                tipo: tipo || 'otro-formato',
                rutas: original ? [original] : [],
                numPaginas, embebidaBase64: embebida, remotos,
            });
            if (!portada || portada.ancho <= anchoActual) return null; // no mejora

            const buffer = Buffer.from(portada.base64, 'base64');

            // 3a. Ya había portada: se sobrescribe el mismo fichero (la ruta no cambia).
            if (doc.portada) {
                await fs.writeFile(path.join(carpeta, path.basename(doc.portada)), buffer);
                return { alertas: [`Portada mejorada por mantenimiento (${anchoActual || 0}→${portada.ancho}px).`] };
            }
            // 3b. No había: se crea y se referencia.
            const { web } = await escribirImagen(carpeta, webDeDoc(doc), buffer, 'portada');
            return {
                set: { portada: web },
                imagenesNuevas: [{ ruta: web, tipo: 'portada', origen: portada.origen }],
                alertas: [`Portada añadida por mantenimiento (${portada.ancho}px).`],
            };
        },
    },

    {
        id: 'generar-sidecars-pdf',
        version: 1,
        descripcion: 'Rasteriza y guarda las 5 primeras páginas + la última de los PDF que no las tengan.',
        aplica: (doc) => Array.isArray(doc.formatos) && doc.formatos.includes('pdf'),
        async ejecutar(doc) {
            const yaPdf = (doc.imagenes || []).filter(im => /^pdf:/.test(im.origen || '')).length;
            if (yaPdf >= 6) return null; // ya tiene el juego completo

            const carpeta = carpetaDeDoc(doc);
            const original = await archivoOriginal(carpeta);
            if (!original || tipoDeArchivo(original) !== 'pdf') return null;

            const numPaginas = (await numeroPaginasPdf(original)) || 5;
            const paginas = [1, 2, 3, 4, 5].filter(p => p <= numPaginas);
            if (numPaginas > 5) paginas.push(numPaginas);

            const renders = await rasterizarPaginas(original, { paginas, ancho: 1600 });
            if (!renders.length) return null; // sin poppler

            const existentes = new Set((doc.imagenes || []).map(im => im.origen));
            const web = webDeDoc(doc);
            const imagenesNuevas = [];
            for (const r of renders) {
                const origen = `pdf:${r.etiqueta}`;
                if (existentes.has(origen)) continue; // ya estaba
                const { web: rutaImg } = await escribirImagen(carpeta, web, r.buffer, r.etiqueta === 'portada' ? 'portada' : `pdfpag-${r.pagina}`);
                imagenesNuevas.push({ ruta: rutaImg, tipo: r.etiqueta === 'portada' ? 'portada' : 'otra', origen });
            }
            if (!imagenesNuevas.length) return null;
            return { imagenesNuevas, alertas: [`${imagenesNuevas.length} página(s) PDF añadidas como sidecar por mantenimiento.`] };
        },
    },

    {
        id: 'regenerar-registros',
        version: 1,
        descripcion: 'Reescribe registro.json y registro.marc.xml desde la BD (autores/editorial por nombre); va el último para reflejar la metadata y la carpeta ya finales.',
        aplica: (doc) => !!doc.ruta_base,
        async ejecutar(doc, { db }) {
            // doc ya refleja los cambios de las tareas anteriores (Object.assign en el conformador),
            // incluida la ruta_base nueva si re-clasificar-cdu movió la carpeta.
            const carpeta = carpetaDeDoc(doc);
            if (!await carpetaExiste(carpeta)) return null;
            const { autores, editorial } = await resolverNombres(db, doc);
            const legible = aRegistroLegible(doc, { autores, editorial });
            try { await escribirSidecars(carpeta, legible); } catch { /* best-effort */ }
            return null; // no cambia la BD; solo sincroniza los sidecars en disco
        },
    },
];
