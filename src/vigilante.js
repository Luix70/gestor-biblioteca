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
import { discriminarMultivolumen } from './utils/multivolumen.js';
import { enviarACuarentena, enviarAReintentos } from './gestor-fallos.js';
import { ejecutarMantenimiento } from './mantenimiento/conformador.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

const INBOX   = resolver(process.env.PATH_INBOX,   'Inbox');
const ER_ROOM = resolver(process.env.PATH_ER_ROOM, '_ER Room');
const PAUSA_MS = Number(process.env.PAUSA_INGESTA_MS || 1500);   // ritmo entre recursos (no saturar APIs)
const REPOSO_MS = Number(process.env.REPOSO_INBOX_MS || 2500);   // espera tras el último cambio antes de procesar
const ESTABILIDAD_MS    = Number(process.env.VIGILANTE_ESTABILIDAD_MS || 1500); // ventana para confirmar que un archivo terminó de escribirse
const HUERFANO_TIMEOUT_MS = Number(process.env.INBOX_HUERFANO_MS || 600000);  // 10 min a 0 bytes → fantasma
const EXT_VALIDAS = ['.epub', '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
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
// ruta → timestamp (ms) de la primera vez que se vio el archivo con 0 bytes.
// Si supera HUERFANO_TIMEOUT_MS el archivo se trata como transferencia fallida y va a Cuarentena.
const huerfanosVistos = new Map();
let ultimaActividad = Date.now();    // último momento con actividad de ingesta
let ultimaRevisionMant = 0;          // última pasada de mantenimiento

// --- Estado del Conformador ---
let modoConformador = (process.env.MANTENIMIENTO_ACTIVO !== '0') ? 'diferido' : 'apagado';
let conformadorApagadoHasta = null;  // ms epoch; solo para modo 'apagado-hasta'
let conformadorDormido = false;      // true cuando la cola está vacía; evita polls innecesarios a Mongo

const esValida = (f) => EXT_VALIDAS.includes(path.extname(f).toLowerCase());

// Portada pre-extraída opcional: junto al documento (Book.jpg), o en una subcarpeta "covers"/
// "Covers" (la del drop o la del propio documento). Se ofrece como CANDIDATA a resolverPortada
// (compite por tamaño con la embebida/remota/rasterizada).
const EXT_PORTADA = ['.jpg', '.jpeg', '.png', '.webp'];

// Entradas que NO cuentan como contenido real (metadatos de Synology, ocultos).
const soloMetadatos = (n) => n.startsWith('@') || n.startsWith('#') || n.startsWith('.');

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

/** Borra TODAS las portadas candidatas de un documento (se haya usado o no), tras catalogarlo. */
async function eliminarPortadasCandidatas(carpetaTop, ficheroRuta) {
    if (!carpetaTop) return;
    const base = path.basename(ficheroRuta, path.extname(ficheroRuta));
    for (const dir of await dirsCandidatosPortada(carpetaTop, ficheroRuta)) {
        for (const ext of EXT_PORTADA) await fs.rm(path.join(dir, base + ext), { force: true }).catch(() => {});
    }
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
        if (restantes.every(soloMetadatos)) await fs.rm(sub, { recursive: true, force: true }).catch(() => {});
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
                const multi = discriminarMultivolumen(documentos);
                if (multi) {
                    // OBRA MULTIVOLUMEN: los ficheros "Vol. N" son tomos de UNA obra (no una colección
                    // de libros sueltos). Cada tomo se cataloga ligado a la obra (nombre de la carpeta).
                    for (const v of multi.volumenes) unidades.push({
                        rutas: [v.ruta], esImagenes: false, carpeta: ruta, conservarCarpeta: false,
                        obra: { titulo: multi.titulo_obra, numero: v.numero, titulo_volumen: v.titulo },
                    });
                } else {
                    const esColeccion = documentos.length >= 2;
                    for (const d of documentos) unidades.push({
                        rutas: [d], esImagenes: false, carpeta: ruta,
                        conservarCarpeta: esColeccion,
                        coleccion: esColeccion ? e.name : undefined,
                    });
                }
            } else {
                // Sin documentos: imágenes DIRECTAS en la carpeta = un libro escaneado.
                const imagenes = (await fs.readdir(ruta)).map(n => path.join(ruta, n)).filter(esImagen);
                if (imagenes.length > 0) {
                    unidades.push({ rutas: filtrarDuplicadosNombre(imagenes), esImagenes: true, carpeta: ruta, conservarCarpeta: false });
                }
            }
        } else if (esValida(e.name)) {
            sueltos.push(ruta);
        }
    }
    for (const u of agrupar(sueltos)) unidades.push({ ...u, carpeta: null });
    return unidades;
}

