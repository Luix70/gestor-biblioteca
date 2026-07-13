import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { procesarRecurso, leerOverride } from './orquestador.js';
import { procesarCatalogo, actualizarDocumento, buscarDocPorHash } from './motor-catalogo.js';
import { rutaCatalogo } from './utils/rutas.js';
import { aMARCXML } from './marc21.js';
import { calcularHashArchivo } from './utils/hash-archivo.js';
import { enviarACuarentena } from './gestor-fallos.js';
import { carpetaDeDoc, archivoOriginal } from './mantenimiento/util-mantenimiento.js';
import { conectarDB } from './database.js';
import { indexarDoc } from './utils/indice-busqueda.js';
import { asignarColeccion, asignarObra } from './utils/agrupar-docs.js';
import { parsearVolumen } from './utils/multivolumen.js';
import { resolverCDU } from './clasificador-cdu.js';
import { enriquecerMetadatos } from './motor-enriquecimiento.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');

/**
 * ¿La carpeta destino ya pertenece a OTRO documento? (mismo ISBN, edición/versión distinta).
 * Lee el registro.json de la carpeta y compara su _id con el nuestro. Si difiere, hay colisión
 * y el llamante debe disambiguar la hoja para no pisar los ficheros del documento existente.
 */
async function carpetaOcupadaPorOtroDoc(carpeta, miId) {
    try {
        const reg = JSON.parse(await fs.readFile(path.join(carpeta, 'registro.json'), 'utf8'));
        return !!reg._id && String(reg._id) !== String(miId);
    } catch {
        return false; // no existe la carpeta o no hay registro.json legible
    }
}

/** Copia los archivos del recurso y materializa las imágenes en la carpeta CDU destino. */
async function copiarArchivos(carpetaFs, rutaWeb, rutasOriginales, activos) {
    await fs.mkdir(carpetaFs, { recursive: true });

    // 1. Copiar los archivos originales (epub/pdf/jpgs) y VERIFICAR la integridad: el destino
    //    debe tener el mismo tamaño (>0) que el origen. Solo los verificados se devuelven en
    //    'originalesOk'; el llamante NO borrará del Inbox los que falten (evita perder datos).
    //    COPIA NO DESTRUCTIVA: se escribe a un temporal oculto y solo se sustituye el destino
    //    (rename atómico) si la copia es íntegra. Así una re-ingesta con copia defectuosa NUNCA
    //    destruye un fichero bueno que ya estuviera en la carpeta (bug histórico: copyFile directo
    //    sobre el destino + rm en fallo borraba el original ya catalogado).
    const originalesOk = [];
    for (const r of rutasOriginales) {
        const destino = path.join(carpetaFs, path.basename(r));
        const tmp = path.join(carpetaFs, `.tmp-${process.pid}-${Date.now()}-${path.basename(r)}`);
        try {
            await fs.copyFile(r, tmp);
            const [src, dst] = await Promise.all([fs.stat(r), fs.stat(tmp)]);
            if (src.size > 0 && src.size === dst.size) {
                await fs.rename(tmp, destino); // sustituye el destino solo tras verificar la copia
                originalesOk.push(r);
            } else {
                console.warn(`   ⚠️  Copia NO íntegra de ${path.basename(r)} (origen ${src.size}B / temp ${dst.size}B): se descarta el temporal; se conserva el original y cualquier copia previa.`);
                await fs.rm(tmp, { force: true }).catch(() => {});
            }
        } catch (e) {
            await fs.rm(tmp, { force: true }).catch(() => {});
            console.warn(`   ⚠️  No se pudo copiar ${path.basename(r)}: ${e.message}`);
        }
    }

    // 2. Materializar imágenes (portada/contraportada/…) y construir imagenes[].
    const imagenes = [];
    let portada = null;
    let i = 0;
    for (const a of activos) {
        i++;
        const nombre = `${a.tipo}-${i}.jpg`;
        const destino = path.join(carpetaFs, nombre);
        try {
            if (a.base64) await fs.writeFile(destino, Buffer.from(a.base64, 'base64'));
            else if (a.rutaOrigen) await fs.copyFile(a.rutaOrigen, destino);
            else if (a.url) {
                const res = await axios.get(a.url, { responseType: 'arraybuffer', timeout: 15000 });
                await fs.writeFile(destino, Buffer.from(res.data));
            } else continue;
            const rutaImg = `${rutaWeb}/${nombre}`;
            imagenes.push({ ruta: rutaImg, tipo: a.tipo, origen: a.origen });
            if (a.tipo === 'portada' && !portada) portada = rutaImg;
        } catch (e) {
            console.warn(`   ⚠️  Imagen (${a.origen}) no materializada: ${e.message}`);
        }
    }
    return { imagenes, portada, originalesOk };
}

