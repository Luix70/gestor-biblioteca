/**
 * Resuelve el NOMBRE de una persona (autor/traductor/ilustrador/…) a su ObjectId en la colección `autores`,
 * con el patrón check-then-create que ya usaba motor-catalogo para los autores. Centralizado aquí para que
 * lo compartan la ingesta (autores + contribuciones) y los scripts de backfill, sin duplicar la lógica:
 *   · normalizarAutor: primer contribuyente del marcador BNE «/**​/» + fechas de vida → nacimiento/fallecimiento.
 *   · latinizarNombre: alfabeto no latino → principal LATINIZADO + grafía original en nombres_alternativos.
 * Empareja por nombre latinizado, nombre limpio o grafía alternativa; si no existe, lo crea. Best-effort:
 * si el nombre queda vacío tras limpiar, devuelve null (no crea basura).
 *
 * @returns {Promise<{_id: import('mongodb').ObjectId, creada: boolean, nombre: string}|null>}
 */
import { normalizarAutor, claveAutor } from './autor-normalizar.js';
import { latinizarNombre } from './transliterar.js';

// Una vez por proceso: índice sobre `clave` y la clave de los autores que aún no la tienen.
let clavesAseguradas = null;
export function asegurarClavesAutores(db) {
    if (!clavesAseguradas) {
        clavesAseguradas = (async () => {
            const col = db.collection('autores');
            await col.createIndex({ clave: 1 }).catch(() => {});
            const sinClave = await col.find({ clave: { $exists: false } }, { projection: { nombre: 1 } }).toArray();
            for (let i = 0; i < sinClave.length; i += 1000) {
                const lote = sinClave.slice(i, i + 1000).map((a) => ({
                    updateOne: { filter: { _id: a._id }, update: { $set: { clave: claveAutor(a.nombre) } } },
                }));
                await col.bulkWrite(lote, { ordered: false });
            }
        })().catch((err) => {
            clavesAseguradas = null;   // se reintenta en la próxima resolución
            throw err;
        });
    }
    return clavesAseguradas;
}

export async function resolverPersona(db, autorStr) {
    if (autorStr && typeof autorStr === 'object' && autorStr._bsontype === 'ObjectId') {
        return { _id: autorStr, creada: false, nombre: null }; // ya es un ObjectId
    }
    const bio = normalizarAutor(autorStr);
    const limpio = bio.nombre || String(autorStr || '').trim();
    if (!limpio) return null;
    const { nombre, alternativos } = latinizarNombre(limpio);
    const col = db.collection('autores');

    // Emparejado INSENSIBLE a mayúsculas Y acentos (collation strength:1): «JEAN TOUCHARD» = «Jean Touchard»
    // = «Jean Tóuchard» → la MISMA persona, no un autor nuevo. Sin esto, la visión (que lee el nombre en
    // mayúsculas de una portada) creaba un duplicado. El nombre canónico es el del PRIMERO creado; la grafía
    // distinta se guarda como nombres_alternativos (más abajo).
    // …y además por CLAVE (sin puntuación ni espacios): «Tolkien, J.R.R.» = «Tolkien, J. R. R.», «H.G.Wells» =
    // «H. G. Wells». La collation ignora mayúsculas y acentos pero no la puntuación (7-oct: 642 grupos de autores
    // repetidos así). Campo `clave` indexado; los autores antiguos lo reciben la primera vez (asegurarClavesAutores).
    const k = claveAutor(nombre);
    let existente = await col.findOne(
        { $or: [{ nombre }, { nombre: limpio }, { nombres_alternativos: limpio }] },
        { collation: { locale: 'es', strength: 1 } });
    if (!existente && k.length >= 4) {
        await asegurarClavesAutores(db).catch(() => {});
        existente = await col.findOne({ clave: k }, { sort: { _id: 1 } });
    }
    if (existente) {
        const upd = {};
        if (limpio !== existente.nombre) upd.$addToSet = { nombres_alternativos: limpio };
        const setBio = {};
        if (bio.nacimiento && !existente.nacimiento) setBio.nacimiento = bio.nacimiento;
        if (bio.fallecimiento && !existente.fallecimiento) setBio.fallecimiento = bio.fallecimiento;
        if (Object.keys(setBio).length) upd.$set = setBio;
        if (Object.keys(upd).length) await col.updateOne({ _id: existente._id }, upd).catch(() => {});
        return { _id: existente._id, creada: false, nombre: existente.nombre };
    }

    const doc = { nombre };
    if (k) doc.clave = k;
    if (alternativos.length) doc.nombres_alternativos = alternativos;
    if (bio.nacimiento) doc.nacimiento = bio.nacimiento;
    if (bio.fallecimiento) doc.fallecimiento = bio.fallecimiento;
    const nuevo = await col.insertOne(doc);
    return { _id: nuevo.insertedId, creada: true, nombre };
}
