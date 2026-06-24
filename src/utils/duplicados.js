/**
 * Resolución de DUPLICADOS de Cuarentena (panel).
 *
 * Cuando un fichero entrante comparte identificador (isbn→issn→título) con un documento ya
 * catalogado PERO su contenido difiere, servicio-ingesta lo deja en Cuarentena/duplicados/<dep>/
 * (con su estado.json y `documento_existente_id`). Aquí se COMPARA el catalogado con el entrante
 * y, con la decisión del usuario, se RESUELVE:
 *
 *   - quedarse 'existente' → el entrante se descarta a la Papelera; el catalogado queda intacto.
 *   - quedarse 'entrante'  → se retira el catalogado (carpeta a la Papelera + se borra su doc) y el
 *                            entrante vuelve al Inbox para RE-CATALOGARSE limpio (reusa el pipeline;
 *                            el documento resultante es nuevo y correcto). Política de desempate por
 *                            defecto (la recomendación): el MÁS GRANDE / con MÁS PÁGINAS.
 *
 * Seguridad: política "nunca borrar" (todo va a Papelera vía reciclar; un depósito/carpeta solo se
 * elimina cuando se confirma que sus ficheros de datos ya están reciclados). Un TOMO de obra
 * multivolumen NO se puede sustituir por aquí (rompería la obra) → se rechaza con aviso.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../mantenimiento/util-mantenimiento.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { reciclar } from './papelera.js';
import { resolverNombres, aRegistroLegible, escribirSidecars } from './registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');

// Resuelve el id relativo ("duplicados/<dep>") a una carpeta REAL bajo Cuarentena (anti-traversal).
function depositoDe(idRel) {
    const partes = String(idRel || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return null;
    return path.join(DIR_CUARENTENA, ...partes);
}

// Métricas de un fichero para comparar: tamaño, páginas (PDF), fecha, formato y si es LEGIBLE.
export async function metricasFichero(ruta) {
    if (!ruta) return { existe: false, legible: false };
    let st; try { st = await fs.stat(ruta); } catch { return { existe: false, legible: false }; }
    const ext = path.extname(ruta).toLowerCase();
    let paginas = null;
    if (ext === '.pdf') paginas = await numeroPaginasPdf(ruta).catch(() => null);
    // PDF legible = pdfinfo dio páginas (>0); otros formatos: basta que no sea de 0 bytes.
    const legible = st.size > 0 && (ext === '.pdf' ? !!(paginas && paginas > 0) : true);
    return { existe: true, ruta, archivo: path.basename(ruta), bytes: st.size, mtime: st.mtimeMs, paginas, legible, ext, formato: ext.slice(1) };
}
const metricas = metricasFichero; // alias interno (compararDuplicado lo usa).

// Política de desempate "mismo formato, contenido distinto": gana el MÁS GRANDE; empate de tamaño
// → el MÁS RECIENTE. Si el catalogado no tiene fichero, gana el entrante (lo aporta).
export function ganaEntrante(ex, en) {
    if (!en.existe) return false;
    if (!ex.existe) return true;
    if (en.bytes !== ex.bytes) return en.bytes > ex.bytes;
    return en.mtime > ex.mtime;
}

/**
 * Sustituye el fichero del documento `doc` por `ficheroNuevo` y SINCRONIZA la BD: actualiza
 * nombre_archivo, hash_contenido y paginas, y regenera registro.json/.marc.xml. El fichero viejo
 * (distinto) va a la Papelera. NO toca el `ficheroNuevo` de origen (eso lo decide el llamante).
 * Lo usan tanto la ingesta en vivo (servicio-ingesta) como el script de backlog.
 */
export async function reemplazarFicheroDeDoc(doc, ficheroNuevo) {
    const db = await conectarDB();
    const carpeta = carpetaDeDoc(doc);
    await fs.mkdir(carpeta, { recursive: true });
    const viejo = await archivoOriginal(carpeta);
    if (viejo) await reciclar([viejo], `reemplazado-${doc.isbn || doc.titulo || String(doc._id)}`);
    const destino = path.join(carpeta, path.basename(ficheroNuevo));
    await fs.copyFile(ficheroNuevo, destino);
    const hash = await calcularHashArchivo(destino).catch(() => null);
    const paginas = path.extname(destino).toLowerCase() === '.pdf' ? await numeroPaginasPdf(destino).catch(() => null) : null;
    const set = { nombre_archivo: path.basename(ficheroNuevo) };
    if (hash) set.hash_contenido = hash;
    if (paginas) set.paginas = paginas;
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
    const docAct = { ...doc, ...set };
    const nombres = await resolverNombres(db, docAct);
    await escribirSidecars(carpeta, aRegistroLegible(docAct, nombres)).catch(() => {});
    return { _id: doc._id, ...set };
}

