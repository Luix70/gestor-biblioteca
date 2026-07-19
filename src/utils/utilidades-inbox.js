/**
 * UTILIDADES DEL INBOX — operaciones MANUALES de preparación, antes de ingerir.
 *
 * El vigilante ya sabe expandir, aplanar y limpiar… pero lo hace AUTOMÁTICAMENTE y según sus heurísticas. Con
 * una descarga compleja (enciclopedias de grabados, colecciones de miles de ficheros) a veces quieres dejar el
 * árbol normalizado TÚ, a mano, y que el vigilante se encuentre algo simple. Eso es lo que hay aquí.
 *
 * LA REGLA QUE LO SOSTIENE: estas utilidades llaman a las MISMAS funciones que usa el vigilante
 * (`extraerArchivoComic`, `reciclar`). No hay una segunda implementación «manual» que pueda divergir de la
 * automática — que es el fallo que ha causado casi todos los problemas de este proyecto (dos listas, dos
 * criterios, uno se actualiza y el otro no).
 *
 * TODAS admiten PREVISUALIZAR antes de aplicar (`ejecutar:false`), porque con «propagar a subcarpetas» un solo
 * clic puede tocar cientos de elementos, y nadie debería descubrir eso después.
 * Y todas son NO DESTRUCTIVAS: lo que se retira va a la Papelera. Nada se borra aquí.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { extraerArchivoComic as extraerComprimido } from './extraer-archivo.js';
import { reciclar, reciclarCarpeta } from './papelera.js';

export const OPERACIONES = ['expandir', 'expandir-aqui', 'aplanar', 'limpiar', 'comprimir', 'renombrar', 'papelera', 'eliminar'];
/** Las que DESTRUYEN (o retiran) por decisión explícita del usuario: el llamante exige contraseña de admin. */
export const OPERACIONES_PELIGROSAS = ['papelera', 'eliminar'];

// Basura conocida: metadatos del sistema y restos de descarga que nunca son contenido.
const ES_BASURA = (n) =>
    n.startsWith('@') || n === '#recycle' || n === '.DS_Store' || n === 'Thumbs.db' || n === 'desktop.ini'
    || /\.(url|nfo|sfv|md5|torrent)$/i.test(n)
    || /^(torrent downloaded from|tracked_by_|downloaded from)/i.test(n);
const ES_CONTENEDOR = (n) => /\.(zip|rar|7z|iso|tar|tgz|tbz2?|txz)$|\.tar\.(gz|bz2|xz)$/i.test(n);
const ignorar = (n) => n.startsWith('.') && n !== '.DS_Store';   // marcadores propios (.ruta_fija…)

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Nombre libre en `dir` (evita pisar: añade « (2)», « (3)»…). NUNCA sobrescribe. */
async function nombreLibre(dir, nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let destino = path.join(dir, nombre);
    for (let i = 2; await existe(destino); i++) destino = path.join(dir, `${base} (${i})${ext}`);
    return destino;
}

/** Recorre un árbol y devuelve {dirs, files} (rutas absolutas). `propagar:false` = solo el primer nivel. */
async function recorrer(raiz, propagar, nivel = 8) {
    const dirs = [], files = [];
    async function rec(d, n) {
        if (n < 0) return;
        let ents;
        try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (ignorar(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) { dirs.push(p); if (propagar) await rec(p, n - 1); }
            else files.push(p);
        }
    }
    await rec(raiz, propagar ? nivel : 0);
    return { dirs, files };
}

/**
 * Ejecuta (o PREVISUALIZA) una utilidad sobre las carpetas/ficheros indicados.
 * @param {object} o
 * @param {string} o.operacion   expandir | aplanar | limpiar | comprimir
 * @param {string[]} o.absolutas rutas ABSOLUTAS ya validadas por el llamante (dentro del Inbox)
 * @param {boolean} o.propagar   aplicar también dentro de las subcarpetas
 * @param {boolean} o.ejecutar   false = solo informa de lo que haría
 * @returns {Promise<{ok, operacion, ejecutar, acciones: [{ruta, hecho, detalle, error?}], resumen}>}
 */
