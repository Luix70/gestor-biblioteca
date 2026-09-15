/**
 * AFINAR LAS GUÍAS del agente de estructura con lo que la interpretación del árbol NO puede saber sola.
 *
 * La interpretación (agente-estructura) mira un ESQUELETO: nombres y recuentos. Dos decisiones necesitan más:
 *
 *   1) EL ISSN DE UNA CABECERA DE REVISTA. La IA NO lo da: un modelo recuerda mal los ISSN, y uno equivocado con
 *      dígito de control válido crearía una cabecera falsa a la que se colgarían todos los números. Aquí solo se
 *      acepta de fuentes COMPROBABLES, en este orden: escrito en los nombres de fichero → la cabecera que ya está
 *      en el catálogo con ese nombre → Wikidata por título. Si ninguna lo da, la guía va sin ISSN y lo aportará
 *      el primer número al ingerirse (código de barras o texto), que lo propaga a los demás por la cabecera.
 *
 *   2) EL DETALLE DE UN LIBRO DESGLOSADO: cuál es el libro entero (si está), el ORDEN de lectura de las partes y
 *      el título de cada una (para el índice de capítulos). Primero en local y gratis: el detector de desgloses
 *      y el orden determinista aciertan cuando los nombres traen número o «Preface/Index». Solo si las partes se
 *      llaman por su TÍTULO («The Fall of Rome.pdf») se hace UNA llamada dirigida a la IA con los nombres y el
 *      sumario del libro (texto de las primeras páginas del preliminar), que es la fuente fiable del orden.
 *
 *   3) LA PORTADA DEL PRIMER NÚMERO de una tirada de revistas: UNA llamada de visión que lee la cabecera tal como
 *      se escribe, el ISSN (código de barras o impreso, confirmado), editorial, idioma, CDU, una descripción y el nº
 *      y la fecha de ese número (la muestra que calibra los demás). Va antes que 1): si la portada da el ISSN, no
 *      hace falta buscarlo, y si da el nombre bien escrito, se busca con él.
 *
 * Lo usan la inspección automática del vigilante (inspeccion-auto) y el CLI inspeccionar-estructura, para que
 * los dos escriban exactamente las mismas guías.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { conectarDB } from '../database.js';
import { leerGuia } from './guia-ingesta.js';
import { buscarISSNporTitulo, buscarNombrePorISSN } from './buscador-issn-titulo.js';
import { detectarLibroDesglosado, ordenarPartesLibro, tienePistaDeOrden, partesDeDesglose, RE_CARPETA_PARTES } from './libro-desglosado.js';
import { conTexto, conVision, extraerJSON } from './vision.js';
import { rasterizarPaginas } from './rasterizar-pdf.js';
import { timeoutPoppler } from './timeout-poppler.js';
import { leerCodigoBarrasPorVision } from './lector-barras.js';
import { decodificarCodigoBarras } from './codigo-barras.js';
import { validarISSN } from './identificadores.js';
import { esVarianteDeNombre } from './colecciones.js';
import { mesesDeNombre, esTituloGenerico, normTituloPublicacion } from './revistas.js';
import { sanearCduMateria } from './guias-estructura.js';
import { PERIODICIDADES } from './agente-estructura.js';

const ejecutar = promisify(execFile);

// ─── 1) ISSN de la cabecera ─────────────────────────────────────────────────────────────────────────────

/**
 * ISSN COMPROBADO de una cabecera, o null. `issnsNombres` = los ISSN válidos escritos en los nombres de los
 * ficheros de la carpeta y sus subcarpetas (los calcula el esqueleto).
 * @returns {Promise<{issn:string, fuente:string}|null>}
 */
export async function resolverIssnCabecera(cabecera, issnsNombres = []) {
    // a) Escrito en los propios ficheros. Solo si es UNO: dos ISSN distintos en la misma tirada (impreso y
    //    electrónico, o una carpeta que mezcla cabeceras) no se deciden a ciegas.
    if (issnsNombres.length === 1) return { issn: issnsNombres[0], fuente: 'nombres de fichero' };
    if (!cabecera) return null;

    // b) La cabecera ya catalogada con ese nombre (sin distinguir mayúsculas ni acentos, como resolverCabecera).
    try {
        const db = await conectarDB();
        const c = await db.collection('colecciones').findOne(
            { nombre: cabecera, issn: { $type: 'string' } },
            { collation: { locale: 'es', strength: 1 }, projection: { issn: 1, nombre: 1 } });
        if (c?.issn) return { issn: c.issn, fuente: `catálogo («${c.nombre}»)` };
    } catch { /* sin BD: se sigue con Wikidata */ }

    // c) Wikidata por título, COMPROBADO DE VUELTA. La búsqueda por título devuelve el primer candidato con ISSN, y
    //    con un título genérico acierta con otra publicación (medido: «Revistas» → 1409-1259, que no es nada de
    //    esta biblioteca). Por eso: nada de títulos genéricos, y el nombre registrado para ese ISSN (Wikidata/ISSN
    //    Portal) tiene que CASAR con la cabecera. Primero en español (la mayoría de las cabeceras), luego en inglés.
    if (esTituloGenerico(cabecera)) return null;
    for (const idioma of ['es', 'en']) {
        const w = await buscarISSNporTitulo(cabecera, { idioma }).catch(() => null);
        if (!w?.issn) continue;
        const registrado = await buscarNombrePorISSN(w.issn, { idioma }).catch(() => null);
        if (registrado?.nombre && nombresCasan(registrado.nombre, cabecera)) return { issn: w.issn, fuente: `${w.fuente}, «${registrado.nombre}»` };
    }
    return null;
}

