/**
 * SUSTITUIR EL FICHERO DE UNA FICHA conservando la ficha (14-nov, petición del usuario).
 *
 * Para cuando la ficha es buena pero el fichero no: un capítulo suelto donde debería estar el libro entero, una
 * copia mutilada, otra edición. Se sube el fichero bueno (de Anna's Archive, Z-Library…) y la ficha se queda con
 * TODO lo que tiene —título, autores, ISBN, CDU, colección, ubicación, valoración, NFC, selecciones, fichas de
 * lectura—; solo cambian el fichero, su hash, sus páginas y las imágenes extraídas de él (portada y 5+1; las
 * imágenes añadidas a mano se conservan).
 *
 * Con el fichero ANTERIOR, la persona elige (`actual`):
 *   · 'papelera'   — se descarta: a la Papelera (recuperable hasta que se vacíe). Su hash pasa a
 *                    `hashes_anteriores`: si vuelve a entrar por el Inbox se reconoce como esta ficha y no se
 *                    cataloga otra vez.
 *   · 'reingestar' — es OTRO documento que merece su propia ficha: va al Inbox y se cataloga solo. Su hash NO se
 *                    guarda en esta ficha (si se guardara, la ingesta lo tomaría por esta y lo reciclaría).
 *   · 'revision'   — se aparta para mirarlo con calma: a `Cuarentena/revision/<título>-<id6>/` con su estado.json.
 *                    Aparece en la página Cuarentena con «Reingestar» y «Descartar». No va al Inbox, así que no se
 *                    vuelve a catalogar solo.
 * Nunca se borra nada: lo único que sale de la carpeta es el fichero anterior, y siempre hacia uno de esos tres sitios.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { carpetaDeDoc, EXT_DOC, numeroPaginasPdf } from '../mantenimiento/util-mantenimiento.js';
import { ficheroDelDoc } from './hash-doc.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { reciclar } from './papelera.js';
import { cabecera, firmaValida } from './saneamiento.js';
import { FORMATO_POR_EXT } from '../orquestador.js';
import { reextraerImagenesDoc } from './reextraer-imagenes.js';
import { indexarDoc } from './indice-busqueda.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
/** Categoría de Cuarentena para los ficheros apartados «para revisión». */
export const CATEGORIA_REVISION = 'revision';
export const DESTINOS_FICHERO_ACTUAL = ['papelera', 'reingestar', 'revision'];

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const nombreSeguro = (s) => (String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'documento');

/** `destino` libre: si ya existe, «nombre (2).ext», «nombre (3).ext»… (nunca se pisa nada). */
async function rutaLibre(destino) {
    if (!(await existe(destino))) return destino;
    const ext = path.extname(destino);
    const base = destino.slice(0, destino.length - ext.length);
    for (let i = 2; ; i++) {
        const otra = `${base} (${i})${ext}`;
        if (!(await existe(otra))) return otra;
    }
}

/**
 * Mueve un fichero sin riesgo: rename y, entre volúmenes distintos (EXDEV), copia → comprueba el tamaño → borra el
 * origen. Si la copia no cuadra, el origen se queda donde estaba.
 */
async function moverFichero(origen, destino) {
    await fs.mkdir(path.dirname(destino), { recursive: true });
    try {
        await fs.rename(origen, destino);
        return;
    } catch (e) {
        if (e.code !== 'EXDEV') throw e;
    }
    await fs.copyFile(origen, destino);
    const [a, b] = await Promise.all([fs.stat(origen), fs.stat(destino)]);
    if (a.size !== b.size) {
        await fs.rm(destino, { force: true }).catch(() => {});
        throw new Error('la copia no coincide en tamaño con el original: no se ha movido');
    }
    await fs.rm(origen);
}

/**
 * @param {object} opciones
 * @param {string} opciones.rutaTmp         el fichero subido (temporal de multer)
 * @param {string} opciones.nombreOriginal  su nombre tal como lo subió la persona
 * @param {'papelera'|'reingestar'|'revision'} opciones.actual  qué hacer con el fichero que tenía la ficha
 * @returns {Promise<{ok, motivo?, nombre?, actual?, destinoActual?, imagenes?}>}
 */