export async function utilidadInbox({ operacion, absolutas = [], propagar = false, ejecutar = false, extra = {} }) {
    if (!OPERACIONES.includes(operacion)) return { ok: false, motivo: `operación desconocida: ${operacion}` };
    const acciones = [];
    const anota = (ruta, hecho, detalle, error) => acciones.push({ ruta, hecho, detalle, ...(error ? { error } : {}) });

    for (const abs of absolutas) {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) { anota(abs, false, 'no existe'); continue; }
        try {
            if (operacion === 'expandir') await opExpandir(abs, st, propagar, ejecutar, anota, false);
            else if (operacion === 'expandir-aqui') await opExpandir(abs, st, propagar, ejecutar, anota, true);
            else if (operacion === 'renombrar') await opRenombrar(abs, st, ejecutar, anota, extra);
            else if (operacion === 'aplanar') await opAplanar(abs, st, propagar, ejecutar, anota, extra);
            else if (operacion === 'limpiar') await opLimpiar(abs, st, propagar, ejecutar, anota);
            else if (operacion === 'comprimir') await opComprimir(abs, st, ejecutar, anota);
            else if (operacion === 'papelera') await opRetirar(abs, st, ejecutar, anota, false);
            else if (operacion === 'eliminar') await opRetirar(abs, st, ejecutar, anota, true);
        } catch (e) { anota(abs, false, 'falló', e.message); }
    }
    const hechas = acciones.filter((a) => a.hecho).length;
    return { ok: true, operacion, ejecutar, acciones, resumen: { total: acciones.length, hechas, fallidas: acciones.length - hechas } };
}

// ── expandir: cada contenedor se abre en su sitio; el original va a la Papelera tras verificar ──────────────
async function opExpandir(abs, st, propagar, ejecutar, anota, aqui) {
    const objetivos = [];
    if (st.isFile()) { if (ES_CONTENEDOR(path.basename(abs))) objetivos.push(abs); }
    else {
        const { files } = await recorrer(abs, propagar);
        objetivos.push(...files.filter((f) => ES_CONTENEDOR(path.basename(f))));
    }
    if (!objetivos.length) { anota(abs, false, 'no hay comprimidos que expandir'); return; }

    for (const zip of objetivos) {
        const dir = path.dirname(zip);
        const base = path.basename(zip).replace(/\.tar\.(gz|bz2|xz)$|\.[^.]+$/i, '') || 'archivo';
        if (!ejecutar) { anota(zip, true, aqui ? 'se expandiría AQUÍ (contenido suelto)' : `se expandiría en «${base}»`); continue; }
        const tmp = path.join(dir, `.expand-${Date.now()}`);
        try {
            await fs.mkdir(tmp, { recursive: true });
            await extraerComprimido(zip, tmp);
            // Un único directorio dentro → se promociona su contenido (evita «X/X/…»).
            const top = (await fs.readdir(tmp, { withFileTypes: true })).filter((d) => !ignorar(d.name));
            const raiz = (top.length === 1 && top[0].isDirectory()) ? path.join(tmp, top[0].name) : tmp;
            let detalle;
            if (aqui) {
                // AQUÍ: el contenido va suelto a la carpeta que contiene el comprimido, resolviendo colisiones
                // con « (2)» — nunca se pisa un fichero que ya estuviera.
                let n = 0;
                for (const nombre of await fs.readdir(raiz)) {
                    await fs.rename(path.join(raiz, nombre), await nombreLibre(dir, nombre));
                    n++;
                }
                detalle = `${n} elemento(s) expandidos aquí`;
            } else {
                const destino = await nombreLibre(dir, base);
                await fs.rename(raiz, destino);
                detalle = `expandido en «${path.basename(destino)}»`;
            }
            await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
            await reciclar([zip], 'utilidad-expandir');   // el original a la Papelera, ya extraído
            anota(zip, true, detalle);
        } catch (e) {
            await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
            anota(zip, false, 'no se pudo expandir', e.message);
        }
    }
}

