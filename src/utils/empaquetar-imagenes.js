/**
 * EMPAQUETAR LISTAS DE IMÁGENES → CBZ, en la INGESTA.
 *
 * Una carpeta de láminas/páginas escaneadas (a veces con las imágenes DENTRO de comprimidos, una por fichero)
 * se convierte en uno o varios `.cbz`. La idea es no inventar un tipo ni un visor nuevos: un CBZ entra por la
 * maquinaria de CÓMIC que ya existe y está probada (visor paginado, portada, formatos, descarga de página).
 *
 * Las tres decisiones, y su porqué:
 *  · **CBZ, nunca CBR.** `comic-paginas.js` abre un .cbz con adm-zip EN MEMORIA (acceso aleatorio: servir la
 *    página N lee solo esa entrada), mientras que un .cbr/.cb7 obliga a extraer el archivo ENTERO a un
 *    temporal. Con miles de láminas, eso es inaceptable en el Atom.
 *  · **STORE (sin comprimir).** Un JPG ya está comprimido: medido sobre las páginas reales del test 69,
 *    deflate ahorra 1 KB de 2756 (0,04%) a cambio de quemar CPU. Con `method = 0` los bytes quedan IDÉNTICOS
 *    (verificado por SHA-256, 8/8) → CERO pérdida de calidad y el original se recupera extrayéndolo.
 *  · **UN CBZ POR SUBCARPETA.** adm-zip carga el ZIP en memoria, así que un único cbz de miles de láminas
 *    serían GBs de RAM → OOM en el Atom. Cada subcarpeta pasa a ser un TOMO: la estructura de carpetas no se
 *    pierde, se convierte en una OBRA MULTIVOLUMEN (que el catálogo ya sabe colapsar y apilar).
 *
 * ANTI-PÉRDIDA: el empaquetado se VERIFICA (todas las imágenes presentes y legibles, byte a byte) ANTES de que
 * el llamante retire nada. Los originales van a la Papelera, jamás se borran.
 */
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extraerArchivoComic } from './extraer-archivo.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

const ES_IMG = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
// Comprimidos que pueden traer imágenes dentro (una lámina por fichero es un patrón habitual de archivo).
const ES_COMPR = /\.(rar|zip|7z|cbz|cbr|cb7|tar|tgz|gz)$/i;
const ES_PDF = /\.pdf$/i;
// Lo que ESCUPE `pdfimages`: con «-j» saca .jpg solo si la imagen va en JPEG dentro del pdf; si es bitonal
// (grabado escaneado en CCITT/JBIG2) saca .pbm, y si es color sin comprimir, .ppm. Esos NO se ven en un cbz.
const ES_SALIDA_PDFIMAGES = /\.(jpe?g|png|ppm|pbm|pgm)$/i;
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#');
const ORDEN = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

/**
 * Tope por tomo, POR TAMAÑO. El visor abre el cbz cargándolo en MEMORIA (adm-zip), así que lo que puede
 * tumbar al Atom son los BYTES, no el número de páginas. Partir por recuento (los 300 de antes) hacía las dos
 * cosas mal: partía en dos un diccionario de 400 páginas ligeras sin necesidad, y dejaba pasar un tomo de 300
 * escaneos enormes de varios GB. Decisión del usuario: ~400 MB.
 */
const MAX_BYTES = Number(process.env.CBZ_MAX_BYTES) || 400 * 1024 * 1024;

/**
 * Parte una lista de imágenes en tomos de ~MAX_BYTES, respetando su orden (son páginas: no se pueden barajar).
 * Una imagen SIEMPRE cabe en algún tomo: si ella sola pasa del tope, va en el suyo — partir una lámina no
 * tiene sentido, y dejarla fuera sería perderla.
 */
