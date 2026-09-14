/**
 * INSPECCIÓN AUTOMÁTICA de las carpetas del Inbox con el agente de estructura — DE SERIE.
 *
 * Antes de clasificar una carpeta de la RAÍZ del Inbox, el vigilante llama a `prepararCarpeta`. Si la carpeta es
 * COMPLEJA, el agente interpreta su árbol (qué es cada carpeta y qué contiene) y deja sus `_guia.json`; la
 * clasificación de ese mismo escaneo ya las obedece. Es lo mismo que hace a mano
 * `node scripts/inspeccionar-estructura.js <ruta> --escribir`, pero sin tener que acordarse.
 *
 * POR QUÉ: una llamada bien alimentada por árbol ahorra muchas llamadas ciegas documento a documento, y sobre todo
 * evita los errores de las reglas planas («carpeta con 2+ documentos = colección», detectores en cascada). Las
 * decisiones de diseño las fijó el usuario (14-sep-2026):
 *   · Solo carpetas COMPLEJAS: 2+ documentos distintos, subcarpetas, o mezcla de tipos (audio + PDF, ejecutables…).
 *     Un libro suelto con su portada no gasta IA: las reglas ya aciertan ahí.
 *   · Si la IA NO responde: la carpeta ESPERA en el Inbox (las demás siguen) y se reintenta cada
 *     INSPECCION_IA_REINTENTO_MIN; pasadas INSPECCION_IA_ESPERA_MAX_H sin IA, se ingiere con las reglas de siempre.
 *   · Lo DUDOSO (confianza baja) no se escribe: esa parte se cataloga con las reglas de siempre y queda anotada.
 *
 * MEMORIA: la marca `.inspeccion-ia.json` en la raíz de la carpeta dice que ya se inspeccionó (o cuándo toca
 * reintentar) y guarda su árbol de carpetas. Empieza por «.», así que el vigilante y el agente la ignoran como
 * contenido. Si luego aparecen CARPETAS NUEVAS, a cualquier profundidad (un buzón de colección que sigue
 * recibiendo), se reinspecciona: las guías del usuario se respetan siempre y las del agente se actualizan. Lo que
 * aparece dentro de una unidad o ya trae guía no cuenta (ver carpetasNuevas).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { esqueletoArbol, interpretarEstructura } from './agente-estructura.js';
import { planGuias, escribirGuias } from './guias-estructura.js';
import { afinarPlan } from './afinar-guias.js';
import { leerGuia, guiaEsSignificativa } from './guia-ingesta.js';
import { inspeccionIAActiva } from './ajustes-ingesta.js';

export const MARCA_INSPECCION = '.inspeccion-ia.json';
const VERSION_MARCA = 1;

const minutos = (n) => n * 60 * 1000;
const reintentoMs = () => minutos(Number(process.env.INSPECCION_IA_REINTENTO_MIN) || 15);
const esperaMaxMs = () => minutos(60 * (Number(process.env.INSPECCION_IA_ESPERA_MAX_H) || 6));

// ─── ¿Es compleja? ──────────────────────────────────────────────────────────────────────────────────────

const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.djv', '.cbz', '.cbr', '.cb7', '.chm', '.doc', '.docx', '.fb2', '.rtf']);
const EXT_IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp', '.heic']);
const EXT_AUDIO = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.opus', '.wav', '.aac', '.aax', '.aa', '.wma']);
const EXT_VIDEO = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.m4v', '.wmv', '.mpg', '.mpeg']);
const EXT_SOFTWARE = new Set(['.exe', '.msi', '.dll', '.iso', '.dmg', '.apk', '.app', '.bin', '.cab', '.ipa', '.jar', '.nrg', '.mdf', '.cue']);
// Acompañantes que llegan con cualquier descarga y NO cambian qué es la carpeta: contarlos como «otro tipo» haría
// complejo un simple «libro.pdf + libro.txt» y gastaría una llamada para nada.
const EXT_RUIDO = new Set(['.txt', '.url', '.nfo', '.ini', '.db', '.lnk', '.sfv', '.md5', '.log', '.opf', '.torrent', '.htm', '.html', '.json', '.xml']);
// Subcarpetas de portadas: tampoco hacen compleja una carpeta (la regla del vigilante ya las trata como portadas).
const SUB_PORTADAS = /^(covers?|portadas?|cubiertas?|artwork|scans?)$/i;
const esAccesorio = (n) => n.startsWith('.') || n.startsWith('_') || n.startsWith('@') || n.startsWith('#') || /^(thumbs\.db|desktop\.ini)$/i.test(n);

/**
 * Evalúa, sin abrir ningún fichero, si la carpeta merece la inspección con IA. Recorrido acotado: se para en
 * cuanto sabe que es compleja.
 * @returns {Promise<{compleja:boolean, motivo:string}>}
 */
