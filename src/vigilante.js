import './utils/consola-timestamp.js'; // marca de tiempo en todos los logs (debe ir lo primero)
import 'dotenv/config';
import './config.js';                  // ajustes por defecto (env > config); debe ir tras dotenv
import axios from 'axios';
// Timeout global para TODA llamada HTTP (ver app.js): evita que una API que no responde
// cuelgue el procesado del Inbox. Necesario también aquí por si se ejecuta en solitario.
axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS || 20000);
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestarRecurso } from './servicio-ingesta.js';
import { agrupar, esImagen, filtrarDuplicadosNombre } from './utils/agrupador.js';
import { discriminarMultivolumenes } from './utils/multivolumen.js';
import { extraerArchivoComic as extraerComprimido } from './utils/extraer-archivo.js';
import { reciclar, reciclarCarpeta } from './utils/papelera.js';
import { esCarpetaTransmedia, esTransmediaFuerte, ingestarTransmedia, ingestarSoftware, ingestarIntacta, ingestarLibroConMaterial } from './utils/transmedia.js';
import { esCarpetaAudiolibro, ingestarAudiolibro } from './utils/audiolibro.js';
import { esColeccionAudiolibros, ingestarColeccionAudiolibros } from './utils/coleccion-audiolibros.js';
import { esAudio } from './utils/lector-audio.js'; // FUENTE ÚNICA de extensiones de audio (ampliada: Audible .aax/.aa, etc.)
import { leerGuia, escribirGuia, aplicarPerfilAContexto, guiaEsSignificativa, NOMBRE_GUIA } from './utils/guia-ingesta.js';
import { conectarDB } from './database.js';
import { enviarACuarentena, enviarAReintentos, enviarAIlegibles } from './gestor-fallos.js';
import { ejecutarMantenimiento } from './mantenimiento/conformador.js';
import { rellenarDescripcionesFaltantes } from './mantenimiento/backfill-descripciones.js';
import { ejecutarCampanasDebidas, ejecutarCampana, leerAjustesCampanas, etiquetaCampana, campanaEnCurso } from './mantenimiento/campanas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

export const INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const PAUSA_MS = Number(process.env.PAUSA_INGESTA_MS || 1500);   // ritmo entre recursos (no saturar APIs)
const REPOSO_MS = Number(process.env.REPOSO_INBOX_MS || 2500);   // espera tras el último cambio antes de procesar
const ESTABILIDAD_MS    = Number(process.env.VIGILANTE_ESTABILIDAD_MS || 1500); // ventana para confirmar que un archivo terminó de escribirse
// Ventana de estabilidad de una CARPETA-drop entera: una carpeta grande (un transmedia de miles de ficheros /
// GB) tarda MINUTOS en copiarse y su copia tiene PAUSAS (red/SMB, creación de subcarpetas). No se procesa
// hasta que su HUELLA (nº de ficheros + bytes) no cambia durante esta ventana — generosa a propósito para no
// confundir una pausa con el fin de la copia. Bájala/súbela con VIGILANTE_CARPETA_ESTABLE_MS (ms). Aunque se
// disparara antes de tiempo, la ingesta lo detecta (la copia al CDU no cuadra) y CONSERVA el origen.
const CARPETA_ESTABLE_MS = Number(process.env.VIGILANTE_CARPETA_ESTABLE_MS || 45000);
const HUERFANO_TIMEOUT_MS = Number(process.env.INBOX_HUERFANO_MS || 600000);  // 10 min a 0 bytes → fantasma
const EXT_VALIDAS = ['.epub', '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.mobi', '.azw', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.chm', '.docx', '.doc', '.zip', '.rar', '.7z', '.iso'];
// Ubicación por defecto para libros/revistas físicos llegados por Inbox (sin POST que la fije).
const UBICACION_INBOX = { ambito: 'Sin asignar', estanteria: 'Sin asignar (Inbox)' };

// Mantenimiento (Conformador): proceso durmiente que, tras un periodo de inactividad del Inbox,
// repasa la base de datos y conforma los documentos (portadas, nombres, sidecars...). Cede
// siempre a la ingesta.
//
// Modos (cambiables en caliente vía API):
//   'diferido'     — auto, tras MANTENIMIENTO_REPOSO_MS de inactividad del Inbox (por defecto)
//   'apagado'      — desactivado hasta cambio manual
//   'apagado-hasta'— desactivado hasta conformadorApagadoHasta (ms epoch), luego vuelve a 'diferido'
//
// El disparo inmediato se hace con POST /api/mantenimiento (ya existía; no es un "modo" persistente).
// MANTENIMIENTO_ACTIVO=0 en .env arranca en modo 'apagado'.
const MANTENIMIENTO_REPOSO_MS = Number(process.env.MANTENIMIENTO_REPOSO_MS || 300000); // 5 min de Inbox inactivo

let temporizador = null;
let procesando = false;              // lock compartido: ingesta Y mantenimiento (nunca solapan)
let actividadActual = null;          // etiqueta legible de QUÉ tiene el lock (para el panel y el «ocupado»)
let mantManualEnCurso = false;       // bucle de mantenimiento manual en marcha (rondas paginadas)
// Arranca PAUSADO por defecto: observa el Inbox pero NO cataloga hasta activarlo desde el Panel de
// Control. VIGILANTE_AUTOSTART=1 lo arranca ya activo (comportamiento anterior).
let vigilanteActivo = process.env.VIGILANTE_AUTOSTART === '1'; // pausa/reanuda el procesado del Inbox (panel)
// ruta → timestamp (ms) de la primera vez que se vio el archivo con 0 bytes.
// Si supera HUERFANO_TIMEOUT_MS el archivo se trata como transferencia fallida y va a Cuarentena.
const huerfanosVistos = new Map();
let ultimaActividad = Date.now();    // último momento con actividad de ingesta
let ultimaRevisionMant = 0;          // última pasada de mantenimiento
// Carpetas-buzón de primer nivel que se DISUELVEN (se eliminan) cuando quedan vacías: obras
// multivolumen (finitas, se vacían al catalogar el último tomo), carpetas de UN solo documento y
// carpetas de imágenes (libro escaneado). NO se añaden las COLECCIONES (2+ documentos distintos),
// que persisten como buzón al que se siguen añadiendo números.
const dropsADisolver = new Set();

// --- Estado del Conformador ---
// El mantenimiento NO corre automáticamente al quedar el Inbox inactivo: se dispara A MANO con
// POST /api/mantenimiento (activar/intervalo). El modo 'diferido' (auto al reposo) es OPT-IN
// (MANTENIMIENTO_ACTIVO=1); por defecto queda 'apagado'.
let modoConformador = (process.env.MANTENIMIENTO_ACTIVO === '1') ? 'diferido' : 'apagado';
let conformadorApagadoHasta = null;  // ms epoch; solo para modo 'apagado-hasta'
let conformadorDormido = false;      // true cuando la cola está vacía; evita polls innecesarios a Mongo
let pararMantManual = false;         // señal de STOP del bucle de mantenimiento manual (modo=apagado)

const esValida = (f) => EXT_VALIDAS.includes(path.extname(f).toLowerCase());

// Portada pre-extraída opcional: junto al documento (Book.jpg), o en una subcarpeta "covers"/
// "Covers" (la del drop o la del propio documento). Se ofrece como CANDIDATA a resolverPortada
// (compite por tamaño con la embebida/remota/rasterizada).
const EXT_PORTADA = ['.jpg', '.jpeg', '.png', '.webp'];

// Entradas que NO cuentan como contenido real (metadatos de Synology, ocultos).
const soloMetadatos = (n) => n.startsWith('@') || n.startsWith('#') || n.startsWith('.');
// Una entrada es "basura" en el Inbox si NO es un documento/imagen CATALOGABLE: metadatos de Synology y
// ocultos (@eaDir, #recycle, .*), y sidecars/accesorios (.meta.json, .txt, .url, .nfo…). Una carpeta cuyo
// contenido restante es TODO basura ya no tiene nada que catalogar → se disuelve CON su basura dentro (así
// el Inbox no se congestiona con carpetas de reprocesado, sidecars y .txt tras verificar el documento).
const soloBasura = (n) => soloMetadatos(n) || !esValida(n);

// CONTENIDO CONSERVABLE: material que el catalogador NO puede procesar todavía pero que NO debe borrarse
// (audio → audiolibros, aún sin tratamiento). El recolector de basura lo RESPETA y su carpeta se marca con
// un testigo .noborrar. (Ampliable a otros formatos cuando toque.)
const esConservable = (n) => esAudio(n); // `esAudio` importado de lector-audio.js (fuente única, ampliada)

// TESTIGO .noborrar: fichero que el usuario/vigilante deposita en la carpeta de PRIMER NIVEL de un drop con
// material no procesable (DRM, audio, formato desconocido) para que el recolector de basura NO la borre.
const TESTIGO = '.noborrar';
const tieneTestigo = (carpeta) => fs.access(path.join(carpeta, TESTIGO)).then(() => true).catch(() => false);
async function depositarTestigo(carpeta, motivo) {
    if (!carpeta || await tieneTestigo(carpeta)) return false;
    const txt = `Esta carpeta contiene material que el catalogador NO puede procesar todavía (${motivo}).\n`
        + `Se DEJA intacta a propósito; el recolector de basura la respeta por la presencia de este fichero.\n`
        + `Bórralo si quieres que se vuelva a intentar / se pueda limpiar.\n`;
    await fs.writeFile(path.join(carpeta, TESTIGO), txt, 'utf8').catch(() => {});
    return true;
}
// ¿La carpeta (o alguna subcarpeta) contiene material conservable? (recursivo, con tope de profundidad).
async function carpetaConservable(dir, nivel = 8) {
    if (nivel < 0) return false;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entradas) {
        if (e.isFile() && esConservable(e.name)) return true;
        if (e.isDirectory() && !soloMetadatos(e.name) && await carpetaConservable(path.join(dir, e.name), nivel - 1)) return true;
    }
    return false;
}
// Ficheros omitidos (DRM/formato) YA vistos, para no reintentar leerlos en cada escaneo (se dejan en el
// Inbox pero no se reprocesan). En memoria (por sesión); el testigo .noborrar persiste en disco.
const _omitidos = new Set();

/** Subcarpeta "covers"/"Covers" (insensible a mayúsculas) dentro de 'carpeta', o null. */
async function subcarpetaCovers(carpeta) {
    try {
        const entradas = await fs.readdir(carpeta, { withFileTypes: true });
        const c = entradas.find(e => e.isDirectory() && /^covers$/i.test(e.name));
        return c ? path.join(carpeta, c.name) : null;
    } catch { return null; }
}

/** Directorios donde puede vivir la portada de un documento: subiendo desde su carpeta hasta la
 *  raíz del drop, en cada nivel el propio dir y su subcarpeta Covers/ (insensible a mayúsculas). */
async function dirsCandidatosPortada(carpetaTop, ficheroRuta) {
    const topAbs = path.resolve(carpetaTop);
    const dirs = [];
    let d = path.dirname(ficheroRuta);
    for (let i = 0; i < 12; i++) {
        dirs.push(d);
        const cov = await subcarpetaCovers(d);
        if (cov) dirs.push(cov);
        if (path.resolve(d) === topAbs) break;
        const padre = path.dirname(d);
        if (padre === d) break; // raíz del sistema de ficheros
        d = padre;
    }
    return dirs;
}

async function buscarPortadaPreextraida(carpetaTop, ficheroRuta) {
    if (!carpetaTop) return null;
    const base = path.basename(ficheroRuta, path.extname(ficheroRuta));
    for (const dir of await dirsCandidatosPortada(carpetaTop, ficheroRuta)) {
        for (const ext of EXT_PORTADA) {
            const p = path.join(dir, base + ext);
            if (await fs.access(p).then(() => true).catch(() => false)) return p; // gana la más cercana
        }
    }
    return null;
}

/** Rutas de TODAS las portadas candidatas EXISTENTES de un documento (para reciclarlas tras catalogarlo). */
async function rutasPortadasCandidatas(carpetaTop, ficheroRuta) {
    if (!carpetaTop) return [];
    const out = [];
    const base = path.basename(ficheroRuta, path.extname(ficheroRuta));
    for (const dir of await dirsCandidatosPortada(carpetaTop, ficheroRuta)) {
        for (const ext of EXT_PORTADA) {
            const p = path.join(dir, base + ext);
            if (await fs.access(p).then(() => true).catch(() => false)) out.push(p);
        }
    }
    return out;
}

