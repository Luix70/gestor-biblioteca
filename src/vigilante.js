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
import { reciclar } from './utils/papelera.js';
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

const INBOX   = resolver(process.env.PATH_INBOX,   'Inbox');
const PAUSA_MS = Number(process.env.PAUSA_INGESTA_MS || 1500);   // ritmo entre recursos (no saturar APIs)
const REPOSO_MS = Number(process.env.REPOSO_INBOX_MS || 2500);   // espera tras el último cambio antes de procesar
const ESTABILIDAD_MS    = Number(process.env.VIGILANTE_ESTABILIDAD_MS || 1500); // ventana para confirmar que un archivo terminó de escribirse
const HUERFANO_TIMEOUT_MS = Number(process.env.INBOX_HUERFANO_MS || 600000);  // 10 min a 0 bytes → fantasma
const EXT_VALIDAS = ['.epub', '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.mobi', '.cbr', '.cbz', '.cb7', '.djvu', '.zip', '.rar', '.7z'];
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

/** Poda (bottom-up) las SUBcarpetas de 'top' que quedaron vacías o solo con metadatos Synology.
 *  No toca 'top' (la carpeta-colección persiste como buzón de depósito). */
async function podarSubcarpetasVacias(top) {
    let entradas;
    try { entradas = await fs.readdir(top, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (!e.isDirectory() || soloMetadatos(e.name)) continue;
        const sub = path.join(top, e.name);
        await podarSubcarpetasVacias(sub); // primero las anidadas
        let restantes; try { restantes = await fs.readdir(sub); } catch { continue; }
        if (restantes.every(soloBasura)) await fs.rm(sub, { recursive: true, force: true }).catch(() => {});
    }
}

/** Tras una pasada: poda subcarpetas vacías dentro de cada carpeta-colección del Inbox. */
async function podarVaciosInbox() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) {
        if (e.isDirectory() && !ignorarEntrada(e.name)) await podarSubcarpetasVacias(path.join(INBOX, e.name));
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

async function listarUnidades() {
    let entradas;
    try { entradas = await fs.readdir(INBOX, { withFileTypes: true }); }
    catch { return []; }

    const unidades = [];
    const sueltos = [];

    for (const e of entradas) {
        if (ignorarEntrada(e.name)) continue; // ocultos + carpetas de sistema (@eaDir, #recycle...)
        const ruta = path.join(INBOX, e.name);
        if (e.isDirectory()) {
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
    for (const u of agrupar(sueltos)) unidades.push({ ...u, carpeta: null });
    return unidades;
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
                if (e.isFile() && !soloMetadatos(e.name) && !esValida(e.name)) aReciclar.push(path.join(unidad.carpeta, e.name));
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
    const contexto = unidad.esImagenes ? { ubicacion: UBICACION_INBOX } : {};
    // Drop por carpeta: ligar el recurso a la colección (nombre de carpeta) y autonumerar la serie.
    if (unidad.coleccion) { contexto.coleccion = unidad.coleccion; contexto.serieAuto = true; }
    if (unidad.obra) contexto.obra = unidad.obra; // tomo de obra multivolumen
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
        if (e.tipo === 'infraestructura') {
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
        ['reintento', '🔁 a Reintentos'], ['conservado', '⛔ conservados (copia no íntegra)']];
    const partes = orden.filter(([k]) => t[k]).map(([k, lab]) => `${lab}: ${t[k]}`);
    return `📊 Lote terminado: ${totalUnidades} unidad(es) — ${partes.length ? partes.join(' · ') : 'sin cambios'}`;
}

// Formatos comprimidos GENÉRICOS que se EXPANDEN como si fueran una CARPETA (misma lógica de drop):
// imágenes sueltas → un libro escaneado; varios documentos → colección; "Vol N" → obra. NO incluye
// .cbz/.cbr/.cb7 (cómics = UN documento) ni .epub (es un zip, pero es un libro).
const EXT_COMPRIMIDO = ['.zip', '.rar', '.7z'];   // bsdtar los lee todos (C plano, apto Atom)
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
    for (const e of entradas) {
        if (!e.isFile() || ignorarEntrada(e.name)) continue;
        if (!EXT_COMPRIMIDO.includes(path.extname(e.name).toLowerCase())) continue;
        const zip = path.join(INBOX, e.name);
        if (await verificarEstabilidad([zip]) !== 'estable') {   // no expandir un zip a medio copiar
            console.log(`  ⏳ ${e.name}: comprimido aún copiándose; se expandirá en el próximo escaneo.`);
            continue;
        }
        const base = path.basename(e.name, path.extname(e.name)).trim() || 'archivo';
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

async function procesarCola() {
    if (procesando || !vigilanteActivo) return; // pausado desde el panel → los ficheros esperan en el Inbox
    procesando = true;
    actividadActual = 'Ingesta del Inbox';
    try {
        let totalProcesadas = 0;
        const tally = {};
        await expandirComprimidos();          // .zip suelto → carpeta (drop) ANTES de listar unidades
        let unidades = await listarUnidades();
        if (unidades.length) ultimaActividad = Date.now(); // hay trabajo: posponer el mantenimiento
        while (unidades.length) {
            console.log(`\n📥 Procesando ${unidades.length} unidad(es) del Inbox...`);
            let procesadas = 0;
            for (const u of unidades) {
                // PAUSA desde el panel: se detiene tras el documento en curso; el resto espera en el
                // Inbox y se reanuda al reactivar el vigilante (igual que el Mantenimiento cede el turno).
                if (!vigilanteActivo) break;
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
        // Tras procesar: poda subcarpetas vacías (docs ya catalogados, covers/ ya consumidas)
        // dentro de las carpetas-colección persistentes; los buzones (carpeta raíz) se conservan,
        // SALVO los de obras multivolumen ya completas, que sí se retiran.
        if (totalProcesadas > 0) {
            console.log(resumenLote(tally, totalProcesadas)); // RESUMEN del lote (visible también en modo simple)
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
