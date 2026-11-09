/**
 * PREPROCESO — preparar antes de catalogar (fase 1: sin IA). Diseño en docs/preproceso.md.
 *
 * El usuario deja en PreProceso lo complejo (carpetas enormes, formatos variopintos, libros por capítulos). Aquí se
 * PREPARA y solo cuando una unidad está lista pasa al Inbox, donde el Vigilante la cataloga como cualquier otra.
 * REGLA DE FONDO: aquí no se cataloga nada; solo se trabaja sobre los ficheros. La base de datos no se toca.
 *
 * Cada pasada, por cada carpeta dejada en PreProceso que ya terminó de copiarse:
 *   1. expande los comprimidos (vigilante · expandirComprimidos: zip/rar/7z → carpeta);
 *   2. convierte en PDF las carpetas de páginas escaneadas (utils/escaneo-a-pdf);
 *   3. resuelve los libros por capítulos: el libro entero si está; si no, convierte las partes .doc con LibreOffice y
 *      las cose (vigilante · materializarDesglose*). Lo que no se pueda, queda PENDIENTE;
 *   4. pasa al Inbox cada UNIDAD sin pendientes y con un camino de catalogación CLARO (motivoParaRetener): se quedan
 *      aquí los capítulos sin coser, lo que no es catalogable (vídeos, .dvi, una descarga incompleta según su .sfv; con
 *      aviso `.NO_CATALOGABLE.txt` en la carpeta) y lo que su guía manda omitir. Lo fácil no espera a lo difícil;
 *   5. deja un informe `_preproceso.txt` en la carpeta con lo hecho y lo que espera.
 *
 * Unidad: si la carpeta dejada es en sí un libro (lleva guía de libro, o solo documentos sin subcarpetas), ella
 * entera; si no, cada uno de sus hijos. Pasa a Inbox/<carpeta dejada>/<hijo>, con la guía de la carpeta dejada al
 * lado, para que el Vigilante conserve el contexto (colección, materia) que da el nombre de la carpeta.
 *
 * Trabaja aunque el Vigilante esté en pausa: preparar no cataloga, y lo que pasa al Inbox espera allí.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carpetaEstable, expandirComprimidos, materializarDesglose, materializarDesgloseGuiado } from './vigilante.js';
import { planEscaneo, materializarEscaneo } from './utils/escaneo-a-pdf.js';
import { detectarLibroDesglosado, detectarDesglosePuro, esLibroPorCapitulos, pareceLibroPorCapitulos } from './utils/libro-desglosado.js';
import { esFicheroCatalogable, examinarCatalogable, escribirAvisoNoCatalogable } from './utils/no-catalogable.js';
import { leerGuia, NOMBRE_GUIA } from './utils/guia-ingesta.js';
import { reciclarCarpeta } from './utils/papelera.js';
import { EXT_DOC } from './mantenimiento/util-mantenimiento.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const INFORME = '_preproceso.txt';
const ACCIONES_INTOCABLES = ['intacta', 'software', 'omitir', 'empaquetar'];   // el usuario dijo: tal cual

const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || n === INFORME;
const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const esDoc = (n) => EXT_DOC.includes(path.extname(n).toLowerCase());

let enCurso = false;
// Una carpeta grande (49.000 ficheros en «Computers») no se vuelve a analizar en cada pasada: solo si cambió, o si
// tiene algo esperando y ya pasó REVISAR_MS (un cosido fallido se reintenta, pero sin machacar el Atom).
const REVISAR_MS = 30 * 60 * 1000;
const ultimaPasada = new Map();   // carpeta → { firma, t }
// Lo hecho en todas las pasadas sobre cada carpeta dejada: el informe lo acumula (en memoria; se reinicia con la app).
const historial = new Map();      // carpeta → { hecho: [], pasadas: 0 }
// Unidades retenidas ya avisadas en el log (ruta|motivo): se avisa una vez, no en cada pasada.
const avisadas = new Set();

/** Una pasada sobre PreProceso. Nunca lanza; si ya hay una en curso, no hace nada. */
export async function pasadaPreproceso() {
    if (enCurso) return;
    enCurso = true;
    try {
        await fs.mkdir(DIR_PRE, { recursive: true }).catch(() => {});
        let entradas;
        try { entradas = await fs.readdir(DIR_PRE, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            const ruta = path.join(DIR_PRE, e.name);
            if (e.isFile()) { await pasarFicheroSuelto(ruta); continue; }
            if (!e.isDirectory() || !(await carpetaEstable(ruta))) continue;
            const firma = await huella(ruta).then((h) => `${h.n}:${h.bytes}`).catch(() => null);
            const previa = ultimaPasada.get(ruta);
            if (previa && previa.firma === firma && Date.now() - previa.t < REVISAR_MS) continue;
            await prepararDrop(ruta).catch((err) => console.warn(`  ⚠️  PreProceso «${e.name}»: ${err.message}`));
            const despues = await huella(ruta).then((h) => `${h.n}:${h.bytes}`).catch(() => null);
            if (despues) ultimaPasada.set(ruta, { firma: despues, t: Date.now() }); else ultimaPasada.delete(ruta);
        }
    } finally {
        enCurso = false;
    }
}

/** Un fichero suelto en PreProceso: si no es un comprimido, no necesita preparación y pasa tal cual. */
async function pasarFicheroSuelto(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.iso'].includes(ext)) {
        await expandirComprimidos(DIR_PRE, 0);   // lo convierte en carpeta; se prepara en la próxima pasada
        return;
    }
    const st = await fs.stat(ruta).catch(() => null);
    if (!st || Date.now() - st.mtimeMs < 60000) return;   // aún copiándose
    if (!esFicheroCatalogable(path.basename(ruta), st.size)) {
        const examen = await examinarCatalogable(ruta);
        const clave = `${ruta}|no-catalogable`;
        if (!avisadas.has(clave)) {
            avisadas.add(clave);
            console.warn(`  ✋ PreProceso: «${path.basename(ruta)}» se queda: ${examen.motivo || 'no es un formato que se catalogue'}.`);
        }
        if (examen.motivo) await escribirAvisoNoCatalogable(ruta, examen, { donde: 'se queda en PreProceso; no pasa al Inbox ni se cataloga' });
        return;
    }
    await moverArbol(ruta, await destinoLibre(path.join(DIR_INBOX, path.basename(ruta))));
    console.log(`  ➡️  PreProceso: «${path.basename(ruta)}» → Inbox (fichero suelto).`);
}

