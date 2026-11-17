/**
 * PREPROCESO — preparar antes de catalogar (fases 1 y 2: preparación + inspección con IA). Diseño en docs/preproceso.md.
 *
 * El usuario deja en PreProceso lo complejo (carpetas enormes, formatos variopintos, libros por capítulos). Aquí se
 * PREPARA y solo cuando una unidad está lista pasa al Inbox, donde el Vigilante la cataloga como cualquier otra.
 * REGLA DE FONDO: aquí no se cataloga nada; solo se trabaja sobre los ficheros. La base de datos no se toca.
 *
 * Cada pasada, por cada carpeta dejada en PreProceso que ya terminó de copiarse:
 *   1. expande los comprimidos (vigilante · expandirComprimidos: zip/rar/7z → carpeta);
 *   1b. inspecciona el árbol con IA si es complejo (utils/inspeccion-auto · prepararCarpeta, la misma del Vigilante) y
 *      deja sus `_guia.json`: lo que pasa al Inbox va ya guiado, y lo que la IA ve no catalogable (guía «omitir») se
 *      queda aquí. Si la IA falla, la carpeta entera ESPERA y se reintenta. El Vigilante no la vuelve a inspeccionar;
 *   2. convierte en PDF las carpetas de páginas escaneadas (utils/escaneo-a-pdf);
 *   3. resuelve los libros por capítulos: el libro entero si está; si no, convierte las partes .doc con LibreOffice y
 *      las cose (vigilante · materializarDesglose*). Lo que no se pueda, queda PENDIENTE;
 *   4. pasa al Inbox cada UNIDAD sin pendientes y con un camino de catalogación CLARO (motivoParaRetener): se quedan
 *      aquí los capítulos sin coser, lo que no es catalogable (vídeos, .dvi, una descarga incompleta según su .sfv; con
 *      aviso `.NO_CATALOGABLE.txt` en la carpeta) y lo que su guía manda omitir. Lo fácil no espera a lo difícil;
 *   5. deja un informe `_preproceso.txt` en la carpeta con lo hecho y lo que espera.
 *
 * Unidad: UN LIBRO O UN COMPRIMIDO, nunca una carpeta de cien documentos (regla del usuario, 17-nov). Se empieza por
 * los hijos de la carpeta dejada (o ella entera si es un libro); si uno está retenido por algo de DENTRO, se parte
 * y pasa lo demás (pasarUnidad). Todo pasa a Inbox/<carpeta dejada>/<su ruta relativa>, con las guías de las carpetas
 * de encima, para que el Vigilante conserve el contexto (colección, materia). Lo que no puede pasar se queda aquí, en
 * su sitio: nada se pierde, y juntando el Inbox con PreProceso sale la estructura original.
 *
 * Trabaja aunque el Vigilante esté en pausa: preparar no cataloga, y lo que pasa al Inbox espera allí.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { carpetaEstable, expandirComprimidos, materializarDesglose, materializarDesgloseGuiado, CARPETA_NO_DESCOMPRIMIDOS } from './vigilante.js';
import { planEscaneo, materializarEscaneo } from './utils/escaneo-a-pdf.js';
import { detectarLibroDesglosado, detectarDesglosePuro, esLibroPorCapitulos, pareceLibroPorCapitulos, parecenCapitulosDeLibro } from './utils/libro-desglosado.js';
import { esFicheroCatalogable, examinarCatalogable, escribirAvisoNoCatalogable, AVISO_NO_CATALOGABLE } from './utils/no-catalogable.js';
import { leerGuia, escribirGuia, NOMBRE_GUIA } from './utils/guia-ingesta.js';
import { esLibroHtml } from './utils/libro-html.js';
import { reciclarCarpeta } from './utils/papelera.js';
import { detallarDesglose } from './utils/afinar-guias.js';
import { prepararCarpeta, MARCA_INSPECCION } from './utils/inspeccion-auto.js'; // fase 2: la IA guía aquí, no en el Inbox
import { CARPETA_MATERIAL_SIN_LIBRO } from './utils/retirar-material.js';
import { EXT_DOC } from './mantenimiento/util-mantenimiento.js';
import { huella, moverArbol, destinoLibre } from './utils/mover-arbol.js';
import { crearLatido } from './utils/latido-proceso.js';
import { esCarpetaCdDePrograma } from './utils/cd-de-programa.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const INFORME = '_preproceso.txt';
const ESTADO = '_ESTADO PREPROCESO.txt';   // qué hace ahora (utils/latido-proceso.js), en la raíz de PreProceso
const ACCIONES_INTOCABLES = ['intacta', 'software', 'omitir', 'empaquetar'];   // el usuario dijo: tal cual

// `_Material sin libro`: lo que se retiró del catálogo por no colgar de ningún libro (utils/retirar-material.js). Espera
// a que lo juntes con su libro; PreProceso no lo prepara ni lo pasa al Inbox.
// `_No se pudo descomprimir`: los comprimidos dañados / con contraseña, apartados para que no retengan su carpeta
// (vigilante·apartarNoExpandido). Esperan a que pongas una copia buena; PreProceso no los toca.
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || n === INFORME || n === ESTADO
    || n === CARPETA_MATERIAL_SIN_LIBRO || n === CARPETA_NO_DESCOMPRIMIDOS;

// Qué hace ahora, con marca de tiempo (petición del usuario, 16-nov: «no deja registro en el log; ¿está activo o
// bloqueado?»): cada fase se anuncia en el log, un latido cada PREPROCESO_LATIDO_MIN la repite mientras dura, y el
// estado queda en `PreProceso/_ESTADO PREPROCESO.txt`.
const latido = crearLatido('PreProceso', {
    fichero: path.join(DIR_PRE, ESTADO),
    latidoMin: Number(process.env.PREPROCESO_LATIDO_MIN || 5),
});
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
    const inicio = Date.now();
    let preparadas = 0;
    try {
        await fs.mkdir(DIR_PRE, { recursive: true }).catch(() => {});
        await devolverApartados().catch((err) => console.warn(`  ⚠️  PreProceso: devolver apartados: ${err.message}`));
        let entradas;
        try { entradas = await fs.readdir(DIR_PRE, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            const ruta = path.join(DIR_PRE, e.name);
            if (e.isFile()) { await pasarFicheroSuelto(ruta); continue; }
            if (!e.isDirectory()) continue;
            if (!(await carpetaEstable(ruta))) {
                latido.detalle(`«${e.name}» aún se está copiando; se espera`);
                continue;
            }
            const firma = await huella(ruta).then((h) => `${h.n}:${h.bytes}`).catch(() => null);
            const previa = ultimaPasada.get(ruta);
            if (previa && previa.firma === firma && Date.now() - previa.t < REVISAR_MS) continue;
            preparadas++;
            const t0 = Date.now();
            latido.fase(`«${e.name}»: empieza la preparación`);
            await prepararDrop(ruta).catch((err) => console.warn(`  ⚠️  PreProceso «${e.name}»: ${err.message}`));
            console.log(`  🧰 PreProceso: «${e.name}» — pasada terminada en ${Math.round((Date.now() - t0) / 60000)} min.`);
            const despues = await huella(ruta).then((h) => `${h.n}:${h.bytes}`).catch(() => null);
            if (despues) ultimaPasada.set(ruta, { firma: despues, t: Date.now() }); else ultimaPasada.delete(ruta);
        }
    } finally {
        enCurso = false;
        latido.reposo(preparadas ? `${preparadas} carpeta(s) revisada(s) en ${Math.round((Date.now() - inicio) / 60000)} min` : '');
    }
}

/** Un fichero suelto en PreProceso: si no es un comprimido, no necesita preparación y pasa tal cual. */
async function pasarFicheroSuelto(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    if (['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.iso'].includes(ext)) {
        latido.fase(`comprimido suelto «${path.basename(ruta)}»`);
        // Lo convierte en carpeta (se prepara en la próxima pasada) o en cómic si solo trae imágenes. Si no se puede
        // abrir, se queda aquí con su aviso `.NO_SE_PUDO_DESCOMPRIMIR - <nombre>.txt` al lado.
        await expandirComprimidos(DIR_PRE, 0, { enPreproceso: true });
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
    const pendientes = new Map();   // ruta → motivo
    const hecho = [];
    // Un comprimido que no se puede abrir SE QUEDA EN PREPROCESO, con su error (regla del usuario, 15-nov): antes iba a
    // Cuarentena/ilegibles. Si el fallo es del propio comprimido (dañado, contraseña) se aparta a «_No se pudo
    // descomprimir/» y su carpeta sigue (16-nov: un .rar dañado retenía 530 libros); solo uno pasajero (sin espacio)
    // vuelve aquí como pendiente y retiene su unidad hasta el reintento.
    latido.fase(`«${nombre}»: abriendo comprimidos`);
    for (const { ruta, motivo } of await expandirComprimidos(drop, 6, { enPreproceso: true })) pendientes.set(ruta, motivo);

    // FASE 2 · INSPECCIÓN CON IA AQUÍ, antes de pasar nada. Antes se hacía en el Inbox, justo antes de catalogar
    // (14-nov: «Medical» pasó entera y se inspeccionó allí), cuando ya no quedaba ocasión de retener lo que no tiene
    // camino. Con las guías escritas aquí, la preparación de abajo (coser un desglose guiado) y el filtro de salida
    // las obedecen. Si la IA falla, no pasa nada de esta carpeta: se reintenta sola.
    latido.fase(`«${nombre}»: inspección con IA (si hace falta)`);
    const prep = await prepararCarpeta(drop, { origen: 'preproceso' }).catch((err) => {
        console.warn(`  🧭 PreProceso «${nombre}»: fallo al preparar la inspección (${err.message}) → sin guías de IA.`);
        return { seguir: true };
    });
    if (!prep.seguir) {
        pendientes.set(drop, 'esperando la inspección con IA (falló o está en revisión en el panel; se reintenta sola)');
        await escribirInforme(drop, hecho, pendientes, 0);
        return;
    }
    latido.fase(`«${nombre}»: preparando (escaneos → PDF, libros por capítulos)`);
    await prepararArbol(drop, pendientes, hecho);

    const unidades = await unidadesDe(drop);
    latido.fase(`«${nombre}»: pasando al Inbox lo que está listo (${unidades.length} unidad(es))`);
    const ctx = { drop, nombre, pendientes, pasadas: 0 };
    for (const u of unidades) await pasarUnidad(u, ctx, 0);
    const pasadas = ctx.pasadas;

    await escribirInforme(drop, hecho, pendientes, pasadas);
    console.log(`  🧰 PreProceso: «${nombre}» — ${pasadas} unidad(es) al Inbox, ${pendientes.size} esperando (detalle en «${nombre}/${INFORME}»).`);
    // Cuando ya no queda nada más que su guía y el informe, la carpeta dejada sobra.
    const resto = (await fs.readdir(drop).catch(() => [])).filter((n) => !ignorar(n) && n !== NOMBRE_GUIA);
    if (!resto.length && pasadas) {
        await reciclarCarpeta(drop, 'preproceso-vaciado');
        console.log(`  ✅ PreProceso: «${nombre}» completa, toda en el Inbox.`);
    }
}

// Guías que hacen de la carpeta UNA COSA (un libro, una obra, un audiolibro, un programa…): no se parte. Sin guía, o
// con una de estas, la carpeta es solo un contenedor de libros y sí se puede partir.
const ACCIONES_DIVISIBLES = [undefined, null, '', 'normal', 'aplanar', 'explotar'];
const MAX_NIVEL_PARTIR = 8;

/**
 * Pasa al Inbox una unidad lista; si algo de DENTRO la retiene, la parte y pasa lo demás.
 *
 * UNIDAD = UN LIBRO O UN COMPRIMIDO, NO UNA CARPETA DE CIEN DOCUMENTOS (regla del usuario, 17-nov). Antes la unidad era
 * cada hijo de la carpeta dejada, entero: un libro por capítulos sin coser (Oppenheim, con una parte dañada) retenía a
 * «500+ Electrical Engineering Books» con sus 529 libros, y otro a «600 …» con 543, reintentándolo cada media hora sin
 * fin. Ahora lo que se retiene es solo el libro (o el fichero) que tiene el problema; sus hermanos siguen al Inbox, a
 * su misma ruta relativa y con las guías de las carpetas de encima (el contexto: colección, materia).
 * Un libro sigue pasando ENTERO o quedándose ENTERO (regla del 9-nov): nunca se parte una carpeta que ES un libro.
 */
async function pasarUnidad(u, ctx, nivel) {
    const bloqueos = [...ctx.pendientes.keys()].filter((p) => p === u || p.startsWith(u + path.sep));
    if (bloqueos.includes(u)) return;   // ella misma es lo que espera (su motivo ya está anotado)
    let retenida = null;
    if (!bloqueos.length) {
        // Solo pasa lo que tiene un camino de catalogación CLARO (regla del usuario, 3-nov). Lo demás se queda aquí.
        retenida = await motivoParaRetener(u);
        if (!retenida) {
            await pasarAlInbox(u, ctx);
            return;
        }
    }
    // Algo la retiene. Si es un contenedor de libros y el problema está DENTRO, se parte: cada hijo por su cuenta.
    if (nivel < MAX_NIVEL_PARTIR && await esDivisible(u, retenida)) {
        const hijos = (await fs.readdir(u, { withFileTypes: true }).catch(() => []))
            .filter((e) => !ignorar(e.name) && e.name !== NOMBRE_GUIA && e.name !== AVISO_NO_CATALOGABLE);
        for (const h of hijos) await pasarUnidad(path.join(u, h.name), { ...ctx, partida: true, padre: ctx }, nivel + 1);
        // Del contenedor ya no queda más que su guía y sus marcas: sobra (a la Papelera, nunca borrado).
        const resto = (await fs.readdir(u).catch(() => [])).filter((n) => !ignorar(n) && n !== NOMBRE_GUIA);
        if (!resto.length && u !== ctx.drop) await reciclarCarpeta(u, 'preproceso-vaciado').catch(() => {});
        return;
    }
    if (!retenida) return;   // un libro con algo pendiente dentro: espera entero (el pendiente ya está anotado)
    ctx.pendientes.set(u, retenida.motivo);
    const clave = `${u}|${retenida.motivo}`;
    if (!avisadas.has(clave)) {
        avisadas.add(clave);
        console.warn(`  ✋ PreProceso: «${path.relative(DIR_PRE, u)}» se queda: ${retenida.motivo}.`);
    }
    // El aviso «.NO_CATALOGABLE.txt» solo para una unidad de primer nivel: dentro de una carpeta partida, un léeme o un
    // .sfv sobrante escribiría el aviso de la carpeta de sus hermanos, que se han ido al Inbox.
    if (retenida.examen && !ctx.partida) {
        await escribirAvisoNoCatalogable(u, retenida.examen, { donde: 'se queda en PreProceso; no pasa al Inbox ni se cataloga' });
    }
}

/** Suma al contador de la carpeta dejada (los contextos de las carpetas partidas son copias). */
function contarPasada(ctx) {
    let c = ctx;
    while (c.padre) c = c.padre;
    c.pasadas++;
}

/**
 * ¿Se puede partir `u`? Solo una carpeta que es un CONTENEDOR de libros: sin guía que la haga una cosa (libro, obra,
 * audiolibro, programa…), que no sea un libro HTML, y cuyo motivo de retención no sea ella misma. Lo «no catalogable»
 * solo se parte si dentro hay algo catalogable y su .sfv (descarga incompleta) no está en ella misma: partir una
 * descarga incompleta dejaría pasar sus trozos sueltos.
 */
async function esDivisible(u, retenida) {
    const st = await fs.stat(u).catch(() => null);
    if (!st?.isDirectory()) return false;
    if (retenida?.propia) return false;
    const guia = await leerGuia(u).catch(() => null);
    if (!ACCIONES_DIVISIBLES.includes(guia?.accion)) return false;
    if (await esLibroHtml(u)) return false;
    if (retenida?.examen) {
        if (!retenida.examen.catalogables) return false;
        const propios = await fs.readdir(u).catch(() => []);
        if (propios.some((n) => n.toLowerCase().endsWith('.sfv'))) return false;
    }
    return true;
}

/**
 * Mueve una unidad lista a Inbox/<carpeta dejada>/<su ruta relativa>. Las guías de las carpetas de encima viajan
 * antes, a sus gemelas del Inbox: son su contexto (colección, materia, perfil heredado). Y la marca de la
 * inspección, para que el Vigilante sepa que ya se inspeccionó aquí y no gaste la IA otra vez.
 */
async function pasarAlInbox(u, ctx) {
    const { drop, nombre } = ctx;
    const rel = path.relative(drop, u);
    const destino = await destinoLibre(rel ? path.join(DIR_INBOX, nombre, rel) : path.join(DIR_INBOX, nombre));
    if (rel) {
        for (let anc = path.dirname(u); ; anc = path.dirname(anc)) {
            const guia = path.join(anc, NOMBRE_GUIA);
            const gemela = path.join(DIR_INBOX, nombre, path.relative(drop, anc), NOMBRE_GUIA);
            if (await existe(guia) && !(await existe(gemela))) {
                await fs.mkdir(path.dirname(gemela), { recursive: true });
                await fs.copyFile(guia, gemela);
            }
            if (anc === drop || !anc.startsWith(drop)) break;
        }
        await pasarMarcaInspeccion(drop, path.join(DIR_INBOX, nombre));
    }
    await moverArbol(u, destino);
    contarPasada(ctx);
    console.log(`  ➡️  PreProceso: «${rel || nombre}» lista → Inbox.`);
}

/**
 * Copia la marca de inspección de la carpeta dejada a su gemela del Inbox, con `origen:'preproceso'` (aunque la marca
 * diga «agotada»: la decisión de no esperar más a la IA ya se tomó aquí). Sin marca no hay nada que copiar: la carpeta
 * era simple y no se inspeccionó, y en el Inbox tampoco se inspeccionará.
 */
async function pasarMarcaInspeccion(drop, destinoDrop) {
    const destino = path.join(destinoDrop, MARCA_INSPECCION);
    if (await existe(destino)) return;
    const marca = await fs.readFile(path.join(drop, MARCA_INSPECCION), 'utf8').then(JSON.parse).catch(() => null);
    if (!marca) return;
    await fs.mkdir(destinoDrop, { recursive: true });
    await fs.writeFile(destino, JSON.stringify({ ...marca, origen: 'preproceso' }, null, 2)).catch(() => {});
}

/** Recorre el árbol de abajo arriba preparando cada carpeta. Anota lo hecho y lo que queda pendiente. */
async function prepararArbol(dir, pendientes, hecho) {
    const guia = await leerGuia(dir).catch(() => null);
    if (ACCIONES_INTOCABLES.includes(guia?.accion)) return;
    const rel0 = path.relative(DIR_PRE, dir);
    // Guía que se puede reescribir: ninguna, o una puesta por la IA / por el propio PreProceso. La tuya manda.
    const guiaReescribible = !guia?.accion || ['agente', 'preproceso'].includes(guia.perfil?.origen);

    // CD DE PROGRAMA (AUTORUN.INF en la raíz, casi ningún documento): se guarda intacto como software, ANTES de mirar
    // dentro (sus carpetas de instaladores no son escaneos ni libros). Regla del usuario, 16-nov (Floyd «CC 7e»).
    if (guiaReescribible && await esCarpetaCdDePrograma(dir)) {
        await escribirGuia(dir, { accion: 'software', perfil: { origen: 'preproceso' } });
        hecho.push(`${rel0}: CD de programa (AUTORUN.INF) → software intacto`);
        console.log(`  💿 PreProceso: ${rel0}: CD de programa (AUTORUN.INF) → se guarda intacto como software.`);
        return;
    }
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

    // LIBRO POR CAPÍTULOS SIN GUÍA (17-nov): antes solo se marcaba «parece un libro por capítulos, ponle una guía» y se
    // quedaba aquí para siempre (Adaptive Image Processing: 0283_01…08 + fm + ref; Living Issues in Ethics: preliminares
    // + «Part 1…4/» con los capítulos). Se intenta coserlo aquí, ANTES de bajar a sus subcarpetas (que son sus partes,
    // no libros sueltos): el orden lo da afinar-guias·detallarDesglose (nombres; si son títulos, una llamada a la IA
    // con el sumario). Si no se puede, el libro se queda aquí ENTERO, y solo él.
    if (!guia?.accion && dir !== DIR_PRE && !RE_NOMBRE_DE_PARTE.test(path.basename(dir))
        && await pareceLibroPorCapitulos(dir, '', 0) === '.') {
        latido.detalle(`libro por capítulos sin guía: ${rel0}`);
        const r = await coserSinGuia(dir, entradas);
        if (r === true) {
            hecho.push(`${rel0}: libro por capítulos cosido`);
            return;
        }
        if (r === 'esperar') {
            pendientes.set(dir, 'libro por capítulos que aún no se puede coser (ver el log)');
            return;
        }
        // 'no-es-desglose': no hay partes que coser; sigue el camino de siempre (motivoParaRetener decidirá).
    }

    for (const e of entradas) {
        if (e.isDirectory() && !ignorar(e.name) && e.name !== 'Desglose') await prepararArbol(path.join(dir, e.name), pendientes, hecho);
    }
    const rel = path.relative(DIR_PRE, dir);

    // Ya preparada en una pasada anterior: su guía dice libro + material.
    if (guia?.accion === 'libro-material') return;

    // Páginas escaneadas → un PDF por libro.
    const plan = await planEscaneo(dir).catch(() => null);
    if (plan) {
        latido.detalle(`escaneo → PDF: ${rel}`);
        const r = await materializarEscaneo(dir, plan);
        if (r.ok) {
            const texto = `${rel}: escaneo → ${r.pdfs.map((p) => `«${p.nombre}» (${p.paginas} págs.)`).join(', ')}`;
            hecho.push(texto);
            console.log(`  📄 PreProceso: ${texto}`);
        } else if (guiaReescribible) {
            // No se pudo pasar a PDF (una imagen que no es JPEG/PNG de verdad, dañada…): antes la carpeta —y con ella
            // toda su unidad— se quedaba aquí para siempre, reintentándolo cada media hora. Un .cbz guarda las
            // imágenes con sus mismos bytes, sin convertir nada: se guía «empaquetar» y sigue su camino (16-nov).
            await escribirGuia(dir, { accion: 'empaquetar', alcance: plan.tipo === 'partes' ? 'subcarpetas' : 'todo', perfil: { origen: 'preproceso' } });
            hecho.push(`${rel}: escaneo que no se pudo pasar a PDF (${r.motivo}) → se empaquetará en .cbz`);
            console.warn(`  ⚠️  PreProceso: ${rel}: escaneo que no se pudo pasar a PDF (${r.motivo}) → se empaquetará en .cbz, sin convertir las imágenes.`);
        } else {
            pendientes.set(dir, `escaneo que no se pudo pasar a PDF (${r.motivo})`);
            console.warn(`  ⚠️  PreProceso: ${rel}: escaneo que no se pudo pasar a PDF (${r.motivo}); tiene una guía tuya, así que espera.`);
        }
        return;
    }

    // Libro por capítulos, guiado o detectado. Un libro que no se puede preparar se queda aquí: nunca se cataloga
    // trozo a trozo.
    let resultado = null;
    latido.detalle(`libro por capítulos: ${rel}`);
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

// Carpetas que son una PARTE de un libro («Part 1 - …», «Chapter 3», «Unidad 2», «Vol 1», «CD1»): no se cosen por su
// cuenta como si fueran el libro entero.
const RE_NOMBRE_DE_PARTE = /^(part|parte|section|secci[oó]n|unit|unidad|chapter|cap[ií]tulo|tema|lesson|lecci[oó]n|module|m[oó]dulo|vol(ume|umen)?|tomo|cd|disc|disco)\b[\s._-]*\d*/i;

/**
 * Cose un libro por capítulos que nadie ha guiado. Sus partes pueden estar sueltas y en subcarpetas de partes (las que
 * solo tienen documentos, sin más subcarpetas). Devuelve true | 'esperar' | 'no-es-desglose'. La guía «desglose» solo
 * se escribe si hay que esperar (para no volver a pedir el orden a la IA en cada pasada); si se cose, el cosido deja
 * la suya de libro + material.
 */
async function coserSinGuia(dir, entradas) {
    const subcarpetas = [];
    for (const e of entradas) {
        if (!e.isDirectory() || ignorar(e.name) || e.name === 'Desglose') continue;
        const dentro = await fs.readdir(path.join(dir, e.name), { withFileTypes: true }).catch(() => []);
        if (dentro.some((x) => x.isDirectory() && !ignorar(x.name))) return 'no-es-desglose';   // árbol más hondo: no se adivina
        if (dentro.some((x) => x.isFile() && esDoc(x.name))) subcarpetas.push(e.name);
    }
    const d = await detallarDesglose(dir, { subcarpetas }).catch((err) => {
        console.warn(`  ⚠️  PreProceso: no se pudo ordenar «${path.basename(dir)}» (${err.message}).`);
        return null;
    });
    if (!d) return 'no-es-desglose';
    // Sin guía nadie ha confirmado que sea UN libro: las partes PDF han de tener páginas y texto de capítulo (no láminas,
    // no documentos sueltos de una página). Si no se puede medir, no se cose: se queda para que lo mires tú.
    const pdfs = d.orden.filter((n) => n.toLowerCase().endsWith('.pdf'));
    if (!d.principal && !(await parecenCapitulosDeLibro(dir, pdfs.length ? pdfs : d.orden))) return 'no-es-desglose';
    const desglose = { ...(d.principal ? { principal: d.principal } : {}), orden: d.orden, ...(Object.keys(d.titulos || {}).length ? { titulos: d.titulos } : {}) };
    console.log(`  📑 PreProceso: «${path.relative(DIR_PRE, dir)}» parece un libro por capítulos sin guía → se cose (${d.orden.length} partes, orden: ${d.fuente}).`);
    const r = await materializarDesgloseGuiado(dir, desglose);
    if (r === 'esperar') await escribirGuia(dir, { accion: 'desglose', desglose, perfil: { origen: 'preproceso' } }).catch(() => {});
    return r;
}

/**
 * Devuelve a su sitio lo que el 16-nov se apartó a «_No se pudo descomprimir/<ruta>»: desde el 17-nov lo que no se
 * puede abrir se queda en su ubicación del árbol (regla del usuario). Lo que ya tenga ocupado su sitio, se deja allí.
 */
async function devolverApartados() {
    const raiz = path.join(DIR_PRE, CARPETA_NO_DESCOMPRIMIDOS);
    if (!(await existe(raiz))) return;
    const ficheros = [];
    const recorrer = async (d) => {
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await recorrer(p); else ficheros.push(p);
        }
    };
    await recorrer(raiz);
    for (const f of ficheros) {
        const destino = path.join(DIR_PRE, path.relative(raiz, f));
        if (await existe(destino)) continue;
        try {
            await moverArbol(f, destino);
            if (!path.basename(f).startsWith('.')) console.log(`  ↩️  PreProceso: «${path.relative(DIR_PRE, destino)}» vuelve a su sitio (ya no se apartan los comprimidos que no se abren).`);
        } catch (err) {
            console.warn(`  ⚠️  PreProceso: no se pudo devolver «${path.relative(raiz, f)}» a su sitio (${err.message}).`);
        }
    }
    // Las carpetas que quedan vacías sobran (de abajo arriba; una con algo dentro no se toca).
    const podar = async (d) => {
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) await podar(path.join(d, e.name));
        if (!(await fs.readdir(d).catch(() => ['x'])).length) await fs.rmdir(d).catch(() => {});
    };
    await podar(raiz);
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
    if (guia?.accion === 'omitir') return { motivo: 'su guía dice «omitir»', propia: true };
    const examen = await examinarCatalogable(u);
    if (examen.motivo) return { motivo: examen.motivo, examen };
    // Preparada aquí (libro entero o cosido): su guía nombra el libro, que tiene que estar.
    if (guia?.accion === 'libro-material') {
        const principal = guia.libro_material?.principal;
        return principal && await existe(path.join(u, principal)) ? null : { motivo: 'guía de libro + material sin su libro principal', propia: true };
    }
    // «Intacta» de la IA sobre algo que no es un libro HTML: daría una ficha de «material» sin libro del que colgar, que
    // la ingesta ya no hace (regla del usuario, 14-nov). Se queda aquí; una guía tuya «intacta» sí pasa.
    if (guia?.accion === 'intacta' && ['agente', 'preproceso'].includes(guia.perfil?.origen) && !(await esLibroHtml(u))) {
        return { motivo: 'la IA la guió «intacta», pero no es un libro: sin un documento principal no se le hace ficha. Si es una obra, guíala tú', propia: true };
    }
    if (ACCIONES_CON_CAMINO.includes(guia?.accion)) return null;
    // Una guía tuya (del Inspector o aprobada en el panel) decide; la del agente, no.
    if (guia && guia.perfil?.origen !== 'agente' && guia.accion) return null;
    // Un LIBRO EN HTML pasa ENTERO, con su guía «intacta» (la ingesta lo cataloga como libro HTML). Sus subcarpetas
    // (solucionarios por capítulo, css, js) son parte del libro, no un libro sin coser.
    if (await esLibroHtml(u)) {
        if (!guia?.accion) await escribirGuia(u, { accion: 'intacta', perfil: { origen: 'preproceso' } });
        return null;
    }
    const capitulos = await pareceLibroPorCapitulos(u);
    if (capitulos) {
        return { motivo: `parece un libro por capítulos sin coser (en «${capitulos === '.' ? path.basename(u) : capitulos}»). Si no lo es, ponle una guía`, propia: capitulos === '.' };
    }
    return null;
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