export async function evaluarComplejidad(dir) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return { compleja: false, motivo: 'ilegible' }; }

    const subUtiles = entradas.filter((e) => e.isDirectory() && !esAccesorio(e.name) && !SUB_PORTADAS.test(e.name));
    if (subUtiles.length) return { compleja: true, motivo: `${subUtiles.length} subcarpeta(s)` };

    const bases = new Set();
    const tipos = new Set();
    for (const e of entradas) {
        if (!e.isFile() || esAccesorio(e.name)) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (EXT_DOC.has(ext)) { tipos.add('documentos'); bases.add(path.basename(e.name, ext).trim().toLowerCase()); }
        else if (EXT_AUDIO.has(ext)) tipos.add('audio');
        else if (EXT_VIDEO.has(ext)) tipos.add('vídeo');
        else if (EXT_SOFTWARE.has(ext)) return { compleja: true, motivo: `software («${e.name}»)` };
        else if (!EXT_IMG.has(ext) && !EXT_RUIDO.has(ext)) tipos.add('otros ficheros');
    }
    // «libro.pdf» + «libro.epub» es UN libro en dos formatos: la regla multiformato ya lo resuelve.
    if (bases.size >= 2) return { compleja: true, motivo: `${bases.size} documentos distintos` };
    if (tipos.size >= 2) return { compleja: true, motivo: `mezcla: ${[...tipos].join(' + ')}` };
    return { compleja: false, motivo: 'simple' };
}

// ─── Marca ──────────────────────────────────────────────────────────────────────────────────────────────

async function leerMarca(dir) {
    try { return JSON.parse(await fs.readFile(path.join(dir, MARCA_INSPECCION), 'utf8')); } catch { return null; }
}
async function escribirMarca(dir, datos) {
    try { await fs.writeFile(path.join(dir, MARCA_INSPECCION), JSON.stringify({ version: VERSION_MARCA, ...datos }, null, 2), 'utf8'); }
    catch (e) { console.warn(`   ⚠️  no se pudo escribir la marca de inspección en «${path.basename(dir)}»: ${e.message}`); }
}

/** Subcarpetas de PRIMER nivel. Solo para las marcas antiguas, que no guardaban el árbol entero. */
async function subcarpetasNivel1(dir) {
    try {
        return (await fs.readdir(dir, { withFileTypes: true }))
            .filter((e) => e.isDirectory() && !esAccesorio(e.name) && !SUB_PORTADAS.test(e.name)).map((e) => e.name).sort();
    } catch { return []; }
}

/**
 * TODAS las carpetas del árbol (rutas relativas «a», «a/b»), solo con readdir: lo que se guarda en la marca y se
 * compara después para saber si ha llegado algo NUEVO, esté a la profundidad que esté. Acotado (profundidad 8,
 * como el vigilante; tope de 3000) porque se consulta en cada escaneo mientras la carpeta siga en el Inbox.
 */