// Desempate (política "más grande / más páginas") + guardas de legibilidad e identidad.
// Exportada para poder testearla sin Mongo ni ficheros.
export function decidir(ex, en, identico) {
    if (!en.existe || !en.legible) return ['existente', 'el entrante no es legible'];
    if (!ex.existe || !ex.legible) return ['entrante', 'el catalogado no está o no es legible'];
    if (identico) return ['existente', 'contenido idéntico (mismo hash)'];
    if (ex.paginas != null && en.paginas != null && ex.paginas !== en.paginas)
        return en.paginas > ex.paginas
            ? ['entrante', `más páginas (${en.paginas} vs ${ex.paginas})`]
            : ['existente', `más páginas (${ex.paginas} vs ${en.paginas})`];
    if (en.bytes !== ex.bytes)
        return en.bytes > ex.bytes
            ? ['entrante', `mayor tamaño (${(en.bytes / 1e6).toFixed(1)} vs ${(ex.bytes / 1e6).toFixed(1)} MB)`]
            : ['existente', `mayor tamaño (${(ex.bytes / 1e6).toFixed(1)} vs ${(en.bytes / 1e6).toFixed(1)} MB)`];
    return ['existente', 'empate: se conserva el catalogado'];
}

/** Compara el documento catalogado con el fichero entrante de un depósito de duplicados. */
export async function compararDuplicado(idRel) {
    const depDir = depositoDe(idRel);
    if (!depDir) return { ok: false, motivo: 'identificador de depósito inválido' };
    let estado; try { estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8')); }
    catch { return { ok: false, motivo: 'depósito sin estado.json' }; }

    // Entrante: el (único) fichero del depósito.
    const ents = await fs.readdir(depDir).catch(() => []);
    const archEntrante = ents.find(n => n !== 'estado.json');
    const en = await metricas(archEntrante ? path.join(depDir, archEntrante) : null);

    // Catalogado: documento de Mongo + su fichero en el árbol CDU.
    const idExist = estado.documento_existente_id;
    let doc = null, rutaEx = null, ex = { existe: false, legible: false };
    if (idExist && ObjectId.isValid(idExist)) {
        const db = await conectarDB();
        doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(idExist) });
        if (doc) { rutaEx = await archivoOriginal(carpetaDeDoc(doc)); ex = await metricas(rutaEx); }
    }

    // Idéntico solo si MISMO tamaño (pre-filtro barato) y mismo hash.
    let identico = false;
    if (ex.existe && en.existe && ex.bytes === en.bytes) {
        const [h1, h2] = await Promise.all([
            calcularHashArchivo(rutaEx).catch(() => null),
            calcularHashArchivo(path.join(depDir, archEntrante)).catch(() => null),
        ]);
        identico = !!(h1 && h2 && h1 === h2);
    }

    const [recomendado, motivo] = decidir(ex, en, identico);
    return {
        ok: true,
        id: idRel,
        titulo: estado.titulo || doc?.titulo || null,
        identificador: estado.identificador || null,
        existente: doc
            ? { _id: String(doc._id), titulo: doc.titulo || null, isbn: doc.isbn || doc.issn || null,
                año_edicion: doc.año_edicion || null, es_obra: !!doc.obra, ...ex }
            : { existe: false, legible: false, motivo: 'documento no encontrado en Mongo (posible huérfano)' },
        entrante: en,
        identico, recomendado, motivo,
    };
}

// Elimina un depósito SOLO si ya no contiene ficheros de datos (los movió reciclar). Devuelve si limpió.
async function limpiarDeposito(depDir) {
    const restantes = (await fs.readdir(depDir).catch(() => [])).filter(n => n !== 'estado.json');
    if (restantes.length) return false; // algo no se recicló → conservar el depósito para reintento
    await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    return true;
}

/**
 * Resuelve un depósito de duplicados con la decisión del usuario.
 * @param {string} idRel    "duplicados/<dep>"
 * @param {'existente'|'entrante'} quedarse  cuál se conserva
 */