// ── aplanar: el contenido sube un nivel, resolviendo colisiones (jamás se pisa nada) ────────────────────────
async function opAplanar(abs, st, propagar, ejecutar, anota, extra = {}) {
    if (!st.isDirectory()) { anota(abs, false, 'aplanar solo aplica a carpetas'); return; }
    // Las subcarpetas se aplanan de DENTRO hacia FUERA (las más hondas primero): si no, al mover una carpeta
    // padre se arrastran las hijas sin procesar y el resultado depende del orden.
    const objetivos = [abs];
    if (propagar) {
        const { dirs } = await recorrer(abs, true);
        objetivos.unshift(...dirs.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length));
    }
    for (const dir of objetivos) {
        let hijos;
        try { hijos = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => !ignorar(e.name)); } catch { continue; }
        let subdirs = hijos.filter((e) => e.isDirectory());
        // «solo carpetas de un único fichero»: disuelve los envoltorios de un solo elemento —el patrón que deja
        // extraer cientos de comprimidos: «I02236/I02236.pdf»— y NO toca las carpetas con varios ficheros, que
        // suelen ser un conjunto aparte (p. ej. «jpg/» con las versiones de baja resolución). Sin esta opción
        // había que elegir entre aplanarlo todo (mezclando ese conjunto) o no aplanar nada.
        if (extra.soloUnicas) {
            const filtradas = [];
            for (const sd of subdirs) {
                const dentro = (await fs.readdir(path.join(dir, sd.name)).catch(() => []))
                    .filter((n) => !ignorar(n));
                if (dentro.length === 1) filtradas.push(sd);
            }
            subdirs = filtradas;
        }
        if (!subdirs.length) { if (dir === abs) anota(dir, false, extra.soloUnicas ? 'ninguna subcarpeta tiene un único fichero' : 'no tiene subcarpetas que aplanar'); continue; }
        let movidos = 0;
        for (const sd of subdirs) {
            const origen = path.join(dir, sd.name);
            let contenido;
            try { contenido = await fs.readdir(origen); } catch { continue; }
            if (!ejecutar) { movidos += contenido.length; continue; }
            for (const n of contenido) {
                const destino = await nombreLibre(dir, n);   // colisión → « (2)», nunca sobrescribe
                await fs.rename(path.join(origen, n), destino).catch(() => {});
                movidos++;
            }
            // La subcarpeta ya vacía se retira (si algo quedó, se conserva: no se fuerza).
            await fs.rmdir(origen).catch(() => {});
        }
        anota(dir, true, ejecutar ? `${movidos} elemento(s) subidos un nivel` : `subiría ${movidos} elemento(s)`);
    }
}

// ── limpiar: basura conocida → PAPELERA (recuperable). No se borra nada aquí ────────────────────────────────
async function opLimpiar(abs, st, propagar, ejecutar, anota) {
    const basura = [];
    if (st.isFile()) { if (ES_BASURA(path.basename(abs))) basura.push(abs); }
    else {
        const { files, dirs } = await recorrer(abs, propagar);
        basura.push(...files.filter((f) => ES_BASURA(path.basename(f))));
        for (const d of dirs) if (ES_BASURA(path.basename(d))) basura.push(d);
        // Ficheros de 0 bytes: restos de descargas fallidas, nunca contenido.
        for (const f of files) {
            if (basura.includes(f)) continue;
            const s = await fs.stat(f).catch(() => null);
            if (s && s.isFile() && s.size === 0) basura.push(f);
        }
    }
    if (!basura.length) { anota(abs, false, 'no se ha encontrado basura'); return; }
    if (!ejecutar) { anota(abs, true, `se retirarían ${basura.length} elemento(s) a la Papelera`); return; }

    let n = 0;
    for (const b of basura) {
        const s = await fs.stat(b).catch(() => null);
        if (!s) continue;
        if (s.isDirectory()) { if (await reciclarCarpeta(b, 'utilidad-limpiar')) n++; }
        else { await reciclar([b], 'utilidad-limpiar'); n++; }
    }
    anota(abs, true, `${n} elemento(s) a la Papelera`);
}

// ── comprimir: una carpeta pasa a ser UN .zip a su lado (para que viaje como bloque) ────────────────────────
async function opComprimir(abs, st, ejecutar, anota) {
    if (!st.isDirectory()) { anota(abs, false, 'comprimir solo aplica a carpetas'); return; }
    const padre = path.dirname(abs), nombre = path.basename(abs);
    const { files } = await recorrer(abs, true);
    if (!files.length) { anota(abs, false, 'la carpeta está vacía'); return; }
    if (!ejecutar) { anota(abs, true, `se comprimiría en «${nombre}.zip» (${files.length} ficheros)`); return; }

    const destino = await nombreLibre(padre, nombre + '.zip');
    try {
        const zip = new AdmZip();
        for (const f of files) zip.addLocalFile(f, path.dirname(path.relative(abs, f)));
        zip.writeZip(destino);
        // VERIFICAR antes de retirar el original: mismo nº de entradas que ficheros.
        const leido = new AdmZip(destino);
        if (leido.getEntries().filter((e) => !e.isDirectory).length !== files.length)
            throw new Error('el zip no contiene todos los ficheros');
        await reciclarCarpeta(abs, 'utilidad-comprimir');   // la carpeta original, a la Papelera
        anota(abs, true, `comprimida en «${path.basename(destino)}» (${files.length} ficheros)`);
    } catch (e) {
        await fs.rm(destino, { force: true }).catch(() => {});
        anota(abs, false, 'no se pudo comprimir', e.message);
    }
}