/**
 * ATAJO POR HASH (primera línea de defensa, ANTES de extraer/enriquecer/llamar a APIs): si el fichero
 * ya está archivado (hash de contenido idéntico) no se malgasta OCR/visión/APIs.
 *   · doc con ese hash y su fichero PRESENTE en el archivo → duplicado exacto → se BORRA el entrante.
 *   · doc con ese hash pero su fichero AUSENTE → se RESTAURA con el entrante (mismo contenido) en su sitio.
 *   · sin coincidencia de hash → null (se procesa normal).
 * Solo para recursos de UN fichero (un grupo de imágenes no tiene un hash único). Respeta el override
 * manual `forzar_nuevo` (conservar ambos): en ese caso NO cortocircuita.
 */
/**
 * GAP-FILL del re-drop: rellena SOLO los huecos del doc existente con el CONTEXTO del nuevo drop
 * (carpeta-colección, obra, o "Vol N" en el nombre). Conservador: nunca pisa lo ya puesto. Best-effort
 * (un fallo no rompe el atajo). Devuelve la lista de campos rellenados (para el log).
 */
async function rellenarHuecosPorContexto(doc, ruta, contexto = {}) {
    const rellenos = [];
    let db;
    try { db = await conectarDB(); } catch { return rellenos; }
    try {
        // Colección por carpeta (re-drop dentro de una carpeta-colección) → enlazar si no la tenía.
        if (contexto.coleccion && !doc.coleccion) {
            const r = await asignarColeccion(db, [doc._id], { nombre: String(contexto.coleccion), tipo: doc.tipo_recurso === 'revista' ? 'revista' : 'libro' });
            if (r?.ok && r.n) rellenos.push(`colección «${contexto.coleccion}»`);
        }
        // Obra por carpeta (re-drop como tomo de una obra) → enlazar si no la tenía.
        const obraTit = contexto.obra?.titulo || contexto.obra?.titulo_obra || null;
        if (obraTit && !doc.obra) {
            const r = await asignarObra(db, [doc._id], { titulo: String(obraTit) });
            if (r?.ok && r.n) rellenos.push(`obra «${obraTit}»`);
        }
        // Volumen por NOMBRE del re-drop ("… Vol. 3") → rellenar si faltaba.
        const vol = parsearVolumen(path.basename(ruta));
        if (vol && vol.numero != null && doc.volumen_numero == null) {
            const set = { volumen_numero: vol.numero, fecha_actualizacion: new Date() };
            if (vol.prefijo && !doc.obra_titulo) set.obra_titulo = vol.prefijo;
            await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
            rellenos.push(`volumen ${vol.numero}`);
        }
        if (rellenos.length) { try { await indexarDoc(db, doc._id); } catch { /* índice best-effort */ } }
    } catch (e) { console.warn(`  ⚠️  [Atajo hash] gap-fill parcial en ${doc._id}: ${e.message}`); }
    return rellenos;
}