/** Poda (bottom-up) las SUBcarpetas de 'top' que quedaron vacías o solo con basura. No toca 'top' aquí; la
 *  retirada de la carpeta de primer nivel (cuando ya no queda nada que catalogar) la hace podarVaciosInbox. */
async function podarSubcarpetasVacias(top) {
    let entradas;
    try { entradas = await fs.readdir(top, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isDirectory() || soloMetadatos(e.name)) continue;
        const sub = path.join(top, e.name);
        await podarSubcarpetasVacias(sub); // primero las anidadas
        let restantes; try { restantes = await fs.readdir(sub); } catch { continue; }
        // No borrar si queda material CONSERVABLE (audio…) —a cualquier profundidad— o hay un testigo .noborrar.
        if (restantes.every(soloBasura) && !restantes.includes(TESTIGO) && !(await carpetaConservable(sub)))
            await fs.rm(sub, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Tras una pasada: poda subcarpetas vacías y, si la carpeta de PRIMER NIVEL ya no tiene NADA que catalogar,
 * la RETIRA del Inbox. NUEVA DIRECTIVA: las carpetas-colección YA NO se conservan como buzón vacío — se
 * borran cuando quedan vacías, con solo basura evidente (metadatos, sidecars _guia.json/.txt/.url, thumbs.db)
 * o con subcarpetas a su vez vacías. Se conservan SOLO mientras quede un documento no trivial (o material
 * conservable / testigo .noborrar). Para RE-añadir a una colección basta re-soltar una carpeta con su nombre
 * (listarUnidades la re-liga por coleccionExiste).
 */
async function podarVaciosInbox() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isDirectory() || ignorarEntrada(e.name)) continue;
        const top = path.join(INBOX, e.name);
        if (await tieneTestigo(top)) continue;          // protegida por .noborrar: no se toca
        await podarSubcarpetasVacias(top);              // primero las subcarpetas vacías (más adentro)
        if (await nadaQueCatalogar(top)) {              // ya no queda nada catalogable → retirar la carpeta top
            // A la PAPELERA, no `fs.rm`: aunque el criterio diga «solo basura», borrar PERMANENTEMENTE una
            // carpeta del Inbox contradice la política de no perder nada — si el criterio se equivocara alguna
            // vez, se iría sin dejar rastro y sin vuelta atrás. Reciclada es recuperable y cuesta lo mismo.
            await reciclarCarpeta(top, 'inbox-sin-nada-que-catalogar').catch(async () => {
                await fs.rm(top, { recursive: true, force: true }).catch(() => {});  // si la Papelera falla, no bloquear
            });
            console.log(`  🗑️  «${e.name}»: sin nada que catalogar (vacía / solo basura / subcarpetas vacías) → a la Papelera.`);
        }
    }
    await limpiarGuiaRaiz();
}

/**
 * Limpia el `_guia.json` de la RAÍZ del Inbox. Las guías de las subcarpetas se van con su carpeta al podarla,
 * pero la raíz NO se poda nunca (es el Inbox), así que su guía se quedaba para siempre — y con acciones por
 * fichero que apuntaban a ficheros YA catalogados/retirados: sidecar obsoleto contaminando un Inbox vacío.
 * Se retiran las entradas de `archivos` cuyo fichero ya no está y, si la guía se queda sin nada que guiar, se
 * borra. Si aún guía algo (una acción pendiente, un perfil), se conserva.
 */
async function limpiarGuiaRaiz() {
    const guia = await leerGuia(INBOX);
    if (!guia) return;
    let cambia = false;
    for (const nombre of Object.keys(guia.archivos || {})) {
        if (!(await rutaExiste(path.join(INBOX, nombre)))) { delete guia.archivos[nombre]; cambia = true; }
    }
    if (!guiaEsSignificativa(guia)) {
        await fs.rm(path.join(INBOX, NOMBRE_GUIA), { force: true }).catch(() => {});
        console.log(`  🧹 Inbox: «${NOMBRE_GUIA}» retirado (ya no guiaba nada).`);
        return;
    }
    if (cambia) await escribirGuia(INBOX, guia).catch(() => {});
}

/**
 * Deposita el testigo .noborrar en las carpetas de PRIMER NIVEL del Inbox que contienen material no
 * procesable (audio, y lo que quede de un fichero OMITIDO por DRM/formato), para que el recolector de basura
 * NO las borre y quede constancia visible de que se dejan a propósito. No toca la RAÍZ del Inbox.
 */
async function protegerConservables() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isDirectory() || ignorarEntrada(e.name)) continue;
        const top = path.join(INBOX, e.name);
        if (await tieneTestigo(top)) continue;
        if (await carpetaConservable(top)) {
            await depositarTestigo(top, 'audio u otro formato sin tratamiento');
            console.log(`  🛡️  «${e.name}»: material no procesable (audio/…) → protegida con ${TESTIGO} (no se borra).`);
        }
    }
}

/**
 * Disuelve (elimina) las carpetas-buzón de primer nivel marcadas en dropsADisolver que ya están
 * vacías: obras multivolumen completas, drops de UN solo documento y libros escaneados. A diferencia
 * de una colección —buzón que persiste para añadir números—, estas son finitas y su carpeta se retira
 * al vaciarse. Solo se borra si no queda ningún documento (solo metadatos de Synology @eaDir, etc.).
 */
async function disolverDropsVacios() {
    for (const carpeta of [...dropsADisolver]) {
        let restantes;
        try { restantes = await fs.readdir(carpeta); }
        catch { dropsADisolver.delete(carpeta); continue; } // ya no existe
        // No disolver si queda material CONSERVABLE (audio…) o hay un testigo .noborrar (se deja intacta).
        if (restantes.includes(TESTIGO) || await carpetaConservable(carpeta)) { dropsADisolver.delete(carpeta); continue; }
        if (restantes.every(soloBasura)) {
            await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
            dropsADisolver.delete(carpeta);
            console.log(`  🗑️  Carpeta vacía disuelta: «${path.basename(carpeta)}» retirada del Inbox.`);
        }
    }
}

/**
 * Documentos bibliográficos de un drop: TODOS los de la carpeta y sus subcarpetas a cualquier
 * profundidad, excluyendo cualquier carpeta "covers"/"Covers". Así, sea cual sea la estructura
 * interna, todos los documentos pertenecen a la colección = nombre de la carpeta del DROP:
 *   60 Revistas/ { Magazines/*.pdf, Covers/*.jpg }              → colección "60 Revistas"
 *   Mathematical Books Collection/ 20 Math books/ *.pdf         → se FUSIONA en "Mathematical…"
 * (cap de 8 niveles por seguridad; los symlinks no se siguen).
 */
async function recopilarDocumentos(dir, nivel = 8) {
    const out = [];
    if (nivel < 0) return out;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entradas) {
        if (ignorarEntrada(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isFile()) {
            if (esValida(e.name) && !esImagen(e.name)) out.push(p);
        } else if (e.isDirectory() && !/^covers$/i.test(e.name)) {
            out.push(...await recopilarDocumentos(p, nivel - 1));
        }
    }
    return out;
}

// ¿Queda alguna IMAGEN catalogable (recursivo)? Un libro escaneado es una carpeta de imágenes: no se retira
// mientras tenga imágenes sin procesar. (covers/ se ignora: son portadas, no contenido.)
async function tieneImagenes(dir, nivel = 8) {
    if (nivel < 0) return false;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entradas) {
        if (ignorarEntrada(e.name)) continue;
        if (e.isFile() && esImagen(e.name)) return true;
        if (e.isDirectory() && !/^covers$/i.test(e.name) && await tieneImagenes(path.join(dir, e.name), nivel - 1)) return true;
    }
    return false;
}

// NUEVA DIRECTIVA de limpieza: ¿la carpeta ya NO tiene NADA que catalogar (recursivo)? Es decir, ni un
// documento no trivial, ni imágenes, ni material conservable (audio). Solo queda BASURA (metadatos de
// Synology, ocultos, sidecars como _guia.json/.txt/.url, thumbs.db) y/o subcarpetas vacías. Antes las
// COLECCIONES se conservaban como buzón vacío; ahora se retiran en cuanto no queda nada que catalogar.
// (Comprobación RECURSIVA y por contenido —no por nombre— para nunca borrar una carpeta con documentos dentro.)
async function nadaQueCatalogar(dir) {
    if (await carpetaConservable(dir)) return false;            // audio u otro conservable
    if ((await recopilarDocumentos(dir)).length) return false; // documentos no triviales pendientes
    if (await tieneImagenes(dir)) return false;                // libro escaneado pendiente
    return true;
}

// Entradas a ignorar SIEMPRE en el Inbox: ocultos y carpetas de sistema de Synology
// (@eaDir con miniaturas/metadatos, @tmp, #recycle). Sin esto, @eaDir hace creer que el Inbox
// tiene contenido (bloquea el mantenimiento) y hasta intentaría catalogar sus miniaturas.
const ignorarEntrada = (nombre) => nombre.startsWith('.') || nombre.startsWith('@') || nombre.startsWith('#');

/** ¿Hay alguna unidad real de trabajo en el Inbox ahora mismo? (Misma lógica que listarUnidades.) */
async function inboxTieneArchivos() {
    return (await listarUnidades()).length > 0;
}

/** El mantenimiento solo CEDE el turno a la ingesta si el vigilante está ACTIVO. Si está PAUSADO, los
 *  ficheros del Inbox no se van a catalogar, así que el mantenimiento puede correr aunque los haya
 *  (ese es justo el caso de uso: pausar el vigilante para conformar el catálogo con el Inbox lleno). */
async function debeCederAIngesta() {
    return vigilanteActivo && await inboxTieneArchivos();
}

/**
 * Analiza el estado de escritura de una unidad del Inbox.
 *
 * Devuelve:
 *   'estable'    — tamaño > 0 y sin cambios: lista para procesar.
 *   'escribiendo'— tamaño 0 o aún cambiando: esperar el siguiente escaneo.
 *   'fantasma'   — lleva ≥ HUERFANO_TIMEOUT_MS con 0 bytes: transferencia fallida.
 *                  El llamante debe enviarla a Cuarentena y limpiar el Inbox.
 */
async function verificarEstabilidad(rutas) {
    const medir = () => Promise.all(rutas.map(r => fs.stat(r).then(s => s.size).catch(() => -1)));
    const a = await medir();

    if (a.some(s => s <= 0)) {
        // Registrar la primera vez que se ve el archivo a 0 bytes.
        const ahora = Date.now();
        for (const r of rutas) {
            if (!huerfanosVistos.has(r)) huerfanosVistos.set(r, ahora);
        }
        const primerVisto = Math.min(...rutas.map(r => huerfanosVistos.get(r) ?? ahora));
        if (ahora - primerVisto >= HUERFANO_TIMEOUT_MS) return 'fantasma';
        return 'escribiendo';
    }

    // Tamaño > 0: ya no es huérfano (la transferencia arrancó bien).
    for (const r of rutas) huerfanosVistos.delete(r);

    // Segunda medida para confirmar que el tamaño no está cambiando.
    await new Promise(res => setTimeout(res, ESTABILIDAD_MS));
    const b = await medir();
    return a.every((s, i) => s === b[i] && s > 0) ? 'estable' : 'escribiendo';
}

// ── Estabilidad de una CARPETA-drop completa (para drops grandes que tardan minutos) ────────────────────
// Firma anterior de cada carpeta del Inbox: `dir → { firma:'nFicheros:bytes', desde:epoch }`. Se compara
// entre escaneos para saber si la carpeta SIGUE creciendo (copiándose) o ya está QUIETA.
const huellaCarpetas = new Map();
// Carpetas ya detectadas como TRANSMEDIA (detección PEGAJOSA): una vez que una carpeta tiene audio, se trata
// SIEMPRE como transmedia aunque un escaneo posterior (copia a medias) no vea el audio todavía — así nunca
// cae por error a la vía normal (que fragmentaría el árbol). Se olvida cuando la carpeta desaparece del Inbox.
const transmediaVistas = new Set();
// Carpetas ya detectadas como AUDIOLIBRO puro (misma detección PEGAJOSA que transmedia): audio suelto sin
// estructura → 1 documento naturaleza:'audiolibro' (playlist + carrusel), no una colección.
const audiolibroVistas = new Set();
// Carpetas ya detectadas como COLECCIÓN de audiolibros (pegajoso): varios audiolibros → una colección con
// un doc por libro (+ PDFs/vídeos miembros). Se comprueba tras transmedia-fuerte y antes del audiolibro suelto.
const colAudioVistas = new Set();
// Carpetas que dieron un resultado DEFINITIVO de duplicado (transmedia «ya existe la colección», audiolibro
// «ya catalogado»): se DEJAN de reintentar para no entrar en bucle (se reprocesarían en cada escaneo). El
// origen se conserva en el Inbox (con .noborrar); el usuario decide qué hacer. Se olvida al desaparecer.
const omitidasDefinitivas = new Set();
// Carpetas con acción OMITIR en su _guia.json (para no repetir el log en cada escaneo). Se olvida al desaparecer.
const omitidasGuia = new Set();

