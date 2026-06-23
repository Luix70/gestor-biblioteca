import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { variantesISBN } from './identificadores.js';

/**
 * Resuelve el TÍTULO (y la descripción) de una obra multivolumen consultando las autoridades por su
 * `isbn_obra` (el ISBN del set). Es la fuente fiable del título de la obra — mejor que el nombre de la
 * carpeta o del fichero del tomo. Reutilizado por: la ingesta (al CREAR la obra), el Conformador
 * (completar-obra-por-isbn) y el panel (botón "re-consultar").
 *
 * @param force  true = re-consulta aunque la obra ya estuviera resuelta (botón del panel).
 * @returns { ok, titulo?, descripcion?, motivo? }
 */
export async function resolverObraPorIsbn(db, obraId, { force = false } = {}) {
    const col = db.collection('obras');
    const obra = await col.findOne({ _id: obraId });
    if (!obra) return { ok: false, motivo: 'obra no encontrada' };
    if (!obra.isbn_obra) return { ok: false, motivo: 'la obra no tiene isbn_obra' };
    if (obra.resuelta_isbn && !force) return { ok: false, motivo: 'ya resuelta' };

    let datos;
    try {
        datos = await buscarMetadatosExternos(obra.titulo || '', '', null, {
            incluirSinopsis: true, incluirCdu: false, isbnsArchivo: variantesISBN(obra.isbn_obra),
        });
    } catch (e) { return { ok: false, motivo: `autoridad no disponible (${e.message})` }; }

    const set = {};
    if (datos.titulo)   set.titulo = datos.titulo;       // el isbn_obra manda sobre el nombre de carpeta/fichero
    if (datos.sinopsis) set.descripcion = datos.sinopsis;
    if (!set.titulo && !set.descripcion) return { ok: false, motivo: 'la autoridad no devolvió datos para ese ISBN' };

    set.resuelta_isbn = true;
    set.fecha_actualizacion = new Date();
    await col.updateOne({ _id: obraId }, { $set: set });
    return { ok: true, titulo: set.titulo || obra.titulo, descripcion: set.descripcion || obra.descripcion || null };
}