async function atajoPorHash(rutas, contexto = {}) {
    if (!rutas || rutas.length !== 1) return null;
    try { const ov = await leerOverride(rutas[0]); if (ov?.forzar_nuevo) return null; } catch { /* sin override */ }
    let hash;
    try { hash = await calcularHashArchivo(rutas[0]); } catch { return null; }
    if (!hash) return null;
    const doc = await buscarDocPorHash(hash);
    if (!doc) return null;                                   // hash nuevo → procesar normal

    // GAP-FILL: el re-drop de un fichero YA archivado puede traer MÁS contexto que la 1.ª vez. Rellena
    // los huecos del doc existente (conservador) antes de descartarlo/restaurarlo.
    const rellenos = await rellenarHuecosPorContexto(doc, rutas[0], contexto);
    const sufijo = rellenos.length ? ` (huecos: ${rellenos.join(', ')})` : '';

    const comun = {
        _id: String(doc._id), duplicado: true, estado: doc.estado_verificacion || null,
        isbn: doc.isbn || null, issn: doc.issn || null, rutaWeb: doc.ruta_base || null,
        carpeta: null, copiaIntegra: false, documento: { ...doc, _id: String(doc._id) },
    };
    const carpeta = carpetaDeDoc(doc);
    const original = carpeta ? await archivoOriginal(carpeta) : null;
    if (original) {
        // Duplicado EXACTO ya archivado y referenciado → borrar el entrante SIN reprocesar (ahorra API/IA).
        for (const r of rutas) { await fs.chmod(r, 0o666).catch(() => {}); await fs.rm(r, { force: true }).catch(() => {}); }
        console.log(`  🗑️  [Atajo hash] «${path.basename(rutas[0])}» ya archivado como ${doc._id} → borrado sin reprocesar${sufijo}.`);
        return { ...comun, operacion: 'duplicado_exacto', accion: 'borrado' };
    }
    // El doc existe pero su FICHERO falta → restaurar con el entrante (mismo contenido) en su carpeta.
    if (carpeta && doc.nombre_archivo) {
        try {
            await fs.mkdir(carpeta, { recursive: true });
            await fs.copyFile(rutas[0], path.join(carpeta, doc.nombre_archivo));
            for (const r of rutas) { await fs.chmod(r, 0o666).catch(() => {}); await fs.rm(r, { force: true }).catch(() => {}); }
            console.log(`  ♻️  [Atajo hash] Fichero ausente de ${doc._id} RESTAURADO con el entrante (mismo hash) en ${carpeta}${sufijo}.`);
            return { ...comun, operacion: 'restaurado', accion: 'restaurado' };
        } catch (e) {
            console.warn(`  ⚠️  [Atajo hash] No se pudo restaurar el fichero de ${doc._id}: ${e.message} → se procesa normal.`);
            return null;                                     // fallback: procesar normal
        }
    }
    return null; // doc sin carpeta/nombre fiable → procesar normal (el pipeline lo coloca)
}

/**
 * Ingesta completa de UN recurso (1 archivo o grupo de imágenes del mismo libro/revista):
 *   extracción → enriquecimiento → persistencia → copia a estructura CDU → enlace de rutas.
 *
 * Lanza ErrorIdentificacion (→ Cuarentena) o ErrorInfraestructura (→ Reintentos); el documento
 * parcial se adjunta a los errores de infraestructura para poder reanudar.
 *
 * @param entrada { rutas: string[], contexto?: { ubicacion } }
 */