/** Mueve los archivos fantasma (0 bytes) al _ER Room preservando el nombre de fichero. */
async function moverAErRoom(rutas) {
    await fs.mkdir(ER_ROOM, { recursive: true });
    for (const ruta of rutas) {
        const nombre = path.basename(ruta);
        let destino = path.join(ER_ROOM, nombre);
        // Evitar colisión si ya existe un archivo con el mismo nombre en el _ER Room.
        if (await fs.access(destino).then(() => true).catch(() => false)) {
            const ext  = path.extname(nombre);
            const base = path.basename(nombre, ext);
            destino = path.join(ER_ROOM, `${base}.${Date.now()}${ext}`);
        }
        await fs.rename(ruta, destino).catch(() => fs.rm(ruta, { force: true }));
    }
}

export async function limpiarInbox(unidad) {
    // Se borran los documentos procesados y SU portada candidata (usada o no), esté junto al doc
    // o en una subcarpeta Covers/. La CARPETA (siempre un buzón de primer nivel del Inbox) NUNCA
    // se borra: las subcarpetas que queden vacías las poda podarVaciosInbox tras la pasada.
    for (const r of unidad.rutas) {
        await fs.chmod(r, 0o666).catch(() => {});
        await fs.rm(r, { force: true }).catch(() => {});
        if (unidad.carpeta) await eliminarPortadasCandidatas(unidad.carpeta, r);
    }
    // Drop puntual (no colección): se descartan los sidecars sueltos (.txt/.url…) que hayan
    // quedado en la raíz de la carpeta. La carpeta vacía permanece (buzón).
    // CRÍTICO: NUNCA borrar un documento bibliográfico válido (.pdf/.epub/imagen). Una obra
    // multivolumen reparte N tomos VÁLIDOS en la MISMA carpeta y se catalogan en unidades
    // distintas: barrer "todo lo que no sea metadato" borraba los tomos 2..N aún sin procesar
    // al limpiar el tomo 1 (pérdida de datos). Solo se barren extensiones NO bibliográficas.
    if (unidad.carpeta && !unidad.conservarCarpeta) {
        let entradas; try { entradas = await fs.readdir(unidad.carpeta, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            if (e.isFile() && !soloMetadatos(e.name) && !esValida(e.name)) {
                await fs.rm(path.join(unidad.carpeta, e.name), { force: true }).catch(() => {});
            }
        }
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
        console.log(`  ✅ ${etiqueta} → ${r.operacion} (${r.estado}) · ${r.rutaWeb}`);
        // SOLO se borra del Inbox si la copia al árbol CDU se verificó íntegra (tamaño origen ===
        // destino). Si no, se conserva el original para no perder datos; el próximo escaneo lo
        // reintentará (la copia es idempotente: sobrescribe el destino corrupto).
        if (r.copiaIntegra) {
            await limpiarInbox(unidad);
        } else {
            console.error(`  ⛔ ${etiqueta}: copia a CDU NO verificada → se CONSERVA el original en el Inbox (se reintentará).`);
        }
    } catch (e) {
        if (e.tipo === 'infraestructura') {
            const destino = await enviarAReintentos(unidad.rutas, {
                error: { tipo: e.tipo, mensaje: e.message },
                documento: e.documentoParcial || null,
            });
            console.error(`  🔁 ${etiqueta} → Reintentos (${e.message})`);
            await limpiarInbox(unidad); // sacar del Inbox para no reprocesar en bucle
        } else {
            // identificación imposible u otro error no recuperable → Cuarentena (manual).
            await enviarACuarentena(unidad.rutas, { error: { tipo: e.tipo || 'desconocido', mensaje: e.message } });
            console.error(`  🚫 ${etiqueta} → Cuarentena (${e.message})`);
            // La carpeta (buzón de primer nivel) no se borra; sus subcarpetas vacías las poda el barrido.
        }
    }
}

async function procesarCola() {
    if (procesando) return;
    procesando = true;
    try {
        let totalProcesadas = 0;
        let unidades = await listarUnidades();
        if (unidades.length) ultimaActividad = Date.now(); // hay trabajo: posponer el mantenimiento
        while (unidades.length) {
            console.log(`\n📥 Procesando ${unidades.length} unidad(es) del Inbox...`);
            let procesadas = 0;
            for (const u of unidades) {
                // Comprobar si el archivo terminó de escribirse (o es un fantasma de 0 bytes).
                const estabilidad = await verificarEstabilidad(u.rutas);
                if (estabilidad === 'fantasma') {
                    const nombre = `${path.basename(u.rutas[0])}${u.rutas.length > 1 ? ` (+${u.rutas.length - 1})` : ''}`;
                    console.warn(`  👻 ${nombre}: 0 bytes durante >${Math.round(HUERFANO_TIMEOUT_MS / 60000)} min → _ER Room (redescargar manualmente).`);
                    await moverAErRoom(u.rutas);
                    // La carpeta (buzón de primer nivel) no se borra.
                    for (const r of u.rutas) huerfanosVistos.delete(r);
                    continue;
                }
                if (estabilidad !== 'estable') {
                    console.log(`  ⏳ ${path.basename(u.rutas[0])}: aún escribiéndose; se reintenta en el próximo escaneo.`);
                    continue;
                }
                await procesarUnidad(u);
                procesadas++;
                await new Promise(res => setTimeout(res, PAUSA_MS)); // ritmo
            }
            totalProcesadas += procesadas;
            // Si en una pasada completa no se procesó nada (todo inestable), salir y esperar al
            // próximo escaneo periódico — así no entramos en un bucle re-listando lo inestable.
            if (procesadas === 0) break;
            unidades = await listarUnidades(); // recoger lo que llegó mientras procesábamos
        }
        // Tras procesar: poda subcarpetas vacías (docs ya catalogados, covers/ ya consumidas)
        // dentro de las carpetas-colección persistentes; los buzones (carpeta raíz) se conservan.
        if (totalProcesadas > 0) await podarVaciosInbox().catch(() => {});
        // Anuncio de reposo: solo en la TRANSICIÓN (tras procesar algo y quedar el Inbox vacío),
        // no en cada escaneo en vacío (evita spam cada VIGILANTE_ESCANEO_MS).
        if (totalProcesadas > 0 && !(await inboxTieneArchivos())) {
            console.log(`📭 Inbox vacío — ${totalProcesadas} unidad(es) procesada(s); la app queda en reposo.`);
            conformadorDormido = false; // nueva(s) ingesta(s) → el Conformador puede tener trabajo
        }
    } finally {
        procesando = false;
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
    try {
        const r = await ejecutarMantenimiento({ debeAbortar: inboxTieneArchivos });
        ultimaRevisionMant = Date.now();
        ultimaActividad = Date.now(); // reinicia el reloj: esperar REPOSO antes del siguiente lote
        if (!r.abortado && r.pendientes === 0) {
            conformadorDormido = true;
            if (r.revisados > 0)
                console.log('🧹 Conformador: cola vacía — en reposo hasta la próxima ingesta.');
        }
        return { ok: true, ...r };
    } catch (e) {
        console.error('Mantenimiento:', e.message);
        return { ok: false, motivo: e.message };
    } finally {
        procesando = false;
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
    if (procesando || conformadorDormido) return; // dormido = cola vacía, no gastar Mongo
    if (Date.now() - ultimaActividad < MANTENIMIENTO_REPOSO_MS) return;
    if (await inboxTieneArchivos()) return; // prioridad absoluta a la ingesta
    await ejecutarPasadaMantenimiento();
}

/**
 * Disparo MANUAL del Conformador (vía API): vacía TODO el backlog en segundo plano, lote a lote,
 * saltándose la espera de inactividad. Cede a la ingesta entre lotes. Devuelve de inmediato.
 */
export function mantenimientoManual() {
    if (procesando) return { ok: false, motivo: 'ocupado: hay ingesta o mantenimiento en curso' };
    conformadorDormido = false; // forzar aunque la cola pareciera vacía
    (async () => {
        console.log('🧹 Mantenimiento lanzado MANUALMENTE.');
        let r;
        do { r = await ejecutarPasadaMantenimiento(); }
        while (r.ok && r.pendientes > 0 && !r.abortado);
        console.log(`🧹 Mantenimiento manual finalizado${r.abortado ? ' (cedió a la ingesta; quedan pendientes)' : ''}.`);
    })().catch(e => console.error('Mantenimiento manual:', e.message));
    return { ok: true, mensaje: 'Mantenimiento iniciado en segundo plano; sigue el progreso en los logs.' };
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
    if (modo === 'diferido') conformadorDormido = false; // permitir que el auto compruebe pronto

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
        apagadoHasta: conformadorApagadoHasta ? new Date(conformadorApagadoHasta).toISOString() : null,
        ultimaRevision: ultimaRevisionMant ? new Date(ultimaRevisionMant).toISOString() : null,
    };
}

export async function iniciarVigilante() {
    await fs.mkdir(INBOX, { recursive: true }).catch(() => {});
    console.log(`👁️  Vigilante observando: ${INBOX}`);
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
    }, escaneoMs);

    // Y un primer barrido inmediato de lo que ya hubiera en el Inbox al arrancar.
    procesarCola().catch(e => console.error('Vigilante (escaneo inicial):', e));

    if (modoConformador === 'diferido') {
        console.log(`🧹 Conformador activo: mantenimiento tras ${Math.round(MANTENIMIENTO_REPOSO_MS / 1000)}s de Inbox inactivo.`);
    } else if (modoConformador === 'apagado') {
        console.log('🧹 Conformador desactivado (MANTENIMIENTO_ACTIVO=0).');
    }

    return watcher;
}

// Ejecución directa: `node src/vigilante.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    iniciarVigilante();
}