function partirPorTamano(imagenes) {
    const tomos = [];
    let act = [], bytes = 0;
    for (const im of imagenes) {
        if (act.length && bytes + im.bytes > MAX_BYTES) { tomos.push(act); act = []; bytes = 0; }
        act.push(im);
        bytes += im.bytes;
    }
    if (act.length) tomos.push(act);
    return tomos;
}
const sumaBytes = (ims) => ims.reduce((s, i) => s + (i.bytes || 0), 0);
/** Borra los temporales de extracción. Nunca lanza: un temporal que se resiste no puede tumbar la ingesta. */
const limpiar = async (tmps) => { for (const t of (tmps || []).filter(Boolean)) await fs.rm(t, { recursive: true, force: true }).catch(() => {}); };

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/**
 * PDF → imágenes, para que una lámina en PDF pueda entrar en el cbz (un cbz es un archivo de IMÁGENES: un
 * visor paginado no renderiza un pdf de dentro). Muy habitual en colecciones de grabados: cada lámina viene
 * como un pdf de UNA página, a veces dentro de su propio comprimido.
 *
 * Dos vías, y la primera es la buena:
 *  1) `pdfimages -j` EXTRAE la imagen embebida con SUS BYTES ORIGINALES (un escaneo es un JPEG dentro de un
 *     pdf) → CERO pérdida de calidad. Solo se acepta si salen tantas imágenes como páginas: así se sabe que
 *     cada página ES una imagen, y no una página compuesta por trozos (que saldría despedazada).
 *  2) Si no cuadra (pdf vectorial, o página hecha de varias piezas) se RASTERIZA con `pdftoppm -jpeg`, que da
 *     una imagen fiel por página. Se pierde algo frente al original, pero es la representación correcta.
 *
 * Devuelve las rutas de las imágenes generadas, en orden de página. Vacío = no se pudo convertir; el llamante
 * DEBE tratarlo como fallo (nunca omitir la lámina en silencio: los originales se reciclan después).
 */
const PDF_DPI = Number(process.env.CBZ_PDF_DPI) || 300;
// Cada cuántas láminas se informa. Dentro de un tomo pueden ser cientos y cada conversión tarda segundos: sin
// esto el proceso parece MUERTO durante una hora (le pasó al usuario dos veces).
const AVISO_CADA = Number(process.env.CBZ_AVISO_CADA) || 25;
let _convertidos = 0, _rasterizados = 0;
export function progresoConversion() { return { convertidos: _convertidos, rasterizados: _rasterizados }; }
function _avisar(nombre, via) {
    _convertidos++;
    if (via === 'raster') _rasterizados++;
    if (_convertidos % AVISO_CADA === 0) {
        const extra = _rasterizados ? ` · ${_rasterizados} rasterizadas (más lento)` : '';
        try { console.log(`  📚 … ${_convertidos} lámina(s) convertidas${extra}`); } catch { /* */ }
    }
}
async function imagenesDePdf(pdf, destDir) {
    await fs.mkdir(destDir, { recursive: true });
    const base = path.join(destDir, 'p');
    let paginas = 0;
    try {
        const { stdout } = await execFileP('pdfinfo', [pdf], { timeout: 60000 });
        paginas = Number((stdout.match(/Pages:\s*(\d+)/i) || [])[1]) || 0;
    } catch { /* sin pdfinfo no se puede validar el cuadre → se irá a rasterizar */ }

    // 1) Extracción SIN pérdida de las imágenes embebidas.
    const listar = async (re) => (await fs.readdir(destDir)).filter((n) => n.startsWith('p-') && re.test(n)).sort();
    const limpiarSalidas = async () => { for (const n of await listar(ES_SALIDA_PDFIMAGES)) await fs.rm(path.join(destDir, n), { force: true }).catch(() => {}); };
    if (paginas > 0) {
        try {
            await execFileP('pdfimages', ['-j', pdf, base], { timeout: 300000 });
            let salidas = await listar(ES_SALIDA_PDFIMAGES);
            // Si alguna salió en un formato que el visor NO abre (.pbm/.ppm/.pgm — el caso de un grabado
            // BITONAL, que es justo lo que trae una enciclopedia escaneada), se repite la extracción en PNG:
            // sigue siendo SIN PÉRDIDA, se ve en cualquier navegador y, en bitonal, ocupa muchísimo menos que
            // un rasterizado. Sin esto se ignoraban esas salidas, parecía que no se había extraído nada y se
            // caía al rasterizado a 300 dpi: 30 veces más lento, peor calidad y 15 veces más tamaño.
            if (salidas.length && salidas.some((n) => !ES_IMG.test(n))) {
                await limpiarSalidas();
                await execFileP('pdfimages', ['-png', pdf, base], { timeout: 300000 });
                salidas = await listar(ES_IMG);
            } else {
                salidas = salidas.filter((n) => ES_IMG.test(n));
            }
            if (salidas.length === paginas) { _avisar(pdf, 'embebida'); return salidas.map((n) => path.join(destDir, n)); }
            // UNA página con VARIAS imágenes embebidas: es el caso típico de una lámina escaneada que lleva el
            // escaneo + una máscara/estarcido (JBIG2) o una miniatura. Se coge la MÁS GRANDE, que es el escaneo
            // — sigue siendo sin pérdida y evita el rasterizado, que en el Atom cuesta 10-30 s por lámina
            // frente a menos de uno. Sin esto, una colección entera se iba por el camino lento.
            if (paginas === 1 && salidas.length > 1) {
                let mejor = null, mejorTam = -1;
                for (const n of salidas) {
                    const t = (await fs.stat(path.join(destDir, n)).catch(() => ({ size: 0 }))).size;
                    if (t > mejorTam) { mejorTam = t; mejor = n; }
                }
                for (const n of salidas) if (n !== mejor) await fs.rm(path.join(destDir, n), { force: true }).catch(() => {});
                if (mejor) { _avisar(pdf, 'embebida'); return [path.join(destDir, mejor)]; }
            }
            // No cuadra: se descarta lo extraído y se rasteriza (mejor una página fiel que trozos sueltos).
            await limpiarSalidas();
        } catch { /* pdfimages no pudo: se rasteriza */ }
    }
    // 2) Rasterizado fiel, una imagen por página.
    try {
        await execFileP('pdftoppm', ['-jpeg', '-r', String(PDF_DPI), pdf, base], { timeout: 600000 });
        _avisar(pdf, 'raster');
        return (await fs.readdir(destDir)).filter((n) => n.startsWith('p-') && ES_IMG.test(n)).sort()
            .map((n) => path.join(destDir, n));
    } catch { return []; }
}

