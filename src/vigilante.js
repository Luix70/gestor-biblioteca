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
import { agrupar } from './utils/agrupador.js';
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
            const dentro = (await fs.readdir(ruta)).map(n => path.join(ruta, n)).filter(esValida);
            for (const u of agrupar(dentro)) unidades.push({ ...u, carpeta: ruta });
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

async function limpiarInbox(unidad) {
    for (const r of unidad.rutas) {
        await fs.chmod(r, 0o666).catch(() => {});
        await fs.rm(r, { force: true }).catch(() => {});
    }
    if (unidad.carpeta) await fs.rmdir(unidad.carpeta).catch(() => {});
}

async function procesarUnidad(unidad) {
    const etiqueta = `${path.basename(unidad.rutas[0])}${unidad.rutas.length > 1 ? ` (+${unidad.rutas.length - 1})` : ''}`;
    const contexto = unidad.esImagenes ? { ubicacion: UBICACION_INBOX } : {};
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
            if (unidad.carpeta) await fs.rmdir(unidad.carpeta).catch(() => {});
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
                    if (u.carpeta) await fs.rmdir(u.carpeta).catch(() => {});
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
        depth: 2,
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