export async function ingestarRecurso({ rutas, contexto = {} }) {
    // 0. ATAJO POR HASH: si el fichero ya está archivado (hash idéntico) no malgastar OCR/visión/APIs;
    //    si el doc existe pero su fichero falta, restaurarlo con el entrante. (Ver atajoPorHash.)
    const atajo = await atajoPorHash(rutas, contexto);
    if (atajo) return atajo;

    // 1. Extracción + enriquecimiento.
    const { documento, activos, forzarNuevo } = await procesarRecurso({ rutas, contexto });

    // Añadir nombre_archivo y hash antes de catalogar.
    // El nombre_archivo permite detectar re-procesamientos del mismo fichero (vs nuevas versiones);
    // el hash_contenido detecta copias exactas aunque el nombre difiera (ej. "X (1).epub").
    // Solo para recursos de un solo archivo (el hash de un grupo de imágenes no tiene sentido).
    if (rutas.length === 1) {
        documento.nombre_archivo = path.basename(rutas[0]);
        try {
            documento.hash_contenido = await calcularHashArchivo(rutas[0]);
        } catch (e) {
            console.warn(`[Servicio] Hash no calculado para ${path.basename(rutas[0])}: ${e.message}`);
        }
    }

    // 2. Persistencia (insertar/actualizar). Adjuntamos el doc a fallos de infra para reanudar.
    //    serieAuto (drop por carpeta): si el doc no trae número de serie, motor-catalogo le asigna
    //    el siguiente incremental dentro de su colección.
    let resultado;
    try {
        resultado = await procesarCatalogo(documento, { serieAuto: !!contexto.serieAuto, forzarNuevo: !!forzarNuevo });
    } catch (e) {
        if (e.tipo === 'infraestructura') e.documentoParcial = documento;
        throw e;
    }

    // DUPLICADO sospechado (hash idéntico, o mismo ISBN con fichero de otro nombre): se CONFIRMA por
    // HASH DE CONTENIDO antes de decidir. "Hashear ambos si no lo están ya": el recién llegado ya trae
    // hash (paso 1); del existente se usa el suyo o se calcula de su fichero en el árbol CDU (y se
    // guarda, para no repetirlo). Idéntico → se BORRA el recién llegado (es el mismo fichero); distinto
    // → Cuarentena/duplicados para revisión humana (nada se pierde). NOTA: con la dedup por ISBN+formato
    // de motor-catalogo, los formatos distintos del mismo libro ya NO llegan aquí (se insertan aparte).
    if (resultado.operacion === 'duplicado_exacto' || resultado.operacion === 'posible_duplicado') {
        const idExist = String(resultado._id);
        const hashNuevo = documento.hash_contenido
            || (rutas.length === 1 ? await calcularHashArchivo(rutas[0]).catch(() => null) : null);
        let hashExistente = resultado.hash_contenido || null;
        if (!hashExistente) {
            try {
                const original = await archivoOriginal(carpetaDeDoc(resultado));
                if (original) {
                    hashExistente = await calcularHashArchivo(original);
                    if (hashExistente) await actualizarDocumento(resultado._id, { hash_contenido: hashExistente }).catch(() => {});
                }
            } catch { /* sin fichero del existente: no comparable → se trata como distinto (a duplicados) */ }
        }
        const identico = !!(hashNuevo && hashExistente && hashNuevo === hashExistente);
        const comun = {
            _id: resultado._id, duplicado: true,
            estado: resultado.estado_verificacion,
            isbn: resultado.isbn || null, issn: resultado.issn || null,
            carpeta: null, rutaWeb: resultado.ruta_base || null, copiaIntegra: false,
            ya_existia: true, fecha_ingreso: resultado.fecha_ingreso || null, ubicacion: resultado.ubicacion || null,
            documento: { ...resultado },
        };
        if (identico) {
            // Contenido IDÉNTICO (mismo hash que un doc ya catalogado) = es OBVIAMENTE el mismo
            // fichero. No aporta nada → se BORRA permanentemente (ni Papelera ni Cuarentena: la
            // intervención humana se reserva para lo que de verdad la necesita).
            for (const r of rutas) { await fs.chmod(r, 0o666).catch(() => {}); await fs.rm(r, { force: true }).catch(() => {}); }
            console.log(`  🗑️  Duplicado EXACTO (hash) de ${idExist}: «${path.basename(rutas[0])}» → borrado.`);
            return { ...comun, operacion: 'duplicado_exacto', accion: 'borrado' };
        }
        // Hash DISTINTO (contenido distinto) → POLÍTICA "solo se borra un fichero si ya existe OTRO
        // IDÉNTICO por hash en el archivo": aquí NO se borra ni se reemplaza NADA. Se conservan AMBOS;
        // el entrante se deja en Cuarentena/duplicados para deduplicación manual posterior (nada se pierde).
        console.log(`  ↔ Duplicado de ${idExist} (mismo identificador, contenido distinto): conservado en Cuarentena/duplicados (no se borra ni reemplaza).`);
        await enviarACuarentena(rutas, {
            titulo: documento.titulo,
            identificador: documento.isbn || documento.issn || documento.titulo,
            error: { tipo: 'duplicado', mensaje: 'Mismo identificador, contenido distinto: conservado para dedup manual.' },
            documento_existente_id: idExist,
            fase: 'catalogo',
        });
        return { ...comun, operacion: 'duplicado', accion: 'cuarentena' };
    }

    // 3. Gestión de archivos: copiar a <CDU>/<libros|revistas>/.../.
    const argsRuta = {
        cdu: resultado.cdu || documento.cdu,
        tipo_recurso: documento.tipo_recurso,
        isbn: resultado.isbn,
        issn: resultado.issn,
        id: resultado._id,
        año_edicion: resultado.año_edicion || documento.año_edicion,
        mes_publicacion: resultado.mes_publicacion || documento.mes_publicacion,
        titulo: resultado.titulo || documento.titulo,
        // Tomo de obra multivolumen: TODOS los tomos viven JUNTOS en /CDU/<cdu>/obras/<isbn_obra | título>/.
        // motor-catalogo IGUALA isbn_obra, obra_titulo y CDU de todos los tomos al valor CANÓNICO de la obra,
        // así que un tomo añadido después cae SIEMPRE en la misma carpeta (carpeta por isbn_obra si la obra lo
        // tiene, si no por título).
        obra: (resultado.obra || documento.obra)
            ? (resultado.isbn_obra || documento.isbn_obra || resultado.obra_titulo || documento.obra_titulo || String(resultado.obra || documento.obra))
            : null,
        volumen_numero: resultado.volumen_numero != null ? resultado.volumen_numero : documento.volumen_numero,
    };
    let rc = rutaCatalogo(argsRuta);
    let carpetaFs = path.join(DIR_CDU, rc.relativa);

    // Colisión de carpeta: si esto es un documento NUEVO y la carpeta destino ya la ocupa OTRO
    // documento (otra edición del mismo ISBN, u OTRO número de revista del mismo año/cabecera cuando
    // falta el mes), disambiguamos la hoja con un sufijo del _id. Así cada documento tiene SU carpeta
    // (1 doc ↔ 1 carpeta) y nunca se pisan ficheros ni sidecars (registro.json/portada). Aplica también
    // a revistas (antes excluidas, lo que mezclaba números del mismo año en una sola carpeta).
    if (resultado.operacion === 'insercion'
        && await carpetaOcupadaPorOtroDoc(carpetaFs, resultado._id)) {
        rc = rutaCatalogo({ ...argsRuta, discriminador: String(resultado._id).slice(-6) });
        carpetaFs = path.join(DIR_CDU, rc.relativa);
    }
    let imagenes = [], portada = null, originalesOk = [];
    try {
        ({ imagenes, portada, originalesOk } = await copiarArchivos(carpetaFs, rc.web, rutas, activos));
    } catch (e) {
        console.warn(`[Servicio] Gestión de archivos incompleta: ${e.message}`);
    }
    // La copia es íntegra solo si TODOS los originales se copiaron y verificaron (tamaño).
    // El vigilante solo borra del Inbox cuando esto es true (no perder originales).
    const copiaIntegra = originalesOk.length === rutas.length;

    // 4. Enlazar rutas en el documento (best-effort; el doc ya está catalogado). Se guarda el
    //    nombre real del archivo original (para recuperarlo/descargarlo; el título normalizado
    //    no basta). Para grupos de imágenes, la lista completa de nombres.
    const campos = { ruta_base: rc.web, nombre_archivo: path.basename(rutas[0]) };
    if (rutas.length > 1) campos.archivos_originales = rutas.map(r => path.basename(r));
    if (imagenes.length) campos.imagenes = imagenes;
    if (portada) campos.portada = portada;
    try {
        await actualizarDocumento(resultado._id, campos);
    } catch (e) {
        console.warn(`[Servicio] No se pudieron enlazar las rutas: ${e.message}`);
    }

    // Snapshot legible: 'documento' conserva autores/editorial por NOMBRE (procesarCatalogo
    // trabaja sobre una copia, no muta este objeto), ideal para inspección/JSON.
    const documentoLegible = {
        ...documento, ...campos,
        isbn: resultado.isbn, issn: resultado.issn, cdu: resultado.cdu,
        _id: String(resultado._id), operacion: resultado.operacion,
    };
    delete documentoLegible._portadas_remotas;
    // Contribuciones por NOMBRE para el sidecar/MARC (aquí ya vienen como [{nombre,rol}]; el ObjectId lo
    // resolvió procesarCatalogo sobre su copia). Fuera el campo de trabajo.
    if (Array.isArray(documento.contribuciones_nombres) && documento.contribuciones_nombres.length)
        documentoLegible.contribuciones = documento.contribuciones_nombres;
    delete documentoLegible.contribuciones_nombres;

    // 5. Guardar, junto a los archivos, el registro en JSON y en MARC 21 (MARCXML).
    try {
        const base = JSON.parse(JSON.stringify(documentoLegible));
        delete base.operacion;
        await fs.writeFile(path.join(carpetaFs, 'registro.json'), JSON.stringify(base, null, 2), 'utf8');
        await fs.writeFile(path.join(carpetaFs, 'registro.marc.xml'), aMARCXML(base), 'utf8');
    } catch (e) {
        console.warn(`[Servicio] No se pudieron escribir los registros JSON/MARC: ${e.message}`);
    }

    // 5b. Índice de búsqueda (FTS local): refleja el doc recién catalogado/actualizado para que la
    //     búsqueda lo encuentre al instante. Best-effort: un fallo del índice no afecta a la ingesta
    //     (la búsqueda cae a Mongo si el índice no está disponible).
    try { await indexarDoc(await conectarDB(), resultado._id); }
    catch (e) { console.warn(`[Servicio] No se pudo indexar para búsqueda: ${e.message}`); }

    // 6. CONFORMAR AL INGERIR (opcional): corre el Conformador sobre el doc recién catalogado para
    //    "acertar desde el principio" en ingestas sueltas/manuales. FIRE-AND-FORGET: no bloquea la cola
    //    del Inbox (como resolverObraPorIsbn). Por defecto OFF; se activa con el toggle global
    //    CONFORMAR_AL_INGERIR=1 o por petición (contexto.conformar). Import dinámico: solo se carga si toca.
    if (process.env.CONFORMAR_AL_INGERIR === '1' || contexto.conformar) {
        import('./mantenimiento/conformador.js')
            .then(({ conformarAlIngerir }) => conformarAlIngerir(resultado._id))
            .then(r => { if (r?.ok && r.cambios) console.log(`   🧹 Conformado al ingerir (${r.cambios} cambio/s): ${documento.titulo || resultado._id}.`); })
            .catch(() => {});
    }

    return {
        _id: resultado._id,
        operacion: resultado.operacion,
        estado: documento.estado_verificacion,
        isbn: resultado.isbn || null,
        issn: resultado.issn || null,
        carpeta: carpetaFs,
        rutaWeb: rc.web,
        copiaIntegra,          // el vigilante solo borra del Inbox si esto es true
        documento: documentoLegible,
        // Aviso «ya ingresado»: si actualizó un doc que ya existía, su fecha de ingreso y ubicación reales.
        ya_existia: resultado.operacion === 'actualizacion',
        fecha_ingreso: resultado.fecha_ingreso || null,
        ubicacion: resultado.ubicacion || null,
    };
}

