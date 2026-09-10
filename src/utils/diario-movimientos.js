/**
 * DIARIO DE MOVIMIENTOS DE CARPETA (para que la copia de seguridad no los pague como copias).
 *
 * EL PROBLEMA: `rsync` no entiende de movimientos. Cuando el Conformador reclasifica un documento y su
 * carpeta cambia de rama del árbol CDU, rsync ve dos hechos inconexos —«desapareció la ruta vieja» y «hay una
 * ruta nueva»— y RETRANSFIERE el documento entero. Con origen y destino locales ni siquiera hay algoritmo
 * delta que valga (rsync usa `--whole-file` por defecto en local-a-local). Con una media que tenderá a ~240 MB
 * por documento, una campaña de reclasificación de 10.000 documentos son ~2,4 TB por USB 2.0: casi un día.
 *
 * LA SOLUCIÓN: nosotros SÍ sabemos que es un movimiento, porque lo hace nuestro código y pasa todo por un
 * único sitio (`util-mantenimiento·moverCarpetaConVerificacion`). Se anota aquí, y antes de sincronizar el
 * script `sincronizar-copia.sh` REPLICA cada movimiento en el disco de copia con un `mv` —un rename dentro
 * del mismo sistema de ficheros, coste constante da igual que el documento pese 4 KB o 2 GB— de modo que
 * rsync se encuentra todo en su sitio y no transfiere nada.
 *
 * ES UNA OPTIMIZACIÓN, NO UNA DEPENDENCIA: si el diario se pierde, se trunca, o un `mv` falla, rsync hace lo
 * de siempre (borrar de un lado, copiar del otro). Se pierde velocidad, nunca datos. Por eso todo aquí es
 * best-effort y jamás lanza: un fallo anotando no puede tumbar una reclasificación que salió bien.
 *
 * DÓNDE VIVE: dentro del propio árbol CDU, que es el punto donde se cruzan el contenedor (`/app/CDU`) y el
 * anfitrión (`/volume3/BIBLIOTECA DIGITAL/CDU`), que es quien ejecuta el script. Sin bind mounts nuevos.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export const NOMBRE_DIARIO = '.movimientos-copia.log';

// Tope de tamaño. Cada línea ronda los 150 bytes, así que 8 MB son ~55.000 movimientos: de sobra entre dos
// copias. Al desbordar se conserva la MITAD MÁS RECIENTE (lo antiguo ya se aplicó hace mucho; y si un disco
// llevaba meses desconectado y pierde entradas, rsync lo resuelve copiando, que es el comportamiento previo).
const TOPE_BYTES = 8 * 1024 * 1024;

/** Ruta del diario dentro del árbol. */
export function rutaDiario(dirCdu) {
    return path.join(dirCdu, NOMBRE_DIARIO);
}

/**
 * Anota un movimiento ya CONSUMADO. Las rutas se guardan RELATIVAS al árbol CDU, porque el script las lee
 * desde el anfitrión, donde el árbol cuelga de otro sitio que dentro del contenedor.
 *
 * Formato TSV, una línea por movimiento: <ISO>\t<ruta vieja>\t<ruta nueva>
 * Se eligió TSV y no JSON para que el script lo lea con `cut`/`read` sin necesitar un parseador.
 *
 * @param dirCdu      raíz del árbol CDU (se pasa como argumento para no importar util-mantenimiento y crear
 *                    una dependencia circular: es él quien llama aquí)
 * @param origenAbs   carpeta de origen (absoluta), ya inexistente
 * @param destinoAbs  carpeta de destino (absoluta)
 */
export async function anotarMovimiento(dirCdu, origenAbs, destinoAbs) {
    try {
        const viejo = path.relative(dirCdu, origenAbs);
        const nuevo = path.relative(dirCdu, destinoAbs);
        // Fuera del árbol (`..`) o movimiento vacío: no es asunto de la copia del árbol CDU.
        if (!viejo || !nuevo || viejo.startsWith('..') || nuevo.startsWith('..') || viejo === nuevo) return;

        // Separadores en estilo POSIX: el script corre en Linux aunque esto se ejecute en Windows.
        const aPosix = (p) => p.split(path.sep).join('/');
        // Un salto o un tabulador dentro de un nombre rompería el TSV. No debería pasar (rutas.js sanea los
        // segmentos), pero si pasara preferimos NO anotar antes que escribir una línea corrupta que el script
        // interpretaría mal: sin anotación, rsync simplemente lo copia.
        const linea = `${new Date().toISOString()}\t${aPosix(viejo)}\t${aPosix(nuevo)}\n`;
        if (linea.includes('\r') || linea.split('\t').length !== 3) return;

        const ruta = rutaDiario(dirCdu);
        await fs.appendFile(ruta, linea, 'utf8');
        await recortarSiDesborda(ruta);
    } catch { /* best-effort: nunca romper el movimiento por no poder anotarlo */ }
}

/** Si el diario supera el tope, conserva la mitad más reciente. Silencioso. */
async function recortarSiDesborda(ruta) {
    try {
        const st = await fs.stat(ruta);
        if (st.size <= TOPE_BYTES) return;
        const texto = await fs.readFile(ruta, 'utf8');
        const lineas = texto.split('\n').filter(Boolean);
        await fs.writeFile(ruta, lineas.slice(Math.floor(lineas.length / 2)).join('\n') + '\n', 'utf8');
    } catch { /* si no se puede recortar, se deja crecer: es preferible a perderlo */ }
}