/** Entradas de un directorio, ya filtradas y ordenadas naturalmente. Nunca lanza. */
async function leer(dir) {
    try { return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !ignorar(e.name)).sort((a, b) => ORDEN(a.name, b.name)); }
    catch { return []; }
}

/**
 * Imágenes de UNA carpeta (sus ficheros directos), incluidas las que vengan DENTRO de comprimidos. Los
 * comprimidos se extraen a un temporal; el llamante debe limpiarlo con `limpiar()`.
 * @returns {Promise<{imagenes: {nombre, abs}[], desdeComprimidos: number, tmp: string|null}>}
 */
async function imagenesDe(dir) {
    const ents = await leer(dir);
    const imagenes = ents.filter((e) => e.isFile() && ES_IMG.test(e.name)).map((e) => ({ nombre: e.name, abs: path.join(dir, e.name) }));
    const medir = async (im) => { try { im.bytes = (await fs.stat(im.abs)).size; } catch { im.bytes = 0; } return im; };
    const comprimidos = ents.filter((e) => e.isFile() && ES_COMPR.test(e.name));
    const pdfs = ents.filter((e) => e.isFile() && ES_PDF.test(e.name));
    // Láminas que NO se pudieron convertir. El llamante ABORTA si hay alguna: omitirlas en silencio sería
    // fatal, porque tras empaquetar «con éxito» los originales se reciclan a la Papelera.
    const fallidos = [];
    let tmp = null, desdeComprimidos = 0;
    if (comprimidos.length) {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cbz-'));
        for (const c of comprimidos) {
            const sub = path.join(tmp, path.basename(c.name, path.extname(c.name)));
            try {
                await fs.mkdir(sub, { recursive: true });
                await extraerArchivoComic(path.join(dir, c.name), sub);
            } catch { continue; }   // comprimido ilegible → se ignora aquí; el llamante lo verá en la verificación
            // Las imágenes extraídas se nombran con el comprimido de origen, para conservar SU orden natural
            // («I02236.rar» → «I02236.jpg»): es lo que da el orden de las láminas dentro del tomo.
            // Si el comprimido trae MÁS DE UNA imagen se numeran («I02240-01.jpg», «I02240-02.jpg»): con el
            // nombre a secas todas se llamarían igual, el cbz tendría entradas duplicadas y la verificación
            // byte a byte abortaría el empaquetado entero — la carpeta quedaba intacta y sin cbz, sin que se
            // entendiera por qué. El caso habitual (un comprimido = una lámina) conserva el nombre limpio.
            // Dentro del comprimido puede venir la lámina como PDF (muy común en colecciones de grabados):
            // se convierte a imagen para que pueda entrar en el cbz.
            for (const pdf of await listarPdfs(sub)) {
                const salidas = await imagenesDePdf(pdf, path.join(sub, '_pdf_' + path.basename(pdf, '.pdf')));
                if (!salidas.length) { fallidos.push(`${c.name} → ${path.basename(pdf)}`); continue; }
                salidas.forEach((abs, i) => imagenes.push({
                    nombre: `${path.basename(c.name, path.extname(c.name))}${salidas.length > 1 ? '-' + String(i + 1).padStart(String(salidas.length).length, '0') : ''}${path.extname(abs)}`, abs,
                }));
                desdeComprimidos += salidas.length;
            }
            const extraidas = await listarImgs(sub);
            const base = path.basename(c.name, path.extname(c.name));
            const ancho = String(extraidas.length).length;
            extraidas.forEach((f, i) => {
                const sufijo = extraidas.length > 1 ? `-${String(i + 1).padStart(ancho, '0')}` : '';
                imagenes.push({ nombre: `${base}${sufijo}${path.extname(f)}`, abs: f });
                desdeComprimidos++;
            });
        }
    }
    // PDFs SUELTOS de la carpeta: cada lámina en pdf se convierte a imagen y entra en el cbz.
    if (pdfs.length) {
        tmp = tmp || await fs.mkdtemp(path.join(os.tmpdir(), 'cbz-'));
        for (const f of pdfs) {
            const base = path.basename(f.name, path.extname(f.name));
            const salidas = await imagenesDePdf(path.join(dir, f.name), path.join(tmp, '_pdf_' + base));
            if (!salidas.length) { fallidos.push(f.name); continue; }
            const ancho = String(salidas.length).length;
            salidas.forEach((abs, i) => imagenes.push({
                nombre: `${base}${salidas.length > 1 ? '-' + String(i + 1).padStart(ancho, '0') : ''}${path.extname(abs)}`, abs,
            }));
        }
    }

    imagenes.sort((a, b) => ORDEN(a.nombre, b.nombre));
    // El tamaño hace falta para partir los tomos: se mide aquí, una vez, para todas.
    for (const im of imagenes) await medir(im);
    return { imagenes, desdeComprimidos, tmp, fallidos };
}

