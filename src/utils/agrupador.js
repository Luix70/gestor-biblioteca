import path from 'path';

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

export const esImagen = (ruta) => EXT_IMAGEN.includes(path.extname(ruta).toLowerCase());

/**
 * Agrupa una lista plana de archivos en UNIDADES de procesamiento (un libro/revista cada una):
 *   - cada epub/pdf/otro formato = su propia unidad,
 *   - TODAS las imágenes sueltas juntas = una sola unidad (un libro físico con varias vistas).
 *
 * @returns Array<{ rutas: string[], esImagenes: boolean }>
 */
export function agrupar(rutas) {
    const imagenes = rutas.filter(esImagen);
    const documentos = rutas.filter(r => !esImagen(r));

    const unidades = documentos.map(r => ({ rutas: [r], esImagenes: false }));
    if (imagenes.length > 0) unidades.push({ rutas: imagenes, esImagenes: true });
    return unidades;
}
