/**
 * Mover un fichero o una carpeta entre montajes SIN PERDER NADA.
 *
 * PreProceso, el Inbox, la Papelera y la Cuarentena son montajes distintos del contenedor, así que `rename` falla con
 * EXDEV: entonces se copia, se verifica (mismos ficheros y mismos bytes) y solo después se borra el origen. Si la copia
 * no cuadra, se borra la COPIA y el origen se queda donde estaba.
 *
 * Antes vivía dentro de preproceso.js; ahora la usan también el Vigilante (un comprimido que no se puede abrir se
 * aparta a PreProceso) y scripts/recuperar-comprimidos.js.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

/** Ficheros y bytes de un árbol (o de un fichero), para verificar una copia. */
export async function huella(ruta) {
    const st = await fs.stat(ruta);
    if (!st.isDirectory()) return { n: 1, bytes: st.size };
    let n = 0, bytes = 0;
    for (const e of await fs.readdir(ruta)) {
        const h = await huella(path.join(ruta, e));
        n += h.n;
        bytes += h.bytes;
    }
    return { n, bytes };
}

/**
 * Mueve `origen` a `destino` (que no debe existir). Lanza si no pudo; en ese caso el origen sigue intacto.
 * @param {{conservarOrigen?: boolean}} [opts]  conservarOrigen: copia verificada, pero sin borrar el origen.
 */
export async function moverArbol(origen, destino, { conservarOrigen = false } = {}) {
    await fs.mkdir(path.dirname(destino), { recursive: true });
    if (!conservarOrigen) {
        try { await fs.rename(origen, destino); return; }
        catch (e) { if (e.code !== 'EXDEV') throw e; }
    }
    await fs.cp(origen, destino, { recursive: true, errorOnExist: true, force: false });
    const [a, b] = await Promise.all([huella(origen), huella(destino)]);
    if (a.n !== b.n || a.bytes !== b.bytes) {
        await fs.rm(destino, { recursive: true, force: true });
        throw new Error(`copia incompleta de «${path.basename(origen)}» (${a.n}/${a.bytes} ≠ ${b.n}/${b.bytes}); el original se queda donde estaba`);
    }
    if (!conservarOrigen) await fs.rm(origen, { recursive: true, force: true });
}

/** Un nombre libre a partir de `destino`: nunca se pisa nada («X (2).zip», «X (3)»…). */
export async function destinoLibre(destino) {
    const existe = (p) => fs.access(p).then(() => true, () => false);
    if (!(await existe(destino))) return destino;
    const ext = path.extname(destino), base = destino.slice(0, destino.length - ext.length);
    for (let i = 2; ; i++) {
        const otro = `${base} (${i})${ext}`;
        if (!(await existe(otro))) return otro;
    }
}