export async function reemplazarFicheroDoc(db, id, { rutaTmp, nombreOriginal, actual = 'papelera' } = {}) {
    if (!ObjectId.isValid(String(id))) return { ok: false, motivo: 'id inválido' };
    if (!DESTINOS_FICHERO_ACTUAL.includes(actual)) return { ok: false, motivo: `destino del fichero actual no válido («${actual}»)` };
    if (!rutaTmp) return { ok: false, motivo: 'no se recibió el fichero nuevo' };
    const bib = db.collection('biblioteca');
    const doc = await bib.findOne({ _id: new ObjectId(String(id)) });
    if (!doc) return { ok: false, motivo: 'documento no encontrado' };
    if ((doc.formatos || []).includes('papel')) return { ok: false, motivo: 'es un libro en papel: no tiene fichero que sustituir' };
    const carpeta = carpetaDeDoc(doc);
    if (!carpeta) return { ok: false, motivo: 'el documento no tiene carpeta (ruta_base)' };

    // 1) El fichero nuevo: un documento de verdad, no una página de error ni el mismo que ya tiene.
    const nombre = path.basename(String(nombreOriginal || '')).replace(/[<>:"\\|?*\x00-\x1f]+/g, ' ').trim();
    const ext = path.extname(nombre).toLowerCase();
    if (!nombre || !EXT_DOC.includes(ext)) return { ok: false, motivo: `formato no admitido (${ext || 'sin extensión'}): ${EXT_DOC.join(' ')}` };
    const st = await fs.stat(rutaTmp).catch(() => null);
    if (!st || st.size < 1024) return { ok: false, motivo: `el fichero está vacío o es demasiado pequeño (${st ? st.size : 0} B)` };
    if (!firmaValida(await cabecera(rutaTmp).catch(() => Buffer.alloc(8)), ext.slice(1))) {
        return { ok: false, motivo: `el fichero no parece un ${ext.slice(1).toUpperCase()} válido (¿una página de error de la descarga?)` };
    }
    const hash = await calcularHashArchivo(rutaTmp);
    if (doc.hash_contenido && hash === doc.hash_contenido) return { ok: false, motivo: 'es exactamente el mismo fichero que ya tiene la ficha' };
    const otro = await bib.findOne({ $or: [{ hash_contenido: hash }, { 'hashes_anteriores.hash': hash }], _id: { $ne: doc._id } }, { projection: { titulo: 1 } });
    if (otro) return { ok: false, motivo: `ese fichero ya está en la biblioteca: «${otro.titulo}» (${otro._id})`, duplicadoDe: String(otro._id) };

    // 2) El fichero actual (puede faltar en disco: entonces solo se coloca el nuevo).
    const abs = await ficheroDelDoc(doc).catch(() => null);

    // 3) Colocar el nuevo en la carpeta. Si se llama igual que el actual, el actual sale antes (paso 4) y el nuevo
    //    entra con su nombre; para eso se deja primero en un temporal de la propia carpeta.
    await fs.mkdir(carpeta, { recursive: true });
    const temporal = path.join(carpeta, `.entrante-${Date.now()}${ext}`);
    await fs.copyFile(rutaTmp, temporal);
    if ((await fs.stat(temporal)).size !== st.size) {
        await fs.rm(temporal, { force: true }).catch(() => {});
        return { ok: false, motivo: 'la copia del fichero nuevo a su carpeta salió incompleta: no se ha cambiado nada' };
    }

    // 4) Retirar el actual a donde se eligió.
    let destinoActual = null;
    if (abs) {
        try {
            if (actual === 'papelera') {
                const sub = await reciclar([abs], `fichero-sustituido-${nombreSeguro(doc.titulo)}`);
                // reciclar CONSERVA el original si no pudo copiarlo: entonces no se sigue.
                if (!sub || (await existe(abs))) throw new Error('la Papelera no lo admitió');
                destinoActual = path.join(sub, path.basename(abs));
            } else if (actual === 'reingestar') {
                destinoActual = await rutaLibre(path.join(DIR_INBOX, path.basename(abs)));
                await moverFichero(abs, destinoActual);
            } else {
                const dep = await rutaLibre(path.join(DIR_CUARENTENA, CATEGORIA_REVISION, `${nombreSeguro(doc.titulo)}-${String(doc._id).slice(-6)}`));
                await fs.mkdir(dep, { recursive: true });
                destinoActual = path.join(dep, path.basename(abs));
                await moverFichero(abs, destinoActual);
                // Lo que el panel de Cuarentena enseña de un depósito (título + motivo).
                await fs.writeFile(path.join(dep, 'estado.json'), JSON.stringify({
                    titulo: `Retirado de «${doc.titulo}»`,
                    error: { tipo: 'revision', mensaje: `Fichero sustituido en la ficha ${doc._id}: revisar qué es antes de reingestarlo o descartarlo.` },
                    fecha: new Date().toISOString(),
                    doc_id: String(doc._id),
                    ruta_base: doc.ruta_base || null,
                    hash: doc.hash_contenido || null,
                }, null, 2), 'utf8');
            }
        } catch (e) {
            // El actual sigue en su sitio: se deshace la entrada del nuevo y no se toca la ficha.
            await fs.rm(temporal, { force: true }).catch(() => {});
            return { ok: false, motivo: `no se pudo retirar el fichero actual (${e.message}): no se ha cambiado nada` };
        }
    }
    const final = await rutaLibre(path.join(carpeta, nombre));
    await fs.rename(temporal, final);

    // 5) La ficha: mismo todo; nuevo fichero, hash, formato, páginas.
    const stFinal = await fs.stat(final);
    const fmtNuevo = FORMATO_POR_EXT[ext];
    const fmtViejo = doc.nombre_archivo ? FORMATO_POR_EXT[path.extname(doc.nombre_archivo).toLowerCase()] : null;
    const formatos = [...new Set([...(doc.formatos || []).filter((f) => f !== fmtViejo), fmtNuevo].filter(Boolean))];
    const ahora = new Date();
    const set = {
        nombre_archivo: path.basename(final),
        formatos,
        hash_contenido: hash, hash_fecha: ahora, hash_mtime: stFinal.mtimeMs, hash_tamano: stFinal.size,
        fecha_actualizacion: ahora,
    };
    if (doc.tamanos) set['tamanos.principal'] = stFinal.size;
    const unset = {};
    if (ext === '.pdf') {
        const n = await numeroPaginasPdf(final).catch(() => 0);
        if (n) set.paginas = n;
    } else if (doc.paginas) {
        unset.paginas = '';   // las páginas eran las del fichero anterior
    }
    const destinoLegible = { papelera: 'a la Papelera', reingestar: 'al Inbox (se catalogará aparte)', revision: 'a Cuarentena/revision' }[actual];
    const update = {
        $set: set,
        $push: { alertas_agente: `Fichero sustituido a mano: «${doc.nombre_archivo || '?'}» → «${path.basename(final)}»; el anterior, ${abs ? destinoLegible : 'no estaba en disco'}.` },
    };
    // Solo un fichero DESCARTADO deja su hash en la ficha (para reconocerlo si vuelve a entrar). El que va a
    // reingestarse o a revisión no: la ingesta lo tomaría por esta ficha y lo reciclaría sin catalogarlo.
    if (actual === 'papelera' && doc.hash_contenido) update.$push.hashes_anteriores = { hash: doc.hash_contenido, hasta: ahora };
    if (Object.keys(unset).length) update.$unset = unset;
    await bib.updateOne({ _id: doc._id }, update);

    // 6) Las imágenes salían del fichero anterior: se vuelven a extraer del nuevo (las manuales se conservan).
    const actualizado = await bib.findOne({ _id: doc._id });
    const img = await reextraerImagenesDoc(db, actualizado, { solo5mas1: true }).catch((e) => ({ ok: false, motivo: e.message }));
    await indexarDoc(db, doc._id).catch(() => {});
    console.log(`🔁 Fichero sustituido en «${doc.titulo}» (${doc._id}): ${path.basename(final)}; el anterior → ${destinoActual || '(no estaba)'}.`);
    return {
        ok: true,
        nombre: path.basename(final),
        actual,
        destinoActual: destinoActual ? path.relative(RAIZ, String(destinoActual)) : null,
        imagenes: img.ok ? img.n : 0,
        avisoImagenes: img.ok ? null : img.motivo,
    };
}