/** Prepara una carpeta dejada en PreProceso y pasa al Inbox sus unidades listas. */
async function prepararDrop(drop) {
    const nombre = path.basename(drop);
    await expandirComprimidos(drop);
    const pendientes = new Map();   // ruta → motivo
    const hecho = [];
    await prepararArbol(drop, pendientes, hecho);

    // Cola de unidades: una unidad retenida por algo que está MÁS ABAJO (un libro por capítulos en una subcarpeta,
    // un escaneo pendiente) se reparte en sus hijos, para que solo se quede la rama culpable. Medido 9-nov:
    // «Science/500+ Electrical Engineering Books» (cientos de libros) no pasaba por UN libro en capítulos dentro.
    const cola = await unidadesDe(drop);
    let pasadas = 0;
    while (cola.length) {
        const u = cola.shift();
        const bloqueos = [...pendientes.keys()].filter((p) => p === u || p.startsWith(u + path.sep));
        if (bloqueos.length) {
            if (!bloqueos.includes(u) && await divisible(u)) cola.unshift(...(await hijosDe(u)));
            continue;
        }
        // Solo pasa lo que tiene un camino de catalogación CLARO (regla del usuario, 3-nov). Lo demás se queda aquí.
        const retenida = await motivoParaRetener(u);
        if (retenida?.masAbajo && await divisible(u)) {
            cola.unshift(...(await hijosDe(u)));
            continue;
        }
        if (retenida) {
            pendientes.set(u, retenida.motivo);
            const clave = `${u}|${retenida.motivo}`;
            if (!avisadas.has(clave)) {
                avisadas.add(clave);
                console.warn(`  ✋ PreProceso: «${path.relative(DIR_PRE, u)}» se queda: ${retenida.motivo}.`);
            }
            if (retenida.examen) {
                await escribirAvisoNoCatalogable(u, retenida.examen, { donde: 'se queda en PreProceso; no pasa al Inbox ni se cataloga' });
            }
            continue;
        }
        const rel = path.relative(drop, u);
        const destino = await destinoLibre(rel ? path.join(DIR_INBOX, nombre, rel) : path.join(DIR_INBOX, nombre));
        // Las guías de la carpeta dejada y de las carpetas intermedias repartidas viajan al lado: son su contexto
        // (colección, materia, perfil heredado).
        if (rel) {
            const partes = path.dirname(rel) === '.' ? [] : path.dirname(rel).split(path.sep);
            for (let i = 0; i <= partes.length; i++) {
                const sub = partes.slice(0, i);
                const guiaPre = path.join(drop, ...sub, NOMBRE_GUIA);
                const guiaInbox = path.join(DIR_INBOX, nombre, ...sub, NOMBRE_GUIA);
                if (await existe(guiaPre) && !(await existe(guiaInbox))) {
                    await fs.mkdir(path.dirname(guiaInbox), { recursive: true });
                    await fs.copyFile(guiaPre, guiaInbox);
                }
            }
        }
        await moverArbol(u, destino);
        pasadas++;
        console.log(`  ➡️  PreProceso: «${rel || nombre}» lista → Inbox.`);
    }

    await escribirInforme(drop, hecho, pendientes, pasadas);
    // Cuando ya no queda nada más que su guía y el informe, la carpeta dejada sobra.
    const resto = (await fs.readdir(drop).catch(() => [])).filter((n) => !ignorar(n) && n !== NOMBRE_GUIA);
    if (!resto.length && pasadas) {
        await reciclarCarpeta(drop, 'preproceso-vaciado');
        console.log(`  ✅ PreProceso: «${nombre}» completa, toda en el Inbox.`);
    }
}

