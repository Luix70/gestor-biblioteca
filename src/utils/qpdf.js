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
// El tiempo NO depende de los megas sino de los OBJETOS del PDF: en el Atom, «Digital Systems» (1.940 págs.) tardó
// 28 s y «Instrument Flying Handbook» (387 págs., 46 MB, con un capítulo de gráficos vectoriales) pasó de 5 min.
const TIEMPO = Number(process.env.QPDF_TIMEOUT_MS || 1800000); // ver config.js

/** ¿Está qpdf disponible? (se cachea: la respuesta no cambia en caliente) */
let _hay = null;
export async function hayQpdf() {
    if (_hay !== null) return _hay;
    try { await ejecutar('qpdf', ['--version'], { timeout: 10000 }); _hay = true; }
    catch { _hay = false; }
    return _hay;
}

const tam = async (p) => { try { return (await fs.stat(p)).size; } catch { return 0; } };

/**
 * Nº de páginas de un PDF según poppler. null si de verdad no se puede leer.
 *
 * OJO CON EL CÓDIGO DE SALIDA: `pdfinfo` devuelve 1 o 99 en cuanto encuentra avisos de sintaxis, AUNQUE haya
 * podido leer el documento e imprimir «Pages:». Como execFile RECHAZA la promesa con código ≠ 0, la versión
 * anterior devolvía null en esos casos y se daba por «ilegible» un PDF reparado que sí valía — y encima se
 * borraba. Aquí se mira SIEMPRE la salida, venga por resolución o por excepción.
 */
export async function paginasPdf(ruta) {
    let salida = '';
    try {
        const { stdout } = await ejecutar('pdfinfo', [ruta], { timeout: 60000, maxBuffer: 1 << 20 });
        salida = stdout || '';
    } catch (e) {
        salida = (e && e.stdout) || '';   // pdfinfo pudo imprimir el informe y salir con código de aviso
    }
    const m = salida.match(/^Pages:\s+(\d+)/m);
    return m ? Number(m[1]) : null;
}

/** ¿Está Ghostscript disponible? (segunda fase de reparación, para daños que qpdf no arregla) */
let _hayGs = null;
export async function hayGs() {
    if (_hayGs !== null) return _hayGs;
    for (const bin of ['gs', 'gsc']) {
        try { await ejecutar(bin, ['--version'], { timeout: 10000 }); _hayGs = bin; return _hayGs; }
        catch { /* siguiente */ }
    }
    _hayGs = false;
    return _hayGs;
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
        await ejecutar('qpdf', ['--empty', '--pages', ...rutas, '--', destino], { timeout, maxBuffer: 1 << 26 });
        const paginas = await paginasPdf(destino);
        const bytes = await tam(destino);
        if (!bytes) return { ok: false, motivo: 'qpdf no produjo salida' };
        return { ok: true, paginas, bytes, partes: rutas.length };
    } catch (e) {
        // Matado por el tiempo: lo que haya escrito está A MEDIAS. Nunca se da por bueno, aunque poppler lo abra.
        if (e.killed) return { ok: false, tiempoAgotado: true, motivo: `qpdf no terminó en ${Math.round(timeout / 60000)} min` };
        // qpdf avisa por stderr de páginas problemáticas pero puede haber generado un PDF válido igualmente.
        const bytes = await tam(destino);
        if (bytes > 0) {
            const paginas = await paginasPdf(destino);
            if (paginas) return { ok: true, paginas, bytes, partes: rutas.length, aviso: String(e.stderr || '').slice(0, 300) };
        }
        // Solo stderr: e.message empieza por la línea de órdenes entera, que con 40 rutas tapaba la causa real.
        // `stderr` entero aparte: unirPdfsReparando busca en él qué partes están dañadas.
        const stderr = String(e.stderr || '').trim();
        return { ok: false, motivo: stderr.slice(-300) || `qpdf terminó con código ${e.code}`, stderr: stderr.slice(-20000) };
    }
}

/**
 * COSE como unirPdfs, pero si qpdf no puede porque alguna PARTE está dañada (xref roto, «invalid object in page
 * tree»), REPARA esas partes en copias temporales y vuelve a coser con ellas. Los originales no se tocan (siguen
 * viajando tal cual al «Desglose/» del libro).
 *
 * Una copia reparada solo se usa si la reparación no es SOSPECHOSA (mismas páginas que se veían antes, sin
 * adelgazar): coser un capítulo mutilado daría un libro al que le faltan páginas sin que nadie lo supiera. Si una
 * parte no se puede reparar bien, el resultado es el fallo original y el libro sigue esperando.
 * Caso que lo motivó (10-nov): Oppenheim «Discrete-Time Signal Processing», 17 capítulos, uno con el xref roto.
 */