/**
 * TODAS las imágenes de un árbol (recursivo), en orden natural y con su tamaño, incluidas las que vengan
 * dentro de comprimidos a cualquier profundidad. Para el alcance 'todo': ahí las subcarpetas son un detalle de
 * cómo se guardó el escaneo, no tomos. El orden lo da la ruta relativa, que respeta la jerarquía.
 */
async function todasLasImagenes(dir) {
    const imagenes = [];
    let desdeComprimidos = 0;
    const tmps = [];
    async function rec(d, prefijo) {
        const r = await imagenesDe(d);
        if (r.tmp) tmps.push(r.tmp);
        desdeComprimidos += r.desdeComprimidos;
        for (const im of r.imagenes) imagenes.push({ ...im, nombre: prefijo + im.nombre });
        for (const e of await leer(d)) if (e.isDirectory()) await rec(path.join(d, e.name), `${prefijo}${e.name}/`);
    }
    await rec(dir, '');
    imagenes.sort((a, b) => ORDEN(a.nombre, b.nombre));
    // Los nombres dentro del cbz no pueden llevar «/» de subcarpeta si queremos un tomo PLANO: se aplana
    // sustituyendo el separador, conservando el orden que ya se fijó arriba.
    for (const im of imagenes) im.nombre = im.nombre.replace(/\//g, ' · ');
    return { imagenes, desdeComprimidos, tmp: tmps[0] || null, tmps };
}

/** PDFs de un árbol (recursivo), en orden natural. Hermano de `listarImgs`. */
async function listarPdfs(dir) {
    const out = [];
    for (const e of await leer(dir)) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await listarPdfs(abs));
        else if (ES_PDF.test(e.name)) out.push(abs);
    }
    return out.sort(ORDEN);
}

/** Imágenes de un árbol (recursivo), en orden natural. */
async function listarImgs(dir) {
    const out = [];
    for (const e of await leer(dir)) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await listarImgs(abs));
        else if (ES_IMG.test(e.name)) out.push(abs);
    }
    return out.sort(ORDEN);
}