/**
 * Huella de un árbol de carpeta: nº total de ficheros, bytes totales y el mtime MÁS RECIENTE. Recorre TODO
 * (pdf, mp3, covers, .txt…), no solo los documentos: así detecta que aún se están copiando audios o portadas.
 * Nunca lanza (ignora lo que desaparezca a media copia).
 */
async function huellaCarpeta(dir) {
    let nFicheros = 0, bytes = 0, maxMtime = 0;
    const pila = [dir];
    while (pila.length) {
        const actual = pila.pop();
        let entradas;
        try { entradas = await fs.readdir(actual, { withFileTypes: true }); } catch { continue; }
        for (const e of entradas) {
            if (ignorarEntrada(e.name)) continue;
            const p = path.join(actual, e.name);
            if (e.isDirectory()) { pila.push(p); continue; }
            try {
                const s = await fs.stat(p);
                nFicheros++;
                bytes += s.size;
                if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
            } catch { /* fichero desaparecido a media copia: se ignora */ }
        }
    }
    return { nFicheros, bytes, maxMtime };
}

/**
 * ¿La carpeta-drop TERMINÓ de copiarse? true si su huella (nº ficheros + bytes) lleva QUIETA al menos
 * CARPETA_ESTABLE_MS. Dos vías: (a) el fichero más nuevo ya es antiguo (nada se ha tocado en la ventana →
 * estable de inmediato, sin esperar otro escaneo); (b) la firma no cambia respecto al escaneo anterior
 * durante la ventana. Mientras la copia crece, la firma cambia y el reloj se reinicia → nunca se procesa a medias.
 */
async function carpetaEstable(dir) {
    const { nFicheros, bytes, maxMtime } = await huellaCarpeta(dir);
    if (nFicheros === 0) return false; // vacía / aún sin ficheros escritos
    const firma = `${nFicheros}:${bytes}`;
    const ahora = Date.now();
    // (a) Ya asentada: nada se tocó en la ventana → estable sin esperar otro escaneo.
    if (ahora - maxMtime >= CARPETA_ESTABLE_MS) { huellaCarpetas.set(dir, { firma, desde: maxMtime }); return true; }
    // (b) Comparar con el escaneo anterior: si la firma cambió, sigue copiándose (reinicia el reloj).
    const previo = huellaCarpetas.get(dir);
    if (!previo || previo.firma !== firma) { huellaCarpetas.set(dir, { firma, desde: ahora }); return false; }
    return ahora - previo.desde >= CARPETA_ESTABLE_MS;
}

/**
 * Construye las unidades de trabajo del Inbox:
 *   - cada subcarpeta se agrupa por su cuenta (imágenes juntas = un libro),
 *   - los archivos sueltos en la raíz: cada epub/pdf por su lado, todas las imágenes juntas.
 */
// ¿Existe ya una colección con ese NOMBRE? (case- y acento-insensible, igual que resolverCabecera).
// Permite tratar como colección una carpeta que coincide con una colección existente AUNQUE quede 1 solo
// documento dentro (p. ej. AÑADIR a una colección re-dropeando un libro en su carpeta). Best-effort.
async function coleccionExiste(nombre) {
    if (!nombre || !String(nombre).trim()) return false;
    try {
        const db = await conectarDB();
        const c = await db.collection('colecciones').findOne(
            { nombre: String(nombre).trim() },
            { collation: { locale: 'es', strength: 1 }, projection: { _id: 1 } });
        return !!c;
    } catch { return false; }
}

// ¿La carpeta `dir` tiene DESCENDIENTES con intención granular (una subcarpeta con guía significativa: acción
// ≠ normal, grupos, o un perfil con pistas)? Si es así, la carpeta NO debe ser tragada entera por la
// autodetección agresiva (colAudio/transmedia): se recurre en ella como un mini-Inbox. Recursivo y acotado.
async function tieneDescendientesGuiados(dir, nivel = 8) {
    if (nivel < 0) return false;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entradas) {
        if (!e.isDirectory() || ignorarEntrada(e.name)) continue;
        const sub = path.join(dir, e.name);
        if (guiaEsSignificativa(await leerGuia(sub))) return true;
        if (await tieneDescendientesGuiados(sub, nivel - 1)) return true;
    }
    return false;
}