// (Los títulos GENÉRICOS —«Revistas», «_REVISTAS»…— y su normalización viven en revistas.js: los usa también el plan
// de guías, para no tomar un cajón de revistas por UNA revista.)
const normTitulo = normTituloPublicacion;

// Palabras que marcan OTRA EDICIÓN de la misma cabecera (un país, una lengua): «All About History: Turkey» no es
// «All About History». Medido el 15-sep: la búsqueda por título en Wikidata dio el ISSN de la edición turca
// (2717-8536) y la regla «uno contiene al otro» lo aceptó. Una coletilla de otro tipo («Outside (revista)», «Popular
// science (New York, N.Y.)») sigue valiendo.
const EDICIONES = new Set(['turkey', 'turkiye', 'espana', 'spain', 'france', 'uk', 'usa', 'us', 'italia', 'italy', 'deutschland',
    'germany', 'mexico', 'argentina', 'brasil', 'brazil', 'portugal', 'india', 'australia', 'canada', 'japan', 'china', 'russia',
    'polska', 'poland', 'nederland', 'netherlands', 'belgique', 'suisse', 'arabic', 'arabia', 'latinoamerica', 'edition', 'edicion',
    'edizione', 'ausgabe', 'international', 'kids', 'junior']);
/** ¿Dos nombres de publicación son la misma? Iguales tras normalizar, o uno contiene al otro entero (subtítulos). */
function nombresCasan(a, b) {
    const x = normTitulo(a), y = normTitulo(b);
    if (!x || !y) return false;
    if (x === y) return true;
    const contiene = (` ${x} `).includes(` ${y} `) || (` ${y} `).includes(` ${x} `);
    if (!contiene) return false;
    // Lo que sobra en el más largo no puede ser el nombre de otra edición.
    const [largo, corto] = x.length >= y.length ? [x, y] : [y, x];
    const cortas = new Set(corto.split(' '));
    return !largo.split(' ').some((w) => !cortas.has(w) && EDICIONES.has(w));
}

// ─── 2) Detalle del desglose ────────────────────────────────────────────────────────────────────────────

const MAX_PARTES_IA = 150;        // un libro se parte en decenas de piezas; más no cabe con sentido en el prompt
const MAX_SUMARIO = 6000;         // caracteres del sumario que se envían (sobra para un índice de capítulos)

/** Páginas de un PDF (poppler), o null si no se puede medir (fuera del NAS puede faltar poppler: se sigue). */
async function paginasPdf(ruta) {
    if (path.extname(ruta).toLowerCase() !== '.pdf') return null;
    try {
        const { stdout } = await ejecutar('pdfinfo', [ruta], { timeout: 20000, maxBuffer: 1 << 20 });
        const m = stdout.match(/^Pages:\s+(\d+)/m);
        return m ? Number(m[1]) : null;
    } catch { return null; }
}

/** Texto de las primeras páginas de un PDF: donde está el SUMARIO de un libro. */
async function textoInicial(ruta, paginas = 8) {
    if (path.extname(ruta).toLowerCase() !== '.pdf') return '';
    try {
        const { stdout } = await ejecutar('pdftotext', ['-f', '1', '-l', String(paginas), '-layout', ruta, '-'], { timeout: 30000, maxBuffer: 8 << 20 });
        return String(stdout || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_SUMARIO);
    } catch { return ''; }
}

/** Título legible a partir del nombre de fichero, para el índice cuando no hay otro («05-CH_Roman_Law» → «Roman Law»). */
export function tituloDeNombre(nombre) {
    const t = path.basename(nombre, path.extname(nombre))
        .replace(/_/g, ' ')
        .replace(/^\s*\d{1,3}\s*[-.\s]+/, '')                 // numeración inicial del editor («05 - »)
        .replace(/\s+/g, ' ')
        .trim();
    return t || path.basename(nombre, path.extname(nombre));
}

/**
 * Detalle de un libro desglosado que vive en `dirAbs`: { principal?, orden, titulos, fuente } o null si no hay
 * partes. Las partes pueden estar sueltas en la carpeta o en sus subcarpetas de partes («Chapters/»…, o las de
 * `subcarpetas`): entonces se nombran con su ruta relativa («Chapters/ch01.pdf»). Nunca lanza: si la IA falla,
 * devuelve el orden determinista (el vigilante coserá con él).
 */