export async function resolverDuplicado(idRel, quedarse) {
    if (!['existente', 'entrante', 'ambos'].includes(quedarse))
        return { ok: false, motivo: "quedarse debe ser 'existente', 'entrante' o 'ambos'" };
    const depDir = depositoDe(idRel);
    if (!depDir) return { ok: false, motivo: 'identificador de depósito inválido' };
    let estado; try { estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8')); }
    catch { return { ok: false, motivo: 'depósito sin estado.json' }; }
    const etiqueta = estado.identificador || estado.titulo || 'recurso';
    const ficherosEntrante = (await fs.readdir(depDir).catch(() => []))
        .filter(n => n !== 'estado.json').map(n => path.join(depDir, n));

    // ── Conservar AMBOS: el catalogado queda intacto y el entrante vuelve al Inbox con un override
    //    forzar_nuevo (.meta.json) para catalogarse como documento DISTINTO (otra edición/ejemplar). ──
    if (quedarse === 'ambos') {
        await fs.mkdir(DIR_INBOX, { recursive: true });
        let movidos = 0;
        for (const f of ficherosEntrante) {
            try {
                const destino = path.join(DIR_INBOX, path.basename(f));
                await fs.copyFile(f, destino);
                const [o, d] = await Promise.all([fs.stat(f), fs.stat(destino)]);
                if (o.size === d.size) {
                    await fs.writeFile(destino + '.meta.json', JSON.stringify({ forzar_nuevo: true }, null, 2), 'utf8');
                    movidos++;
                }
            } catch { /* sigue con el resto */ }
        }
        if (movidos === ficherosEntrante.length) await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
        return { ok: movidos > 0, accion: 'entrante-reingestado-como-distinto', movidos, total: ficherosEntrante.length,
            aviso: movidos === ficherosEntrante.length ? null : 'algún fichero no se pudo mover al Inbox: depósito conservado' };
    }

    // ── Conservar el CATALOGADO: el entrante se descarta a la Papelera. ──
    if (quedarse === 'existente') {
        if (ficherosEntrante.length) await reciclar(ficherosEntrante, `duplicado-descartado-${etiqueta}`);
        const limpio = await limpiarDeposito(depDir);
        return { ok: true, accion: 'entrante-descartado', deposito_eliminado: limpio,
            aviso: limpio ? null : 'el entrante no se pudo reciclar del todo: depósito conservado' };
    }

    // ── Conservar el ENTRANTE: retirar el catalogado y re-catalogar el entrante limpio. ──
    const idExist = estado.documento_existente_id;
    const db = await conectarDB();
    const doc = (idExist && ObjectId.isValid(idExist))
        ? await db.collection('biblioteca').findOne({ _id: new ObjectId(idExist) }) : null;
    if (doc?.obra)
        return { ok: false, motivo: 'el catalogado es un TOMO de obra multivolumen: resuélvelo desde Obras para no romper la obra' };

    if (doc) {
        // 1) Reciclar la carpeta del catalogado. Si NO queda vacía (algo no se recicló) → abortar:
        //    no borramos el doc ni movemos nada (nunca perder datos, nunca dejar a medias).
        const carpeta = carpetaDeDoc(doc);
        const entradas = await fs.readdir(carpeta, { withFileTypes: true }).catch(() => []);
        const ficheros = entradas.filter(e => e.isFile()).map(e => path.join(carpeta, e.name));
        if (ficheros.length) await reciclar(ficheros, `reemplazado-${doc.isbn || doc.titulo || String(doc._id)}`);
        const sigue = (await fs.readdir(carpeta).catch(() => [])).length;
        if (sigue) return { ok: false, motivo: 'no se pudo reciclar por completo la carpeta del catalogado: acción cancelada (sin cambios)' };
        await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
        // 2) Borrar el documento catalogado (el entrante lo reemplazará al recatalogarse).
        await db.collection('biblioteca').deleteOne({ _id: doc._id }).catch(() => {});
    }

    // 3) Mover el entrante al Inbox (copia verificada) para que el vigilante lo recatalogue.
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let movidos = 0;
    for (const f of ficherosEntrante) {
        try {
            const destino = path.join(DIR_INBOX, path.basename(f));
            await fs.copyFile(f, destino);
            const [o, d] = await Promise.all([fs.stat(f), fs.stat(destino)]);
            if (o.size === d.size) movidos++;
        } catch { /* sigue con el resto */ }
    }
    if (movidos === ficherosEntrante.length) await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    return {
        ok: movidos > 0,
        accion: 'catalogado-retirado-y-entrante-reingestado',
        doc_eliminado: doc ? String(doc._id) : null,
        movidos, total: ficherosEntrante.length,
        aviso: movidos === ficherosEntrante.length ? null : 'algún fichero del entrante no se pudo mover al Inbox: depósito conservado',
    };
}