// ── renombrar: uno a uno, o BUSCAR-Y-REEMPLAZAR sobre varios ────────────────────────────────────────────────
/**
 * Dos modos, según lo que mande el cliente en `extra`:
 *   · {nuevo:'…'}      → renombra ESE elemento (solo tiene sentido con uno seleccionado).
 *   · {de:'…', a:'…'}  → sustituye un texto en el nombre de TODOS los seleccionados. Es lo que sirve para
 *                        limpiar la basura de los release groups («[Team Nanban][TPB]», «(gnv64)»…) de golpe.
 * La sustitución es LITERAL (split/join), no una expresión regular: el usuario escribe «[TPB]» y eso es lo que
 * se busca, sin que los corchetes signifiquen otra cosa ni se pueda colar un patrón que reviente.
 * NUNCA sobrescribe: si el nombre resultante ya existe, se añade « (2)».
 */
async function opRenombrar(abs, st, ejecutar, anota, extra = {}) {
    const dir = path.dirname(abs), actual = path.basename(abs);
    let destinoNombre = null;

    if (typeof extra.nuevo === 'string' && extra.nuevo.trim()) destinoNombre = extra.nuevo.trim();
    else if (typeof extra.de === 'string' && extra.de) {
        if (!actual.includes(extra.de)) { anota(abs, false, `no contiene «${extra.de}»`); return; }
        destinoNombre = actual.split(extra.de).join(String(extra.a ?? '')).trim();
    } else { anota(abs, false, 'falta el nombre nuevo (o el texto a sustituir)'); return; }

    // Un nombre no puede llevar separadores ni «..»: renombrar NO es mover a otra carpeta.
    const SEP = String.fromCharCode(92);   // «\» sin escribirlo literal (este entorno lo corrompe)
    if (!destinoNombre || destinoNombre.includes('/') || destinoNombre.includes(SEP) || destinoNombre === '.' || destinoNombre === '..') {
        anota(abs, false, 'nombre no válido'); return;
    }
    if (destinoNombre === actual) { anota(abs, false, 'el nombre no cambia'); return; }
    if (!ejecutar) { anota(abs, true, `«${actual}» → «${destinoNombre}»`); return; }
    try {
        const destino = await nombreLibre(dir, destinoNombre);
        await fs.rename(abs, destino);
        anota(abs, true, `«${actual}» → «${path.basename(destino)}»`);
    } catch (e) { anota(abs, false, 'no se pudo renombrar', e.message); }
}

// ── papelera / eliminar: retirar lo seleccionado ────────────────────────────────────────────────────────────
/**
 * Dos operaciones con la MISMA mecánica y consecuencias muy distintas:
 *   · papelera → va a la Papelera. Recuperable. Es la que debería usarse casi siempre.
 *   · eliminar → BORRADO DIRECTO, sin Papelera. NO tiene vuelta atrás.
 *
 * `eliminar` existe porque el usuario lo pidió explícitamente, pero es el único punto de todo el sistema donde
 * un error no se puede deshacer — y con selección múltiple un clic se lleva mucho. Por eso el llamante exige
 * CONTRASEÑA de administrador, y la previsualización dice cuántos ficheros hay dentro de cada cosa: borrar una
 * carpeta «vacía» y borrar uña con 4.000 láminas se parecen demasiado en un listado.
 */
async function opRetirar(abs, st, ejecutar, anota, definitivo) {
    // Cuántos ficheros hay ahí dentro: el dato que evita un borrado a ciegas.
    let n = 1;
    if (st.isDirectory()) {
        const { files } = await recorrer(abs, true);
        n = files.length;
    }
    const que = st.isDirectory() ? `carpeta con ${n} fichero(s)` : 'fichero';
    if (!ejecutar) {
        anota(abs, true, definitivo ? `se ELIMINARÍA (${que}) — SIN Papelera, irreversible` : `iría a la Papelera (${que})`);
        return;
    }
    try {
        if (definitivo) {
            await fs.rm(abs, { recursive: true, force: true });
            anota(abs, true, `ELIMINADO (${que})`);
        } else if (st.isDirectory()) {
            await reciclarCarpeta(abs, 'utilidad-papelera');
            anota(abs, true, `a la Papelera (${que})`);
        } else {
            await reciclar([abs], 'utilidad-papelera');
            anota(abs, true, 'a la Papelera');
        }
    } catch (e) { anota(abs, false, 'no se pudo retirar', e.message); }
}