export async function detallarDesglose(dirAbs, { subcarpetas = [] } = {}) {
    const docs = [];
    for (const nombre of await partesDeDesglose(dirAbs, subcarpetas)) {
        let bytes = 0; try { bytes = (await fs.stat(path.join(dirAbs, ...nombre.split('/')))).size; } catch { /* sin stat */ }
        docs.push({ nombre, bytes });
    }
    if (docs.length < 2) return null;

    // a) El detector local ya reconoce «libro entero + partes numeradas»: gratis y probado.
    const local = await detectarLibroDesglosado(dirAbs).catch(() => null);
    if (local) return { principal: local.principal, orden: ordenarPartesLibro(local.partes), titulos: {}, fuente: 'local' };

    // b) Partes que dicen su sitio en el nombre: el orden determinista basta (y los títulos, del nombre).
    const nombres = docs.map((d) => d.nombre);
    const ordenLocal = ordenarPartesLibro(nombres);
    const conPista = nombres.filter(tienePistaDeOrden).length / nombres.length;
    if (conPista >= 0.9 || nombres.length > MAX_PARTES_IA) return { orden: ordenLocal, titulos: {}, fuente: 'local' };

    // c) Partes con nombre de TÍTULO: una llamada dirigida con los nombres, su tamaño y el sumario.
    try {
        const conPaginas = [];
        for (const d of docs) conPaginas.push({ ...d, paginas: await paginasPdf(path.join(dirAbs, ...d.nombre.split('/'))) });
        const preliminar = ordenLocal.find((n) => /front|contents|toc|preface|pr[oó]logo|[ií]ndice|sumario/i.test(path.basename(n)))
            || [...conPaginas].sort((a, b) => a.bytes - b.bytes)[0]?.nombre;
        const sumario = preliminar ? await textoInicial(path.join(dirAbs, ...preliminar.split('/'))) : '';
        const r = await pedirOrdenIA(path.basename(dirAbs), conPaginas, preliminar, sumario);
        return { ...validarDetalle(r, nombres, ordenLocal), fuente: sumario ? 'IA con el sumario' : 'IA solo con los nombres' };
    } catch (e) {
        console.warn(`   ⚠️  desglose «${path.basename(dirAbs)}»: la IA no ordenó las partes (${String(e.message).slice(0, 80)}); se usa el orden por nombre.`);
        return { orden: ordenLocal, titulos: {}, fuente: 'local (la IA falló)' };
    }
}

async function pedirOrdenIA(carpeta, docs, preliminar, sumario) {
    const mb = (b) => (b / 1048576).toFixed(1);
    const lista = docs.map((d) => `- «${d.nombre}» — ${mb(d.bytes)} MB${d.paginas ? ` — ${d.paginas} págs.` : ''}`).join('\n');
    const prompt = `Estos ficheros son las PARTES de UN libro partido en capítulos, en la carpeta «${carpeta}».
Decide:
1) «principal»: si uno de ellos es el LIBRO ENTERO (pesa y ocupa mucho más que los demás), su nombre exacto; si no, null.
2) «orden»: TODOS los demás ficheros en ORDEN DE LECTURA (preliminares, capítulos en su orden, apéndices,
   bibliografía, índice). Usa los nombres EXACTOS.
3) «titulos»: para cada fichero de «orden», el título de esa parte tal como iría en el índice del libro
   (p. ej. «3. La caída de Roma»), en el idioma del libro.
${sumario ? `El SUMARIO de abajo (texto de las primeras páginas de «${preliminar}») es la fuente FIABLE del orden y de los
títulos: úsalo por encima de lo que sugieran los nombres.` : 'No hay sumario legible: deduce el orden de los nombres y del tamaño.'}

Ficheros:
${lista}
${sumario ? `\nSUMARIO:\n${sumario}\n` : ''}
Responde SOLO con JSON, sin texto alrededor:
{"principal":"…o null","orden":["…"],"titulos":{"fichero":"título"}}`;
    const txt = await conTexto({ prompt, json: true, maxTokens: 16000 });
    const r = extraerJSON(txt);
    if (!r || !Array.isArray(r.orden)) throw new Error('respuesta sin «orden»');
    return r;
}

/**
 * Se queda solo con lo que casa con ficheros REALES. Lo que la IA olvide se añade al final en el orden
 * determinista: coser un libro sin una de sus partes sería perder contenido en silencio.
 */
function validarDetalle(r, nombres, ordenLocal) {
    const existe = new Set(nombres);
    const principal = existe.has(r.principal) ? r.principal : null;
    const orden = [...new Set((r.orden || []).filter((n) => existe.has(n) && n !== principal))];
    for (const n of ordenLocal) if (n !== principal && !orden.includes(n)) orden.push(n);
    const titulos = {};
    for (const [k, v] of Object.entries(r.titulos || {})) {
        if (existe.has(k) && typeof v === 'string' && v.trim()) titulos[k] = v.trim().slice(0, 300);
    }
    return { ...(principal ? { principal } : {}), orden, titulos };
}

