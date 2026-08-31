import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { timeoutPoppler } from './timeout-poppler.js';

const execFileP = promisify(execFile);

// Ancho objetivo del rasterizado. pdftoppm (poppler) es un rasterizador CPU portátil que
// detecta las instrucciones del procesador en tiempo de ejecución (pixman cae a SSE2/SSSE3),
// así que funciona en el Atom D525 — al contrario que sharp/libvips (SIMD AVX en un .node).
const ANCHO = Number(process.env.PDF_RASTER_ANCHO || 1024);

// Errores de poppler que indican que el PDF ENTERO es ilegible (xref dañado, sin árbol de
// páginas…), no que falle una página suelta: ante esto no tiene sentido probar más páginas.
const PDF_ILEGIBLE = /pages object is wrong type|xref\b.*not found|after the last page \(0\)|May not be a PDF|Couldn't read xref|Document stream is empty/i;

// Páginas clave: las 2 primeras (portada/portadilla) y la última (contraportada).
function paginasObjetivo(numPaginas) {
    const set = new Set([1]);
    if (numPaginas >= 2) set.add(2);
    if (numPaginas >= 1) set.add(numPaginas);
    return [...set].sort((a, b) => a - b);
}

// Agrupa una lista de páginas en TRAMOS contiguos [desde, hasta]. Rasterizar cada tramo en UNA sola llamada
// a pdftoppm ahorra RELECTURAS del PDF: en un PDF grande NO-linealizado (Acrobat sin «fast web view»),
// poppler relee el fichero ENTERO en CADA invocación, así que rasterizar 6 páginas por separado = 6 lecturas
// de 177 MB (~50 s cada una en el Atom → timeouts). Por tramos: frontales [1..5] en 1 lectura + contraportada.
function tramosContiguos(paginas) {
    const orden = [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b);
    const tramos = [];
    for (const p of orden) {
        const ultimo = tramos[tramos.length - 1];
        if (ultimo && p === ultimo[1] + 1) ultimo[1] = p;
        else tramos.push([p, p]);
    }
    return tramos;
}

// Rasteriza el tramo [desde, hasta] a JPEG en `dir` con UNA llamada a pdftoppm. pdftoppm nombra la salida
// `<prefijo>-NNNN.jpg` (NNNN = nº de página relleno con ceros al ancho del TOTAL de páginas del documento,
// que no conocemos aquí) → se GLOBEA el directorio y se mapea por el número del nombre. Devuelve
// [{ pagina, buffer }] ordenado. Lanza (para que el caller distinga ENOENT/ilegible/timeout).
async function rasterizarTramo(ruta, desde, hasta, dir, ancho, timeout, idx) {
    const prefijo = path.join(dir, `t${idx}`);
    await execFileP('pdftoppm', [
        '-jpeg', '-f', String(desde), '-l', String(hasta),
        '-scale-to-x', String(ancho), '-scale-to-y', '-1',
        ruta, prefijo,
    ], { timeout: timeout || 60000 });
    const nombres = (await fs.readdir(dir)).filter(n => n.startsWith(`t${idx}-`) && n.endsWith('.jpg'));
    const paginas = [];
    for (const n of nombres) {
        const m = n.match(/-(\d+)\.jpg$/);
        if (m) paginas.push({ pagina: parseInt(m[1], 10), buffer: await fs.readFile(path.join(dir, n)) });
    }
    return paginas.sort((a, b) => a.pagina - b.pagina);
}

/**
 * Rasteriza páginas de un PDF a JPEG con poppler/pdftoppm.
 *   - { numPaginas }      → páginas clave para portada (1, 2 y la última).
 *   - { paginas: [..] }   → lista explícita (p. ej. la portadilla/créditos para OCR).
 *   - { ancho }           → ancho objetivo en px (1024 portada; más alto para OCR legible).
 * Devuelve [{ buffer, pagina, etiqueta }] (la 1ª = 'portada'). Rasteriza por TRAMOS contiguos (menos
 * relecturas del PDF). Si pdftoppm no está instalado (ENOENT) o el PDF está dañado, devuelve lo que pudo
 * (posiblemente []) → degradación elegante.
 */