/**
 * PLAN (sin efectos): qué tomos saldrían de `dir`. Cada subcarpeta con imágenes = un tomo; si la carpeta trae
 * imágenes sueltas, esas forman su propio tomo. Una carpeta plana con más de MAX_IMGS se parte.
 * Pensado para el dry-run: el usuario ve qué va a pasar ANTES de que se toque nada.
 */
export async function planEmpaquetado(dir, { alcance = 'subcarpetas' } = {}) {
    const nombre = path.basename(dir);
    const tomos = [];
    // Láminas que NO se pudieron convertir a imagen (p. ej. un pdf ilegible). Se propagan al plan para que el
    // dry-run las enseñe ANTES de tocar nada: empaquetar dejándolas fuera y luego reciclar los originales
    // sería una pérdida real.
    const fallidos = [];
    // ALCANCE 'todo': TODAS las láminas del árbol en un solo documento (un diccionario escaneado: sus
    // subcarpetas son un detalle de cómo se guardó, no tomos). Solo se parte si pesa demasiado.
    if (alcance === 'todo') {
        const todas = await todasLasImagenes(dir);
        const trozos = partirPorTamano(todas.imagenes);
        fallidos.push(...(todas.fallidos || []));
        await limpiar(todas.tmps);   // un árbol con comprimidos crea VARIOS temporales, no uno
        trozos.forEach((t, i) => tomos.push({
            nombre: nombre + (trozos.length > 1 ? ` (${i + 1})` : ''),
            imagenes: t.length, bytes: sumaBytes(t), desdeComprimidos: todas.desdeComprimidos,
        }));
        return { raiz: dir, nombre, tomos, multivolumen: tomos.length > 1, total: todas.imagenes.length, fallidos };
    }
    const añadir = (base, imgs, desdeCompr) => {
        const trozos = partirPorTamano(imgs);
        trozos.forEach((trozo, i) => {
            const parte = trozos.length > 1 ? ` (${i + 1})` : '';
            tomos.push({ nombre: base + parte, imagenes: trozo.length, bytes: sumaBytes(trozo), desdeComprimidos: desdeCompr });
        });
    };
    // Imágenes propias de la carpeta raíz.
    const propias = await imagenesDe(dir);
    fallidos.push(...(propias.fallidos || []));
    if (propias.tmp) await fs.rm(propias.tmp, { recursive: true, force: true }).catch(() => {});
    if (propias.imagenes.length) añadir(nombre, propias.imagenes, propias.desdeComprimidos);
    // Cada subcarpeta con imágenes = un tomo.
    for (const e of await leer(dir)) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        const r = await imagenesDe(sub);
        fallidos.push(...(r.fallidos || []));
        if (r.tmp) await fs.rm(r.tmp, { recursive: true, force: true }).catch(() => {});
        if (r.imagenes.length) añadir(e.name, r.imagenes, r.desdeComprimidos);
    }
    return { raiz: dir, nombre, tomos, multivolumen: tomos.length > 1, total: tomos.reduce((s, t) => s + t.imagenes, 0), fallidos };
}