export async function carpetasDelArbol(dir, { profundidad = 8, max = 3000 } = {}) {
    const out = [];
    const cola = [{ abs: dir, rel: '', nivel: 0 }];
    while (cola.length && out.length < max) {
        const { abs, rel, nivel } = cola.shift();
        if (nivel >= profundidad) continue;
        let ents;
        try { ents = await fs.readdir(abs, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (!e.isDirectory() || esAccesorio(e.name) || SUB_PORTADAS.test(e.name)) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            out.push(r);
            cola.push({ abs: path.join(abs, e.name), rel: r, nivel: nivel + 1 });
        }
    }
    return out.sort();
}

// Acciones de guía que hacen de una carpeta UNA cosa que se ingiere entera (o que no se toca): lo que aparezca
// DENTRO es parte de ella, no algo nuevo que interpretar. Incluye lo que el propio vigilante crea al procesar —
// la «Desglose/» de un libro cosido, la subcarpeta de un libro con sus adjuntos—, que si no dispararía una
// reinspección por su propia culpa.
const ACCIONES_UNIDAD = new Set(['obra', 'software', 'libro-material', 'intacta', 'empaquetar', 'omitir',
    'audiolibro', 'coleccion-audiolibros', 'transmedia', 'desglose']);

/** ¿Esta carpeta nueva merece interpretación? No si ya tiene guía propia, ni si está dentro de una unidad. */
async function esNuevaQueInterpretar(dir, rel) {
    const partes = rel.split('/');
    for (let i = partes.length; i >= 0; i--) {
        const g = await leerGuia(path.join(dir, ...partes.slice(0, i)));
        if (!g) continue;
        if (ACCIONES_UNIDAD.has(g.accion)) return false;          // ella o una antecesora es una unidad
        if (i === partes.length && guiaEsSignificativa(g)) return false;   // ya guiada (por ti o por el agente)
    }
    return true;
}

/** Carpetas que han llegado desde la última inspección y merecen interpretarse. */
async function carpetasNuevas(dir, marca) {
    // Marca ANTIGUA (sin el árbol entero): se compara solo el primer nivel, como entonces. Si no, todas las
    // carpetas de más abajo parecerían nuevas y se reinspeccionaría todo lo ya inspeccionado.
    if (!Array.isArray(marca.carpetas)) {
        const conocidas = new Set(marca.subcarpetas || []);
        return (await subcarpetasNivel1(dir)).filter((s) => !conocidas.has(s));
    }
    const conocidas = new Set(marca.carpetas);
    const nuevas = [];
    for (const rel of await carpetasDelArbol(dir)) {
        if (conocidas.has(rel)) continue;
        if (await esNuevaQueInterpretar(dir, rel)) nuevas.push(rel);
    }
    return nuevas;
}

// ─── Flujo ──────────────────────────────────────────────────────────────────────────────────────────────

const avisadasManual = new Set();   // carpetas guiadas a mano: se avisa UNA vez, no en cada escaneo

/**
 * Prepara UNA carpeta de la raíz del Inbox antes de clasificarla.
 * @returns {Promise<{seguir:boolean}>} seguir=false → ESPERAR (la IA falló y aún no toca reintentar).
 */
export async function prepararCarpeta(dir) {
    if (!inspeccionIAActiva()) return { seguir: true };
    const nombre = path.basename(dir);
    const marca = await leerMarca(dir);

    // Ya inspeccionada (o agotada la espera): solo se repite si han llegado carpetas NUEVAS, a cualquier profundidad.
    if (marca && (marca.estado === 'hecha' || marca.estado === 'agotada')) {
        const nuevas = await carpetasNuevas(dir, marca);
        if (!nuevas.length) return { seguir: true };
        console.log(`  🧭 «${nombre}»: ${nuevas.length} carpeta(s) nueva(s) desde la última inspección `
            + `(${nuevas.slice(0, 3).join(', ')}${nuevas.length > 3 ? '…' : ''}) → se reinspecciona.`);
    }

    // Falló antes: esperar al próximo intento, o rendirse pasado el tope (y seguir con las reglas).
    if (marca?.estado === 'fallida') {
        const desde = Date.parse(marca.primer_intento) || Date.now();
        if (Date.now() - desde >= esperaMaxMs()) {
            await escribirMarca(dir, { ...marca, estado: 'agotada', fecha: new Date().toISOString(), carpetas: await carpetasDelArbol(dir) });
            console.warn(`  🧭 «${nombre}»: ${marca.intentos} intento(s) sin IA en ${Math.round((Date.now() - desde) / 3600000)} h → se ingiere con las reglas de siempre.`);
            return { seguir: true };
        }
        if (Date.now() < (Date.parse(marca.proximo) || 0)) return { seguir: false };
    }

    // Guiada A MANO en su raíz (Inspector): manda el usuario y no se gasta IA.
    const guia = await leerGuia(dir);
    if (guia && guiaEsSignificativa(guia) && guia.perfil?.origen !== 'agente') {
        if (!avisadasManual.has(dir)) { avisadasManual.add(dir); console.log(`  🧭 «${nombre}»: guiada a mano → sin inspección con IA.`); }
        return { seguir: true };
    }

    const cx = await evaluarComplejidad(dir);
    if (!cx.compleja) return { seguir: true };

    return inspeccionar(dir, marca, cx.motivo);
}

async function inspeccionar(dir, marcaPrevia, motivo) {
    const nombre = path.basename(dir);
    const t0 = Date.now();
    console.log(`  🧭 «${nombre}»: carpeta compleja (${motivo}) → inspección con IA antes de ingerir…`);
    try {
        const esq = await esqueletoArbol(dir);
        // Un solo reintento corto (un corte de red momentáneo): lo demás lo cubre el reintento de fondo.
        const r = await interpretarEstructura(esq, { esperasReintento: [10000] });
        // Una interpretación INCOMPLETA no se aplica: guiar la mitad del árbol y dejar la otra a las reglas daría
        // un resultado incoherente (la madre como serie, sus hijas como colecciones sueltas). Se reintenta entera.
        if (r.fallidas?.length) throw new Error(r.aviso || 'la IA no interpretó todas las carpetas');

        const plan = await planGuias(dir, esq, r, { incluirDudosas: false });
        const notas = await afinarPlan(plan, esq);
        const escritas = await escribirGuias(plan);

        const dudosas = plan.filter((p) => p.estado === 'dudosa').map((p) => ({ ruta: p.ruta, tipo: p.tipo, contenido: p.contenido, motivo: p.motivo }));
        const porClase = {};
        for (const p of plan.filter((q) => q.estado === 'nueva' || q.estado === 'actualizar')) {
            const k = p.contenido && p.contenido !== 'libros' ? p.contenido : p.tipo;
            porClase[k] = (porClase[k] || 0) + 1;
        }
        await escribirMarca(dir, {
            estado: 'hecha',
            fecha: new Date().toISOString(),
            segundos: Math.round((Date.now() - t0) / 1000),
            llamadas: r.llamadas,
            carpetas: esq.carpetas.length,
            recortado: !!esq.recortado,
            guias_escritas: escritas,
            por_clase: porClase,
            dudosas,
            notas,
            raiz: r.carpetas.find((c) => c.ruta === '.') || null,
            sin_ver: esq.sin_ver || 0,
            // El árbol ENTERO tal como estaba (no solo lo que vio la IA): así, una carpeta que llegue después a
            // cualquier profundidad se reconoce como nueva. Las que quedaron fuera por el tope no cuentan como
            // nuevas: ya se sabía que existían y van por las reglas con las guías heredadas.
            carpetas: await carpetasDelArbol(dir),
        });
        const resumen = Object.entries(porClase).map(([k, n]) => `${n} ${k}`).join(', ') || 'ninguna';
        console.log(`  🧭 «${nombre}»: inspeccionada en ${Math.round((Date.now() - t0) / 1000)} s (${r.llamadas} llamada(s), ${esq.carpetas.length} carpetas). Guías: ${resumen}.`);
        if (esq.recortado) {
            console.warn(`     · árbol RECORTADO: la IA vio ${esq.carpetas.length} carpetas${esq.sin_ver ? ` y quedan al menos ${esq.sin_ver} más` : ''}`
                + ' (por profundidad o por el tope). Lo que no vio va por las reglas, heredando las guías de arriba.');
        }
        for (const n of notas) console.log(`     · ${n}`);
        if (dudosas.length) console.log(`     · ${dudosas.length} carpeta(s) dudosa(s) → reglas de siempre: ${dudosas.slice(0, 5).map((d) => d.ruta).join(', ')}${dudosas.length > 5 ? '…' : ''}`);
        return { seguir: true };
    } catch (e) {
        const ahora = new Date();
        const intentos = (marcaPrevia?.estado === 'fallida' ? marcaPrevia.intentos || 0 : 0) + 1;
        const primer = marcaPrevia?.estado === 'fallida' && marcaPrevia.primer_intento ? marcaPrevia.primer_intento : ahora.toISOString();
        const proximo = new Date(ahora.getTime() + reintentoMs());
        await escribirMarca(dir, {
            estado: 'fallida', intentos, primer_intento: primer, proximo: proximo.toISOString(),
            motivo: String(e.message).slice(0, 300),
        });
        const limite = new Date((Date.parse(primer) || ahora.getTime()) + esperaMaxMs());
        console.warn(`  🧭 «${nombre}»: la IA no pudo inspeccionarla (${String(e.message).slice(0, 120)}). ESPERA en el Inbox; `
            + `reintento a las ${proximo.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} `
            + `(si sigue sin IA a las ${limite.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}, se ingiere con las reglas).`);
        return { seguir: false };
    }
}