export async function rasterizarPaginas(ruta, { numPaginas = 2, paginas = null, ancho = ANCHO } = {}) {
    const objetivo = (paginas && paginas.length)
        ? [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b)
        : paginasObjetivo(numPaginas);
    const total = objetivo.length ? Math.max(...objetivo) : numPaginas;
    let dir;
    try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raster-'));
    } catch {
        return [];
    }

    // Timeout ADAPTATIVO al tamaño (se calcula UNA vez): en el Atom, un PDF de cientos de MB no se rasteriza
    // en 60 s → antes daba renders=[] y el PDF (válido) acababa declarado ilegible.
    const to = await timeoutPoppler(ruta);
    const salida = [];
    try {
        let idx = 0;
        for (const [desde, hasta] of tramosContiguos(objetivo)) {
            try {
                for (const { pagina, buffer } of await rasterizarTramo(ruta, desde, hasta, dir, ancho, to, idx++)) {
                    const etiqueta = pagina === 1 ? 'portada' : (pagina === total ? 'contraportada' : `pagina-${pagina}`);
                    salida.push({ buffer, pagina, etiqueta });
                }
            } catch (e) {
                if (e.code === 'ENOENT') {
                    console.warn('[Raster] pdftoppm (poppler-utils) no disponible: se omite el rasterizado del PDF.');
                    break;
                }
                if (PDF_ILEGIBLE.test(e.message || '') || PDF_ILEGIBLE.test(e.stderr || '')) {
                    console.warn(`[Raster] PDF ilegible (estructura dañada, p. ej. xref): se omite el rasterizado de "${path.basename(ruta)}". Requiere una copia mejor.`);
                    break;
                }
                // Timeout (proceso matado) o error del tramo: DIAGNÓSTICO explícito (para verlo en los logs del
                // NAS) y se sigue con el resto de tramos (otro puede salir bien).
                const motivo = e.killed ? `TIMEOUT tras ${to} ms` : ((e.stderr || e.message || '').split('\n')[0] || 'error');
                console.warn(`[Raster] tramo ${desde}-${hasta} de "${path.basename(ruta)}" no rasterizado: ${motivo}.`);
            }
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return salida.sort((a, b) => a.pagina - b.pagina);
}

// ── DETECCIÓN DE PÁGINAS SIN CONTENIDO ÚTIL (sin IA, apta para el Atom) ──────────────────────────────────
// Al extraer las 5 páginas frontales + 1 final para OCR/visión/portada, una página SIN CONTENIDO IDENTIFICATIVO
// no aporta nada y desperdicia cupo. Se salta cualquiera que esté CASI VACÍA (poca tinta): página en blanco, el
// aviso «This page is intentionally left blank», un «scanned by …», una línea o caption pequeña, o un adorno
// gráfico decorativo (viñeta, florón, cul-de-lampe, rosetón, separador «* * *»…). Se detecta rasterizando la
// página a un PGM GRIS diminuto con poppler (C, sin SIMD) y midiendo la fracción de píxeles con TINTA: casi vacía
// da ~0-0.5 %; una portada/portadilla/texto, ≥ 2 %. Barato: el PGM es minúsculo (~120px). El coste real de
// poppler es la RELECTURA del PDF, así que se mide TODA la ventana en UNA llamada (tramos contiguos), no página
// a página. (Un adorno GRANDE y muy denso podría superar el umbral; se prefiere conservar de más a descartar
// contenido real — dirección segura.)
const SIG_ANCHO = Number(process.env.PDF_SIGNIFICATIVA_ANCHO || 120);   // ancho del render de medida (px)
const TINTA_MIN = Number(process.env.PDF_TINTA_MIN || 0.005);           // ≥ 0.5 % de píxeles con tinta = significativa
const VENTANA_EXTRA = Number(process.env.PDF_OCR_VENTANA_EXTRA || 5);   // páginas de más que se sondean para poder saltar blancos

/**
 * Fracción de píxeles OSCUROS (con tinta) de un PGM binario P5 (0..1). Cabecera ASCII «P5 <w> <h> <maxval>» +
 * 1 byte separador + w*h bytes de gris (pdftoppm -gray es de 8 bits → maxval 255). Robusto a comentarios (#) y
 * espacios en la cabecera. Exportada para poder testearla en aislamiento.
 */
export function fraccionTinta(buf, umbralGris = 200) {
    if (!buf || buf.length < 10) return 0;
    let pos = 0;
    const esEsp = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
    const token = () => {
        while (pos < buf.length) {                                   // saltar espacios y comentarios
            if (buf[pos] === 0x23) { while (pos < buf.length && buf[pos] !== 0x0a) pos++; }
            else if (esEsp(buf[pos])) pos++;
            else break;
        }
        let s = '';
        while (pos < buf.length && !esEsp(buf[pos]) && buf[pos] !== 0x23) { s += String.fromCharCode(buf[pos]); pos++; }
        return s;
    };
    if (token() !== 'P5') return 0;
    const w = parseInt(token(), 10), h = parseInt(token(), 10), maxv = parseInt(token(), 10);
    if (!w || !h || !maxv) return 0;
    pos++;                                                            // el ÚNICO byte separador tras maxval → los píxeles empiezan aquí
    const total = w * h, umbral = Math.round(umbralGris * maxv / 255);
    let oscuros = 0, contados = 0;
    for (let i = 0; i < total && pos < buf.length; i++, pos++) { contados++; if (buf[pos] < umbral) oscuros++; }
    return contados ? oscuros / contados : 0;
}

// Rasteriza el tramo [desde, hasta] a PGM GRIS diminuto (para medir tinta). Hermano de `rasterizarTramo` pero
// sin -jpeg y con -gray (salida .pgm). Devuelve [{ pagina, buffer }]. Lanza (el caller distingue ilegible/timeout).
async function rasterizarGrisTramo(ruta, desde, hasta, dir, timeout, idx) {
    const prefijo = path.join(dir, `g${idx}`);
    await execFileP('pdftoppm', [
        '-gray', '-f', String(desde), '-l', String(hasta),
        '-scale-to-x', String(SIG_ANCHO), '-scale-to-y', '-1',
        ruta, prefijo,
    ], { timeout: timeout || 60000 });
    const nombres = (await fs.readdir(dir)).filter(n => n.startsWith(`g${idx}-`) && n.endsWith('.pgm'));
    const out = [];
    for (const n of nombres) {
        const m = n.match(/-(\d+)\.pgm$/);
        if (m) out.push({ pagina: parseInt(m[1], 10), buffer: await fs.readFile(path.join(dir, n)) });
    }
    return out;
}

// Mapa pagina→fracciónTinta para un conjunto de páginas, midiéndolas por TRAMOS contiguos (menos relecturas).
// Best-effort: una página no medida (fallo de tramo) simplemente no aparece en el mapa.
async function medirTinta(ruta, paginas) {
    const objetivo = [...new Set(paginas)].filter(p => p >= 1).sort((a, b) => a - b);
    if (!objetivo.length) return new Map();
    let dir;
    try { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gris-')); } catch { return new Map(); }
    const to = await timeoutPoppler(ruta);
    const frac = new Map();
    try {
        let idx = 0;
        for (const [desde, hasta] of tramosContiguos(objetivo)) {
            try {
                for (const { pagina, buffer } of await rasterizarGrisTramo(ruta, desde, hasta, dir, to, idx++)) frac.set(pagina, fraccionTinta(buffer));
            } catch (e) {
                if (PDF_ILEGIBLE.test(e.message || '') || PDF_ILEGIBLE.test(e.stderr || '')) break; // PDF entero ilegible
                // tramo suelto (timeout/fallo): se sigue con el resto; las no medidas se tratan como significativas.
            }
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    return frac;
}

// De una ventana de páginas, las que superan el umbral de tinta (una NO medida se considera significativa: no se
// descarta contenido por un fallo de medida — dirección segura).
const significativasDe = (frac, ventana) => ventana.filter(p => (frac.has(p) ? frac.get(p) : 1) >= TINTA_MIN);

/**
 * Rasteriza a JPEG las primeras `frente` páginas SIGNIFICATIVAS (saltando las en blanco) + la última
 * significativa, imitando el 5+1 pero sin páginas vacías. Sondea una VENTANA (`frente`+EXTRA al principio, y otra
 * al final) midiendo la tinta con un PGM gris, elige las páginas con contenido y solo ENTONCES las rasteriza a
 * JPEG al ancho pedido. La 1.ª significativa = 'portada'; la última = 'contraportada'. Fallbacks: si medir falla
 * o todo sale en blanco, cae a [1..frente]+última (nunca vacía → la comprobación de legibilidad sigue valiendo).
 */
export async function rasterizarSignificativas(ruta, { frente = 5, incluirUltima = true, ancho = ANCHO, numPaginas = 0 } = {}) {
    const total = numPaginas || 0;
    const finVentana = total ? Math.min(total, frente + VENTANA_EXTRA) : frente + VENTANA_EXTRA;
    const ventanaFrente = Array.from({ length: finVentana }, (_, i) => i + 1);
    const fracFrente = await medirTinta(ruta, ventanaFrente);
    const sigFrente = significativasDe(fracFrente, ventanaFrente);
    const elegidasFrente = (sigFrente.length ? sigFrente : ventanaFrente).slice(0, frente);

    // Contraportada: la ÚLTIMA página significativa (el código de barras/ISBN suele estar ahí). Si la ventana
    // frontal ya llegó al final del documento, se toma de esa misma medida; si no, se sondea una ventana al
    // final. Solo se etiqueta si el documento es más largo que el frente (si no, la 1.ª ya es toda la portada).
    let paginaFinal = null;
    if (incluirUltima && total > frente) {
        if (finVentana >= total) {
            paginaFinal = (sigFrente.length ? sigFrente : ventanaFrente).slice(-1)[0]; // el frente cubrió todo el doc
        } else {
            const iniBack = Math.max(finVentana + 1, total - VENTANA_EXTRA);
            if (iniBack <= total) {
                const ventanaBack = Array.from({ length: total - iniBack + 1 }, (_, i) => iniBack + i);
                const sigBack = significativasDe(await medirTinta(ruta, ventanaBack), ventanaBack);
                paginaFinal = (sigBack.length ? sigBack : ventanaBack).slice(-1)[0];
            }
        }
    }

    // Rasterizar a JPEG SOLO las elegidas (+ la final) y RE-ETIQUETAR por posición (no por número de página:
    // la portada puede ser la pág. 3 si las 2 primeras estaban en blanco).
    const primera = elegidasFrente[0];
    const pags = [...new Set([...elegidasFrente, ...(paginaFinal ? [paginaFinal] : [])])];
    const renders = await rasterizarPaginas(ruta, { paginas: pags, ancho });
    return renders.map(r => ({
        buffer: r.buffer, pagina: r.pagina,
        etiqueta: r.pagina === primera ? 'portada' : (r.pagina === paginaFinal ? 'contraportada' : `pagina-${r.pagina}`),
    })).sort((a, b) => (a.etiqueta === 'portada' ? -1 : b.etiqueta === 'portada' ? 1 : a.pagina - b.pagina));
}

/**
 * ¿Es un PDF de IMÁGENES (escaneo), aunque traiga capa de texto OCR? Adobe Scan / CamScanner / Lens…
 * generan PDFs que SON fotos de páginas con una capa de texto OCR encima → `texto_legible` da true y
 * se colaban como "PDF digital". Señales (poppler, C, sin SIMD → apto para el Atom):
 *   1) Productor/creador = app de escaneo conocida.
 *   2) pdffonts: sin fuentes reales — solo la invisible "GlyphLessFont" del OCR (Tesseract/Adobe), o ninguna.
 * Devuelve true si parece escaneo. Degrada a false si no hay pdfinfo/pdffonts.
 */
const APPS_ESCANEO = /adobe scan|camscanner|office lens|microsoft lens|genius scan|scanbot|swiftscan|tiny scanner|tapscanner|clear ?scanner|fast scanner|notebloc|photomyne|simple scan|naps2|vflat/i;
export async function pdfEsImagen(ruta) {
    const to = await timeoutPoppler(ruta);   // adaptativo: un PDF grande no cabe en 15 s en el Atom
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: to });
        if (APPS_ESCANEO.test(stdout)) return true;
    } catch { /* sin pdfinfo o PDF raro */ }
    try {
        const { stdout } = await execFileP('pdffonts', [ruta], { timeout: to });
        const filas = stdout.split('\n').slice(2).filter(l => l.trim()); // saltar las 2 líneas de cabecera
        if (filas.length === 0) return true;                              // sin fuentes → página = imagen
        if (filas.every(l => /glyphlessfont/i.test(l))) return true;      // solo la fuente invisible del OCR
    } catch { /* sin pdffonts (poppler) → no se puede afinar; se queda en false */ }
    return false;
}

/**
 * Tamaño de la 1ª página en puntos (1/72") vía pdfinfo. Sirve para calcular recortes a una resolución
 * conocida. Devuelve { anchoPts, altoPts } o null (sin pdfinfo / PDF ilegible) → degradación elegante.
 */
export async function tamanoPagina(ruta) {
    try {
        const { stdout } = await execFileP('pdfinfo', [ruta], { timeout: await timeoutPoppler(ruta) });
        return tamanoDeStdout(stdout);
    } catch { /* sin pdfinfo o PDF ilegible */ }
    return null;
}

/** Extrae { anchoPts, altoPts } del stdout de `pdfinfo` (para reusar una lectura ya hecha). null si no aparece. */
export function tamanoDeStdout(stdout) {
    const m = String(stdout || '').match(/Page size:\s*([\d.]+)\s*x\s*([\d.]+)\s*pts/i);
    return m ? { anchoPts: parseFloat(m[1]), altoPts: parseFloat(m[2]) } : null;
}

// Página DESCOMUNAL: por encima de esto el mediabox es basura, no un documento real. Referencia: el mayor
// formato de imprenta, A0, mide 841×1189 mm ≈ 3370 pts en su lado largo; un póster/plano ANSI-E, ~3168 pts.
// El PDF que tumbó la app («…Philosophy off Law…», OOM) declaraba 4342×14400 pts (60×200"): claramente corrupto.
// El tope (100" = 7200 pts) deja MUCHO margen sobre cualquier formato legítimo y ataja el corrupto.
const PAGINA_MAX_PTS = Number(process.env.PDF_PAGINA_MAX_PTS || 7200);

/**
 * ¿La 1ª página del PDF tiene un tamaño DESCOMUNAL (mediabox corrupto, p. ej. 60×200")? Rasterizar una página
 * así revienta la RAM del contenedor (OOM → caída de la app), así que la ingesta la desvía a Cuarentena/ilegibles
 * ANTES de tocar poppler. Devuelve { descomunal, anchoPts?, altoPts?, pulgadas? }. Degrada a `descomunal:false`
 * si no hay pdfinfo o el PDF es ilegible por otra vía (eso lo trata el veredicto normal de «ilegible»).
 */
export async function paginaDescomunal(ruta) {
    const tam = await tamanoPagina(ruta);
    if (!tam) return { descomunal: false };
    const mayorPts = Math.max(tam.anchoPts, tam.altoPts);
    return {
        descomunal: mayorPts > PAGINA_MAX_PTS,
        anchoPts: tam.anchoPts, altoPts: tam.altoPts,
        pulgadas: Math.round(mayorPts / 72),
    };
}

/**
 * DPI seguro para rasterizar una página de tamaño `tam` (pts) sin pasar de `maxPx` píxeles de ÁREA (ancho×alto).
 * Con un mediabox descomunal, un DPI fijo (p. ej. 300) pediría decenas/cientos de M px → OOM; aquí se BAJA el DPI
 * lo justo para respetar el tope. Como el área crece con el CUADRADO del DPI, el factor de reducción es
 * √(maxPx/área). Devuelve el DPI (≥1). Si no hay tamaño (pdfinfo falló), devuelve `dpiDeseado` sin tocar.
 */
export function dpiAcotado(tam, dpiDeseado, maxPx) {
    if (!tam) return dpiDeseado;
    const area = (tam.anchoPts / 72 * dpiDeseado) * (tam.altoPts / 72 * dpiDeseado);
    if (area <= maxPx) return dpiDeseado;
    return Math.max(1, Math.floor(dpiDeseado * Math.sqrt(maxPx / area)));
}

/**
 * Rasteriza UN RECORTE de una página a JPEG con poppler (pdftoppm -r DPI -x -y -W -H, todo en C → barato
 * en CPU, sin SIMD; apto para el Atom). Coordenadas en el espacio de píxeles del DPI dado. Devuelve el
 * buffer JPEG o null. Se usa para enfocar el CÓDIGO DE BARRAS de la cubierta antes de pasarlo a la visión.
 */
// Tope duro de píxeles del recorte (borde inferior-derecho): pdftoppm rasteriza la PÁGINA hasta ese punto a la
// resolución dada, así que un mediabox descomunal/corrupto (60×200") pediría decenas de M px y REVENTARÍA la RAM
// del contenedor (OOM → caída de la app). Por encima del tope, se rechaza (warn + null) en vez de tumbar Node.
const MAX_PX_RECORTE = Number(process.env.PDF_RECORTE_MAX_PX || 24_000_000);
export async function rasterizarRecorte(ruta, pagina, { dpi, x, y, w, h }) {
    const X = Math.max(0, Math.round(x)), Y = Math.max(0, Math.round(y)), W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    if ((X + W) * (Y + H) > MAX_PX_RECORTE) {
        console.warn(`[Raster] recorte p${pagina} OMITIDO: región ${X + W}×${Y + H}px supera el tope anti-OOM (mediabox gigante/corrupto en "${path.basename(ruta)}").`);
        return null;
    }
    let dir;
    try { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crop-')); } catch { return null; }
    const prefijo = path.join(dir, `crop-${pagina}`);
    try {
        await execFileP('pdftoppm', [
            '-jpeg', '-singlefile', '-f', String(pagina), '-l', String(pagina),
            '-r', String(Math.round(dpi)),
            '-x', String(X), '-y', String(Y), '-W', String(W), '-H', String(H),
            ruta, prefijo,
        ], { timeout: await timeoutPoppler(ruta) });
        return await fs.readFile(`${prefijo}.jpg`);
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[Raster] recorte p${pagina} no generado: ${e.message}`);
        return null;
    } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
}
