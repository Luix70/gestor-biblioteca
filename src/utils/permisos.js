/**
 * NORMALIZACIÓN DE PERMISOS DEL ÁRBOL CDU.
 *
 * PROBLEMA QUE RESUELVE: `fs.copyFile` y `fs.cp` PRESERVAN el modo del origen. El material que entra en la
 * biblioteca viene de descargas, discos ajenos y colecciones empaquetadas por terceros, y trae los permisos
 * que tuviera allí: ficheros de solo lectura (`-r--r--r--`), y sobre todo DIRECTORIOS sin el bit de travesía
 * para grupo/otros. Esos modos se copian tal cual al árbol CDU y se quedan ahí para siempre.
 *
 * CONSECUENCIA REAL (así se descubrió): un `du` —o un `rsync` de copia de seguridad— ejecutado con un usuario
 * que no sea el propietario se topa con «Permission denied» en esas carpetas y LAS SALTA. La aplicación no se
 * entera (el contenedor corre con privilegios y lee bien), así que el fallo es SILENCIOSO: la copia de
 * seguridad queda con huecos y no te enteras hasta que necesitas restaurar. Es el peor modo de fallo posible
 * para un backup, y por eso se normaliza en el momento de escribir, no «cuando haga falta».
 *
 * POLÍTICA: directorios 0o755 y ficheros 0o644 — todo el mundo puede LEER y recorrer el árbol, solo el
 * propietario escribe. Es lo mínimo que garantiza que cualquier herramienta de copia lo vea entero.
 * Deliberadamente NO se toca la propiedad (usuario/grupo): DSM monta ACLs por encima de los permisos POSIX
 * y un `chown` desde aquí podría dejarlas inconsistentes. Con el modo basta para que la copia funcione.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const MODO_DIR = 0o755;      // rwxr-xr-x → cualquiera puede entrar y listar
export const MODO_FICHERO = 0o644;  // rw-r--r-- → cualquiera puede leer

/**
 * Normaliza los permisos de una ruta (fichero o carpeta) y, si es carpeta, de todo su contenido.
 *
 * Es BEST-EFFORT por diseño: nunca lanza. Se llama desde el camino crítico de la ingesta, y unos permisos
 * que no se pudieron ajustar no deben tumbar una catalogación que por lo demás fue bien (el fichero está
 * copiado y verificado; a lo sumo habrá que repasarlo luego con el backfill).
 *
 * @param   {string} rutaAbs  ruta absoluta a normalizar
 * @returns {Promise<number>} número de entradas cuyo modo se cambió realmente (para informes)
 */
export async function normalizarPermisos(rutaAbs) {
    let st;
    try { st = await fs.lstat(rutaAbs); } catch { return 0; }

    // Los enlaces simbólicos se saltan: `chmod` seguiría el enlace y tocaría el destino, que puede estar
    // fuera del árbol. En el árbol CDU no debería haber ninguno, pero más vale no sorprenderse.
    if (st.isSymbolicLink()) return 0;

    const deseado = st.isDirectory() ? MODO_DIR : MODO_FICHERO;
    let cambiados = 0;

    // Solo se llama a chmod si el modo NO es ya el deseado. Sobre 485.000 ficheros por SMB o en un Atom, un
    // chmod incondicional serían cientos de miles de escrituras de metadatos inútiles.
    if ((st.mode & 0o777) !== deseado) {
        try { await fs.chmod(rutaAbs, deseado); cambiados++; } catch { /* sin permiso para cambiarlo: se ignora */ }
    }

    if (!st.isDirectory()) return cambiados;

    // El directorio se normaliza ANTES de recorrerlo: si le faltaba el bit de travesía, sin esto no podríamos
    // ni listar su contenido para arreglar lo de dentro — que es exactamente el caso que originó todo esto.
    let entradas;
    try { entradas = await fs.readdir(rutaAbs); } catch { return cambiados; }
    for (const nombre of entradas) {
        cambiados += await normalizarPermisos(path.join(rutaAbs, nombre));
    }
    return cambiados;
}

/**
 * Variante para un fichero recién creado, sin `lstat` previo ni recursión: el caso más común en la ingesta
 * (acabamos de copiar un fichero y sabemos que es un fichero). Nunca lanza.
 */
export async function normalizarFichero(rutaAbs) {
    await fs.chmod(rutaAbs, MODO_FICHERO).catch(() => {});
}
