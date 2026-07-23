/**
 * qpdf — dos operaciones ESTRUCTURALES sobre PDF (no re-renderiza: copia los objetos originales, así que no
 * hay pérdida de calidad ni de la capa de texto):
 *
 *   · unirPdfs()   — COSE varios PDF en uno. Lo usa el «libro desglosado PURO» (una carpeta que solo trae los
 *                    capítulos, sin el libro entero): se recompone el libro y se cataloga de forma ordinaria.
 *   · repararPdf() — RECONSTRUYE la tabla xref de un PDF dañado a partir de los objetos que sí están en el
 *                    fichero. Es lo que hacen por dentro las webs tipo iLovePDF.
 *
 * FILOSOFÍA DEL INFORME DE REPARACIÓN (la fija el usuario): una reparación puede salir «bien» y devolver un
 * documento MUTILADO (iLovePDF a veces reconstruye 25 páginas de un libro de cientos). Dar por bueno eso sería
 * FALSA SEGURIDAD: creerías tener un libro que en realidad no tienes. Por eso `repararPdf` NUNCA dice solo
 * «reparado»: devuelve páginas recuperadas, bytes antes/después y una SOSPECHA razonada de mutilación, para
 * que la decisión de reingerir (o no) la tome una persona mirando los números.
 *
 * Si qpdf no está instalado, ambas degradan devolviendo {ok:false, sinQpdf:true} — nada se rompe.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const ejecutar = promisify(execFile);
const TIEMPO = Number(process.env.QPDF_TIMEOUT_MS || 300000); // 5 min: coser 700 páginas en un Atom no es instantáneo

/** ¿Está qpdf disponible? (se cachea: la respuesta no cambia en caliente) */
let _hay = null;
export async function hayQpdf() {
    if (_hay !== null) return _hay;
    try { await ejecutar('qpdf', ['--version'], { timeout: 10000 }); _hay = true; }
    catch { _hay = false; }
    return _hay;
}

const tam = async (p) => { try { return (await fs.stat(p)).size; } catch { return 0; } };

/** Nº de páginas de un PDF según poppler (pdfinfo). null si no se puede leer. */
export async function paginasPdf(ruta) {
    try {
        const { stdout } = await ejecutar('pdfinfo', [ruta], { timeout: 60000, maxBuffer: 1 << 20 });
        const m = stdout.match(/^Pages:\s+(\d+)/m);
        return m ? Number(m[1]) : null;
    } catch { return null; }
}

/**
 * COSE `rutas` (en ese orden) en un único PDF `destino`. Devuelve { ok, paginas, bytes } o { ok:false, motivo }.
 * qpdf copia las páginas tal cual: el resultado es la suma exacta de las partes, sin recomprimir.
 */
export async function unirPdfs(rutas, destino, { timeout = TIEMPO } = {}) {
    if (!Array.isArray(rutas) || rutas.length < 2) return { ok: false, motivo: 'hacen falta al menos dos PDF' };
    if (!(await hayQpdf())) return { ok: false, sinQpdf: true, motivo: 'qpdf no está instalado' };
    try {
        await fs.mkdir(path.dirname(destino), { recursive: true });
        // qpdf --empty --pages <a> <b> … -- <destino>   (cada fichero aporta TODAS sus páginas)
        await ejecutar('qpdf', ['--empty', '--pages', ...rutas, '--', destino], { timeout, maxBuffer: 1 << 22 });
        const paginas = await paginasPdf(destino);
        const bytes = await tam(destino);
        if (!bytes) return { ok: false, motivo: 'qpdf no produjo salida' };
        return { ok: true, paginas, bytes, partes: rutas.length };
    } catch (e) {
        // qpdf avisa por stderr de páginas problemáticas pero puede haber generado un PDF válido igualmente.
        const bytes = await tam(destino);
        if (bytes > 0) {
            const paginas = await paginasPdf(destino);
            if (paginas) return { ok: true, paginas, bytes, partes: rutas.length, aviso: (e.stderr || e.message || '').slice(0, 300) };
        }
        return { ok: false, motivo: (e.stderr || e.message || 'error de qpdf').slice(0, 300) };
    }
}

/**
 * REPARA un PDF dañado (reconstruye el xref). Escribe el resultado en `destino` y devuelve un INFORME:
 *   { ok, paginas, paginasAntes, bytesOrigen, bytesDestino, ratio, sospecha, motivoSospecha }
 * `sospecha` = la reparación pudo salir INCOMPLETA (documento mutilado). No se decide por el usuario: se le
 * dan los números para que mire el resultado y decida.
 */
export async function repararPdf(origen, destino, { timeout = TIEMPO } = {}) {
    if (!(await hayQpdf())) return { ok: false, sinQpdf: true, motivo: 'qpdf no está instalado' };
    const bytesOrigen = await tam(origen);
    if (!bytesOrigen) return { ok: false, motivo: 'el fichero de origen está vacío o no existe' };
    // Páginas que poppler logra ver ANTES de reparar (a veces reconstruye por su cuenta): sirve de contraste.
    const paginasAntes = await paginasPdf(origen);

    try {
        await fs.mkdir(path.dirname(destino), { recursive: true });
        // Sin --replace-input: NUNCA se toca el original (queda intacto para reintentar con otra herramienta).
        await ejecutar('qpdf', ['--decrypt', origen, destino], { timeout, maxBuffer: 1 << 22 });
    } catch (e) {
        // qpdf devuelve código 3 en «warnings» (típico al reconstruir un xref roto) PERO sí escribe el PDF.
        const b = await tam(destino);
        if (!b) return { ok: false, motivo: (e.stderr || e.message || 'qpdf no pudo reparar').slice(0, 300) };
    }

    const bytesDestino = await tam(destino);
    if (!bytesDestino) return { ok: false, motivo: 'la reparación no produjo ningún fichero' };
    const paginas = await paginasPdf(destino);
    if (!paginas) {
        await fs.rm(destino, { force: true }).catch(() => {});
        return { ok: false, motivo: 'el resultado sigue sin ser un PDF legible (daño demasiado severo)' };
    }

    // ── SOSPECHA DE MUTILACIÓN ──────────────────────────────────────────────────────────────────────────
    // No podemos saber cuántas páginas «debería» tener un fichero roto, pero sí dar señales objetivas:
    //   · el resultado pesa mucho menos que el original → se quedó contenido por el camino;
    //   · poppler ya veía MÁS páginas antes de reparar que las que hay ahora;
    //   · muy pocas páginas para el tamaño del original (un PDF de 20 MB con 25 páginas huele mal).
    const ratio = bytesOrigen ? bytesDestino / bytesOrigen : 0;
    const motivos = [];
    if (ratio < 0.6) motivos.push(`el PDF reparado pesa solo el ${Math.round(ratio * 100)}% del original`);
    if (paginasAntes && paginas < paginasAntes) motivos.push(`antes se veían ${paginasAntes} páginas y ahora ${paginas}`);
    const mbOrigen = bytesOrigen / 1048576;
    if (mbOrigen > 5 && paginas < mbOrigen * 2) motivos.push(`${paginas} páginas para ${mbOrigen.toFixed(1)} MB de original: parecen pocas`);

    return {
        ok: true, paginas, paginasAntes, bytesOrigen, bytesDestino,
        ratio: Number(ratio.toFixed(2)),
        sospecha: motivos.length > 0,
        motivoSospecha: motivos.join(' · '),
    };
}
