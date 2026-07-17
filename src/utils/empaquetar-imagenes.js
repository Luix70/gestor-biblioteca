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

const ES_IMG = /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i;
// Comprimidos que pueden traer imágenes dentro (una lámina por fichero es un patrón habitual de archivo).
const ES_COMPR = /\.(rar|zip|7z|cbz|cbr|cb7|tar|tgz|gz)$/i;
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
            for (const f of await listarImgs(sub)) {
                imagenes.push({ nombre: `${path.basename(c.name, path.extname(c.name))}${path.extname(f)}`, abs: f });
                desdeComprimidos++;
            }
        }
    }
    imagenes.sort((a, b) => ORDEN(a.nombre, b.nombre));
    // El tamaño hace falta para partir los tomos: se mide aquí, una vez, para todas.
    for (const im of imagenes) await medir(im);
    return { imagenes, desdeComprimidos, tmp };
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
    // ALCANCE 'todo': TODAS las láminas del árbol en un solo documento (un diccionario escaneado: sus
    // subcarpetas son un detalle de cómo se guardó, no tomos). Solo se parte si pesa demasiado.
    if (alcance === 'todo') {
        const todas = await todasLasImagenes(dir);
        const trozos = partirPorTamano(todas.imagenes);
        await limpiar(todas.tmps);   // un árbol con comprimidos crea VARIOS temporales, no uno
        trozos.forEach((t, i) => tomos.push({
            nombre: nombre + (trozos.length > 1 ? ` (${i + 1})` : ''),
            imagenes: t.length, bytes: sumaBytes(t), desdeComprimidos: todas.desdeComprimidos,
        }));
        return { raiz: dir, nombre, tomos, multivolumen: tomos.length > 1, total: todas.imagenes.length };
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
    if (propias.tmp) await fs.rm(propias.tmp, { recursive: true, force: true }).catch(() => {});
    if (propias.imagenes.length) añadir(nombre, propias.imagenes, propias.desdeComprimidos);
    // Cada subcarpeta con imágenes = un tomo.
    for (const e of await leer(dir)) {
        if (!e.isDirectory()) continue;
        const sub = path.join(dir, e.name);
        const r = await imagenesDe(sub);
        if (r.tmp) await fs.rm(r.tmp, { recursive: true, force: true }).catch(() => {});
        if (r.imagenes.length) añadir(e.name, r.imagenes, r.desdeComprimidos);
    }
    return { raiz: dir, nombre, tomos, multivolumen: tomos.length > 1, total: tomos.reduce((s, t) => s + t.imagenes, 0) };
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
    const plan = await planEmpaquetado(dir, { alcance });
    if (!plan.tomos.length) return { ok: false, motivo: 'no se encontraron imágenes que empaquetar' };

    const hechos = [];
    const grupos = [];
    if (alcance === 'todo') {
        // TODO el árbol en un documento: un grupo único (se partirá por tamaño si hace falta).
        const todas = await todasLasImagenes(dir);
        grupos.push({ base: path.basename(dir), imagenes: todas.imagenes, tmps: todas.tmps });
    } else {
        // Se recogen igual que en el plan (raíz + una subcarpeta por tomo), pero AHORA sí extrayendo de verdad.
        const propias = await imagenesDe(dir);
        if (propias.imagenes.length) grupos.push({ base: path.basename(dir), ...propias, tmps: [propias.tmp] });
        for (const e of await leer(dir)) {
            if (!e.isDirectory()) continue;
            const r = await imagenesDe(path.join(dir, e.name));
            if (r.imagenes.length) grupos.push({ base: e.name, ...r, tmps: [r.tmp] });
        }
    }

    try {
        for (const g of grupos) {
            const trozos = partirPorTamano(g.imagenes);
            for (const [i, trozo] of trozos.entries()) {
                const parte = trozos.length > 1 ? ` (${i + 1})` : '';
                const nombre = `${g.base}${parte}`;
                const r = await escribirCbz(trozo, path.join(dirDestino, `${nombre.replace(/[/\\:*?"<>|]/g, '_')}.cbz`));
                if (!r.ok) return { ok: false, motivo: `«${nombre}»: ${r.motivo}` };
                hechos.push({ nombre, ruta: r.ruta, paginas: r.paginas, bytes: sumaBytes(trozo) });
            }
        }
    } finally {
        for (const g of grupos) await limpiar(g.tmps);
    }
    return { ok: true, tomos: hechos, multivolumen: hechos.length > 1 };
}