export async function unirPdfsReparando(rutas, destino, opciones = {}) {
    const r = await unirPdfs(rutas, destino, opciones);
    if (r.ok || r.sinQpdf || r.tiempoAgotado) return r;

    // Las partes culpables: las que qpdf nombra en sus mensajes. Si no nombra ninguna, se prueban todas.
    const nombradas = rutas.filter((p) => (r.stderr || r.motivo || '').includes(p));
    const culpables = nombradas.length ? nombradas : rutas;
    const tmp = await fs.mkdtemp(path.join(path.dirname(destino), '.reparadas-'));
    try {
        const sustitutas = new Map();
        for (const parte of culpables) {
            const copia = path.join(tmp, `${sustitutas.size}-${path.basename(parte)}`);
            const inf = await repararPdf(parte, copia, opciones);
            if (!inf.ok || inf.sospecha) {
                // Con TODAS a prueba (qpdf no dijo cuál), una sana que no mejora no estorba: se usa el original.
                if (!nombradas.length) continue;
                return { ...r, motivo: `${r.motivo} · «${path.basename(parte)}» no se pudo reparar sin perder páginas (${inf.motivoSospecha || inf.motivo})` };
            }
            sustitutas.set(parte, copia);
        }
        if (!sustitutas.size) return r;
        await fs.rm(destino, { force: true }).catch(() => {});
        const r2 = await unirPdfs(rutas.map((p) => sustitutas.get(p) || p), destino, opciones);
        return r2.ok ? { ...r2, reparadas: [...sustitutas.keys()].map((p) => path.basename(p)) } : r2;
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * REPARA un PDF dañado (reconstruye el xref). Escribe el resultado en `destino` y devuelve un INFORME:
 *   { ok, paginas, paginasAntes, bytesOrigen, bytesDestino, ratio, sospecha, motivoSospecha }
 * `sospecha` = la reparación pudo salir INCOMPLETA (documento mutilado). No se decide por el usuario: se le
 * dan los números para que mire el resultado y decida.
 */
export async function repararPdf(origen, destino, { timeout = TIEMPO } = {}) {
    // Basta con tener UNA de las dos: qpdf (estructural) o Ghostscript (reconstructiva). Antes se exigía qpdf
    // y, si solo estaba gs, ni se intentaba.
    const conQpdf = await hayQpdf(), conGs = await hayGs();
    if (!conQpdf && !conGs) return { ok: false, sinQpdf: true, motivo: 'no hay ninguna herramienta de reparación (qpdf / ghostscript)' };
    const bytesOrigen = await tam(origen);
    if (!bytesOrigen) return { ok: false, motivo: 'el fichero de origen está vacío o no existe' };
    // Páginas que poppler logra ver ANTES de reparar (a veces reconstruye por su cuenta): sirve de contraste.
    const paginasAntes = await paginasPdf(origen);

    await fs.mkdir(path.dirname(destino), { recursive: true });
    // ── FASE 1 · qpdf: reparación ESTRUCTURAL (reconstruye la tabla xref a partir de los objetos que están).
    //    Arregla los casos «el índice está roto pero el contenido está entero». NUNCA se usa --replace-input:
    //    el original dañado se conserva intacto para poder reintentar con otra herramienta.
    let herramienta = null;
    try {
        if (!conQpdf) throw new Error('sin qpdf');
        await ejecutar('qpdf', ['--decrypt', origen, destino], { timeout, maxBuffer: 1 << 22 });
        herramienta = 'qpdf';
    } catch (e) {
        // Código 3 = «terminó con avisos» (lo normal al reconstruir un xref): el PDF SÍ se escribió.
        if (await tam(destino)) herramienta = 'qpdf';
    }
    let paginas = herramienta ? await paginasPdf(destino) : null;

    // ── FASE 2 · Ghostscript: reparación RECONSTRUCTIVA. Reinterpreta el documento y lo REESCRIBE entero, así
    //    que recupera daños que qpdf no puede tocar (es, en esencia, lo que hacen por dentro iLovePDF/pdf24).
    //    Es más lento y re-codifica, por eso se deja como SEGUNDA fase: solo si la primera no dio un PDF legible.
    if (!paginas) {
        const gs = conGs;
        if (gs) {
            const tmpGs = destino + '.gs.pdf';
            try {
                await ejecutar(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dPDFSTOPONERROR=false', '-sDEVICE=pdfwrite',
                    '-sOutputFile=' + tmpGs, origen], { timeout, maxBuffer: 1 << 22 });
            } catch { /* gs también avisa por stderr; lo que manda es si produjo un PDF legible */ }
            const pagsGs = (await tam(tmpGs)) ? await paginasPdf(tmpGs) : null;
            if (pagsGs) {
                await fs.rm(destino, { force: true }).catch(() => {});
                await fs.rename(tmpGs, destino);
                paginas = pagsGs;
                herramienta = 'ghostscript';
            } else {
                await fs.rm(tmpGs, { force: true }).catch(() => {});
            }
        }
    }

    const bytesDestino = await tam(destino);
    if (!paginas) {
        await fs.rm(destino, { force: true }).catch(() => {});
        return {
            ok: false,
            motivo: bytesDestino
                ? 'el resultado sigue sin ser un PDF legible (daño demasiado severo)'
                : 'ninguna herramienta pudo reconstruir el fichero',
            sinGs: !conGs,   // el panel puede sugerir instalar Ghostscript si falta la segunda fase
        };
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
        ok: true, paginas, paginasAntes, bytesOrigen, bytesDestino, herramienta,
        ratio: Number(ratio.toFixed(2)),
        sospecha: motivos.length > 0,
        motivoSospecha: motivos.join(' · '),
    };
}
