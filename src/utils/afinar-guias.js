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
 * Lo usan la inspección automática del vigilante (inspeccion-auto) y el CLI inspeccionar-estructura, para que
 * los dos escriban exactamente las mismas guías.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { conectarDB } from '../database.js';
import { buscarISSNporTitulo, buscarNombrePorISSN } from './buscador-issn-titulo.js';
import { detectarLibroDesglosado, ordenarPartesLibro, tienePistaDeOrden } from './libro-desglosado.js';
import { conTexto, extraerJSON } from './vision.js';

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

// Títulos que describen un SOPORTE o un cajón, no una publicación: buscarles ISSN solo puede dar uno ajeno.
const GENERICOS = new Set(['revista', 'revistas', 'magazine', 'magazines', 'periodicos', 'prensa', 'diarios', 'comic', 'comics',
    'boletin', 'boletines', 'varios', 'varias', 'misc', 'otros', 'numeros', 'ejemplares', 'suscripciones']);
const normTitulo = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/^(el|la|los|las|the|le|les|il|lo|der|die|das) /, '').trim();
function esTituloGenerico(t) {
    const n = normTitulo(t);
    return !n || n.length < 3 || GENERICOS.has(n);
}
/** ¿Dos nombres de publicación son la misma? Iguales tras normalizar, o uno contiene al otro entero (subtítulos). */
function nombresCasan(a, b) {
    const x = normTitulo(a), y = normTitulo(b);
    if (!x || !y) return false;
    return x === y || (` ${x} `).includes(` ${y} `) || (` ${y} `).includes(` ${x} `);
}

// ─── 2) Detalle del desglose ────────────────────────────────────────────────────────────────────────────

const EXT_PARTE = new Set(['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.djv', '.chm', '.doc', '.docx', '.rtf']);
const esAccesorio = (n) => n.startsWith('.') || n.startsWith('_') || n.startsWith('@') || n.startsWith('#');
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
 * partes. Nunca lanza: si la IA falla, devuelve el orden determinista (el vigilante coserá con él).
 */
export async function detallarDesglose(dirAbs) {
    let entradas;
    try { entradas = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return null; }
    const docs = [];
    for (const e of entradas) {
        if (!e.isFile() || esAccesorio(e.name) || !EXT_PARTE.has(path.extname(e.name).toLowerCase())) continue;
        let bytes = 0; try { bytes = (await fs.stat(path.join(dirAbs, e.name))).size; } catch { /* sin stat */ }
        docs.push({ nombre: e.name, bytes });
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
        for (const d of docs) conPaginas.push({ ...d, paginas: await paginasPdf(path.join(dirAbs, d.nombre)) });
        const preliminar = ordenLocal.find((n) => /front|contents|toc|preface|pr[oó]logo|[ií]ndice|sumario/i.test(n))
            || [...conPaginas].sort((a, b) => a.bytes - b.bytes)[0]?.nombre;
        const sumario = preliminar ? await textoInicial(path.join(dirAbs, preliminar)) : '';
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

// ─── Plan completo ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Afina, EN SITIO, las guías del plan que se van a escribir (estado nueva/actualizar). Devuelve notas legibles
 * de lo que se hizo (para el log y el CLI). No lanza: lo que no se pueda afinar se queda como estaba.
 *
 * @param plan  salida de guias-estructura · planGuias
 * @param esq   el esqueleto (para los ISSN escritos en los nombres de cada subárbol)
 */
export async function afinarPlan(plan, esq) {
    const notas = [];
    const issnsDe = (ruta) => {
        const vistos = new Set();
        for (const c of esq.carpetas) {
            if (ruta === '.' || c.ruta === ruta || c.ruta.startsWith(ruta + '/')) (c.issn_en_nombre || []).forEach((i) => vistos.add(i));
        }
        return [...vistos];
    };

    for (const p of plan) {
        if (!p.guia || !['nueva', 'actualizar'].includes(p.estado)) continue;
        const nombre = p.ruta === '.' ? esq.raiz : p.ruta;

        const cab = p.guia.perfil?.cabecera;
        if (p.guia.perfil?.tipo_probable === 'revista' && cab) {
            // Las subcarpetas de una tirada (por año) HEREDAN la cabecera y el ISSN de la madre: no se repite la
            // búsqueda si una guía de más arriba ya lleva ese mismo nombre de cabecera con su ISSN.
            const madre = plan.find((q) => q !== p && q.guia?.perfil?.cabecera === cab && q.guia.perfil.issn
                && (q.ruta === '.' || p.ruta.startsWith(q.ruta + '/')));
            if (!madre) {
                const r = await resolverIssnCabecera(cab, issnsDe(p.ruta));
                if (r) { p.guia.perfil.issn = r.issn; notas.push(`«${nombre}»: cabecera «${cab}», ISSN ${r.issn} (${r.fuente}).`); }
                else notas.push(`«${nombre}»: cabecera «${cab}», sin ISSN comprobable (lo aportará el primer número al ingerirse).`);
            }
        }

        if (p.guia.accion === 'desglose') {
            const d = await detallarDesglose(p.abs);
            if (d) {
                p.guia.desglose = { ...(d.principal ? { principal: d.principal } : {}), orden: d.orden, ...(Object.keys(d.titulos).length ? { titulos: d.titulos } : {}) };
                notas.push(`«${nombre}»: libro desglosado — ${d.principal ? `libro entero «${d.principal}» + ${d.orden.length} partes` : `${d.orden.length} partes a coser`} (orden: ${d.fuente}).`);
            }
        }
    }
    return notas;
}