/** Escribe UN cbz (STORE) y lo VERIFICA byte a byte. Devuelve {ok, ruta, paginas, motivo?}. */
async function escribirCbz(imagenes, destino) {
    const zip = new AdmZip();
    const firmas = new Map();
    for (const im of imagenes) {
        let buf;
        try { buf = await fs.readFile(im.abs); } catch { return { ok: false, motivo: `no se pudo leer «${im.nombre}»` }; }
        zip.addFile(im.nombre, buf);
        firmas.set(im.nombre, sha(buf));
    }
    zip.getEntries().forEach((e) => { e.header.method = 0; });   // 0 = STORED: bytes idénticos, sin quemar CPU
    await fs.mkdir(path.dirname(destino), { recursive: true });
    zip.writeZip(destino);

    // VERIFICACIÓN: se relee el cbz recién escrito y se comprueba cada imagen byte a byte. Sin esto no podemos
    // decirle al llamante que ya puede reciclar los originales.
    let leido;
    try { leido = new AdmZip(destino); } catch (e) { return { ok: false, motivo: `el cbz no abre: ${e.message}` }; }
    const ents = leido.getEntries();
    if (ents.length !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${ents.length}/${imagenes.length}` };
    for (const e of ents) {
        if (firmas.get(e.entryName) !== sha(e.getData())) return { ok: false, motivo: `la página «${e.entryName}» no coincide byte a byte` };
    }
    return { ok: true, ruta: destino, paginas: ents.length };
}

/**
 * EMPAQUETA `dir` en uno o varios cbz dentro de `dirDestino`. NO toca los originales: devuelve el resultado y
 * es el LLAMANTE quien decide reciclarlos, y solo si `ok`.
 * @returns {Promise<{ok, tomos: [{nombre, ruta, paginas}], multivolumen, motivo?}>}
 */
export async function empaquetarImagenes(dir, dirDestino, { alcance = 'subcarpetas' } = {}) {
    // OJO: aquí NO se llama a `planEmpaquetado`. Hacerlo duplicaba TODO el trabajo pesado —extraer cada
    // comprimido y convertir cada PDF— porque el plan recorre lo mismo que luego se empaqueta. Con una
    // enciclopedia de miles de láminas eso son horas de más, en silencio. Se recoge UNA vez y de ahí salen
    // tanto los tomos como los fallos.
    const hechos = [];
    const grupos = [];
    const fallidos = [];
    const log = (m) => { try { console.log(`  📚 ${m}`); } catch { /* el log nunca rompe */ } };
    _convertidos = 0; _rasterizados = 0;   // el contador es POR PASADA (era de módulo y acumulaba entre reintentos)

    if (alcance === 'todo') {
        // TODO el árbol en un documento: un grupo único (se partirá por tamaño si hace falta).
        log(`empaquetando «${path.basename(dir)}» (todo el árbol): recogiendo láminas…`);
        const todas = await todasLasImagenes(dir);
        fallidos.push(...(todas.fallidos || []));
        grupos.push({ base: path.basename(dir), imagenes: todas.imagenes, tmps: todas.tmps });
        log(`«${path.basename(dir)}»: ${todas.imagenes.length} lámina(s) listas`);
    } else {
        const subs = (await leer(dir)).filter((e) => e.isDirectory());
        log(`empaquetando «${path.basename(dir)}»: ${subs.length} subcarpeta(s) que revisar…`);
        const propias = await imagenesDe(dir);
        fallidos.push(...(propias.fallidos || []));
        if (propias.imagenes.length) grupos.push({ base: path.basename(dir), ...propias, tmps: [propias.tmp] });
        let i = 0;
        for (const e of subs) {
            i++;
            const r = await imagenesDe(path.join(dir, e.name));
            fallidos.push(...(r.fallidos || []));
            if (r.imagenes.length) grupos.push({ base: e.name, ...r, tmps: [r.tmp] });
            // Progreso por subcarpeta: extraer y convertir cientos de láminas tarda, y sin esto el proceso
            // PARECE colgado (es justo lo que le pasó al usuario: media hora sin una línea).
            log(`[${i}/${subs.length}] «${e.name}»: ${r.imagenes.length} lámina(s)`);
        }
    }

    if (fallidos.length) {
        await limpiar(grupos.flatMap((g) => g.tmps || []));
        // RED DE SEGURIDAD: si alguna lámina no se pudo convertir a imagen, NO se empaqueta. Empaquetar
        // dejándolas fuera y reciclar después los originales sería una pérdida real.
        return { ok: false, motivo: `no se pudieron convertir a imagen ${fallidos.length} lámina(s): ${fallidos.slice(0, 3).join(', ')}${fallidos.length > 3 ? '…' : ''}` };
    }
    if (!grupos.length) return { ok: false, motivo: 'no se encontraron imágenes que empaquetar' };

    try {
        for (const g of grupos) {
            const trozos = partirPorTamano(g.imagenes);
            for (const [i, trozo] of trozos.entries()) {
                const parte = trozos.length > 1 ? ` (${i + 1})` : '';
                const nombre = `${g.base}${parte}`;
                const r = await escribirCbz(trozo, path.join(dirDestino, `${nombre.replace(/[/\\:*?"<>|]/g, '_')}.cbz`));
                if (!r.ok) return { ok: false, motivo: `«${nombre}»: ${r.motivo}` };
                hechos.push({ nombre, ruta: r.ruta, paginas: r.paginas, bytes: sumaBytes(trozo) });
                log(`✔ «${nombre}.cbz» escrito y verificado: ${r.paginas} página(s)`);
            }
        }
    } finally {
        for (const g of grupos) await limpiar(g.tmps);
    }
    return { ok: true, tomos: hechos, multivolumen: hechos.length > 1 };
}
