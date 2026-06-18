import 'dotenv/config';
import chokidar from 'chokidar';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestarRecurso } from './servicio-ingesta.js';
import { agrupar } from './utils/agrupador.js';
import { enviarACuarentena, enviarAReintentos } from './gestor-fallos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

const INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const PAUSA_MS = Number(process.env.PAUSA_INGESTA_MS || 1500);   // ritmo entre recursos (no saturar APIs)
const REPOSO_MS = Number(process.env.REPOSO_INBOX_MS || 2500);   // espera tras el último cambio antes de procesar
const EXT_VALIDAS = ['.epub', '.pdf', '.jpg', '.jpeg', '.png', '.webp', '.heic', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
// Ubicación por defecto para libros/revistas físicos llegados por Inbox (sin POST que la fije).
const UBICACION_INBOX = { ambito: 'Sin asignar', estanteria: 'Sin asignar (Inbox)' };

let temporizador = null;
let procesando = false;

const esValida = (f) => EXT_VALIDAS.includes(path.extname(f).toLowerCase());

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
        if (e.name.startsWith('.')) continue;
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
        await limpiarInbox(unidad);
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
        let unidades = await listarUnidades();
        while (unidades.length) {
            console.log(`\n📥 Procesando ${unidades.length} unidad(es) del Inbox...`);
            for (const u of unidades) {
                await procesarUnidad(u);
                await new Promise(res => setTimeout(res, PAUSA_MS)); // ritmo
            }
            unidades = await listarUnidades(); // recoger lo que llegó mientras procesábamos
        }
    } finally {
        procesando = false;
    }
}

function programarScan() {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => procesarCola().catch(e => console.error('Vigilante:', e)), REPOSO_MS);
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
    return watcher;
}

// Ejecución directa: `node src/vigilante.js`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    iniciarVigilante();
}