async function listarUnidades() {
    const unidades = [];
    await clasificarDirectorio(INBOX, true, unidades);

    // Poda de las cachés por-carpeta: olvida las de PRIMER NIVEL que ya no están en el Inbox (procesadas/
    // retiradas), para que no crezcan sin fin. Una carpeta anidada (recurrida) no persiste su stickiness —
    // se re-evalúa en cada escaneo, lo cual es inocuo (la detección es determinista y, una vez catalogada,
    // desaparece del árbol).
    let dirs;
    try { dirs = (await fs.readdir(INBOX, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch { dirs = []; }
    const dirsActuales = new Set(dirs.map((e) => path.join(INBOX, e.name)));
    for (const dir of huellaCarpetas.keys()) if (!dirsActuales.has(dir)) huellaCarpetas.delete(dir);
    for (const dir of transmediaVistas) if (!dirsActuales.has(dir)) transmediaVistas.delete(dir);
    for (const dir of audiolibroVistas) if (!dirsActuales.has(dir)) audiolibroVistas.delete(dir);
    for (const dir of colAudioVistas) if (!dirsActuales.has(dir)) colAudioVistas.delete(dir);
    for (const dir of omitidasDefinitivas) if (!dirsActuales.has(dir)) omitidasDefinitivas.delete(dir);
    for (const dir of omitidasGuia) if (!dirsActuales.has(dir)) omitidasGuia.delete(dir);

    return unidades;
}

/**
 * Clasifica las entradas de UN directorio en unidades de trabajo. Se usa para el Inbox (esRaiz=true) y,
 * recursivamente, para una carpeta con intención granular dentro (esRaiz=false), tratada como un mini-Inbox:
 * cada hijo se detecta/guía por su cuenta en vez de ser tragado entero por la autodetección agresiva.
 */
async function clasificarDirectorio(dir, esRaiz, unidades) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    const sueltos = [];

    for (const e of entradas) {
        if (ignorarEntrada(e.name)) continue; // ocultos + carpetas de sistema (@eaDir, #recycle...)
        const ruta = path.join(dir, e.name);
        if (e.isDirectory()) {
            // En la RAÍZ del Inbox: no reintentar un duplicado definitivo (evita reprocesar la misma carpeta en
            // cada escaneo) y ESPERAR a que termine la copia (un drop grande de miles de ficheros tarda minutos;
            // a medias se trataría como colección/pdf incompleto). En una carpeta ya recurrida no hace falta: su
            // carpeta de primer nivel ya superó ambas comprobaciones antes de recurrir.
            if (esRaiz) {
                if (omitidasDefinitivas.has(ruta)) continue;
                if (!(await carpetaEstable(ruta))) {
                    console.log(`  ⏳ ${e.name}: carpeta aún copiándose — se espera a que termine (no se procesa a medias).`);
                    continue;
                }
            }
            // GUÍA de ingesta (_guia.json). aplanar/explotar ya se aplicaron en la pasada previa; aquí:
            //   · OMITIR  → NO catalogar nada de esta carpeta (se deja intacta en el Inbox).
            //   · INTACTA → conservar VERBATIM por la ruta transmedia (preserva la estructura + agrupa en colección).
            const guiaCarpeta = await leerGuia(ruta);
            if (guiaCarpeta?.accion === 'omitir') {
                if (!omitidasGuia.has(ruta)) { omitidasGuia.add(ruta); console.log(`  ⏭️  ${e.name}: OMITIR (guía) — no se cataloga.`); }
                continue;
            }
            if (guiaCarpeta?.accion === 'intacta') {
                // INTACTA = «esto es UNA COSA: consérvala íntegra y déjame un registro». NO es transmedia (eso
                // es una colección de ficheros de VARIOS tipos que se catalogan por separado). Enrutarla por
                // transmedia era el fallo del test 67: su análisis no cuenta las imágenes, así que una carpeta
                // de 142 páginas escaneadas salía con CERO documentos y quedaba invisible.
                unidades.push({ esIntacta: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            if (guiaCarpeta?.accion === 'software') {
                // Software (Libronix, etc.): categoría DEDICADA — se copia verbatim en BLOQUE y se cataloga
                // como UN registro naturaleza:'software' (ingestarSoftware). Su ficha lleva un explorador de
                // ficheros de solo lectura.
                unidades.push({ esSoftware: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            if (guiaCarpeta?.accion === 'libro-material') {
                // LIBRO + MATERIAL AUXILIAR: el documento principal se cataloga por el PIPELINE NORMAL
                // (tipo_recurso:'libro' de pleno derecho) y el material (código, datasets…) se conserva
                // verbatim junto a él (ruta_fija), visible en el explorador de la ficha. NO es transmedia.
                unidades.push({ esLibroMaterial: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            if (guiaCarpeta?.accion === 'obra') {
                // FORZAR obra multivolumen: TODOS los documentos de la carpeta son tomos de UNA obra cuyo
                // título es el nombre de la carpeta; el nº de tomo va por orden natural del nombre de fichero.
                const docsObra = filtrarDuplicadosNombre(await recopilarDocumentos(ruta))
                    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
                if (docsObra.length) {
                    dropsADisolver.add(ruta);
                    docsObra.forEach((d, i) => unidades.push({
                        rutas: [d], esImagenes: false, carpeta: ruta, conservarCarpeta: false, esObra: true,
                        obra: { titulo: e.name, numero: i + 1, titulo_volumen: path.basename(d, path.extname(d)), total: docsObra.length },
                    }));
                }
                continue;
            }
            // GRANULAR: la carpeta tiene DESCENDIENTES guiados (obra/software/audiolibro/perfil dentro) → se
            // trata como un mini-Inbox y se RECURRE, para NO dejar que la autodetección agresiva (transmedia /
            // colección de audiolibros) se trague todo el bloque e ignore las guías internas. Cada hijo se
            // detecta/guía por su cuenta (obra, software, audiolibro, colección, doc suelto…).
            if (await tieneDescendientesGuiados(ruta)) {
                dropsADisolver.add(ruta); // buzón que se disuelve al vaciarse (sus hijos se catalogan aparte)
                await clasificarDirectorio(ruta, false, unidades);
                continue;
            }
            // ENRUTADO POR PESO (audio vs PDF). Orden:
            // 1) TRANSMEDIA FUERTE: marcador .transmedia, contenido interactivo (CD-ROM) o estructura «Stage N»
            //    (lecturas graduadas) → el PDF/interactivo manda. Detección PEGAJOSA.
            if (transmediaVistas.has(ruta) || await esTransmediaFuerte(ruta)) {
                transmediaVistas.add(ruta);
                unidades.push({ esTransmedia: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            // 2) COLECCIÓN DE AUDIOLIBROS: varios audiolibros (autor→libro→parte, o carpeta plana con las obras
            //    en el nombre) → una colección con un doc por libro (+ PDFs/vídeos miembros). El audio manda,
            //    aunque haya PDFs de guía. Detección pegajosa.
            if (colAudioVistas.has(ruta) || await esColeccionAudiolibros(ruta)) {
                colAudioVistas.add(ruta);
                unidades.push({ esColeccionAudio: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            // 3) TRANSMEDIA DÉBIL: audio + ≥2 PDFs SIN estructura ni colección de audiolibros (lecturas con
            //    audio de apoyo). Se preserva verbatim como transmedia.
            if (await esCarpetaTransmedia(ruta)) {
                transmediaVistas.add(ruta);
                unidades.push({ esTransmedia: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            // 4) AUDIOLIBRO PURO: audio suelto (una sola obra, sin estructura de colección) → UN documento con
            //    playlist + carrusel. Detección pegajosa.
            if (audiolibroVistas.has(ruta) || await esCarpetaAudiolibro(ruta)) {
                audiolibroVistas.add(ruta);
                unidades.push({ esAudiolibro: true, carpeta: ruta, rutas: [ruta] });
                continue;
            }
            // Documentos del drop: directos o en subcarpetas (Books/, Magazines/…; se excluye
            // covers/). Las imágenes son PORTADAS (no libros), y .txt/.url/etc. se descartan. La
            // COLECCIÓN y la carpeta persistente son el nombre del DROP (carpeta superior).
            // 2+ docs = colección; 1 solo doc NO es colección (la carpeta se descarta).
            const documentos = filtrarDuplicadosNombre(await recopilarDocumentos(ruta));
            if (documentos.length > 0) {
                // OBRAS MULTIVOLUMEN: cada subcarpeta con tomos "Vol. N" es UNA obra independiente
                // (no se funden las distintas obras de un mismo drop). Sus ficheros son tomos ligados
                // a la obra (nombre de la carpeta), no una colección de libros sueltos.
                const { obras, resto } = discriminarMultivolumenes(documentos);
                for (const obra of obras) {
                    dropsADisolver.add(ruta); // drop de obra(s): la carpeta-buzón se elimina al vaciarse
                    for (const v of obra.volumenes) unidades.push({
                        rutas: [v.ruta], esImagenes: false, carpeta: ruta, conservarCarpeta: false, esObra: true,
                        obra: { titulo: obra.titulo_obra, numero: v.numero, titulo_volumen: v.titulo, total: obra.total },
                    });
                }
                // Resto (no son tomos). Tres casos:
                //   · 1 documento → suelto; la carpeta se DISUELVE (deflate) al vaciarse.
                //   · 2+ con el MISMO nombre base (Book.pdf/.epub/.mobi) = "mismo libro, varios
                //     formatos": un documento POR formato (la dedup por ISBN+formato los separa), NO es
                //     colección, la carpeta se disuelve y comparten portada (mismo nombre base).
                //   · 2+ con nombres base DISTINTOS = colección (la carpeta PERSISTE como buzón).
                if (resto.length > 0) {
                    const base = (p) => path.basename(p, path.extname(p)).trim().toLowerCase().replace(/\s+/g, ' ');
                    const multiFormato = resto.length >= 2 && new Set(resto.map(base)).size === 1;
                    // Colección si hay 2+ documentos DISTINTOS, O si el NOMBRE de la carpeta coincide con una
                    // colección YA EXISTENTE. Esto último arregla AÑADIR a una colección re-dropeando un libro
                    // en su carpeta aunque quede SOLO ese (caso atajo/gap-fill: el resto ya estaba catalogado).
                    let esColeccion = !multiFormato && resto.length >= 2;
                    if (!esColeccion && !multiFormato && await coleccionExiste(e.name)) esColeccion = true;
                    if (!esColeccion) dropsADisolver.add(ruta); // single-doc NUEVO o multi-formato → deflate
                    for (const d of resto) unidades.push({
                        rutas: [d], esImagenes: false, carpeta: ruta,
                        conservarCarpeta: esColeccion,
                        coleccion: esColeccion ? e.name : undefined,
                    });
                }
            } else {
                // Sin documentos: imágenes DIRECTAS en la carpeta = un libro escaneado. La carpeta se
                // DISUELVE al vaciarse (no es un buzón de colección).
                const imagenes = (await fs.readdir(ruta)).map(n => path.join(ruta, n)).filter(esImagen);
                if (imagenes.length > 0) {
                    dropsADisolver.add(ruta);
                    unidades.push({ rutas: filtrarDuplicadosNombre(imagenes), esImagenes: true, carpeta: ruta, conservarCarpeta: false });
                }
            }
        } else if (esValida(e.name) && !EXT_COMPRIMIDO.includes(path.extname(e.name).toLowerCase())) {
            // Un COMPRIMIDO suelto (.zip/.rar/.7z) NO se cataloga NUNCA como documento crudo: lo maneja EN
            // EXCLUSIVA expandirComprimidos (expandir → carpeta → drop). Si aún se está copiando, se saltó
            // allí y debe ESPERAR al próximo escaneo — sin esta guarda se colaba aquí como unidad y se
            // catalogaba como «fmt:zip» sin contenido (perdía el escaneo real). Caso de reprocesado.
            sueltos.push(ruta);
        }
    }
    // Sueltos de ESTE directorio. En la raíz: cada uno por su cuenta, sin carpeta. En una carpeta recurrida:
    // agrupados igual (imágenes juntas = un libro; docs por su cuenta), pero LIGADOS a la carpeta para poder
    // disolverla al vaciarse.
    for (const u of agrupar(sueltos)) unidades.push({ ...u, carpeta: esRaiz ? null : dir });
    if (!esRaiz && sueltos.length) dropsADisolver.add(dir);
}


export async function limpiarInbox(unidad, { borrarCatalogados = false } = {}) {
    // Limpieza del Inbox tras procesar una unidad. Por defecto, política "nunca borrar": se MUEVE
    // todo a la Papelera (Recycling) en una subcarpeta serializada. PERO si borrarCatalogados=true
    // (éxito VERIFICADO: copia íntegra en el árbol CDU + documento en Mongo), los originales ya
    // catalogados se BORRAN permanentemente —son redundantes y solo inflarían la Papelera—; sus
    // portadas candidatas y los sidecars NO bibliográficos sí van a la Papelera (red de seguridad
    // para lo accesorio/ambiguo). La CARPETA (buzón de primer nivel del Inbox) NUNCA se toca; las
    // subcarpetas vacías las poda podarVaciosInbox tras la pasada.
    const aReciclar = borrarCatalogados ? [] : [...unidad.rutas];
    if (unidad.carpeta) {
        for (const r of unidad.rutas) aReciclar.push(...await rutasPortadasCandidatas(unidad.carpeta, r));
        // Drop puntual (no colección): sidecars sueltos (.txt/.url…) de la raíz de la carpeta.
        // CRÍTICO: NUNCA reciclar un documento bibliográfico válido (.pdf/.epub/imagen). Una obra
        // multivolumen reparte N tomos VÁLIDOS en la MISMA carpeta y se catalogan en unidades
        // distintas: retirar "todo lo que no sea metadato" se llevaba los tomos 2..N aún sin
        // procesar al limpiar el tomo 1 (pérdida de datos). Solo extensiones NO bibliográficas.
        if (!unidad.conservarCarpeta) {
            let entradas; try { entradas = await fs.readdir(unidad.carpeta, { withFileTypes: true }); } catch { entradas = []; }
            for (const e of entradas) {
                // NUNCA reciclar material CONSERVABLE (audio…): se deja intacto (lo protege .noborrar).
                if (e.isFile() && !soloMetadatos(e.name) && !esValida(e.name) && !esConservable(e.name)) aReciclar.push(path.join(unidad.carpeta, e.name));
            }
        }
    }
    if (aReciclar.length) await reciclar(aReciclar, path.basename(unidad.rutas[0]));
    // Borrado permanente de los originales ya catalogados (su copia íntegra vive en el árbol CDU y
    // el documento en Mongo): redundantes → no se reciclan, se eliminan.
    if (borrarCatalogados) {
        for (const r of unidad.rutas) {
            await fs.chmod(r, 0o666).catch(() => {});
            await fs.rm(r, { force: true }).catch(() => {});
        }
    }
    // Sidecars de override (.meta.json) ya consumidos: el fichero que acompañaban abandona el Inbox,
    // así que se eliminan (son instrucciones, no datos) para no dejarlos huérfanos en la raíz.
    for (const r of unidad.rutas) {
        const sinExt = path.join(path.dirname(r), path.basename(r, path.extname(r)));
        for (const meta of [r + '.meta.json', sinExt + '.meta.json']) await fs.rm(meta, { force: true }).catch(() => {});
    }
}

async function procesarUnidad(unidad) {
    const etiqueta = `${path.basename(unidad.rutas[0])}${unidad.rutas.length > 1 ? ` (+${unidad.rutas.length - 1})` : ''}`;
    // Ya OMITIDO antes (DRM/formato): se dejó en el Inbox intacto; no reintentar leerlo en cada escaneo.
    if (unidad.rutas.every((r) => _omitidos.has(r))) return 'omitido';
    let contexto = unidad.esImagenes ? { ubicacion: UBICACION_INBOX } : {};
    // Drop por carpeta: ligar el recurso a la colección (nombre de carpeta) y autonumerar la serie.
    if (unidad.coleccion) { contexto.coleccion = unidad.coleccion; contexto.serieAuto = true; }
    if (unidad.obra) contexto.obra = unidad.obra; // tomo de obra multivolumen
    // PERFIL de ingesta: pistas del usuario en el `_guia.json` de la carpeta (sesga tipo/APIs/prompts, T4).
    // Solo rellena huecos; la colección/obra REAL del drop manda sobre la pista (ver aplicarPerfilAContexto).
    if (unidad.carpeta) {
        const guia = await leerGuia(unidad.carpeta);
        if (guia && Object.keys(guia.perfil).length) contexto = aplicarPerfilAContexto(contexto, guia.perfil);
    }
    // PISTA DE RUTA: los nombres de las carpetas contenedoras (p. ej. «PSEUDOCIENCIAS / BIBLIOTECA DE
    // RELIGION») orientan la MATERIA/CDU. Viaja como pista en el perfil → prompts de IA (y clasificador CDU);
    // la realidad (ISBN/Fichero/CIP) sigue mandando. Se captura al procesar, ANTES de que el fichero salga
    // del Inbox — así, aunque luego se aplane/explote la carpeta, la pista ya viajó con el documento.
    if (unidad.rutas[0]) {
        const rel = path.relative(INBOX, path.dirname(unidad.rutas[0]));
        if (rel && !rel.startsWith('..')) contexto.perfil = { ...(contexto.perfil || {}), materia_ruta: rel.split(path.sep).join(' / ') };
    }
    // Portada pre-extraída en covers/ (si existe): candidata para la resolución de portada.
    if (!unidad.esImagenes && unidad.carpeta) {
        const portadaLocal = await buscarPortadaPreextraida(unidad.carpeta, unidad.rutas[0]);
        if (portadaLocal) contexto.portadaLocal = portadaLocal;
    }
    try {
        const r = await ingestarRecurso({ rutas: unidad.rutas, contexto });
        // Duplicado: el servicio ya dispuso del fichero (reciclado si idéntico por hash, o a
        // Cuarentena/duplicados si el contenido difiere). No hay nada que copiar ni limpiar.
        if (r.duplicado) {
            // El servicio YA dispuso del fichero entrante; etiquetar por `accion` (no inventar Cuarentena):
            //   borrado/restaurado = duplicado IDÉNTICO por hash (ya NO está en el Inbox; NO es Cuarentena);
            //   cuarentena         = mismo identificador pero CONTENIDO distinto → Cuarentena/duplicados.
            const MAPA = {
                borrado:    ['♻️', 'idéntico (mismo hash) → borrado', 'reciclado'],
                restaurado: ['♻️', 'fichero ausente restaurado con el entrante', 'reciclado'],
                cuarentena: ['⚠️', 'contenido distinto → Cuarentena/duplicados', 'duplicado'],
            };
            const [ic, txt, cat] = MAPA[r.accion] || ['⚠️', `duplicado (${r.accion || '?'})`, 'duplicado'];
            console.log(`  ${ic}  ${etiqueta} → ${txt}; ya catalogado: ${r._id}.`);
            return cat;
        }
        console.log(`  ✅ ${etiqueta} → ${r.operacion} (${r.estado}) · ${r.rutaWeb}`);
        // SOLO se borra del Inbox si la copia al árbol CDU se verificó íntegra (tamaño origen ===
        // destino). Si no, se conserva el original para no perder datos; el próximo escaneo lo
        // reintentará (la copia es idempotente: sobrescribe el destino corrupto).
        if (r.copiaIntegra) {
            // Éxito VERIFICADO (copia íntegra en CDU + documento insertado en Mongo): el original del
            // Inbox es redundante → BORRADO PERMANENTE (no inflamos la Papelera con copias seguras).
            await limpiarInbox(unidad, { borrarCatalogados: !!r._id });
            return r.operacion === 'actualizacion' ? 'actualizado' : 'nuevo';
        } else {
            console.error(`  ⛔ ${etiqueta}: copia a CDU NO verificada → se CONSERVA el original en el Inbox (se reintentará).`);
            return 'conservado';
        }
    } catch (e) {
        if (e.tipo === 'omitir') {
            // No se puede (ni se debe) procesar todavía (DRM, formato sin tratamiento): NO se borra, NO va a
            // Cuarentena. Se DEJA en el Inbox intacto; se marca su carpeta con .noborrar (para el recolector)
            // y su ruta como omitida (para no reintentar en cada escaneo).
            for (const r of unidad.rutas) _omitidos.add(r);
            if (unidad.carpeta) await depositarTestigo(unidad.carpeta, e.message || 'formato no procesable');
            console.warn(`  🚫 ${etiqueta} → OMITIDO (se deja en el Inbox): ${e.message}`);
            return 'omitido';
        } else if (e.tipo === 'infraestructura') {
            const destino = await enviarAReintentos(unidad.rutas, {
                error: { tipo: e.tipo, mensaje: e.message },
                documento: e.documentoParcial || null,
            });
            console.error(`  🔁 ${etiqueta} → Reintentos (${e.message})`);
            await limpiarInbox(unidad); // sacar del Inbox para no reprocesar en bucle
            return 'reintento';
        } else if (e.tipo === 'ilegible') {
            // Fichero estructuralmente dañado (EPUB/PDF corrupto): no es cuestión de catalogación
            // manual sino de conseguir una COPIA SANA → Cuarentena/ilegibles (depósito con sidecar);
            // se reemplaza desde el panel buscando una copia. Igual que los fantasmas de 0 bytes.
            await enviarAIlegibles(unidad.rutas, { titulo: etiqueta, mensaje: e.message });
            console.error(`  📛 ${etiqueta} → Cuarentena/ilegibles (ilegible: ${e.message})`);
            return 'ilegible';
        } else {
            // identificación imposible u otro error no recuperable → Cuarentena (manual).
            await enviarACuarentena(unidad.rutas, { error: { tipo: e.tipo || 'desconocido', mensaje: e.message } });
            console.error(`  🚫 ${etiqueta} → Cuarentena (${e.message})`);
            // La carpeta (buzón de primer nivel) no se borra; sus subcarpetas vacías las poda el barrido.
            return 'cuarentena';
        }
    }
}

// Resumen legible de un lote del Vigilante (solo categorías con cuenta). Lleva 📊 → visible en modo simple.
function resumenLote(t, totalUnidades) {
    const orden = [['nuevo', '✅ nuevos'], ['actualizado', '♻️ actualizados'], ['reciclado', '⏭️ duplicados idénticos'],
        ['duplicado', '⚠️ duplicados a Cuarentena'], ['cuarentena', '🚫 sin identificar'], ['ilegible', '📛 ilegibles'],
        ['omitido', '🚫 omitidos (DRM/audio/formato) — se dejan en el Inbox'],
        ['reintento', '🔁 a Reintentos'], ['conservado', '⛔ conservados (copia no íntegra)']];
    const partes = orden.filter(([k]) => t[k]).map(([k, lab]) => `${lab}: ${t[k]}`);
    return `📊 Lote terminado: ${totalUnidades} unidad(es) — ${partes.length ? partes.join(' · ') : 'sin cambios'}`;
}

// Formatos comprimidos GENÉRICOS que se EXPANDEN como si fueran una CARPETA (misma lógica de drop):
// imágenes sueltas → un libro escaneado; varios documentos → colección; "Vol N" → obra. NO incluye
// .cbz/.cbr/.cb7 (cómics = UN documento) ni .epub (es un zip, pero es un libro).
// bsdtar (libarchive) los lee todos (C plano, apto Atom): ZIP/RAR/RAR5/7z e ISO9660 (.iso → imagen de
// disco de una colección/escaneo, se expande igual que un .zip). Se recicla el original tras expandir.
// Contenedores que bsdtar SÍ sabe abrir → su defecto es EXPANDIR (comportamiento histórico).
const EXT_COMPRIMIDO = ['.zip', '.rar', '.7z', '.iso'];
// Contenedores OPACOS: bsdtar NO los abre (imagen de Nero, paquete de app iOS/macOS, imagen de disco…), así
// que «expandir» ni siquiera es una opción para ellos → su defecto es SOFTWARE INTACTO (1 registro). Antes se
// quedaban INVISIBLES: no están en EXT_VALIDAS (el pipeline por-fichero no los mira) ni se expandían, así que
// nadie los tocaba — violaban el invariante de que todo lo que entra acabe con un registro que apunte a él.
const EXT_CONTENEDOR_OPACO = ['.nrg', '.ipa', '.dmg', '.mdf', '.mds', '.cdi', '.ccd', '.img', '.bin', '.cue'];
const esContenedor = (n) => {
    const x = path.extname(n).toLowerCase();
    return EXT_COMPRIMIDO.includes(x) || EXT_CONTENEDOR_OPACO.includes(x);
};
const defectoContenedor = (n) => (EXT_CONTENEDOR_OPACO.includes(path.extname(n).toLowerCase()) ? 'software' : 'expandir');
// VENTANA DE DECISIÓN de un contenedor sin acción explícita en la guía (ver expandirComprimidos): tiempo que
// se espera a que elijas en el Inspector antes de expandirlo por defecto. Sin ella, con el vigilante activo el
// .iso/.rar se expandía en el primer escaneo y la acción del Inspector era inalcanzable.
//   0 → expandir de inmediato (comportamiento histórico)   ·   -1 → nunca expandir sin decisión explícita
const CONTENEDOR_ESPERA_MS = Number(process.env.CONTENEDOR_ESPERA_MS ?? 300000);   // 5 min por defecto
const esperandoDecision = new Set();   // contenedores ya anunciados (para no repetir el aviso en cada escaneo)
const rutaExiste = (p) => fs.access(p).then(() => true).catch(() => false);

/**
 * PRE-PASO del Inbox: expande los comprimidos (.zip) SUELTOS de la raíz a una CARPETA del mismo nombre,
 * para que listarUnidades los trate IGUAL que un drop de carpeta (imágenes→libro escaneado, varios docs→
 * colección, "Vol N"→obra). El zip original se RECICLA (nunca se borra). Un zip corrupto → Cuarentena/
 * ilegibles. Aplana un único directorio raíz (evita Inbox/<base>/<base>/… y que las imágenes queden anidadas).
 */
async function expandirComprimidos() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    // ACCIÓN POR FICHERO elegida en el Inspector (guía de la carpeta): un contenedor complejo NO se puede
    // adivinar. El MISMO .iso puede ser un archivo de documentos (→ abrir) o una enciclopedia/instalador de
    // software (→ INTACTO): abrir este último metía cientos de vídeos y recursos como fichas sueltas. Por
    // defecto se sigue expandiendo (comportamiento histórico); el humano decide lo contrario en el Inspector.
    const guiaRaiz = await leerGuia(INBOX);
    for (const e of entradas) {
        if (!e.isFile() || ignorarEntrada(e.name)) continue;
        if (!esContenedor(e.name)) continue;
        const zip = path.join(INBOX, e.name);
        const spec = guiaRaiz?.archivos?.[e.name] || {};
        const decidido = spec.accion || (spec.omitir ? 'omitir' : null);   // null = el usuario aún no ha dicho nada
        if (decidido === 'omitir') {
            if (!omitidasGuia.has(zip)) { omitidasGuia.add(zip); console.log(`  ⏭️  ${e.name}: OMITIR (guía) — no se cataloga.`); }
            continue;
        }
        if (await verificarEstabilidad([zip]) !== 'estable') {   // no tocar un contenedor a medio copiar
            console.log(`  ⏳ ${e.name}: comprimido aún copiándose; se tratará en el próximo escaneo.`);
            continue;
        }
        // VENTANA DE DECISIÓN. Sin esto, la acción del Inspector era INALCANZABLE: con el vigilante activo el
        // contenedor se expandía en el primer escaneo tras el drop, así que cuando ibas a «inspeccionar antes»
        // el fichero ya no existía (era una carpeta) y solo podías marcar el resultado ya expandido. Ahora, si
        // NO hay decisión explícita, se espera CONTENEDOR_ESPERA_MS a que la tomes; pasada la ventana se expande
        // (comportamiento histórico → la ingesta desatendida sigue funcionando sola).
        //   ·  0  → expandir de inmediato (como antes)     · -1 → NUNCA expandir sin decisión explícita
        const porDefecto = defectoContenedor(e.name);   // opaco (.nrg/.ipa/.dmg…) → software; abrible → expandir
        if (!decidido && CONTENEDOR_ESPERA_MS !== 0) {
            const edad = await fs.stat(zip).then((s) => Date.now() - (s.mtimeMs || 0)).catch(() => Infinity);
            if (CONTENEDOR_ESPERA_MS < 0 || edad < CONTENEDOR_ESPERA_MS) {
                if (!esperandoDecision.has(zip)) {
                    esperandoDecision.add(zip);
                    const cuanto = CONTENEDOR_ESPERA_MS < 0 ? 'indefinidamente' : `${Math.round(CONTENEDOR_ESPERA_MS / 60000)} min`;
                    const dice = porDefecto === 'software' ? 'se guardará INTACTO (1 registro)' : 'se abrirá';
                    console.log(`  🤔 «${e.name}»: contenedor — esperando ${cuanto} tu decisión en el Inspector (📂 abrir y catalogar dentro · 💿 software intacto · ⏭️ omitir).${CONTENEDOR_ESPERA_MS < 0 ? '' : ` Si no dices nada, ${dice}.`}`);
                }
                continue;
            }
            console.log(`  ⌛ «${e.name}»: sin decisión en la ventana → ${porDefecto === 'software' ? 'se guarda INTACTO' : 'se abre'} (por defecto).`);
        }
        const accion = decidido || porDefecto;
        esperandoDecision.delete(zip);   // se actúa: deja de estar «a la espera» (y no crece el Set sin fin)
        const base = path.basename(e.name, path.extname(e.name)).trim() || 'archivo';
        if (accion === 'software') {
            // NO se abre: se conserva INTACTO y se cataloga como UN registro. Se envuelve en su propia carpeta
            // con una guía `accion:'software'` → lo recoge la unidad esSoftware (ingestarSoftware: copia
            // verbatim en bloque + 1 documento naturaleza:'software'). Reutiliza toda la maquinaria existente.
            const dirSw = await nombreLibre(INBOX, base);
            try {
                await fs.mkdir(dirSw, { recursive: true });
                await fs.rename(zip, path.join(dirSw, e.name));
                await escribirGuia(dirSw, { accion: 'software' });
                console.log(`  💿 «${e.name}»: SOFTWARE (guía) — se conserva INTACTO, sin abrir → 1 registro.`);
            } catch (err) {
                console.warn(`  ⚠️  No se pudo preparar «${e.name}» como software: ${err.message} (se conserva).`);
                await fs.rm(dirSw, { recursive: true, force: true }).catch(() => {});
            }
            continue;
        }
        let destino = path.join(INBOX, base);
        for (let i = 2; await rutaExiste(destino); i++) destino = path.join(INBOX, `${base} (${i})`);
        const tmp = path.join(INBOX, `.expand-${Date.now()}`);   // oculto → ignorarEntrada lo salta
        try {
            await fs.mkdir(tmp, { recursive: true });
            await extraerComprimido(zip, tmp);                   // bsdtar (zip/rar/7z) → al temporal
            // Aplanar: si el zip contiene UN único directorio de nivel superior, usar SU contenido como raíz.
            const top = (await fs.readdir(tmp, { withFileTypes: true })).filter(d => !ignorarEntrada(d.name));
            const raiz = (top.length === 1 && top[0].isDirectory()) ? path.join(tmp, top[0].name) : tmp;
            await fs.rename(raiz, destino);
            if (raiz !== tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
            await reciclar([zip], 'comprimido-expandido');       // política nunca-borrar: zip → Papelera
            console.log(`  📦 «${e.name}» expandido → carpeta «${path.basename(destino)}» (se cataloga como drop de carpeta).`);
        } catch (err) {
            await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
            console.warn(`  ⚠️  No se pudo expandir «${e.name}» (${err.message}) → Cuarentena/ilegibles.`);
            await enviarAIlegibles([zip], { titulo: e.name, mensaje: `comprimido no extraíble: ${err.message}` });
        }
    }
}

// Nombre libre en `dir` a partir de `nombre` (evita pisar; añade « (2)», « (3)»…).
async function nombreLibre(dir, nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let destino = path.join(dir, nombre);
    for (let i = 2; await rutaExiste(destino); i++) destino = path.join(dir, `${base} (${i})${ext}`);
    return destino;
}

// ¿Un FICHERO suelto ya terminó de copiarse? (mismo criterio que carpetaEstable pero por tamaño+mtime): un
// audio monolítico grande tarda en copiarse; moverlo a medias sería un error. Estable si (a) nada se tocó en
// la ventana, o (b) el tamaño no cambió respecto al escaneo anterior durante CARPETA_ESTABLE_MS.
const huellaFicheros = new Map(); // ruta → { tam, desde }
async function ficheroEstable(abs) {
    let st;
    try { st = await fs.stat(abs); } catch { return false; }
    if (!st.isFile() || st.size === 0) return false;
    const ahora = Date.now();
    if (ahora - (st.mtimeMs || 0) >= CARPETA_ESTABLE_MS) { huellaFicheros.set(abs, { tam: st.size, desde: st.mtimeMs || 0 }); return true; }
    const previo = huellaFicheros.get(abs);
    if (!previo || previo.tam !== st.size) { huellaFicheros.set(abs, { tam: st.size, desde: ahora }); return false; }
    return ahora - previo.desde >= CARPETA_ESTABLE_MS;
}

// PRE-PASO del Inbox: un audio MONOLÍTICO suelto en la RAÍZ (un fichero = un audiolibro entero) NO lo cataloga
// el pipeline por-fichero (detectarTipo='desconocido') → antes se ignoraba/perdía. Se ENVUELVE cada uno en su
// propia subcarpeta (nombre = el del fichero sin extensión) para que la autodetección lo trate como AUDIOLIBRO
// (esCarpetaAudiolibro → ingestarAudiolibro: ID3, portada embebida, playlist, ruta_fija). Solo ficheros ESTABLES
// (no a medio copiar) y NUNCA borra: mueve (rename) dentro del propio Inbox. Un audio que el usuario haya
// AGRUPADO en el Inspector ya lo movió antes procesarGruposGuia, así que aquí solo caen los realmente sueltos.
async function envolverAudiosSueltos() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isFile() || ignorarEntrada(e.name) || !esAudio(e.name)) continue;
        const abs = path.join(INBOX, e.name);
        if (!(await ficheroEstable(abs))) { console.log(`  ⏳ audio «${e.name}»: aún copiándose — se espera a que termine.`); continue; }
        const base = path.basename(e.name, path.extname(e.name)).trim() || 'Audiolibro';
        const destinoDir = await nombreLibre(INBOX, base);
        try {
            await fs.mkdir(destinoDir, { recursive: true });
            await fs.rename(abs, path.join(destinoDir, e.name));
            huellaFicheros.delete(abs);
            console.log(`  🎧 Audio monolítico «${e.name}» → «${path.basename(destinoDir)}/» (se catalogará como audiolibro).`);
        } catch (err) {
            console.warn(`  ⚠️  No se pudo envolver el audio «${e.name}»: ${err.message} (se conserva suelto).`);
            await fs.rm(destinoDir, { recursive: true, force: true }).catch(() => {});
        }
    }
}

/**
 * PRE-PASO del Inbox: aplica las ACCIONES ESTRUCTURALES de `_guia.json` que MUTAN el sistema de ficheros,
 * ANTES de listar unidades (como expandirComprimidos). Cada acción es «mover» (nunca borrar contenido):
 *   · explotar → mueve el contenido de la carpeta a la carpeta que la contiene (el Inbox) y borra la envoltura.
 *   · aplanar  → si contiene UNA sola subcarpeta y ningún fichero suelto, promociona esa subcarpeta un nivel
 *                arriba (deshace `Descarga/NombreReal/…` → `NombreReal/…`) y borra la envoltura.
 * omitir/intacta NO mutan el FS (se resuelven en listarUnidades). Solo se tocan carpetas ESTABLES (copiadas).
 */
async function aplicarAccionesGuiaFs() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isDirectory() || ignorarEntrada(e.name)) continue;
        const dir = path.join(INBOX, e.name);
        let guia;
        try { guia = await leerGuia(dir); } catch { guia = null; }
        if (!guia || (guia.accion !== 'explotar' && guia.accion !== 'aplanar')) continue;
        if (!(await carpetaEstable(dir))) continue; // aún copiándose → esperar al próximo escaneo
        try {
            const hijos = (await fs.readdir(dir, { withFileTypes: true })).filter((h) => !ignorarEntrada(h.name) && h.name !== NOMBRE_GUIA);
            if (guia.accion === 'explotar') {
                for (const h of hijos) await fs.rename(path.join(dir, h.name), await nombreLibre(INBOX, h.name));
                await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); // solo queda el _guia.json
                console.log(`  💥 «${e.name}»: EXPLOTAR (guía) → ${hijos.length} elemento(s) liberados en el Inbox.`);
            } else { // aplanar
                const subs = hijos.filter((h) => h.isDirectory());
                const files = hijos.filter((h) => !h.isDirectory());
                if (subs.length === 1 && files.length === 0) {
                    const inner = path.join(dir, subs[0].name);
                    await fs.rename(inner, await nombreLibre(INBOX, subs[0].name)); // promociona la subcarpeta única
                    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
                    console.log(`  📂 «${e.name}»: APLANAR (guía) → «${subs[0].name}» promocionada un nivel.`);
                }
                // Si no cumple (no es una carpeta sola), se deja como está y se procesa normal.
            }
        } catch (err) {
            console.warn(`  ⚠️  Acción de guía «${guia.accion}» sobre «${e.name}» falló: ${err.message} (se conserva intacta).`);
        }
    }
}

/**
 * PRE-PASO del Inbox (agrupado B): los GRUPOS declarados en un `_guia.json` (ficheros sueltos que forman UN
 * audiolibro/obra) se materializan MOVIÉNDOLOS a una subcarpeta, para que la autodetección del vigilante los
 * trate como una unidad (audio→audiolibro; una obra se marca con accion:'obra' en la subcarpeta). Recursivo
 * y acotado; solo carpetas ESTABLES; los grupos ya procesados se vacían del _guia.json.
 */
async function procesarGruposGuia(dir = INBOX, nivel = 8) {
    if (nivel < 0) return;
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (e.isDirectory() && !ignorarEntrada(e.name)) await procesarGruposGuia(path.join(dir, e.name), nivel - 1);
    }
    let guia;
    try { guia = await leerGuia(dir); } catch { guia = null; }
    if (!guia || !guia.grupos || !guia.grupos.length) return;
    if (!(await carpetaEstable(dir))) return;
    for (const grupo of guia.grupos) {
        const nombre = (grupo.nombre || (grupo.tipo === 'obra' ? 'Obra' : 'Audiolibro')).replace(/[/\\:*?"<>|]/g, '_');
        const destino = path.join(dir, nombre);
        const presentes = [];
        for (const rel of grupo.archivos) { const a = path.join(dir, ...rel.split('/')); if (await rutaExiste(a)) presentes.push(a); }
        if (!presentes.length) continue; // ya movidos/desaparecidos → se descarta al vaciar grupos
        await fs.mkdir(destino, { recursive: true });
        for (const a of presentes) await fs.rename(a, await nombreLibre(destino, path.basename(a))).catch(() => {});
        if (grupo.tipo === 'obra') await escribirGuia(destino, { accion: 'obra' }).catch(() => {});
        console.log(`  🧩 Grupo «${nombre}» (${grupo.tipo}): ${presentes.length} fichero(s) → subcarpeta (se agrupará como una unidad).`);
    }
    await escribirGuia(dir, { ...guia, grupos: [] }).catch(() => {}); // grupos consumidos
}

async function procesarCola() {
    if (procesando || !vigilanteActivo) return; // pausado desde el panel → los ficheros esperan en el Inbox
    procesando = true;
    actividadActual = 'Ingesta del Inbox';
    try {
        let totalProcesadas = 0;
        const tally = {};
        await expandirComprimidos();          // .zip suelto → carpeta (drop) ANTES de listar unidades
        await procesarGruposGuia();           // guía: grupos de ficheros → subcarpetas (agrupado B)
        await envolverAudiosSueltos();        // audio monolítico suelto → subcarpeta → audiolibro (no ignorar)
        await aplicarAccionesGuiaFs();        // guía: explotar/aplanar (mutan FS) ANTES de listar unidades
        let unidades = await listarUnidades();
        if (unidades.length) ultimaActividad = Date.now(); // hay trabajo: posponer el mantenimiento
        while (unidades.length) {
            console.log(`\n📥 Procesando ${unidades.length} unidad(es) del Inbox...`);
            let procesadas = 0;
            for (const u of unidades) {
                // PAUSA desde el panel: se detiene tras el documento en curso; el resto espera en el
                // Inbox y se reanuda al reactivar el vigilante (igual que el Mantenimiento cede el turno).
                if (!vigilanteActivo) break;
                // SOFTWARE (guía): copia verbatim EN BLOQUE + UN registro naturaleza:'software'. No pasa por
                // el pipeline por-fichero (no cataloga cada .exe/.dll). Recicla el origen tras verificar la copia.
                if (u.esSoftware) {
                    console.log(`\n💿 Software «${path.basename(u.carpeta)}»: catalogando (bloque verbatim, 1 registro)…`);
                    try {
                        const rs = await ingestarSoftware(u.carpeta);
                        if (rs.ok) {
                            console.log(`  ✔ software «${rs.titulo}» · ${rs.ficheros} ficheros · CDU ${rs.cdu} · ${rs.web}`);
                            tally.software = (tally.software || 0) + 1; procesadas++;
                        } else {
                            console.warn(`  ✗ software: ${rs.motivo} (se CONSERVA el origen)`);
                            if (rs.permanente) omitidasDefinitivas.add(u.carpeta);
                        }
                    } catch (err) { console.error(`  ✗ software falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // INTACTA (guía): la carpeta se conserva ÍNTEGRA en el árbol CDU y deja UN registro que apunta
                // a ella (naturaleza:'material', con su explorador). No se procesa su contenido.
                if (u.esIntacta) {
                    console.log(`\n📦 Intacta «${path.basename(u.carpeta)}»: conservando íntegra (1 registro)…`);
                    try {
                        const ri = await ingestarIntacta(u.carpeta);
                        if (ri.ok) {
                            console.log(`  ✔ «${ri.titulo}» · ${ri.ficheros} ficheros · CDU ${ri.cdu} · ${ri.web}`);
                            tally.intacta = (tally.intacta || 0) + 1; procesadas++;
                        } else {
                            console.warn(`  ✗ intacta: ${ri.motivo} (se CONSERVA el origen)`);
                            if (ri.permanente) omitidasDefinitivas.add(u.carpeta);
                        }
                    } catch (err) { console.error(`  ✗ intacta falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // LIBRO + MATERIAL AUXILIAR (guía): el documento principal por el PIPELINE NORMAL (libro de
                // pleno derecho, ISBN/CDU/metadatos) + el material (código, datasets…) conservado verbatim junto
                // a él (ruta_fija), visible en el explorador de la ficha. NO es transmedia ni colección.
                if (u.esLibroMaterial) {
                    console.log(`\n📖 Libro + material «${path.basename(u.carpeta)}»: catalogando el libro (pipeline normal) y adjuntando el material…`);
                    try {
                        const rlm = await ingestarLibroConMaterial(u.carpeta);
                        if (rlm.ok) {
                            console.log(`  ✔ libro «${rlm.titulo}»${rlm.duplicado ? ' (ya existía)' : ''} · ${rlm.material} elemento(s) de material adjunto · CDU ${rlm.cdu || '—'} · ${rlm.web || ''}`);
                            tally.libroMaterial = (tally.libroMaterial || 0) + 1; procesadas++;
                        } else {
                            console.warn(`  ✗ libro + material: ${rlm.motivo} (se CONSERVA el origen)`);
                            if (rlm.permanente) omitidasDefinitivas.add(u.carpeta);
                        }
                    } catch (err) { console.error(`  ✗ libro + material falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // TRANSMEDIA: copia el árbol verbatim al CDU + cataloga (un doc por PDF, audios, ruta_fija) y
                // recicla el origen SOLO tras verificar la copia. No pasa por el pipeline normal por-fichero.
                if (u.esTransmedia) {
                    console.log(`\n📦 Transmedia «${path.basename(u.carpeta)}»: catalogando (estructura preservada)…`);
                    try {
                        const rt = await ingestarTransmedia(u.carpeta);
                        if (rt.ok) {
                            console.log(rt.insertados
                                ? `  ✔ ${rt.insertados} documento(s) · CDU ${rt.cdu} · ${rt.web}`
                                : `  ✔ contenido preservado verbatim (0 documentos catalogables, p. ej. CD interactivo) · ${rt.web}`);
                            tally.transmedia = (tally.transmedia || 0) + 1; procesadas++;
                        } else {
                            console.warn(`  ✗ transmedia: ${rt.motivo} (se CONSERVA el origen)`);
                            if (rt.permanente) omitidasDefinitivas.add(u.carpeta); // duplicado real: no reintentar (evita bucle)
                        }
                    } catch (err) { console.error(`  ✗ transmedia falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // AUDIOLIBRO PURO: copia verbatim + 1 documento (playlist + carrusel) por audiolibro; recicla el
                // origen solo tras verificar la copia. No pasa por el pipeline normal por-fichero.
                if (u.esAudiolibro) {
                    console.log(`\n📀 Audiolibro «${path.basename(u.carpeta)}»: catalogando (playlist + carrusel)…`);
                    try {
                        const ra = await ingestarAudiolibro(u.carpeta, {});
                        const oks = (ra.resultados || []).filter((r) => r.ok);
                        if (ra.ok) { oks.forEach((r) => console.log(`  ✔ «${r.titulo}» · ${r.audios} pistas · ${r.imagenes} imágenes`)); tally.audiolibro = (tally.audiolibro || 0) + oks.length; procesadas++; }
                        else {
                            console.warn(`  ✗ audiolibro: ${(ra.resultados || [])[0]?.motivo || 'sin resultado'} (se CONSERVA el origen)`);
                            if (ra.permanente) omitidasDefinitivas.add(u.carpeta); // ya catalogado: no reintentar (evita bucle)
                        }
                    } catch (err) { console.error(`  ✗ audiolibro falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // COLECCIÓN DE AUDIOLIBROS: copia verbatim + una colección con un doc por libro (audiolibro),
                // por PDF y por vídeo; recicla el origen solo tras verificar la copia.
                if (u.esColeccionAudio) {
                    console.log(`\n📚 Colección de audiolibros «${path.basename(u.carpeta)}»: catalogando…`);
                    try {
                        const rc = await ingestarColeccionAudiolibros(u.carpeta, {});
                        const oks = (rc.resultados || []).filter((r) => r.ok);
                        if (rc.ok) { oks.forEach((r) => console.log(`  ✔ «${r.coleccion}» · ${r.insertados} miembro(s)${r.videos ? ` (incl. ${r.videos} vídeo/s)` : ''}`)); tally.coleccionAudio = (tally.coleccionAudio || 0) + oks.length; procesadas++; }
                        else {
                            console.warn(`  ✗ colección de audiolibros: ${(rc.resultados || [])[0]?.motivo || 'sin resultado'} (se CONSERVA el origen)`);
                            if (rc.permanente) omitidasDefinitivas.add(u.carpeta); // ya existe: no reintentar (evita bucle)
                        }
                    } catch (err) { console.error(`  ✗ colección de audiolibros falló: ${err.message} (se CONSERVA el origen)`); }
                    continue;
                }
                // Comprobar si el archivo terminó de escribirse (o es un fantasma de 0 bytes).
                const estabilidad = await verificarEstabilidad(u.rutas);
                if (estabilidad === 'fantasma') {
                    const nombre = `${path.basename(u.rutas[0])}${u.rutas.length > 1 ? ` (+${u.rutas.length - 1})` : ''}`;
                    console.warn(`  👻 ${nombre}: 0 bytes durante >${Math.round(HUERFANO_TIMEOUT_MS / 60000)} min → Cuarentena/ilegibles (redescargar y reemplazar).`);
                    await enviarAIlegibles(u.rutas, { titulo: path.basename(u.rutas[0]), mensaje: 'transferencia incompleta (0 bytes)' });
                    // La carpeta (buzón de primer nivel) no se borra.
                    for (const r of u.rutas) huerfanosVistos.delete(r);
                    tally.ilegible = (tally.ilegible || 0) + 1;
                    continue;
                }
                if (estabilidad !== 'estable') {
                    console.log(`  ⏳ ${path.basename(u.rutas[0])}: aún escribiéndose; se reintenta en el próximo escaneo.`);
                    continue;
                }
                const out = await procesarUnidad(u);
                if (out) tally[out] = (tally[out] || 0) + 1;
                procesadas++;
                await new Promise(res => setTimeout(res, PAUSA_MS)); // ritmo
            }
            totalProcesadas += procesadas;
            if (!vigilanteActivo) { console.log(`  ⏸️  Vigilante PAUSADO: ingesta detenida (${totalProcesadas} procesada(s)); el resto espera en el Inbox.`); break; }
            // Si en una pasada completa no se procesó nada (todo inestable), salir y esperar al
            // próximo escaneo periódico — así no entramos en un bucle re-listando lo inestable.
            if (procesadas === 0) break;
            unidades = await listarUnidades(); // recoger lo que llegó mientras procesábamos
        }
        // Tras procesar: poda subcarpetas vacías (docs ya catalogados, covers/ ya consumidas) y RETIRA las
        // carpetas de primer nivel que ya no tienen nada que catalogar (vacías / solo basura / subcarpetas
        // vacías) — incluidas las colecciones (ya NO se conservan como buzón vacío). Se conserva solo lo que
        // aún tenga un documento no trivial, material conservable (audio) o testigo .noborrar.
        if (totalProcesadas > 0) {
            console.log(resumenLote(tally, totalProcesadas)); // RESUMEN del lote (visible también en modo simple)
            await protegerConservables().catch(() => {}); // marca .noborrar (audio/omitidos) ANTES de podar
            await podarVaciosInbox().catch(() => {});
            await disolverDropsVacios().catch(() => {});
        }
        // Anuncio de reposo: solo en la TRANSICIÓN (tras procesar algo y quedar el Inbox vacío),
        // no en cada escaneo en vacío (evita spam cada VIGILANTE_ESCANEO_MS).
        if (totalProcesadas > 0 && !(await inboxTieneArchivos())) {
            console.log(`📭 Inbox vacío — ${totalProcesadas} unidad(es) procesada(s); la app queda en reposo.`);
            conformadorDormido = false; // nueva(s) ingesta(s) → el Conformador puede tener trabajo
        }
    } finally {
        procesando = false;
        actividadActual = null;
    }
}

function programarScan() {
    ultimaActividad = Date.now(); // llegó algo: reinicia el reloj de inactividad del mantenimiento
    clearTimeout(temporizador);
    temporizador = setTimeout(() => procesarCola().catch(e => console.error('Vigilante:', e)), REPOSO_MS);
}

/** Una pasada (un lote) de mantenimiento bajo el lock compartido. No solapa con la ingesta. */
async function ejecutarPasadaMantenimiento() {
    if (procesando) return { ok: false, motivo: 'ocupado: hay ingesta o mantenimiento en curso' };
    procesando = true;
    actividadActual = 'Mantenimiento (Conformador)';
    try {
        const r = await ejecutarMantenimiento({ debeAbortar: debeCederAIngesta });
        ultimaRevisionMant = Date.now();
        ultimaActividad = Date.now(); // reinicia el reloj: esperar REPOSO antes del siguiente lote

        // Relleno perezoso de descripciones de clasificación (CDU/Dewey/LCC) en tandas pequeñas: acota
        // el coste de IA y, cuando todo está descrito, no hace ninguna llamada. MANTENIMIENTO_DESC_LOTE=0
        // lo desactiva. Si genera o quedan pendientes, el Conformador NO se duerme (sigue rellenando).
        let desc = { generadas: 0, fallos: 0, pendientes: 0 };
        if (!r.abortado) {
            const lote = Number(process.env.MANTENIMIENTO_DESC_LOTE ?? 5);
            try { desc = await rellenarDescripcionesFaltantes({ limite: lote }); }
            catch (e) { console.error('Mantenimiento (descripciones):', e.message); }
            if (desc.generadas) console.log(`🧹 Conformador: ${desc.generadas} descripción(es) de clasificación generadas (faltan ${desc.pendientes}).`);
        }

        // Dormir SOLO si no queda trabajo ni de documentos ni de descripciones.
        if (!r.abortado && r.pendientes === 0 && desc.pendientes === 0) {
            conformadorDormido = true;
            if (r.revisados > 0)
                console.log('🧹 Conformador: cola vacía — en reposo hasta la próxima ingesta.');
        }
        return { ok: true, ...r, descripciones: desc };
    } catch (e) {
        console.error('Mantenimiento:', e.message);
        return { ok: false, motivo: e.message };
    } finally {
        procesando = false;
        actividadActual = null;
    }
}

/**
 * Pasada AUTOMÁTICA: solo si el Inbox lleva inactivo lo suficiente y nada más corre. Cede el
 * turno en cuanto algo llega al Inbox (debeAbortar). Por lotes: el siguiente tick continúa.
 */
async function quizasMantenimiento() {
    // ¿Expiró un apagado temporal?
    if (modoConformador === 'apagado-hasta' && Date.now() >= conformadorApagadoHasta) {
        modoConformador = 'diferido';
        conformadorApagadoHasta = null;
        conformadorDormido = false;
        console.log('🧹 Conformador: pausa temporal expirada → modo diferido.');
    }
    if (modoConformador === 'apagado' || modoConformador === 'apagado-hasta') return;
    if (procesando || conformadorDormido || mantManualEnCurso) return; // dormido = cola vacía; o ya hay manual en curso
    if (Date.now() - ultimaActividad < MANTENIMIENTO_REPOSO_MS) return;
    if (await debeCederAIngesta()) return; // prioridad a la ingesta SOLO si el vigilante está activo
    await ejecutarPasadaMantenimiento();
}

/**
 * Pasada de CAMPAÑAS DE FONDO (roles, huecos, autores, descripciones): independiente del Conformador
 * por-documento — cada campaña tiene su propio ajuste activa/lote/cadencia y decide dentro si le toca.
 * Se dispara al reposo, comparte el lock con la ingesta y le cede el turno. Es opt-in por campaña (todas
 * arrancan desactivadas), por eso no depende del modo del Conformador.
 */
async function quizasCampanas() {
    if (procesando || mantManualEnCurso) return;
    if (Date.now() - ultimaActividad < MANTENIMIENTO_REPOSO_MS) return;
    if (await debeCederAIngesta()) return;
    procesando = true;
    actividadActual = 'Campañas de fondo';
    try {
        const r = await ejecutarCampanasDebidas({ debeAbortar: debeCederAIngesta, alEmpezar: (id) => { actividadActual = `Campaña: ${etiquetaCampana(id)}`; } });
        if (r.lanzadas) ultimaActividad = Date.now(); // se hizo trabajo: reinicia el reloj de reposo
    } catch (e) {
        console.error('Campañas de fondo:', e.message);
    } finally {
        procesando = false;
        actividadActual = null;
    }
}

/**
 * Disparo MANUAL de UNA campaña (botón «Ejecutar ahora» del panel): lanza UNA tanda en segundo plano,
 * saltándose la espera de reposo pero respetando el lock y cediendo a la ingesta. Devuelve de inmediato.
 */
export function ejecutarCampanaAhora(id) {
    if (procesando || mantManualEnCurso) {
        // Mensaje INFORMATIVO: dice QUÉ tiene el lock (ingesta / mantenimiento / otra campaña).
        const quien = actividadActual || (mantManualEnCurso ? 'Mantenimiento manual' : 'otro proceso');
        return { ok: false, motivo: `Ocupado: «${quien}» en curso. Se ejecuta un proceso pesado a la vez; espera a que termine.` };
    }
    procesando = true;
    actividadActual = `Campaña: ${etiquetaCampana(id)}`;
    (async () => {
        try {
            const db = await conectarDB();
            const cfg = await leerAjustesCampanas(db);
            const limite = (cfg[id] && cfg[id].lote) || 25; // una sola tanda del tamaño configurado
            const r = await ejecutarCampana(db, id, { limite, debeAbortar: debeCederAIngesta });
            console.log(`🎯 [Campaña ${id}] (manual) ${r.procesados} procesados · ${r.cambios} cambios · ${r.pendientes} pendientes.`);
        } catch (e) {
            console.error(`Campaña ${id} (manual):`, e.message);
        } finally {
            procesando = false;
            actividadActual = null;
        }
    })();
    return { ok: true, mensaje: `Campaña «${etiquetaCampana(id)}» lanzada (una tanda). Verás su progreso abajo.` };
}

// ── Backfill COMPLETO de una campaña (drenaje): encadena tandas hasta pendientes=0 ────────────
let drenajeId = null;       // id de la campaña que se está vaciando (o null)
let pararDrenaje = false;   // señal de STOP del drenaje

/**
 * Vacía una campaña ENTERA en segundo plano: repite tandas hasta que no queden pendientes, cediendo el
 * turno a la ingesta entre tandas (respeta el lock único). Ideal para un backfill completo (p. ej. roles).
 * Solo uno a la vez. Devuelve de inmediato; el progreso y el nº de pendientes se ven en el panel.
 */
export function ejecutarCampanaCompleta(id) {
    if (drenajeId) return { ok: false, motivo: `Ya hay un backfill completo en curso («${etiquetaCampana(drenajeId)}»). Deténlo antes.` };
    if (procesando || mantManualEnCurso) return { ok: false, motivo: `Ocupado: «${actividadActual || 'otro proceso'}» en curso. Inténtalo cuando termine.` };
    drenajeId = id;
    pararDrenaje = false;
    const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));
    (async () => {
        try {
            const db = await conectarDB();
            let vueltas = 0;
            console.log(`🎯 Backfill COMPLETO de «${etiquetaCampana(id)}» iniciado.`);
            while (!pararDrenaje) {
                if (procesando || mantManualEnCurso) { await dormir(2); continue; } // otro proceso tiene el lock
                procesando = true;
                if (await debeCederAIngesta()) { procesando = false; await dormir(5); continue; } // prioridad a la ingesta
                actividadActual = `Backfill: ${etiquetaCampana(id)}`;
                let r = null;
                try {
                    const cfg = await leerAjustesCampanas(db);
                    const limite = (cfg[id] && cfg[id].lote) || 25;
                    r = await ejecutarCampana(db, id, { limite, debeAbortar: debeCederAIngesta });
                } finally {
                    procesando = false;
                    actividadActual = null;
                }
                vueltas++;
                if (r && r.pendientes === 0) { console.log(`🎯 Backfill «${etiquetaCampana(id)}» COMPLETO (${vueltas} tandas).`); break; }
                await dormir(1);
            }
            if (pararDrenaje) console.log(`🎯 Backfill «${etiquetaCampana(id)}» detenido por el usuario.`);
        } catch (e) {
            console.error(`Backfill ${id}:`, e.message);
        } finally {
            drenajeId = null;
            pararDrenaje = false;
        }
    })();
    return { ok: true, mensaje: `Backfill completo de «${etiquetaCampana(id)}» en marcha (se detiene solo al llegar a 0).` };
}

/** Detiene el backfill completo en curso (si lo hay). */
export function pararCampanaCompleta() {
    if (!drenajeId) return { ok: false, motivo: 'no hay ningún backfill completo en curso' };
    pararDrenaje = true;
    return { ok: true, mensaje: `Deteniendo el backfill de «${etiquetaCampana(drenajeId)}»…` };
}

/** Estado del backfill completo (para el panel). */
export function estadoDrenaje() {
    return { id: drenajeId, etiqueta: drenajeId ? etiquetaCampana(drenajeId) : null };
}

/**
 * Disparo MANUAL del Conformador (vía API): vacía TODO el backlog en segundo plano, lote a lote,
 * saltándose la espera de inactividad. Cede a la ingesta entre lotes. Devuelve de inmediato.
 */
export function mantenimientoManual({ intervaloSegundos = 0, activarSegundos = 0 } = {}) {
    if (mantManualEnCurso) return { ok: false, motivo: 'ya hay un mantenimiento manual en curso' };
    mantManualEnCurso = true;
    pararMantManual = false;
    conformadorDormido = false; // forzar aunque la cola pareciera vacía
    const seg = Math.max(0, Number(intervaloSegundos) || 0);     // pausa entre rondas (0 = continuo)
    const activar = Number(activarSegundos) || 0;                // 0 = ya · >0 = tras N s · -1 = al quedar el Inbox inactivo
    const lote = Number(process.env.MANTENIMIENTO_LOTE || 25);
    const dormir = (s) => new Promise(r => setTimeout(r, s * 1000));
    (async () => {
        try {
            // — Arranque programado —
            if (activar === -1) {
                console.log('🧹 Mantenimiento manual: esperando a que el Inbox quede inactivo…');
                while (!pararMantManual && await debeCederAIngesta()) await dormir(10);
            } else if (activar > 0) {
                console.log(`🧹 Mantenimiento manual: arrancará en ${activar}s…`);
                for (let t = 0; t < activar && !pararMantManual; t += 5) await dormir(Math.min(5, activar - t));
            }
            if (pararMantManual) { console.log('🧹 Mantenimiento manual cancelado antes de arrancar.'); return; }

            // — Rondas de LOTE, cediendo a la ingesta y reintentando hasta vaciar el backlog —
            console.log(`🧹 Mantenimiento manual iniciado (${seg > 0 ? `pausa ${seg}s entre rondas de ${lote}` : 'continuo, sin pausa'}).`);
            while (!pararMantManual) {
                const r = await ejecutarPasadaMantenimiento();
                if (!r.ok || r.abortado) { await dormir(Math.max(seg, 5)); continue; } // ocupado/cedió → reintenta
                if (r.pendientes === 0) { console.log('🧹 Mantenimiento manual finalizado: backlog vacío.'); break; }
                if (seg > 0) await dormir(seg);
            }
            if (pararMantManual) console.log('🧹 Mantenimiento manual detenido (modo=apagado).');
        } finally { mantManualEnCurso = false; }
    })().catch(e => { mantManualEnCurso = false; console.error('Mantenimiento manual:', e.message); });

    const cuando = activar === -1 ? 'cuando el Inbox quede inactivo' : activar > 0 ? `en ${activar}s` : 'inmediatamente';
    return { ok: true, mensaje: `Mantenimiento programado (${cuando}; ${seg > 0 ? `${seg}s entre rondas de ${lote}` : 'continuo'}). Detén con modo=apagado.` };
}

/** Calcula el ms-epoch del siguiente hito temporal para 'apagado-hasta'. */
function calcularHasta(hasta) {
    const d = new Date();
    switch (hasta) {
        case 'proxima-hora':
            return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0, 0, 0).getTime();
        case 'proximo-dia':
            return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0).getTime();
        case 'proxima-semana':
            return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, 0, 0, 0, 0).getTime();
        default:
            return null;
    }
}

/**
 * Cambia el modo del Conformador en caliente.
 * @param {object} opts
 * @param {'diferido'|'apagado'|'apagado-hasta'} opts.modo
 * @param {'proxima-hora'|'proximo-dia'|'proxima-semana'} [opts.hasta] — requerido si modo='apagado-hasta'
 */
export function configurarConformador({ modo, hasta } = {}) {
    const MODOS = ['diferido', 'apagado', 'apagado-hasta'];
    if (!MODOS.includes(modo))
        return { ok: false, motivo: `Modo inválido: "${modo}". Valores: diferido, apagado, apagado-hasta.` };

    if (modo === 'apagado-hasta') {
        const ts = calcularHasta(hasta);
        if (!ts)
            return { ok: false, motivo: `Periodo inválido: "${hasta}". Valores: proxima-hora, proximo-dia, proxima-semana.` };
        conformadorApagadoHasta = ts;
    } else {
        conformadorApagadoHasta = null;
    }

    modoConformador = modo;
    if (modo === 'diferido') conformadorDormido = false;      // permitir que el auto compruebe pronto
    if (modo === 'apagado') pararMantManual = true;           // además, DETIENE un mantenimiento manual en curso

    const info = modo === 'apagado-hasta'
        ? `apagado hasta ${new Date(conformadorApagadoHasta).toLocaleString('es-ES')}`
        : modo;
    console.log(`🧹 Conformador: modo → ${info}`);
    return { ok: true, ...estadoConformador() };
}

/** Devuelve el estado actual del Conformador (para GET /api/mantenimiento/estado). */
export function estadoConformador() {
    return {
        modo: modoConformador,
        dormido: conformadorDormido,
        mantenimientoManual: mantManualEnCurso,
        apagadoHasta: conformadorApagadoHasta ? new Date(conformadorApagadoHasta).toISOString() : null,
        ultimaRevision: ultimaRevisionMant ? new Date(ultimaRevisionMant).toISOString() : null,
    };
}

/** Pausa/reanuda el procesado del Inbox (sin parar la app). Pausado: los ficheros esperan. */
export function configurarVigilante({ activo } = {}) {
    if (typeof activo === 'boolean') {
        vigilanteActivo = activo;
        console.log(`👁️  Vigilante ${activo ? 'REANUDADO' : 'PAUSADO'} desde el panel.`);
        if (activo) programarScan(); // al reanudar, procesa lo que se haya acumulado
    }
    return estadoVigilante();
}

/** Estado del vigilante (para el panel). `actividad` = qué tiene el lock ahora (o null si libre). */
export function estadoVigilante() {
    return { activo: vigilanteActivo, procesando, actividad: actividadActual };
}

export async function iniciarVigilante() {
    await fs.mkdir(INBOX, { recursive: true }).catch(() => {});
    // INBOX es la ruta INTERNA del contenedor (p. ej. /app/Inbox); el usuario ve la carpeta del HOST mapeada
    // por el bind mount (p. ej. "Biblioteca Digital/Inbox"). Se muestra INBOX_PUBLIC_PATH si está en .env.
    const inboxPublico = process.env.INBOX_PUBLIC_PATH || '';
    console.log(`👁️  Vigilante observando el Inbox${inboxPublico ? `: ${inboxPublico}` : ` (${INBOX} dentro del contenedor)`}`);
    console.log(vigilanteActivo
        ? '   ▶️  Vigilante ACTIVO al arrancar (VIGILANTE_AUTOSTART=1).'
        : '   ⏸️  Vigilante PAUSADO al arrancar: actívalo desde el Panel de Control (los ficheros esperan en el Inbox).');
    const sondeoMs = Number(process.env.VIGILANTE_POLL_MS || 1500);
    const watcher = chokidar.watch(INBOX, {
        ignoreInitial: false,
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
        depth: Number(process.env.VIGILANTE_DEPTH || 3), // Inbox/Colección/Subcarpeta/fichero = 3 niveles
        // En NAS/Docker los eventos inotify del host no siempre cruzan el bind mount
        // (sobre todo si el archivo se suelta por SMB/AFP): el evento 'add' nunca llega y
        // el Inbox parece "muerto". El sondeo recorre el Inbox cada VIGILANTE_POLL_MS y SÍ
        // detecta archivos nuevos. Activo por defecto; VIGILANTE_POLLING=0 lo desactiva
        // (p. ej. en local con inotify fiable, para no gastar CPU).
        usePolling: process.env.VIGILANTE_POLLING !== '0',
        interval: sondeoMs,
        binaryInterval: sondeoMs,
    });
    watcher.on('add', programarScan).on('addDir', programarScan);

    // Red de seguridad: en bind mounts de Synology los eventos de chokidar pueden no dispararse
    // nunca (el Inbox parece inerte aunque el archivo ya esté dentro del contenedor). Un escaneo
    // periódico llama a procesarCola directamente —que hace su propio fs.readdir— y garantiza la
    // recogida pase lo que pase con los eventos. El guard 'procesando' evita solapes con el
    // disparo por evento de chokidar. Ajustable con VIGILANTE_ESCANEO_MS.
    const escaneoMs = Number(process.env.VIGILANTE_ESCANEO_MS || 10000);
    setInterval(async () => {
        await procesarCola().catch(e => console.error('Vigilante (escaneo periódico):', e));
        // Si el Inbox queda inactivo, aprovechar para una pasada de mantenimiento (cede a la ingesta).
        await quizasMantenimiento().catch(e => console.error('Vigilante (mantenimiento):', e));
        // Y, con el sistema en reposo, una tanda de las campañas de fondo que estén activas y les toque.
        await quizasCampanas().catch(e => console.error('Vigilante (campañas):', e));
    }, escaneoMs);

    // Y un primer barrido inmediato de lo que ya hubiera en el Inbox al arrancar.
    procesarCola().catch(e => console.error('Vigilante (escaneo inicial):', e));

    if (modoConformador === 'diferido') {
        console.log(`🧹 Conformador en AUTO (opt-in): mantenimiento tras ${Math.round(MANTENIMIENTO_REPOSO_MS / 1000)}s de Inbox inactivo.`);
    } else {
        console.log('🧹 Conformador MANUAL: no corre solo. Dispáralo con POST /api/mantenimiento (activar=0|N|-1, intervalo=N).');
    }

    return watcher;
}

// Ejecución directa: `node src/vigilante.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    iniciarVigilante();
}
