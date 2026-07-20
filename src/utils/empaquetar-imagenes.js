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
import { corregirPolaridadPng } from './png-polaridad.js';
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
 * Ejecuta `tarea` sobre cada elemento con un tope de CONCURRENCIA. Las conversiones de pdf son procesos
 * externos independientes (poppler) que pasan casi todo el tiempo esperando CPU/disco: hacerlas de una en una
 * dejaba parados los demás hilos del NAS. Con 3 en paralelo el trabajo se reduce a menos de la mitad.
 * No se sube más: cada pdftoppm puede comer bastante RAM y el Atom tiene 1 GB para el contenedor.
 */
const CONCURRENCIA = Math.max(1, Number(process.env.CBZ_CONCURRENCIA) || 3);
async function enParalelo(items, tarea, limite = CONCURRENCIA) {
    const resultados = new Array(items.length);
    let siguiente = 0;
    const obrero = async () => {
        while (true) {
            const i = siguiente++;
            if (i >= items.length) return;
            resultados[i] = await tarea(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limite, items.length) }, obrero));
    return resultados;
}

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
let _convertidos = 0, _rasterizados = 0, _invertidos = 0;
export function progresoConversion() { return { convertidos: _convertidos, rasterizados: _rasterizados, invertidos: _invertidos }; }
function _avisar(nombre, via) {
    _convertidos++;
    if (via === 'raster') _rasterizados++;
    if (_convertidos % AVISO_CADA === 0) {
        const extra = (_rasterizados ? ` · ${_rasterizados} rasterizadas (más lento)` : '')
            + (_invertidos ? ` · ${_invertidos} en negativo corregidas` : '');
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

    // Toda lámina extraída pasa por la corrección de POLARIDAD: `pdfimages` vuelca el bitonal tal como está
    // guardado y en un stencil (ImageMask) eso sale en NEGATIVO. Le pasó a los 14 tomos de la Encyclopédie que
    // no habían sido convertidos a mano. Solo toca PNG de 1 bit y decide por contenido; el resto ni se abre.
    const conPolaridadOk = async (rutas) => {
        for (const r of rutas) {
            if (/\.png$/i.test(r) && await corregirPolaridadPng(r)) _invertidos++;
        }
        return rutas;
    };

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
            if (salidas.length === paginas) { _avisar(pdf, 'embebida'); return conPolaridadOk(salidas.map((n) => path.join(destDir, n))); }
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
                if (mejor) { _avisar(pdf, 'embebida'); return conPolaridadOk([path.join(destDir, mejor)]); }
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
async function imagenesDe(dir, { excluirCbz = false } = {}) {
    const ents = await leer(dir);
    const imagenes = ents.filter((e) => e.isFile() && ES_IMG.test(e.name)).map((e) => ({ nombre: e.name, abs: path.join(dir, e.name) }));
    const medir = async (im) => { try { im.bytes = (await fs.stat(im.abs)).size; } catch { im.bytes = 0; } return im; };
    // `excluirCbz`: un .cbz es la SALIDA de esta tarea, no una entrada. Al empaquetar tomo a tomo los cbz ya
    // terminados quedan en la raíz junto a las subcarpetas que faltan; sin esto, la pasada siguiente los
    // volvería a expandir (ES_COMPR los incluye) y reempaquetaría su propio resultado en bucle.
    const comprimidos = ents.filter((e) => e.isFile() && ES_COMPR.test(e.name) && !(excluirCbz && /\.cbz$/i.test(e.name)));
    const pdfs = ents.filter((e) => e.isFile() && ES_PDF.test(e.name));
    // Láminas que NO se pudieron convertir. El llamante ABORTA si hay alguna: omitirlas en silencio sería
    // fatal, porque tras empaquetar «con éxito» los originales se reciclan a la Papelera.
    const fallidos = [];
    let tmp = null, desdeComprimidos = 0;
    if (comprimidos.length) {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cbz-'));
        const raizC = tmp;
        // Extraer + convertir en PARALELO: en «.14»/«.15» son cientos de comprimidos con una lámina dentro y
        // hacerlo de uno en uno era el grueso del tiempo. Cada uno va a su propio subdirectorio, así que no se
        // pisan; el orden final lo fija el ordenado por nombre de más abajo.
        const lotes = await enParalelo(comprimidos, async (c) => {
            const sub = path.join(raizC, path.basename(c.name, path.extname(c.name)));
            try {
                await fs.mkdir(sub, { recursive: true });
                await extraerArchivoComic(path.join(dir, c.name), sub);
            } catch { return null; }   // comprimido ilegible → el llamante lo verá en la verificación
            // Dentro puede venir la lámina como PDF (muy común en colecciones de grabados): se convierte.
            const dePdf = [];
            for (const pdf of await listarPdfs(sub)) {
                dePdf.push({ pdf, salidas: await imagenesDePdf(pdf, path.join(sub, '_pdf_' + path.basename(pdf, '.pdf'))) });
            }
            return { c, dePdf, extraidas: await listarImgs(sub) };
        });
        for (const lote of lotes) {
            if (!lote) continue;
            const { c, dePdf, extraidas } = lote;
            const base = path.basename(c.name, path.extname(c.name));
            for (const { pdf, salidas } of dePdf) {
                if (!salidas.length) { fallidos.push(`${c.name} → ${path.basename(pdf)}`); continue; }
                salidas.forEach((abs, i) => imagenes.push({
                    nombre: `${base}${salidas.length > 1 ? '-' + String(i + 1).padStart(String(salidas.length).length, '0') : ''}${path.extname(abs)}`, abs,
                }));
                desdeComprimidos += salidas.length;
            }
            // Las imágenes ya extraídas se nombran con el comprimido de origen, para conservar SU orden natural
            // («I02236.rar» → «I02236.jpg»). Si trae varias se numeran, o todas se llamarían igual y el cbz
            // tendría entradas duplicadas.
            const ancho = String(extraidas.length).length;
            extraidas.forEach((f, i) => {
                const sufijo = extraidas.length > 1 ? `-${String(i + 1).padStart(ancho, '0')}` : '';
                imagenes.push({ nombre: `${base}${sufijo}${path.extname(f)}`, abs: f });
                desdeComprimidos++;
            });
        }
    }
    // SI YA HAY IMÁGENES SUELTAS, LOS PDF SE IGNORAN. Cuando alguien convierte a mano las láminas (más rápido
    // con una herramienta de escritorio) y deja los pdf al lado, el pdf es el ORIGEN y el jpg el resultado: si
    // se procesaran los dos, cada lámina entraría DOS VECES en el cbz. Se avisa con los recuentos para que se
    // vea en el log lo que se ha decidido, que es justo donde se descubren las sorpresas.
    if (imagenes.length && pdfs.length) {
        try {
            console.log(`  📚 «${path.basename(dir)}»: ${imagenes.length} imagen(es) sueltas y ${pdfs.length} pdf → se usan las IMÁGENES (los pdf son el origen; no se tocan).`);
        } catch { /* el log nunca rompe */ }
    }
    // PDFs SUELTOS de la carpeta: cada lámina en pdf se convierte a imagen y entra en el cbz.
    if (pdfs.length && !imagenes.length) {
        tmp = tmp || await fs.mkdtemp(path.join(os.tmpdir(), 'cbz-'));
        const raiz = tmp;
        // En PARALELO: son procesos externos independientes. El orden se conserva porque cada resultado vuelve
        // en su índice y se vuelca después (y de todas formas se ordena por nombre más abajo).
        const res = await enParalelo(pdfs, async (f) => {
            const base = path.basename(f.name, path.extname(f.name));
            const salidas = await imagenesDePdf(path.join(dir, f.name), path.join(raiz, '_pdf_' + base));
            return { nombre: f.name, base, salidas };
        });
        for (const { nombre, base, salidas } of res) {
            if (!salidas.length) { fallidos.push(nombre); continue; }
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
 * @returns {Promise<{ok, tomos: [{nombre, ruta, paginas, origen}], omitidos, fallidos, parcial, multivolumen, motivo?}>}
 */
export async function empaquetarImagenes(dir, dirDestino, { alcance = 'subcarpetas' } = {}) {
    // OJO: aquí NO se llama a `planEmpaquetado`. Hacerlo duplicaba TODO el trabajo pesado —extraer cada
    // comprimido y convertir cada PDF— porque el plan recorre lo mismo que luego se empaqueta. Con una
    // enciclopedia de miles de láminas eso son horas de más, en silencio. Se recoge UNA vez y de ahí salen
    // tanto los tomos como los fallos.
    //
    // TOMO A TOMO (no todo al final). Antes se recogían las 15 subcarpetas, y SOLO entonces se miraba si
    // alguna lámina había fallado: una sola mala tiraba las 2.225 conversiones buenas y no se escribía ni un
    // cbz — 91 minutos a la basura por un PDF. Ahora cada carpeta se convierte, se escribe y se VERIFICA por
    // su cuenta; la que falla se queda fuera (`omitidos`) sin arrastrar a las demás. Además libera su
    // temporal al terminar, en vez de mantener los 15 a la vez en /tmp.
    const hechos = [];
    const omitidos = [];
    const fallidos = [];
    const log = (m) => { try { console.log(`  📚 ${m}`); } catch { /* el log nunca rompe */ } };
    _convertidos = 0; _rasterizados = 0; _invertidos = 0;   // el contador es POR PASADA (era de módulo y acumulaba entre reintentos)

    /**
     * Escribe los cbz de UN grupo ya recogido. Un grupo puede dar varios cbz si excede CBZ_MAX_BYTES.
     * `origen` = carpeta cuyos originales podrá reciclar el llamante SI este grupo se empaquetó bien
     * (null = las imágenes sueltas de la raíz). Devuelve true si se escribió todo.
     */
    const escribirGrupo = async (g) => {
        const trozos = partirPorTamano(g.imagenes);
        for (const [i, trozo] of trozos.entries()) {
            const parte = trozos.length > 1 ? ` (${i + 1})` : '';
            const nombre = `${g.base}${parte}`;
            const limpio = nombre.replace(/[/\\:*?"<>|]/g, '_');
            const r = await escribirCbz(trozo, path.join(dirDestino, `${limpio}.cbz`));
            if (!r.ok) {
                omitidos.push({ base: g.base, motivo: r.motivo });
                log(`✖ «${nombre}»: NO se pudo escribir el cbz (${r.motivo}) — se conservan sus originales`);
                return false;
            }
            hechos.push({
                nombre, ruta: r.ruta, paginas: r.paginas, bytes: sumaBytes(trozo),
                origen: g.origen ?? null, conservar: g.conservar || [],
            });
            log(`✔ «${nombre}.cbz» escrito y verificado: ${r.paginas} página(s)`);
        }
        return true;
    };

    /**
     * Recoge una carpeta y escribe su cbz en el acto.
     *
     * Una lámina DAÑADA O ILEGIBLE no tumba el tomo: se empaqueta el resto y ella se CONSERVA en disco (el
     * llamante la aparta en «_no-convertibles/» y jamás la recicla). Antes se descartaba el tomo entero para
     * no perderla —el reciclado posterior se la llevaría—, pero eso convertía un pdf roto en 15 tomos sin
     * empaquetar. Conservar el fichero da la misma garantía de no-pérdida sin bloquear nada.
     */
    const procesar = async (carpeta, base, origen, opciones) => {
        const r = await imagenesDe(carpeta, opciones);
        try {
            const malas = r.fallidos || [];
            if (malas.length) {
                fallidos.push(...malas);
                log(`⚠ «${base}»: ${malas.length} lámina(s) ilegibles → fuera del cbz, pero SE CONSERVAN en disco`);
            }
            if (!r.imagenes.length) {
                if (malas.length) omitidos.push({ base, motivo: `sin ninguna lámina legible (${malas.length} ilegibles)` });
                return;
            }
            await escribirGrupo({ base, imagenes: r.imagenes, origen, conservar: malas.map(ficheroDelFallo) });
        } finally {
            await limpiar([r.tmp]);   // el temporal de ESTE tomo, ya no hace falta
        }
    };

    if (alcance === 'todo') {
        // TODO el árbol en un documento: no hay tomos que aislar, es un único grupo (partido por tamaño).
        log(`empaquetando «${path.basename(dir)}» (todo el árbol): recogiendo láminas…`);
        const todas = await todasLasImagenes(dir);
        try {
            const malas = todas.fallidos || [];
            if (malas.length) {
                return { ok: false, fallidos: malas, omitidos, motivo: motivoFallidos(malas) };
            }
            if (!todas.imagenes.length) return { ok: false, fallidos, omitidos, motivo: 'no se encontraron imágenes que empaquetar' };
            log(`«${path.basename(dir)}»: ${todas.imagenes.length} lámina(s) listas`);
            await escribirGrupo({ base: path.basename(dir), imagenes: todas.imagenes, origen: null });
        } finally {
            await limpiar(todas.tmps);
        }
    } else {
        const subs = (await leer(dir)).filter((e) => e.isDirectory());
        log(`empaquetando «${path.basename(dir)}»: ${subs.length} subcarpeta(s) que revisar…`);
        // Las imágenes SUELTAS de la raíz forman su propio tomo. Se excluyen los .cbz: son la salida de esta
        // misma tarea (los de una pasada anterior parcial) y reexpandirlos sería reempaquetar el resultado.
        await procesar(dir, path.basename(dir), null, { excluirCbz: true });
        let i = 0;
        for (const e of subs) {
            i++;
            const sub = path.join(dir, e.name);
            // Progreso por subcarpeta: extraer y convertir cientos de láminas tarda, y sin esto el proceso
            // PARECE colgado (es justo lo que le pasó al usuario: media hora sin una línea).
            log(`[${i}/${subs.length}] «${e.name}»…`);
            await procesar(sub, e.name, sub);
        }
    }

    if (!hechos.length) {
        return {
            ok: false, fallidos, omitidos,
            motivo: fallidos.length ? motivoFallidos(fallidos) : 'no se encontraron imágenes que empaquetar',
        };
    }
    // PARCIAL: hay cbz escritos pero algún tomo se quedó fuera. Es `ok` —lo hecho es válido y verificado— y
    // el llamante recicla SOLO los originales de los tomos de `hechos` (cada uno lleva su `origen`).
    return { ok: true, tomos: hechos, omitidos, fallidos, parcial: omitidos.length > 0, multivolumen: hechos.length > 1 };
}

/**
 * Fichero REAL en disco al que se refiere un fallo. Los fallos vienen en dos formas: el nombre suelto
 * («I04178.pdf») o «contenedor → lámina» cuando la lámina venía dentro de un comprimido («I02236.rar →
 * x.pdf»). En el segundo caso lo que existe en disco es el CONTENEDOR: es lo que hay que conservar.
 */
export function ficheroDelFallo(f) {
    const i = String(f).indexOf(' → ');
    return i >= 0 ? String(f).slice(0, i) : String(f);
}

/** Motivo legible de un fallo de conversión (se muestra en el log y en el panel). */
function motivoFallidos(malas) {
    return `no se pudieron convertir a imagen ${malas.length} lámina(s): `
        + `${malas.slice(0, 3).join(', ')}${malas.length > 3 ? '…' : ''}`;
}