// ─── 3) La portada del PRIMER NÚMERO de una tirada (visión) ─────────────────────────────────────────────
//
// Los nombres no bastan para una revista: la carpeta se llama «l'historie» o «l´hist0r1e» y la publicación es
// «L'Histoire»; nada en «7-8.pdf» dice el año; y el ISSN no está escrito en ningún nombre. La PORTADA sí lo dice.
// Una llamada de visión por tirada, con la portada, las primeras páginas con contenido (sumario, créditos) y la
// contraportada del primer número, deja en la guía la cabecera bien escrita, su ISSN, editorial, idioma, CDU y una
// descripción, más una MUESTRA (nº y fecha de ese número) que calibra los demás. Es una inversión: con esa guía,
// cada número se ingiere sin volver a preguntar a la IA por nada de eso.

const VISION_ACTIVA = () => process.env.INSPECCION_IA_VISION !== '0';
const VISION_PAGINAS = () => Number(process.env.INSPECCION_IA_VISION_PAGINAS || 4);   // páginas con contenido del principio
const VISION_ANCHO = () => Number(process.env.INSPECCION_IA_VISION_ANCHO || 1000);    // px: legible sin pesar demasiado
const VISION_MAX = () => Number(process.env.INSPECCION_IA_VISION_MAX || 60);          // tiradas leídas por inspección

