/**
 * BORRADO SEGURO — única vía para retirar una carpeta del Inbox / árbol CDU. Política fijada por el usuario
 * (prioridad ABSOLUTA: no perder datos), tras la pérdida de «Alexandrina.2.Ancient Greece»:
 *
 *   1. `fs.rm` de una carpeta SOLO si está LITERALMENTE vacía de contenido real (a cualquier profundidad):
 *      únicamente metadatos del sistema (@eaDir, #recycle, .*, Thumbs.db) o subcarpetas vacías. Nunca borra
 *      un fichero real.
 *   2. Si la carpeta tiene CUALQUIER contenido real —incluidos los COMPRIMIDOS de cualquier tipo, que NO son
 *      basura— o pesa MÁS de 10 MB, se MUEVE A LA PAPELERA (reciclarCarpeta), NUNCA se borra con fs.rm.
 *   3. Si el reciclado falla, la carpeta se CONSERVA (jamás se borra a ciegas).
 *
 * El único `fs.rm` de FICHEROS que sigue permitido vive en la ingesta: un re-drop byte-idéntico (mismo hash)
 * de un documento YA archivado y con su copia PRESENTE físicamente. Todo lo demás pasa por aquí o por la Papelera.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { reciclarCarpeta } from './papelera.js';

// Umbral por encima del cual una carpeta NUNCA se borra con fs.rm: siempre va a la Papelera (recuperable).
const UMBRAL_PAPELERA = Number(process.env.BORRADO_UMBRAL_PAPELERA_MB || 10) * 1024 * 1024;
const NIVEL_MAX = 24; // tope de profundidad (anti-ciclos de symlink); ante la duda, se trata como «con contenido».

// Sidecars que genera la propia app (instrucciones/registros, NO datos del usuario): son borrables.
const SIDECARS = new Set(['_guia.json', 'estado.json', 'registro.json', 'registro.marc.xml', '.papelera.json', '.ruta_fija', '.transmedia', '.noborrar', '.portadas']);

// Metadatos que NO cuentan como contenido y pueden borrarse: ocultos, carpetas de Synology (@eaDir/#recycle),
// Thumbs.db/desktop.ini, los sidecars de la app y los *.meta.json de override. (Los COMPRIMIDOS de cualquier
// tipo —.zip/.rar/.7z/.tar.gz/.gz…— NO entran aquí: son contenido de pleno derecho, nunca basura.)
export const esMetadatoSistema = (n) => {
    if (n.startsWith('.') || n.startsWith('@') || n.startsWith('#')) return true;
    const l = n.toLowerCase();
    if (l === 'thumbs.db' || l === 'desktop.ini' || l.endsWith('.meta.json')) return true;
    return SIDECARS.has(n);
};

/** ¿Hay ALGÚN fichero real (no metadato del sistema) a CUALQUIER profundidad? Conservador: ante la duda, sí. */
export async function hayContenidoReal(dir, nivel = NIVEL_MAX) {
    if (nivel < 0) return true; // demasiado hondo → por seguridad se considera CON contenido (no se borra)
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
        if (esMetadatoSistema(e.name)) continue;
        if (e.isFile()) return true;
        if (e.isDirectory() && (await hayContenidoReal(path.join(dir, e.name), nivel - 1))) return true;
    }
    return false;
}

/** Suma recursiva de bytes de una carpeta (best-effort). */
export async function bytesCarpeta(dir, nivel = NIVEL_MAX) {
    if (nivel < 0) return 0;
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
    let total = 0;
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) total += await bytesCarpeta(p, nivel - 1);
        else { try { total += (await fs.stat(p)).size; } catch { /* ignora */ } }
    }
    return total;
}

/**
 * Retira una carpeta del Inbox / árbol CDU con la política de seguridad. Devuelve:
 *   'inexistente' | 'reciclada' (a la Papelera) | 'borrada-vacia' (solo metadatos, fs.rm) | 'conservada' (fallo).
 */
export async function retirarCarpeta(dir, etiqueta = 'retirada') {
    if (!dir) return 'inexistente';
    try { await fs.access(dir); } catch { return 'inexistente'; }
    const [conContenido, bytes] = await Promise.all([hayContenidoReal(dir), bytesCarpeta(dir)]);
    // Contenido real (incluidos comprimidos) o > umbral → SIEMPRE a la Papelera, nunca fs.rm.
    if (conContenido || bytes > UMBRAL_PAPELERA) {
        try {
            await reciclarCarpeta(dir, etiqueta);
            return 'reciclada';
        } catch (e) {
            console.warn(`  ⚠ No se pudo reciclar «${path.basename(dir)}» (${e.message}): se CONSERVA (no se borra).`);
            return 'conservada';
        }
    }
    // Solo metadatos del sistema o subcarpetas vacías, y < umbral → fs.rm no pierde nada.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    return 'borrada-vacia';
}
