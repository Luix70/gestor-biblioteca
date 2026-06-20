import path from 'path';

const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

export const esImagen = (ruta) => EXT_IMAGEN.includes(path.extname(ruta).toLowerCase());

/**
 * Filtra duplicados de nombre: si "X.pdf" y "X (1).pdf" coexisten, descarta el "(N)".
 * El sistema de archivos añade este sufijo para evitar sobreescritura; el contenido es el mismo.
 */
export function filtrarDuplicadosNombre(rutas) {
    const basenames = new Set(rutas.map(r => path.basename(r)));
    return rutas.filter(r => {
        const nombre = path.basename(r);
        const sinSufijo = nombre.replace(/ \(\d+\)(\.[^.]+)$/, '$1');
        if (sinSufijo === nombre) return true;        // sin sufijo (N): siempre incluir
        return !basenames.has(sinSufijo);             // con sufijo: solo si el original no existe
    });
}

/**
 * Agrupa una lista plana de archivos en UNIDADES de procesamiento (un libro/revista cada una):
 *   - cada epub/pdf/otro formato = su propia unidad,
 *   - TODAS las imágenes sueltas juntas = una sola unidad (un libro físico con varias vistas).
 *
 * @returns Array<{ rutas: string[], esImagenes: boolean }>
 */
export function agrupar(rutas) {
    const filtradas = filtrarDuplicadosNombre(rutas);
    const imagenes  = filtradas.filter(esImagen);
    const documentos = filtradas.filter(r => !esImagen(r));

    const unidades = documentos.map(r => ({ rutas: [r], esImagenes: false }));
    if (imagenes.length > 0) unidades.push({ rutas: imagenes, esImagenes: true });
    return unidades;
}