/** Primer PDF de una tirada en orden natural («1.pdf» antes que «10.pdf»), bajando hasta 3 niveles (años). */
async function primerNumeroPdf(dirAbs, nivel = 0) {
    let entradas;
    try { entradas = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return null; }
    const orden = (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' });
    const pdf = entradas.filter((e) => e.isFile() && /\.pdf$/i.test(e.name) && !/^[._@#]/.test(e.name)).sort(orden)[0];
    if (pdf) return path.join(dirAbs, pdf.name);
    if (nivel >= 3) return null;
    for (const d of entradas.filter((e) => e.isDirectory() && !/^[._@#]/.test(e.name)).sort(orden)) {
        const r = await primerNumeroPdf(path.join(dirAbs, d.name), nivel + 1);
        if (r) return r;
    }
    return null;
}

/** Texto de un tramo de páginas de un PDF ('' si no tiene capa de texto o no hay poppler). */
async function textoDePaginas(ruta, desde, hasta) {
    if (hasta < desde) return '';
    try {
        // Timeout adaptado al tamaño (en el Atom, un número de 150 MB no se lee en 30 s).
        const { stdout } = await ejecutar('pdftotext', ['-f', String(desde), '-l', String(hasta), ruta, '-'], { timeout: await timeoutPoppler(ruta), maxBuffer: 64 << 20 });
        return String(stdout || '');
    } catch { return ''; }
}

/** ISSN escritos junto a la palabra «ISSN» en un texto (la mancheta del número), validados y sin repetir. */
function issnsEnTexto(texto) {
    const vistos = new Set();
    for (const m of String(texto || '').matchAll(/ISSN[^0-9]{0,15}(\d{4}\s*[-‐‑–]?\s*\d{3}[\dXx])/gi)) {
        const v = validarISSN(m[1].replace(/\s+/g, ''));
        if (v) vistos.add(v);
    }
    return [...vistos];
}

/**
 * ¿Se puede CONFIRMAR un ISSN que la visión dice haber leído (en el código de barras o impreso)? La guía lo aplica a
 * TODOS los números de la tirada, y la visión se equivoca de dígitos sin avisar. Medido con L'Histoire 2016: leyó en
 * el código de barras 0241-2780 —dígito de control del EAN correcto— y es el ISSN de «Graphite»; el de L'Histoire
 * (0182-2411) estaba impreso en la mancheta. Vale: que esté en la capa de texto del número, que la cabecera
 * catalogada con ese ISSN se llame igual, o que el nombre registrado para ese ISSN (Wikidata / ISSN Portal) case con
 * el de la portada. Devuelve { fuente } o { rechazo } (el porqué, para la nota).
 */
async function confirmarIssn(issn, textoNumero, cabecera) {
    const [a, b] = issn.split('-');
    if (new RegExp(`${a}\\s*[-‐‑–]?\\s*${b.replace('X', '[Xx]')}`).test(textoNumero)) return { fuente: 'capa de texto del número' };
    if (!cabecera) return { rechazo: 'sin nombre de cabecera con que cotejarlo' };
    try {
        const db = await conectarDB();
        const c = await db.collection('colecciones').findOne({ issn }, { projection: { nombre: 1 } });
        if (c?.nombre && (nombresCasan(c.nombre, cabecera) || esVarianteDeNombre(c.nombre, cabecera))) return { fuente: `catálogo («${c.nombre}»)` };
    } catch { /* sin BD: se sigue con el registro */ }
    const reg = await buscarNombrePorISSN(issn).catch(() => null);
    if (reg?.nombre && (nombresCasan(reg.nombre, cabecera) || esVarianteDeNombre(reg.nombre, cabecera))) return { fuente: `${reg.fuente || 'registro ISSN'}, «${reg.nombre}»` };
    return { rechazo: reg?.nombre ? `registrado como «${reg.nombre}»` : 'no aparece en el texto ni en los registros' };
}

function promptPortada(carpeta, fichero, nombres, pistas) {
    const pista = [
        pistas.cabecera && `cabecera «${pistas.cabecera}»`,
        pistas.materia_cdu && `CDU ${pistas.materia_cdu}`,
        pistas.periodicidad && `periodicidad ${pistas.periodicidad}`,
        pistas.periodo && `años ${pistas.periodo.desde}${pistas.periodo.hasta !== pistas.periodo.desde ? `-${pistas.periodo.hasta}` : ''}`,
    ].filter(Boolean).join(' · ');
    return `Estas imágenes son páginas del PRIMER número («${fichero}») de una tirada de revistas guardada en la carpeta
«${carpeta}». La primera es la PORTADA; las siguientes, las primeras páginas con contenido (sumario, créditos o
mancheta); la última, la CONTRAPORTADA. Otros ficheros de la tirada: ${nombres.slice(0, 15).map((n) => `«${n}»`).join(', ')}.
${pista ? `Lo que se dedujo de los NOMBRES (son pistas y pueden estar MAL: las carpetas vienen con erratas u ofuscadas): ${pista}.\n` : ''}
Devuelve SOLO un JSON con estos campos (null o vacío lo que no veas con seguridad; NO inventes ni recuerdes de memoria):
- "cabecera": el nombre de la publicación tal como la escribe ella misma (su logotipo), sin número, fecha ni lema,
  con mayúsculas normales («L'Histoire», no «L'HISTOIRE»).
- "issn_impreso": el ISSN IMPRESO que VEAS (créditos, mancheta, junto a la palabra ISSN), formato NNNN-NNNX.
- "codigo_barras": los 13 dígitos del código de barras EAN-13 de la portada o la contraportada, sin espacios.
- "editorial": la empresa editora (créditos).
- "idioma": código ISO 639-1 del idioma de la revista (es, en, fr…).
- "periodicidad": ${PERIODICIDADES.join('|')}, si se ve o se deduce.
- "cdu": la CDU (Clasificación Decimal Universal, NO Dewey) de la MATERIA de la publicación, lo más precisa que
  puedas justificar: historia → 94 (en la CDU las divisiones 95-99 NO existen), fotografía → 77, dibujo → 741,
  informática → 004, ciencia divulgativa → 50.
- "descripcion": una o dos frases en español que describan la publicación (qué es, de qué trata, de dónde es).
- "numero": el número de ESTE ejemplar (entero), o null. "mes": su mes (1-12; en un número doble, el primero);
  "mes_fin": el segundo mes de un número doble, o null. "anio": su año (4 cifras).`;
}

/**
 * Lee la portada del primer número de la tirada que vive en `dirAbs`. Devuelve lo leído, ya validado
 * ({ fichero, cabecera, issn, issn_fuente, issn_sin_confirmar, editorial, idioma, periodicidad, cdu, descripcion,
 * muestra }), o null si no hay un PDF que leer. Lanza si la visión falla (el llamante sigue sin ella).
 */
export async function leerPortadaRevista(dirAbs, pistas = {}) {
    const ruta = await primerNumeroPdf(dirAbs);
    if (!ruta) return null;
    const fichero = path.relative(dirAbs, ruta).split(path.sep).join('/');
    // CACHÉ en memoria (fichero + tamaño + fecha): «🔄 Repetir» o una segunda inspección del mismo árbol no vuelven a
    // pagar la portada ya leída mientras el proceso siga vivo.
    let clave = null;
    try { const st = await fs.stat(ruta); clave = `${ruta}|${st.size}|${st.mtimeMs}`; } catch { /* sin stat: sin caché */ }
    if (clave && CACHE_PORTADAS.has(clave)) return { ...CACHE_PORTADAS.get(clave), fichero };
    const t0 = Date.now();
    console.log(`   📰 Portada de «${path.basename(dirAbs)}» («${fichero}»)…`);
    const total = await paginasPdf(ruta);

    // RENDIMIENTO EN EL NAS (medido: un _REVISTAS de 121 carpetas llevaba 51 min afinando). Cada llamada a poppler
    // RELEE el PDF entero, y en el Atom un número de revista de 20-100 MB tarda en cada lectura. Así que el mínimo de
    // pasadas: las páginas pedidas se rasterizan de una vez (no se mide antes la tinta: una revista no empieza con
    // páginas en blanco), el texto solo de las primeras y las últimas páginas (la mancheta está ahí), y los recortes
    // del código de barras (cinco pasadas más) solo si el texto no dio el ISSN.
    const frente = Array.from({ length: Math.min(VISION_PAGINAS(), total || VISION_PAGINAS()) }, (_, i) => i + 1);
    const paginas = total && total > frente.length ? [...frente, total] : frente;
    const renders = await rasterizarPaginas(ruta, { paginas, ancho: VISION_ANCHO() });
    if (!renders.length) return null;

    // a) El ISSN sin IA, de dos fuentes que no se equivocan de dígitos: la MANCHETA en la capa de texto del número (si
    //    trae UN solo ISSN; varios —impreso y electrónico, o el de otra revista citada— no se deciden a ciegas) y el
    //    código de barras leído en LOCAL (zxing, decodificador determinista: un 977 ES el ISSN de la publicación).
    let issn = null, issnFuente = null;
    const textoNumero = (await textoDePaginas(ruta, 1, Math.min(total || 12, 12)))
        + (total > 12 ? await textoDePaginas(ruta, Math.max(13, total - 3), total) : '');
    const issnsTexto = issnsEnTexto(textoNumero);
    if (issnsTexto.length === 1) { issn = issnsTexto[0]; issnFuente = 'mancheta (capa de texto del número)'; }
    if (!issn && total) {
        const bcLocal = await leerCodigoBarrasPorVision(ruta, total, [], { soloLocal: true }).catch(() => null);
        if (bcLocal?.issn) { issn = bcLocal.issn; issnFuente = 'código de barras'; }
    }

    // b) UNA llamada de visión con las páginas.
    let nombres = [];
    try { nombres = (await fs.readdir(path.dirname(ruta))).filter((n) => /\.(pdf|epub|cbz|cbr|djvu)$/i.test(n)); } catch { /* sin lista */ }
    const txt = await conVision({
        prompt: promptPortada(path.basename(dirAbs), fichero, nombres, pistas),
        imagenes: renders.map((r) => ({ base64: r.buffer.toString('base64'), mimeType: 'image/jpeg' })),
    });
    const v = extraerJSON(txt) || {};

    const texto = (x, max) => (typeof x === 'string' && x.trim() && x.trim().toLowerCase() !== 'null' ? x.trim().slice(0, max) : null);
    const entero = (x, min, max) => (Number.isInteger(Number(x)) && Number(x) >= min && Number(x) <= max ? Number(x) : null);
    const cabecera = texto(v.cabecera, 120);

    // ISSN que dice haber leído la visión (impreso, o en el código de barras): solo CONFIRMADO (ver confirmarIssn).
    // El impreso primero: el código de barras es donde más se equivoca de dígitos.
    let issnSinConfirmar = null;
    if (!issn) {
        const candidatos = [
            [validarISSN(v.issn_impreso || ''), 'impreso'],
            [decodificarCodigoBarras(v.codigo_barras)?.issn || null, 'código de barras'],
        ].filter(([c]) => c);
        for (const [cand, donde] of candidatos) {
            const conf = await confirmarIssn(cand, textoNumero, cabecera || pistas.cabecera);
            if (conf.fuente) { issn = cand; issnFuente = `${donde} (visión), confirmado por ${conf.fuente}`; break; }
            issnSinConfirmar = issnSinConfirmar || `${cand} (${donde}, visión: ${conf.rechazo})`;
        }
    }

    const numero = entero(v.numero, 1, 100000), mes = entero(v.mes, 1, 12), anio = entero(v.anio, 1800, 2100);
    const muestra = (numero || (mes && anio)) ? { fichero, ...(numero ? { numero } : {}), ...(anio ? { anio } : {}), ...(mes ? { mes } : {}) } : null;
    const idioma = texto(v.idioma, 3);
    const leido = {
        fichero,
        cabecera,
        issn, issn_fuente: issnFuente, issn_sin_confirmar: issnSinConfirmar,
        editorial: texto(v.editorial, 120),
        idioma: idioma && /^[a-z]{2,3}$/i.test(idioma) ? idioma.toLowerCase() : null,
        periodicidad: PERIODICIDADES.includes(v.periodicidad) ? v.periodicidad : null,
        cdu: sanearCduMateria(texto(v.cdu, 40)),
        descripcion: texto(v.descripcion, 600),
        muestra,
    };
    if (clave) CACHE_PORTADAS.set(clave, leido);
    console.log(`   📰 «${path.basename(dirAbs)}»: «${cabecera || '?'}»${issn ? `, ISSN ${issn}` : ''} (${Math.round((Date.now() - t0) / 1000)} s).`);
    return leido;
}
const CACHE_PORTADAS = new Map();

/**
 * Vuelca en el perfil de la guía lo leído en la portada. La portada manda sobre lo deducido de los nombres (la ha
 * VISTO); los choques se anotan para que se vean en el log y en el panel. Devuelve las notas.
 */
function aplicarPortada(perfil, v, nombre) {
    const notas = [];
    if (v.cabecera) {
        if (perfil.cabecera && perfil.cabecera !== v.cabecera) notas.push(`cabecera «${perfil.cabecera}» (de los nombres) → «${v.cabecera}» (leída en la portada)`);
        perfil.cabecera = v.cabecera;
        perfil.cabecera_verificada = true;
    }
    if (v.issn) { perfil.issn = v.issn; notas.push(`ISSN ${v.issn} (${v.issn_fuente})`); }
    if (v.issn_sin_confirmar) notas.push(`ISSN ${v.issn_sin_confirmar} SIN confirmar: no se usa`);
    if (v.editorial && !perfil.editorial_probable) perfil.editorial_probable = v.editorial;
    if (v.idioma && !perfil.idioma_probable) perfil.idioma_probable = v.idioma;
    if (v.periodicidad) perfil.periodicidad = v.periodicidad;
    if (v.descripcion) perfil.descripcion = v.descripcion;
    // CDU: la más precisa si una afina a la otra (94 → 94(44)); si chocan, la de la portada (ha visto el contenido).
    if (v.cdu && v.cdu !== perfil.materia_cdu) {
        const previa = perfil.materia_cdu;
        if (!previa || v.cdu.startsWith(previa)) perfil.materia_cdu = v.cdu;
        else if (!previa.startsWith(v.cdu)) { notas.push(`CDU ${previa} (de los nombres) → ${v.cdu} (vista la revista)`); perfil.materia_cdu = v.cdu; }
    }
    if (v.muestra) {
        perfil.muestra = v.muestra;
        // CALIBRAR la numeración de los ficheros con la muestra: si «1.pdf» es de enero, los números son meses.
        const mn = mesesDeNombre(path.basename(v.muestra.fichero));
        const baseNum = Number(path.basename(v.muestra.fichero).replace(/\.[^.]+$/, ''));
        if (mn && v.muestra.mes) {
            if (mn.mes === v.muestra.mes) {
                if (perfil.numeracion !== 'mes') notas.push(`«${v.muestra.fichero}» es de ${v.muestra.mes}/${v.muestra.anio || '?'}: los números de los ficheros son MESES`);
                perfil.numeracion = 'mes';
                perfil.numeracion_verificada = true;
            } else if (perfil.numeracion === 'mes') {
                notas.push(`«${v.muestra.fichero}» es del mes ${v.muestra.mes}, no del ${mn.mes}: los números de los ficheros NO son meses`);
                delete perfil.numeracion;
                delete perfil.numeracion_verificada;
            }
        }
        if (v.muestra.numero && baseNum === v.muestra.numero) { perfil.numeracion = 'numero'; perfil.numeracion_verificada = true; }
        if (perfil.periodo && v.muestra.anio && (v.muestra.anio < perfil.periodo.desde || v.muestra.anio > perfil.periodo.hasta)) {
            notas.push(`OJO: el primer número es de ${v.muestra.anio}, fuera de los años de la carpeta (${perfil.periodo.desde}-${perfil.periodo.hasta})`);
        }
    }
    return notas.length ? [`«${nombre}» (portada de «${v.fichero}»): ${notas.join('; ')}.`] : [`«${nombre}»: portada de «${v.fichero}» leída (cabecera «${perfil.cabecera || '?'}»${perfil.materia_cdu ? `, CDU ${perfil.materia_cdu}` : ''}).`];
}

// ─── Plan completo ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Afina, EN SITIO, las guías del plan que se van a escribir (estado nueva/actualizar). Devuelve notas legibles
 * de lo que se hizo (para el log y el CLI). No lanza: lo que no se pueda afinar se queda como estaba.
 *
 * @param plan  salida de guias-estructura · planGuias
 * @param esq   el esqueleto (para los ISSN escritos en los nombres de cada subárbol)
 * @param opciones.onProgreso  (texto) → qué se está haciendo («portada 12 de 60 · «Muy Historia 2014»»): el panel lo
 *                             enseña y renueva con él la reserva de la carpeta. Un árbol con decenas de revistas son
 *                             decenas de minutos en el NAS.
 * @param opciones.cancelado   () → true para dejarlo a medias (el panel canceló: no seguir pagando portadas).
 */
// `maxPortadas`: tope de portadas leídas en esta pasada. La automática usa INSPECCION_IA_VISION_MAX (60: bloquea al
// vigilante mientras dura); la del panel pasa uno mayor (se ve el progreso y se puede cancelar).
export async function afinarPlan(plan, esq, { onProgreso = () => {}, cancelado = () => false, maxPortadas = VISION_MAX() } = {}) {
    const notas = [];
    const issnsDe = (ruta) => {
        const vistos = new Set();
        for (const c of esq.carpetas) {
            if (ruta === '.' || c.ruta === ruta || c.ruta.startsWith(ruta + '/')) (c.issn_en_nombre || []).forEach((i) => vistos.add(i));
        }
        return [...vistos];
    };

    // Tiradas cuya portada ya se leyó (en esta pasada o en una anterior): ruta → cabecera. Una subcarpeta solo se da
    // por leída si su madre leída es la MISMA publicación (los años de una tirada). Con un Set de rutas, una raíz mal
    // tomada por revista dejó sin leer las 60 tiradas de debajo (15-sep, «_REVISTAS»).
    const leidas = new Map();
    let llamadasVision = 0;     // lo que cuenta para el tope: las llamadas de verdad, no las reaprovechadas
    const aAfinar = plan.filter((p) => p.guia && ['nueva', 'actualizar'].includes(p.estado));
    const tiradas = aAfinar.filter((p) => p.guia.perfil?.tipo_probable === 'revista').length;
    let paso = 0, tirada = 0;
    for (const p of plan) {
        if (!p.guia || !['nueva', 'actualizar'].includes(p.estado)) continue;
        if (cancelado()) { notas.push('Afinado interrumpido: la inspección se canceló.'); break; }
        const nombre = p.ruta === '.' ? esq.raiz : p.ruta;
        const bajoDe = (q) => q.ruta === '.' || p.ruta.startsWith(q.ruta + '/');
        paso++;
        if (p.guia.perfil?.tipo_probable === 'revista') tirada++;
        onProgreso(p.guia.perfil?.tipo_probable === 'revista'
            ? `Revista ${tirada} de ${tiradas} · «${nombre}»${VISION_ACTIVA() ? ` · portadas leídas: ${llamadasVision}${maxPortadas < tiradas ? ` (tope ${maxPortadas})` : ''}` : ''}`
            : `Carpeta ${paso} de ${aAfinar.length} · «${nombre}»`);

        // La PORTADA del primer número (visión). No se repite en una subcarpeta de una tirada ya leída, ni si la guía que
        // ya hay en disco la leyó en una inspección anterior: se reaprovecha (reinspeccionar no vuelve a pagarla, y
        // una segunda pasada sobre un _REVISTAS enorme completa las que el tope dejó sin leer).
        const previa = p.guia.perfil?.tipo_probable === 'revista' ? await leerGuia(p.abs).catch(() => null) : null;
        if (previa?.perfil?.cabecera_verificada) {
            for (const k of ['cabecera', 'cabecera_verificada', 'issn', 'editorial_probable', 'idioma_probable', 'periodicidad', 'descripcion', 'muestra', 'numeracion', 'numeracion_verificada', 'materia_cdu']) {
                if (previa.perfil[k] !== undefined) p.guia.perfil[k] = previa.perfil[k];
            }
            leidas.set(p.ruta, normTitulo(p.guia.perfil.cabecera));
            notas.push(`«${nombre}»: portada ya leída en una inspección anterior (cabecera «${p.guia.perfil.cabecera}»); se conserva.`);
        } else if (p.guia.perfil?.tipo_probable === 'revista' && VISION_ACTIVA()) {
            const cabP = normTitulo(p.guia.perfil.cabecera);
            const madreLeida = !!cabP && [...leidas].some(([r, cab]) => r !== p.ruta && bajoDe({ ruta: r }) && cab === cabP);
            if (!madreLeida && llamadasVision < maxPortadas) {
                try {
                    llamadasVision++;
                    const v = await leerPortadaRevista(p.abs, p.guia.perfil);
                    if (v) { notas.push(...aplicarPortada(p.guia.perfil, v, nombre)); leidas.set(p.ruta, normTitulo(p.guia.perfil.cabecera)); }
                } catch (e) {
                    notas.push(`«${nombre}»: no se pudo leer la portada con la visión (${String(e.message).slice(0, 80)}); la guía se queda con lo deducido de los nombres.`);
                }
            } else if (!madreLeida) {
                notas.push(`«${nombre}»: portada sin leer (tope de ${maxPortadas} tiradas por inspección; otra pasada reaprovecha las leídas y sigue con las demás).`);
            }
        }

        const cab = p.guia.perfil?.cabecera;
        if (p.guia.perfil?.tipo_probable === 'revista' && cab && !p.guia.perfil.issn) {
            // Las subcarpetas de una tirada (por año) HEREDAN la cabecera y el ISSN de la madre: no se repite la
            // búsqueda si una guía de más arriba ya lleva ese mismo nombre de cabecera con su ISSN.
            const madre = plan.find((q) => q !== p && q.guia?.perfil?.cabecera === cab && q.guia.perfil.issn && bajoDe(q));
            if (!madre) {
                const r = await resolverIssnCabecera(cab, issnsDe(p.ruta));
                if (r) { p.guia.perfil.issn = r.issn; notas.push(`«${nombre}»: cabecera «${cab}», ISSN ${r.issn} (${r.fuente}).`); }
                else notas.push(`«${nombre}»: cabecera «${cab}», sin ISSN comprobable (lo aportará el primer número al ingerirse).`);
            }
        }

        if (p.guia.accion === 'desglose') {
            // Subcarpetas donde pueden estar sus partes: las que el agente leyó como «parte» (o como otro trozo del
            // mismo libro desglosado); las de nombre típico («Chapters/»…) las añade partesDeDesglose por su cuenta.
            const madreDe = (ruta) => (ruta.includes('/') ? ruta.slice(0, ruta.lastIndexOf('/')) : '.');
            const subcarpetas = plan
                .filter((q) => q.ruta !== '.' && madreDe(q.ruta) === p.ruta)
                .filter((q) => q.tipo === 'parte' || q.contenido === 'libro-desglosado' || RE_CARPETA_PARTES.test(q.ruta.split('/').pop()))
                .map((q) => q.ruta.split('/').pop());
            const d = await detallarDesglose(p.abs, { subcarpetas });
            if (d) {
                p.guia.desglose = { ...(d.principal ? { principal: d.principal } : {}), orden: d.orden, ...(Object.keys(d.titulos).length ? { titulos: d.titulos } : {}) };
                notas.push(`«${nombre}»: libro desglosado — ${d.principal ? `libro entero «${d.principal}» + ${d.orden.length} partes` : `${d.orden.length} partes a coser`} (orden: ${d.fuente}).`);
            }
        }
    }
    return notas;
}
