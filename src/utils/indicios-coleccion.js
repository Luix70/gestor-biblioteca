/**
 * INDICIOS DE COLECCIÓN → EDITORIAL. Lo que el bibliotecario APRENDE al identificar ediciones: «Solaris ficción»
 * la publica La Factoría de Ideas. Cada vez que un libro de una colección queda identificado (por autoridad, con
 * ISBN provisional o porque tú elegiste la edición), se anota en la colección la editorial de esa edición. Esos
 * indicios sirven después como PRUEBA de editorial para los demás libros de la misma colección, aunque su campo
 * `editorial` esté vacío o mal (caso real: «Los propios dioses» tenía «Salamandra» y su colección «Ediciones B»;
 * ninguna candidata casaba y quedó ambigua).
 *
 * Se guardan en la colección como `editoriales_indicios: [{ nombre, n, ultima }]` (n = cuántas identificaciones
 * lo respaldan). Indicios, no verdades: se suman, y el que más respaldo tiene va primero.
 */
import { ObjectId } from 'mongodb';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** La colección del documento: por su referencia o, si no la tiene, por su nombre (sin mayúsculas ni acentos). */
async function coleccionDe(db, { coleccion = null, coleccion_nombre = null }) {
    const col = db.collection('colecciones');
    if (coleccion) {
        const _id = typeof coleccion === 'string' && ObjectId.isValid(coleccion) ? new ObjectId(coleccion) : coleccion;
        const c = await col.findOne({ _id }, { projection: { nombre: 1, editorial: 1, editoriales_indicios: 1 } }).catch(() => null);
        if (c) return c;
    }
    const nombre = String(coleccion_nombre || '').trim();
    if (!nombre) return null;
    const escapado = nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return col.findOne({ nombre: { $regex: `^${escapado}$`, $options: 'i' } }, { projection: { nombre: 1, editorial: 1, editoriales_indicios: 1 } }).catch(() => null);
}

/**
 * Editoriales que la colección del documento sugiere, de más a menos respaldadas: primero los indicios
 * aprendidos y, al final, la editorial que tenga fijada la colección (puede estar mal: por eso va detrás).
 * @returns {Promise<string[]>}
 */
export async function editorialesDeColeccion(db, ref) {
    const c = await coleccionDe(db, ref);
    if (!c) return [];
    const out = [...(c.editoriales_indicios || [])].sort((a, b) => (b.n || 0) - (a.n || 0)).map((x) => x.nombre);
    if (c.editorial) {
        const ed = await db.collection('editoriales').findOne({ _id: c.editorial }, { projection: { nombre: 1 } }).catch(() => null);
        if (ed?.nombre) out.push(ed.nombre);
    }
    return [...new Set(out.filter(Boolean))];
}

/** Anota en la colección del documento que una edición suya es de `editorial`. Nunca lanza. */
export async function anotarEditorialDeColeccion(db, ref, editorial) {
    try {
        if (!editorial) return false;
        const c = await coleccionDe(db, ref);
        if (!c) return false;
        const lista = [...(c.editoriales_indicios || [])];
        const k = norm(editorial);
        const hay = lista.find((x) => norm(x.nombre) === k);
        if (hay) { hay.n = (hay.n || 0) + 1; hay.ultima = new Date(); }
        else lista.push({ nombre: editorial, n: 1, ultima: new Date() });
        await db.collection('colecciones').updateOne({ _id: c._id }, { $set: { editoriales_indicios: lista } });
        return true;
    } catch { return false; }
}