/** Recorre el árbol de abajo arriba preparando cada carpeta. Anota lo hecho y lo que queda pendiente. */
async function prepararArbol(dir, pendientes, hecho) {
    const guia = await leerGuia(dir).catch(() => null);
    if (ACCIONES_INTOCABLES.includes(guia?.accion)) return;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (e.isDirectory() && !ignorar(e.name) && e.name !== 'Desglose') await prepararArbol(path.join(dir, e.name), pendientes, hecho);
    }
    const rel = path.relative(DIR_PRE, dir);

    // Ya preparada en una pasada anterior: su guía dice libro + material.
    if (guia?.accion === 'libro-material') return;

    // Páginas escaneadas → un PDF por libro.
    const plan = await planEscaneo(dir).catch(() => null);
    if (plan) {
        const r = await materializarEscaneo(dir, plan);
        if (r.ok) hecho.push(`${rel}: escaneo → ${r.pdfs.map((p) => `«${p.nombre}» (${p.paginas} págs.)`).join(', ')}`);
        else pendientes.set(dir, `escaneo que no se pudo pasar a PDF (${r.motivo})`);
        return;
    }

    // Libro por capítulos, guiado o detectado. Un libro que no se puede preparar se queda aquí: nunca se cataloga
    // trozo a trozo.
    let resultado = null;
    if (guia?.accion === 'desglose') {
        resultado = await materializarDesgloseGuiado(dir, guia.desglose || {});
    } else {
        const desg = await detectarLibroDesglosado(dir);
        if (desg) resultado = await materializarDesglose(dir, desg) ? true : 'esperar';
        else {
            const puro = await detectarDesglosePuro(dir);
            if (puro || await esLibroPorCapitulos(dir)) resultado = await materializarDesgloseGuiado(dir, { orden: puro?.partes || [] });
        }
    }
    if (resultado === true) hecho.push(`${rel}: libro por capítulos preparado`);
    else if (resultado === 'esperar') pendientes.set(dir, 'libro por capítulos que aún no se puede coser (ver el log)');
}

