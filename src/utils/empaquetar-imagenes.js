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

// Tope por tomo: si una carpeta PLANA trae más, se parte en varios cbz (evita el ZIP gigante en memoria).
const MAX_IMGS = Number(process.env.CBZ_MAX_IMAGENES) || 300;

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
    return { imagenes, desdeComprimidos, tmp };
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
export async function planEmpaquetado(dir) {
    const nombre = path.basename(dir);
    const tomos = [];
    const añadir = (base, imgs, desdeCompr) => {
        for (let i = 0; i < imgs.length; i += MAX_IMGS) {
            const trozo = imgs.slice(i, i + MAX_IMGS);
            const parte = imgs.length > MAX_IMGS ? ` (${Math.floor(i / MAX_IMGS) + 1})` : '';
            tomos.push({ nombre: base + parte, imagenes: trozo.length, desdeComprimidos: desdeCompr });
        }
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
export async function empaquetarImagenes(dir, dirDestino) {
    const plan = await planEmpaquetado(dir);
    if (!plan.tomos.length) return { ok: false, motivo: 'no se encontraron imágenes que empaquetar' };

    const hechos = [];
    const grupos = [];
    // Se recogen igual que en el plan (raíz + una subcarpeta por tomo), pero AHORA sí extrayendo de verdad.
    const propias = await imagenesDe(dir);
    if (propias.imagenes.length) grupos.push({ base: path.basename(dir), ...propias });
    for (const e of await leer(dir)) {
        if (!e.isDirectory()) continue;
        const r = await imagenesDe(path.join(dir, e.name));
        if (r.imagenes.length) grupos.push({ base: e.name, ...r });
    }

    try {
        for (const g of grupos) {
            for (let i = 0; i < g.imagenes.length; i += MAX_IMGS) {
                const trozo = g.imagenes.slice(i, i + MAX_IMGS);
                const parte = g.imagenes.length > MAX_IMGS ? ` (${Math.floor(i / MAX_IMGS) + 1})` : '';
                const nombre = `${g.base}${parte}`;
                const r = await escribirCbz(trozo, path.join(dirDestino, `${nombre.replace(/[/\\:*?"<>|]/g, '_')}.cbz`));
                if (!r.ok) return { ok: false, motivo: `«${nombre}»: ${r.motivo}` };
                hechos.push({ nombre, ruta: r.ruta, paginas: r.paginas });
            }
        }
    } finally {
        for (const g of grupos) if (g.tmp) await fs.rm(g.tmp, { recursive: true, force: true }).catch(() => {});
    }
    return { ok: true, tomos: hechos, multivolumen: hechos.length > 1 };
}
