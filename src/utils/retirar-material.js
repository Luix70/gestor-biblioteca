/**
 * RETIRAR FICHAS DE «MATERIAL» SIN LIBRO — regla del usuario (14-nov): una ficha «Libro, material» solo tiene sentido
 * colgada de un documento principal, como material adicional de su ficha. Suelta es ruido («LAT01», «GROTE»,
 * «README», «Lib16», los dosieres web de patentes…): 67 fichas medidas el 14-nov, 41 de ellas .txt.
 *
 * La ingesta ya no las crea (transmedia: el material viaja con la colección sin ficha propia; una carpeta sin un solo
 * documento se queda en el Inbox con su aviso; «intacta» de la IA sobre algo que no es un libro HTML, igual). Esto
 * retira las de antes SIN PERDER UN FICHERO:
 *   · si sus ficheros siguen en la carpeta de un documento de verdad (su colección tiene otros miembros, otro documento
 *     vive en esa carpeta o la contiene), se borra SOLO la ficha: el fichero sigue donde estaba, con la colección;
 *   · si no, se borra la ficha y su carpeta vuelve a `PreProceso/_Material sin libro/`, con la misma ruta relativa que
 *     tenía en el árbol CDU, para que la juntes con su libro o la retires tú. PreProceso no toca esa carpeta.
 *
 * Consumidor: scripts/retirar-material-suelto.js.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { otroDocEnCarpeta } from './carpeta-en-uso.js';
import { desindexarDoc } from './indice-busqueda.js';
import { eliminarColeccionVacia } from './gestion-grupos.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');

/** Carpeta de PreProceso donde vuelve el material que no cuelga de ningún libro. PreProceso la ignora. */
export const CARPETA_MATERIAL_SIN_LIBRO = '_Material sin libro';

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Las rutas web de las carpetas que CONTIENEN a `rutaBase` («/recursos/a/b/c» → «/recursos/a/b», «/recursos/a»). */
function ancestros(rutaBase) {
    const partes = String(rutaBase || '').split('/').filter(Boolean);
    const out = [];
    for (let i = partes.length - 1; i >= 2; i--) out.push('/' + partes.slice(0, i).join('/'));
    return out;
}

/**
 * Qué hacer con UNA ficha de material. `idsRetirando` = todas las fichas que se retiran en esta pasada (no cuentan
 * como «documento de verdad» que conserve los ficheros).
 * @returns {Promise<{accion:'quitar-ficha'|'devolver', motivo:string, carpeta:string, destino?:string}>}
 */
export async function planRetirada(db, doc, idsRetirando = []) {
    const bib = db.collection('biblioteca');
    const fuera = [doc._id, ...idsRetirando];
    const carpeta = carpetaDeDoc(doc);

    // ¿Algún documento de verdad conserva estos ficheros?
    if (doc.coleccion) {
        const hermano = await bib.findOne(
            { coleccion: doc.coleccion, _id: { $nin: fuera }, naturaleza: { $ne: 'material' } },
            { projection: { titulo: 1 } });
        if (hermano) return { accion: 'quitar-ficha', carpeta, motivo: `el fichero sigue en su colección (con «${hermano.titulo}»)` };
    }
    const dentro = await otroDocEnCarpeta(db, doc.ruta_base, fuera);
    if (dentro) return { accion: 'quitar-ficha', carpeta, motivo: `la carpeta es también de «${dentro.titulo}»` };
    const contenedor = await bib.findOne(
        { ruta_base: { $in: ancestros(doc.ruta_base) }, _id: { $nin: fuera } }, { projection: { titulo: 1 } });
    if (contenedor) return { accion: 'quitar-ficha', carpeta, motivo: `está dentro de la carpeta de «${contenedor.titulo}»` };

    const rel = path.relative(DIR_CDU, carpeta);
    const destino = rel && !rel.startsWith('..')
        ? path.join(DIR_PRE, CARPETA_MATERIAL_SIN_LIBRO, rel)
        : path.join(DIR_PRE, CARPETA_MATERIAL_SIN_LIBRO, path.basename(carpeta));
    return { accion: 'devolver', carpeta, destino, motivo: 'ningún documento conserva sus ficheros: la carpeta vuelve a PreProceso' };
}

/** Borra la ficha y la saca de su colección y de las selecciones. La colección se borra si queda vacía. */
export async function borrarFicha(db, doc) {
    await db.collection('biblioteca').deleteOne({ _id: doc._id });
    await desindexarDoc(doc._id).catch(() => {});
    await db.collection('selecciones').updateMany({ docs: doc._id }, { $pull: { docs: doc._id } });
    if (doc.coleccion) {
        await db.collection('colecciones').updateOne({ _id: doc.coleccion }, { $pull: { numeros: { _id: doc._id }, numeros_sin_fecha: doc._id } });
        await eliminarColeccionVacia(db, doc.coleccion).catch(() => {});   // solo si ya no tiene miembros
    }
}

/** Ficheros y bytes de un árbol, para verificar una copia. */
async function huella(ruta) {
    const st = await fs.stat(ruta);
    if (!st.isDirectory()) return { n: 1, bytes: st.size };
    let n = 0, bytes = 0;
    for (const e of await fs.readdir(ruta)) {
        const h = await huella(path.join(ruta, e));
        n += h.n; bytes += h.bytes;
    }
    return { n, bytes };
}

/**
 * Lleva la carpeta del árbol CDU a PreProceso. Son montajes distintos (EXDEV): copiar, verificar y solo entonces borrar
 * el origen. Nunca pisa nada: si el destino existe, se le añade « (2)», « (3)»… Devuelve el destino o lanza.
 */
export async function devolverCarpeta(carpeta, destino) {
    let final = destino;
    for (let i = 2; await existe(final); i++) final = `${destino} (${i})`;
    await fs.mkdir(path.dirname(final), { recursive: true });
    try {
        await fs.rename(carpeta, final);
        return final;
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
    }
    await fs.cp(carpeta, final, { recursive: true, errorOnExist: true, force: false });
    const [a, b] = await Promise.all([huella(carpeta), huella(final)]);
    if (a.n !== b.n || a.bytes !== b.bytes) {
        await fs.rm(final, { recursive: true, force: true });
        throw new Error(`copia incompleta (${a.n}/${a.bytes} ≠ ${b.n}/${b.bytes}); la carpeta se queda donde estaba`);
    }
    await fs.rm(carpeta, { recursive: true, force: true });
    return final;
}