/**
 * ALTA POR ISBN (sin fichero): crea un documento a partir de los metadatos del Fichero local (+ ediciones
 * del usuario) y de la(s) portada(s) elegidas (por URL o subida). Reutiliza el motor de catálogo y la copia
 * de archivos del pipeline, pero SIN extracción ni visión: el ISBN es el pivote y los datos ya vienen dados,
 * así que NO se gasta IA en identificar. Pensado para catalogar libros FÍSICOS a mano con su código de barras.
 *   base      = { titulo, subtitulo, autores[], editorial, isbn, idioma, paginas, año_edicion, dewey, lcc,
 *                 cdu, sinopsis, categorias[], coleccion_nombre }  (metadatos del Fichero + ediciones)
 *   activos   = [{ tipo:'portada'|'imagen', url?|base64?, origen }]  (la portada primero)
 *   contexto  = { ambito, estanteria, coleccion, obra }
 *   completar = true → enriquecer (APIs, conservador) + resolver CDU de forma SÍNCRONA antes de insertar;
 *               false → alta rápida (queda pendiente; el Conformador la perfeccionará luego).
 */
export async function altaPorISBN({ base = {}, activos = [], contexto = {}, completar = false }) {
    let documento;
    if (completar) {
        documento = await enriquecerMetadatos({ ...base, formatos: ['papel'], tipo_recurso: 'libro' },
            { ...contexto, tipo_recurso: 'libro', formatos: ['papel'] });
    } else {
        documento = { ...base, formatos: ['papel'], tipo_recurso: 'libro', estado_verificacion: 'pendiente' };
    }
    documento.tipo_recurso = documento.tipo_recurso || 'libro';
    documento.formatos = (documento.formatos && documento.formatos.length) ? documento.formatos : ['papel'];
    if (!documento.idioma) documento.idioma = base.idioma || 'es';

    // Sin título no se puede catalogar (lo exige el $jsonSchema). Con `completar` se acaba de intentar
    // recuperarlo de las APIs/IA (enriquecerMetadatos); si aun así no hay título, el ISBN no está en ninguna
    // fuente → error claro para el panel, en lugar de un fallo de validación de esquema (121) más adelante.
    if (!documento.titulo || !String(documento.titulo).trim()) {
        throw new Error('No se pudo determinar el título (ni en el Fichero ni en las APIs online). Escribe al menos el título y pulsa «Crear».');
    }

    // CDU obligatoria ($jsonSchema). Fichero.cdu → mapear dewey/lcc (cache/API/IA) → placeholder '0'.
    if (!documento.cdu) {
        try {
            const rcdu = await resolverCDU({ dewey: documento.dewey, lcc: documento.lcc, categorias: documento.categorias || [], titulo: documento.titulo, autor: (documento.autores || [])[0], sinopsis: documento.sinopsis });
            if (rcdu && rcdu.cdu) documento.cdu = rcdu.cdu;
        } catch (e) { console.warn(`[AltaISBN] CDU no resuelta: ${e.message}`); }
    }
    if (!documento.cdu) { documento.cdu = '0'; documento.estado_verificacion = documento.estado_verificacion || 'pendiente'; }

    // Ubicación ($jsonSchema exige {ambito, estanteria}); colección/obra como señales del pipeline.
    documento.ubicacion = {
        ambito: contexto.ambito || (documento.ubicacion && documento.ubicacion.ambito) || 'Sin asignar',
        estanteria: contexto.estanteria || (documento.ubicacion && documento.ubicacion.estanteria) || 'Sin asignar',
    };
    if (contexto.coleccion) documento.coleccion_nombre = contexto.coleccion;
    if (contexto.obra) documento.obra_titulo = contexto.obra;
    // Dimensiones medidas con el tapete en el cliente (ancho_cm/alto_cm) → viajan tal cual, sin re-medir.
    if (contexto.dimensiones && contexto.dimensiones.ancho_cm && contexto.dimensiones.alto_cm) {
        documento.ancho_cm = contexto.dimensiones.ancho_cm;
        documento.alto_cm = contexto.dimensiones.alto_cm;
    }
    documento.origen_ingesta = 'isbn';

    // Persistencia (dedup + refs autores/editorial + upsert).
    const resultado = await procesarCatalogo(documento, {});

    // Carpeta CDU + copia de imágenes (por URL/base64, sin fichero original) + enlazar rutas + sidecars.
    const argsRuta = {
        cdu: resultado.cdu || documento.cdu, tipo_recurso: documento.tipo_recurso,
        isbn: resultado.isbn, issn: resultado.issn, id: resultado._id,
        año_edicion: resultado.año_edicion || documento.año_edicion,
        titulo: resultado.titulo || documento.titulo,
        obra: (resultado.obra || documento.obra)
            ? (resultado.isbn_obra || documento.isbn_obra || resultado.obra_titulo || documento.obra_titulo || String(resultado.obra || documento.obra))
            : null,
        volumen_numero: resultado.volumen_numero != null ? resultado.volumen_numero : documento.volumen_numero,
    };
    let rc = rutaCatalogo(argsRuta);
    let carpetaFs = path.join(DIR_CDU, rc.relativa);
    if (resultado.operacion === 'insercion' && await carpetaOcupadaPorOtroDoc(carpetaFs, resultado._id)) {
        rc = rutaCatalogo({ ...argsRuta, discriminador: String(resultado._id).slice(-6) });
        carpetaFs = path.join(DIR_CDU, rc.relativa);
    }
    let imagenes = [], portada = null;
    try { ({ imagenes, portada } = await copiarArchivos(carpetaFs, rc.web, [], activos)); }
    catch (e) { console.warn(`[AltaISBN] Imágenes no copiadas: ${e.message}`); }

    const campos = { ruta_base: rc.web };
    if (imagenes.length) campos.imagenes = imagenes;
    if (portada) campos.portada = portada;
    try { await actualizarDocumento(resultado._id, campos); } catch (e) { console.warn(`[AltaISBN] Rutas no enlazadas: ${e.message}`); }

    try {
        const snap = { ...documento, ...campos, isbn: resultado.isbn, cdu: resultado.cdu, _id: String(resultado._id) };
        delete snap._portadas_remotas;
        if (Array.isArray(documento.contribuciones_nombres) && documento.contribuciones_nombres.length)
            snap.contribuciones = documento.contribuciones_nombres;
        delete snap.contribuciones_nombres;
        await fs.writeFile(path.join(carpetaFs, 'registro.json'), JSON.stringify(snap, null, 2), 'utf8');
        await fs.writeFile(path.join(carpetaFs, 'registro.marc.xml'), aMARCXML(snap), 'utf8');
    } catch (e) { console.warn(`[AltaISBN] Sidecars no escritos: ${e.message}`); }

    try { await indexarDoc(await conectarDB(), resultado._id); } catch { /* índice best-effort */ }

    return {
        _id: String(resultado._id), operacion: resultado.operacion,
        titulo: resultado.titulo || documento.titulo, isbn: resultado.isbn || documento.isbn || null,
        cdu: resultado.cdu || documento.cdu, ruta_base: rc.web, portada: portada || null,
        ya_existia: resultado.operacion === 'actualizacion',
        fecha_ingreso: resultado.fecha_ingreso || null, ubicacion: resultado.ubicacion || null,
    };
}
