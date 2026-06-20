import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { procesarRecurso } from './orquestador.js';
import { procesarCatalogo, actualizarDocumento } from './motor-catalogo.js';
import { rutaCatalogo } from './utils/rutas.js';
import { aMARCXML } from './marc21.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');

/** Copia los archivos del recurso y materializa las imágenes en la carpeta CDU destino. */
async function copiarArchivos(carpetaFs, rutaWeb, rutasOriginales, activos) {
    await fs.mkdir(carpetaFs, { recursive: true });

    // 1. Copiar los archivos originales (epub/pdf/jpgs) y VERIFICAR la integridad: el destino
    //    debe tener el mismo tamaño (>0) que el origen. Solo los verificados se devuelven en
    //    'originalesOk'; el llamante NO borrará del Inbox los que falten (evita perder datos).
    //    Una copia no íntegra se elimina del CDU para no dejar un archivo de 0 bytes/corrupto.
    const originalesOk = [];
    for (const r of rutasOriginales) {
        const destino = path.join(carpetaFs, path.basename(r));
        try {
            await fs.copyFile(r, destino);
            const [src, dst] = await Promise.all([fs.stat(r), fs.stat(destino)]);
            if (src.size > 0 && src.size === dst.size) {
                originalesOk.push(r);
            } else {
                console.warn(`   ⚠️  Copia NO íntegra de ${path.basename(r)} (origen ${src.size}B / destino ${dst.size}B): se descarta.`);
                await fs.rm(destino, { force: true }).catch(() => {});
            }
        } catch (e) {
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

    // 2. Persistencia (insertar/actualizar). Adjuntamos el doc a fallos de infra para reanudar.
    let resultado;
    try {
        resultado = await procesarCatalogo(documento);
    } catch (e) {
        if (e.tipo === 'infraestructura') e.documentoParcial = documento;
        throw e;
    }

    // 3. Gestión de archivos: copiar a <CDU>/<libros|revistas>/.../.
    const rc = rutaCatalogo({
        cdu: resultado.cdu || documento.cdu,
        tipo_recurso: documento.tipo_recurso,
        isbn: resultado.isbn,
        issn: resultado.issn,
        id: resultado._id,
        año_edicion: resultado.año_edicion || documento.año_edicion,
        mes_publicacion: resultado.mes_publicacion || documento.mes_publicacion,
        titulo: resultado.titulo || documento.titulo,
    });
    const carpetaFs = path.join(DIR_CDU, rc.relativa);
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
