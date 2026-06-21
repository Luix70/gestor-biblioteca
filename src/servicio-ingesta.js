import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { procesarRecurso } from './orquestador.js';
import { procesarCatalogo, actualizarDocumento } from './motor-catalogo.js';
import { rutaCatalogo } from './utils/rutas.js';
import { aMARCXML } from './marc21.js';
import { calcularHashArchivo } from './utils/hash-archivo.js';
import { enviarACuarentena } from './gestor-fallos.js';

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
 * Ingesta completa de UN recurso (1 archivo o grupo de imágenes del mismo libro/revista):
 *   extracción → enriquecimiento → persistencia → copia a estructura CDU → enlace de rutas.
 *
 * Lanza ErrorIdentificacion (→ Cuarentena) o ErrorInfraestructura (→ Reintentos); el documento
 * parcial se adjunta a los errores de infraestructura para poder reanudar.
 *
 * @param entrada { rutas: string[], contexto?: { ubicacion } }
 */
export async function ingestarRecurso({ rutas, contexto = {} }) {
    // 1. Extracción + enriquecimiento.
    const { documento, activos } = await procesarRecurso({ rutas, contexto });

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
        resultado = await procesarCatalogo(documento, { serieAuto: !!contexto.serieAuto });
    } catch (e) {
        if (e.tipo === 'infraestructura') e.documentoParcial = documento;
        throw e;
    }

    // Copia exacta detectada por hash: mover el archivo a Cuarentena con nota al documento existente.
    if (resultado.operacion === 'duplicado_exacto') {
        await enviarACuarentena(rutas, {
            titulo: documento.titulo,
            identificador: documento.isbn || documento.issn || documento.titulo,
            error: {
                tipo: 'duplicado_exacto',
                mensaje: `Contenido idéntico a documento ya catalogado (id: ${resultado._id}, ` +
                         `archivo: ${resultado.nombre_archivo || 'desconocido'}).`,
            },
            documento_existente_id: String(resultado._id),
            fase: 'catalogo',
        });
        return {
            _id: resultado._id,
            operacion: 'duplicado_exacto',
            estado: resultado.estado_verificacion,
            isbn: resultado.isbn || null,
            issn: resultado.issn || null,
            carpeta: null,
            rutaWeb: resultado.ruta_base || null,
            copiaIntegra: false,
            documento: { ...resultado },
        };
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
    };
    let rc = rutaCatalogo(argsRuta);
    let carpetaFs = path.join(DIR_CDU, rc.relativa);

    // Colisión de carpeta (libros): si esto es un documento NUEVO (otra versión del mismo ISBN)
    // y la carpeta destino ya la ocupa OTRO documento, disambiguamos la hoja con un sufijo del
    // _id. Así dos revisiones del mismo ISBN viven en carpetas distintas (1 doc ↔ 1 carpeta).
    if (resultado.operacion === 'insercion' && documento.tipo_recurso !== 'revista'
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

    // 5. Guardar, junto a los archivos, el registro en JSON y en MARC 21 (MARCXML).
    try {
        const base = JSON.parse(JSON.stringify(documentoLegible));
        delete base.operacion;
        await fs.writeFile(path.join(carpetaFs, 'registro.json'), JSON.stringify(base, null, 2), 'utf8');
        await fs.writeFile(path.join(carpetaFs, 'registro.marc.xml'), aMARCXML(base), 'utf8');
    } catch (e) {
        console.warn(`[Servicio] No se pudieron escribir los registros JSON/MARC: ${e.message}`);
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
    };
}