/**
 * Las unidades que pasan al Inbox por separado. La carpeta dejada entera si ya es un libro (guía de libro, o solo
 * documentos sin subcarpetas); si no, cada uno de sus hijos.
 */
async function unidadesDe(drop) {
    const guia = await leerGuia(drop).catch(() => null);
    const entradas = (await fs.readdir(drop, { withFileTypes: true }).catch(() => [])).filter((e) => !ignorar(e.name) && e.name !== NOMBRE_GUIA);
    const esLibro = ['libro-material', 'desglose'].includes(guia?.accion)
        || (entradas.every((e) => e.isFile()) && entradas.some((e) => esDoc(e.name)));
    if (esLibro) return [drop];
    return entradas.map((e) => path.join(drop, e.name));
}

// Guías que dicen por sí solas qué es la unidad y cómo se cataloga.
const ACCIONES_CON_CAMINO = ['intacta', 'software', 'audiolibro', 'coleccion-audiolibros', 'transmedia', 'empaquetar', 'obra'];

/**
 * ¿Por qué NO debe pasar esta unidad al Inbox? null si tiene un camino de catalogación claro. Regla del usuario
 * (3-nov): al Inbox solo lo que se va a catalogar bien; nada de capítulos sin coser ni contenido dudoso. Medido: Strunk
 * y Coaching for Character pasaron con sus capítulos sueltos (ningún detector los reconoció) y cada uno acabó como un
 * documento. Devuelve { motivo, examen? } (examen = no catalogable: lleva su aviso en la carpeta).
 */
async function motivoParaRetener(u) {
    const st = await fs.stat(u).catch(() => null);
    if (!st) return null;
    if (!st.isDirectory()) {
        // Un capítulo suelto junto a otros, al lado de subcarpetas, también es parte de un libro sin coser.
        if (await pareceLibroPorCapitulos(path.dirname(u), '', 0)) {
            return { motivo: `«${path.basename(u)}» parece un capítulo de un libro sin coser (los ficheros de su carpeta)` };
        }
        if (esFicheroCatalogable(path.basename(u), st.size)) return null;
        const examen = await examinarCatalogable(u);
        return { motivo: examen.motivo || 'no es un formato que se catalogue', examen };
    }
    const guia = await leerGuia(u).catch(() => null);
    if (guia?.accion === 'omitir') return { motivo: 'su guía dice «omitir»' };
    const examen = await examinarCatalogable(u);
    if (examen.motivo) return { motivo: examen.motivo, examen };
    // Preparada aquí (libro entero o cosido): su guía nombra el libro, que tiene que estar.
    if (guia?.accion === 'libro-material') {
        const principal = guia.libro_material?.principal;
        return principal && await existe(path.join(u, principal)) ? null : { motivo: 'guía de libro + material sin su libro principal' };
    }
    if (ACCIONES_CON_CAMINO.includes(guia?.accion)) return null;
    // Una guía tuya (del Inspector o aprobada en el panel) decide; la del agente, no.
    if (guia && guia.perfil?.origen !== 'agente' && guia.accion) return null;
    const capitulos = await pareceLibroPorCapitulos(u);
    if (capitulos) {
        // masAbajo: lo visto está en una subcarpeta → la unidad se puede repartir y retener solo esa rama.
        return {
            motivo: `parece un libro por capítulos sin coser (en «${capitulos === '.' ? path.basename(u) : capitulos}»). Si no lo es, ponle una guía`,
            masAbajo: capitulos !== '.',
        };
    }
    return null;
}

/**
 * ¿Se puede repartir la unidad en sus hijos? Solo una carpeta con subcarpetas que no sea ella misma un libro
 * o una unidad con camino propio según su guía (esas viajan enteras o se quedan enteras).
 */
async function divisible(u) {
    const st = await fs.stat(u).catch(() => null);
    if (!st?.isDirectory()) return false;
    const guia = await leerGuia(u).catch(() => null);
    if (['libro-material', 'desglose', 'omitir', ...ACCIONES_CON_CAMINO].includes(guia?.accion)) return false;
    const entradas = await fs.readdir(u, { withFileTypes: true }).catch(() => []);
    return entradas.some((e) => e.isDirectory() && !ignorar(e.name) && e.name !== 'Desglose');
}

/** Los hijos de una unidad repartida (su guía no: viaja aparte, al lado de cada hijo que pasa). */
async function hijosDe(u) {
    const entradas = await fs.readdir(u, { withFileTypes: true }).catch(() => []);
    return entradas.filter((e) => !ignorar(e.name) && e.name !== NOMBRE_GUIA).map((e) => path.join(u, e.name));
}

/** Un nombre libre en el destino: nunca se pisa nada del Inbox. */
async function destinoLibre(destino) {
    if (!(await existe(destino))) return destino;
    const ext = path.extname(destino), base = destino.slice(0, destino.length - ext.length);
    for (let i = 2; ; i++) {
        const otro = `${base} (${i})${ext}`;
        if (!(await existe(otro))) return otro;
    }
}

/** Ficheros y bytes de un árbol (o de un fichero), para verificar una copia. */
async function huella(ruta) {
    const st = await fs.stat(ruta);
    if (!st.isDirectory()) return { n: 1, bytes: st.size };
    let n = 0, bytes = 0;
    for (const e of await fs.readdir(ruta)) {
        const h = await huella(path.join(ruta, e));
        n += h.n; bytes += h.bytes;
    }
    return { n, bytes };
}

/**
 * Mueve un fichero o carpeta. PreProceso y el Inbox son montajes distintos del contenedor, así que `rename` falla
 * (EXDEV): entonces se copia, se verifica (mismos ficheros y bytes) y solo después se borra el origen. Si la copia no
 * cuadra, se borra la copia y el origen se queda.
 */
async function moverArbol(origen, destino) {
    await fs.mkdir(path.dirname(destino), { recursive: true });
    try { await fs.rename(origen, destino); return; }
    catch (e) { if (e.code !== 'EXDEV') throw e; }
    await fs.cp(origen, destino, { recursive: true, errorOnExist: true, force: false });
    const [a, b] = await Promise.all([huella(origen), huella(destino)]);
    if (a.n !== b.n || a.bytes !== b.bytes) {
        await fs.rm(destino, { recursive: true, force: true });
        throw new Error(`copia incompleta de «${path.basename(origen)}» (${a.n}/${a.bytes} ≠ ${b.n}/${b.bytes}); se queda en PreProceso`);
    }
    await fs.rm(origen, { recursive: true, force: true });
}

async function escribirInforme(drop, hecho, pendientes, pasadas) {
    const h = historial.get(drop) || { hecho: [], pasadas: 0 };
    h.hecho.push(...hecho.map((x) => `${new Date().toLocaleString('es-ES')} · ${x}`));
    h.pasadas += pasadas;
    historial.set(drop, h);
    const lineas = [
        `PreProceso · ${path.basename(drop)} · ${new Date().toLocaleString('es-ES')}`,
        '',
        `Unidades pasadas al Inbox: ${h.pasadas}`,
        '',
        `Preparado (${h.hecho.length}):`, ...h.hecho.map((x) => `  · ${x}`),
        '',
        `Esperando (${pendientes.size}) — no pasan al Inbox hasta resolverse:`,
        ...[...pendientes].map(([r, m]) => `  · ${path.relative(DIR_PRE, r)}: ${m}`),
    ];
    await fs.writeFile(path.join(drop, INFORME), lineas.join('\n') + '\n').catch(() => {});
}

/** Arranca la pasada periódica. Cada PREPROCESO_ESCANEO_MS (config.js). */
export function iniciarPreproceso() {
    const ms = Number(process.env.PREPROCESO_ESCANEO_MS || 300000);
    console.log(`🧰 PreProceso: preparando lo que se deje en ${process.env.PREPROCESO_PUBLIC_PATH || DIR_PRE} (cada ${Math.round(ms / 1000)} s).`);
    setInterval(() => { pasadaPreproceso().catch((e) => console.error('PreProceso:', e.message)); }, ms);
}
