import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../database.js';
import { reciclar, reciclarCarpeta } from './papelera.js';
import { retirarCarpeta } from './borrado-seguro.js';

/**
 * Utilidades de INSPECCIÓN para el panel de control: tamaño/contenido de la Papelera, listado y
 * reingesta de la Cuarentena, e ingesta por día. Solo lectura + acciones explícitas del usuario.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_RECICLAJE = resolver(process.env.PATH_RECICLAJE, 'Recycling');
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');

// Tamaño y nº de ficheros de una subcarpeta de la Papelera. No cuenta el manifiesto de su raíz
// (`.papelera.json`): es metadato, no algo que se borrara — igual que lo omiten contenidoPapelera y
// explorarPapelera. Si contara, cada carpeta restaurable saldría con un fichero de más, y ordenar por
// nº de ficheros las mezclaría mal con las antiguas sin manifiesto.
async function tamanoDir(dir) {
    let bytes = 0, ficheros = 0;
    async function walk(d) {
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else if (d === dir && e.name === '.papelera.json') continue;
            else { try { bytes += (await fs.stat(p)).size; ficheros++; } catch { /* ignora */ } }
        }
    }
    await walk(dir);
    return { bytes, ficheros };
}

// ── Papelera (Recycling) ─────────────────────────────────────────────────────

// Nombre de subcarpeta que pone papelera.js: `<serial>_AAAA-MM-DD_HH-MM-SS[_etiqueta]`, con la hora en UTC
// (sale de toISOString).
const RE_FECHA_SUBCARPETA = /^\d+_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/;

/**
 * Fecha de ELIMINACIÓN de una subcarpeta de la Papelera (ISO), para poder ordenar por ella:
 *   1) la que lleva el propio nombre (exacta: es el momento en que se creó la subcarpeta al reciclar);
 *   2) si el nombre no la trae (entradas antiguas), `creado` del manifiesto;
 *   3) en último caso, la fecha de modificación de la carpeta (aproximada).
 */
async function fechaSubcarpeta(nombre, dir) {
    const m = nombre.match(RE_FECHA_SUBCARPETA);
    if (m) {
        const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
        if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    try {
        const man = JSON.parse(await fs.readFile(path.join(dir, '.papelera.json'), 'utf8'));
        const d = new Date(man.creado);
        if (man.creado && !Number.isNaN(d.getTime())) return d.toISOString();
    } catch { /* sin manifiesto */ }
    try { return (await fs.stat(dir)).mtime.toISOString(); } catch { return null; }
}

// ── Tamaños de las subcarpetas: MEDIDOS EN SEGUNDO PLANO y GUARDADOS ──────────────────────────────────────
// Antes `infoPapelera` medía TODA la Papelera (un stat por fichero) antes de responder. Con 4.215 subcarpetas y
// 102.598 ficheros (23-nov) eso son varios minutos en el Atom y el panel recibía un 504 del proxy: no se podía
// ver nada. Una subcarpeta no cambia después de creada (cada reciclado crea la suya; solo restaurar o vaciar la
// tocan), así que su tamaño se mide UNA vez y se guarda en logs/ con la fecha de modificación de la carpeta como
// control (si cambia, se vuelve a medir). La lista se devuelve al momento con lo que ya se sabe, y lo que falta
// se mide en segundo plano; el panel vuelve a preguntar mientras queden pendientes.
const FICHERO_TAMANOS = path.join(RAIZ, 'logs', 'papelera-tamanos.json');
let tamanos = null;              // Map nombre → { mtime, bytes, ficheros }
let midiendo = null;             // promesa de la medición en curso (una sola a la vez)

async function cargarTamanos() {
    if (tamanos) return tamanos;
    tamanos = new Map();
    try {
        const guardado = JSON.parse(await fs.readFile(FICHERO_TAMANOS, 'utf8'));
        for (const [nombre, v] of Object.entries(guardado || {})) tamanos.set(nombre, v);
    } catch { /* primera vez, o fichero dañado: se mide todo de nuevo */ }
    return tamanos;
}

async function guardarTamanos() {
    try {
        await fs.mkdir(path.dirname(FICHERO_TAMANOS), { recursive: true });
        await fs.writeFile(FICHERO_TAMANOS, JSON.stringify(Object.fromEntries(tamanos)));
    } catch { /* la caché es una comodidad: si no se puede guardar, se volverá a medir */ }
}

/**
 * Mide en segundo plano las subcarpetas sin tamaño conocido (o cuya carpeta cambió). Nunca dos a la vez.
 * Orden: las MÁS RECIENTES primero (las que el panel enseña arriba por defecto) y varias a la vez. Antes se
 * medían de una en una y en el orden del disco (las más antiguas): el 23-nov, tras 15 s, la primera página
 * del panel seguía sin un solo tamaño aunque la medición ya llevaba cientos de carpetas.
 */
function medirPendientes(pendientes) {
    if (midiendo || !pendientes.length) return;
    const orden = [...pendientes].sort((a, b) => b.nombre.localeCompare(a.nombre)); // serial desc
    midiendo = (async () => {
        let desdeGuardado = 0;
        await enParalelo(orden, 8, async ({ nombre, mtime }) => {
            const medida = await tamanoDir(path.join(DIR_RECICLAJE, nombre));
            // Se conserva lo ya sabido (restaurable, fecha); solo si la carpeta no volvió a cambiar entre medias.
            const previo = tamanos.get(nombre);
            if (previo && previo.mtime === mtime) tamanos.set(nombre, { ...previo, ...medida });
            // Se guarda cada 200 para no perder lo medido si la app se reinicia a mitad.
            if (++desdeGuardado >= 200) { desdeGuardado = 0; await guardarTamanos(); }
        });
        await guardarTamanos();
    })().catch((e) => console.warn(`[Papelera] medición de tamaños interrumpida: ${e.message}`))
        .finally(() => { midiendo = null; });
}

/**
 * Nº de elementos en la RAÍZ de una subcarpeta (sin el manifiesto). Es UNA lectura de directorio —barata,
 * a diferencia de medir el árbol entero—, así que se sabe al momento si una subcarpeta está VACÍA o tiene
 * algo, que es lo que importa para decidir si merece la pena mirarla, mientras su tamaño aún se está midiendo.
 */
async function contarEntradas(dir) {
    try { return (await fs.readdir(dir)).filter((n) => n !== '.papelera.json').length; }
    catch { return null; }
}

/** `fn` sobre cada elemento, con a lo sumo `n` a la vez (miles de stat en serie tardaban un minuto por SMB). */
async function enParalelo(lista, n, fn) {
    const out = new Array(lista.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, lista.length) }, async () => {
        while (i < lista.length) { const k = i++; out[k] = await fn(lista[k]); }
    }));
    return out;
}

export async function infoPapelera() {
    await cargarTamanos();
    const pendientes = [];
    let ents; try { ents = await fs.readdir(DIR_RECICLAJE, { withFileTypes: true }); } catch { ents = []; }
    const nombres = ents.filter((e) => e.isDirectory()).map((e) => e.name);
    const presentes = new Set(nombres);
    // Por subcarpeta, UN stat (su fecha de modificación). Lo demás —tamaño, si es restaurable, fecha de
    // eliminación— sale de la caché mientras esa fecha no cambie; si cambió (o es nueva) se vuelve a mirar.
    const subcarpetas = await enParalelo(nombres, 32, async (nombre) => {
        const dir = path.join(DIR_RECICLAJE, nombre);
        let mtime = 0; try { mtime = (await fs.stat(dir)).mtimeMs; } catch { /* desaparecida entre medias */ }
        let conocido = tamanos.get(nombre);
        if (!conocido || conocido.mtime !== mtime) {
            // ¿Tiene manifiesto de origen? → se puede restaurar a su sitio (Papelera de Windows).
            const restaurable = await fs.access(path.join(dir, '.papelera.json')).then(() => true).catch(() => false);
            conocido = {
                mtime, restaurable, fecha: await fechaSubcarpeta(nombre, dir),
                entradas: await contarEntradas(dir),   // vacía o no, al momento (el tamaño llega después)
            };
            tamanos.set(nombre, conocido);
            pendientes.push({ nombre, mtime });
        } else if (conocido.bytes == null) {
            // Vista antes, pero la medición no llegó a ella (o la caché es de antes de contar las entradas).
            if (conocido.entradas == null) conocido.entradas = await contarEntradas(dir);
            pendientes.push({ nombre, mtime });
        }
        return {
            nombre, restaurable: conocido.restaurable, fecha: conocido.fecha,
            // Sin medir aún: sin cifras (el panel muestra «…» y las ordena al final), pero con cuántos
            // elementos hay en su raíz, para distinguir al momento una subcarpeta VACÍA de una con contenido.
            ...(conocido.bytes != null
                ? { bytes: conocido.bytes, ficheros: conocido.ficheros }
                : { entradas: conocido.entradas }),
        };
    });
    // Lo vaciado ya no cuenta.
    for (const nombre of [...tamanos.keys()]) if (!presentes.has(nombre)) tamanos.delete(nombre);
    medirPendientes(pendientes);

    subcarpetas.sort((a, b) => b.nombre.localeCompare(a.nombre)); // serial desc → más reciente primero
    const bytes = subcarpetas.reduce((s, x) => s + (x.bytes || 0), 0);
    const ficheros = subcarpetas.reduce((s, x) => s + (x.ficheros || 0), 0);
    // `pendientes` > 0: los totales aún son parciales (se están midiendo).
    return { bytes, ficheros, subcarpetas, pendientes: pendientes.length };
}

export async function contenidoPapelera(sub) {
    const dir = path.join(DIR_RECICLAJE, path.basename(String(sub || '')));
    const out = [];
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        if (!e.isFile() || e.name === '.papelera.json') continue; // el manifiesto es metadato, no contenido
        let size = 0; try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* ignora */ }
        out.push({ nombre: e.name, bytes: size });
    }
    return out;
}

// EXPLORAR el árbol real de una subcarpeta de la Papelera (navegable, no solo el primer nivel): lista carpetas
// y ficheros de `<sub>/<ruta>` con su tamaño. Guarda contra path-traversal: `objetivo` debe caer DENTRO de la
// subcarpeta. Devuelve { sub, ruta, entradas:[{nombre,dir,bytes}] }.
export async function explorarPapelera(sub, ruta = '') {
    const base = path.resolve(path.join(DIR_RECICLAJE, path.basename(String(sub || ''))));
    const rel = String(ruta || '').replace(/^[\\/]+/, '');
    const objetivo = path.resolve(base, rel);
    if (objetivo !== base && !objetivo.startsWith(base + path.sep)) throw new Error('ruta no permitida');
    let ents; try { ents = await fs.readdir(objetivo, { withFileTypes: true }); } catch { throw new Error('carpeta no encontrada'); }
    const entradas = [];
    for (const e of ents) {
        if (!rel && e.name === '.papelera.json') continue; // el manifiesto (solo en la raíz) es metadato, no contenido
        let bytes = 0; if (e.isFile()) { try { bytes = (await fs.stat(path.join(objetivo, e.name))).size; } catch { /* ignora */ } }
        entradas.push({ nombre: e.name, dir: e.isDirectory(), bytes });
    }
    entradas.sort((a, b) => (Number(b.dir) - Number(a.dir)) || a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
    return { sub: path.basename(String(sub || '')), ruta: rel, entradas };
}

// Ruta absoluta (validada) de UN fichero dentro de una subcarpeta de la Papelera, para descargarlo. null si la
// ruta se sale de la subcarpeta (debe estar ESTRICTAMENTE dentro, nunca la raíz a secas).
export function rutaFicheroPapelera(sub, ruta) {
    const base = path.resolve(path.join(DIR_RECICLAJE, path.basename(String(sub || ''))));
    const objetivo = path.resolve(base, String(ruta || '').replace(/^[\\/]+/, ''));
    return objetivo.startsWith(base + path.sep) ? objetivo : null;
}

/** Vacía la Papelera entera o una subcarpeta. Es la PAPELERA (último destino): borrar aquí es la
 *  acción explícita de "vaciar la basura" del usuario — fs.rm es correcto. */
export async function vaciarPapelera(sub = null) {
    if (sub) {
        await fs.rm(path.join(DIR_RECICLAJE, path.basename(String(sub))), { recursive: true, force: true }).catch(() => {});
        return { ok: true, vaciado: path.basename(String(sub)) };
    }
    let ents; try { ents = await fs.readdir(DIR_RECICLAJE, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) await fs.rm(path.join(DIR_RECICLAJE, e.name), { recursive: true, force: true }).catch(() => {});
    return { ok: true, vaciado: 'todo' };
}

// ── Cuarentena ───────────────────────────────────────────────────────────────
export async function listarCuarentena() {
    const categorias = {};
    let cats; try { cats = await fs.readdir(DIR_CUARENTENA, { withFileTypes: true }); } catch { return categorias; }
    for (const c of cats) {
        if (!c.isDirectory() || c.name.startsWith('@') || c.name.startsWith('.')) continue;
        const catDir = path.join(DIR_CUARENTENA, c.name);
        const depositos = [];
        let deps; try { deps = await fs.readdir(catDir, { withFileTypes: true }); } catch { deps = []; }
        for (const d of deps) {
            if (!d.isDirectory()) continue;
            const depDir = path.join(catDir, d.name);
            let estado = null;
            try { estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8')); } catch { /* sin estado */ }
            const archivos = (await fs.readdir(depDir).catch(() => []))
                .filter(n => n !== 'estado.json' && n !== '.reemplazo');
            depositos.push({
                id: `${c.name}/${d.name}`, nombre: d.name, archivos,
                titulo: estado?.titulo || null,
                error: estado?.error?.mensaje || estado?.error?.tipo || null,
                fecha: estado?.fecha || null,
                // Saneamiento: copia sana ya PREPARADA (lista para procesar por lotes) + posible fallo.
                listo: !!estado?.listo,
                reemplazo: estado?.reemplazo || null,
                error_proceso: estado?.error_proceso || null,
                // Reparación de un PDF roto: el candidato en staging viene de qpdf, no de una copia sana subida.
                // `reparacion` lleva el INFORME (páginas, bytes, sospecha) para que el panel avise antes de
                // catalogar: una reparación puede devolver un documento MUTILADO y no queremos falsa seguridad.
                reparado: !!estado?.reparado,
                reparacion: estado?.reparacion || null,
            });
        }
        if (depositos.length) categorias[c.name] = depositos;
    }
    return categorias;
}

/** Devuelve los ficheros reales de un depósito al Inbox para re-catalogarlos, y retira el depósito. */
export async function reingestarCuarentena(idRel) {
    const partes = String(idRel || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { ok: false, motivo: 'identificador de depósito inválido' };
    const depDir = path.join(DIR_CUARENTENA, ...partes);
    let ents; try { ents = await fs.readdir(depDir, { withFileTypes: true }); } catch { return { ok: false, motivo: 'depósito no encontrado' }; }
    // Solo ficheros NO vacíos: reingestar un fantasma de 0 bytes lo devolvería tal cual a
    // Cuarentena/ilegibles (trabajo de Sísifo). Un fichero ilegible se arregla con «Reemplazar».
    const candidatos = ents.filter(e => e.isFile() && e.name !== 'estado.json');
    const archivos = [];
    for (const a of candidatos) {
        try { if ((await fs.stat(path.join(depDir, a.name))).size > 0) archivos.push(a); } catch { /* ignora */ }
    }
    if (!archivos.length) return { ok: false, motivo: 'el depósito solo tiene ficheros vacíos (0 bytes): usa «Reemplazar» con una copia sana' };
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let movidos = 0;
    for (const a of archivos) {
        try { await fs.copyFile(path.join(depDir, a.name), path.join(DIR_INBOX, a.name)); movidos++; } catch { /* sigue */ }
    }
    if (movidos === archivos.length) await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    return { ok: movidos > 0, movidos, total: archivos.length };
}

/** DESCARTA un depósito: mueve su CARPETA ENTERA (intacta, con `.reemplazo/` y sidecar) a la Papelera,
 *  bajo su categoría, y lo retira de la Cuarentena. Conservar la carpeta tal cual facilita restaurarla
 *  (basta moverla de vuelta). Para cuando ya no interesa el documento o no hay copia sana. */
export async function descartarCuarentena(idRel) {
    const partes = String(idRel || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { ok: false, motivo: 'identificador de depósito inválido' };
    const depDir = path.join(DIR_CUARENTENA, ...partes);
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'depósito no encontrado' }; }
    const dest = await reciclarCarpeta(depDir, 'cuarentena-descartada', partes[0]);
    if (!dest) return { ok: false, motivo: 'no se pudo mover el depósito a la Papelera' };
    return { ok: true, descartado: partes.join('/') };
}

/** DESCARTA una CATEGORÍA entera: mueve cada depósito (carpeta intacta) a la Papelera. Destructivo →
 *  el endpoint exige re-confirmar la contraseña de administrador. */
export async function descartarCategoria(cat) {
    const c = path.basename(String(cat || ''));
    if (!c) return { ok: false, motivo: 'categoría inválida' };
    const catDir = path.join(DIR_CUARENTENA, c);
    let deps; try { deps = (await fs.readdir(catDir, { withFileTypes: true })).filter(e => e.isDirectory()); }
    catch { return { ok: false, motivo: 'categoría no encontrada' }; }
    let movidos = 0;
    for (const d of deps) {
        if (await reciclarCarpeta(path.join(catDir, d.name), `cuarentena-categoria-${c}`, c)) movidos++;
    }
    await retirarCarpeta(catDir, `cuarentena-categoria-${c}`); // vacía → fs.rm; si algún depósito no se recicló → Papelera
    return { ok: true, categoria: c, movidos, total: deps.length };
}

/** Reingesta TODOS los depósitos de Cuarentena/duplicados (vuelven al Inbox para re-evaluarse con la
 *  lógica actual: los de mismo hash se BORRAN, los de otro formato se SEPARAN en su propio documento,
 *  y solo los conflictos reales (mismo formato, contenido distinto) vuelven a Cuarentena). */
export async function reingestarTodosDuplicados() {
    const catDir = path.join(DIR_CUARENTENA, 'duplicados');
    let deps; try { deps = await fs.readdir(catDir, { withFileTypes: true }); } catch { return { ok: true, depositos: 0, movidos: 0 }; }
    let depositos = 0, movidos = 0;
    for (const d of deps) {
        if (!d.isDirectory()) continue;
        const r = await reingestarCuarentena(`duplicados/${d.name}`);
        depositos++; if (r.ok) movidos += r.movidos || 0;
    }
    return { ok: true, depositos, movidos };
}

// ── Ingesta por día (para la gráfica del panel) ──────────────────────────────
export async function ingestaPorDia(dias = 30) {
    const db = await conectarDB();
    const desde = new Date(Date.now() - dias * 86400000);
    const agg = await db.collection('biblioteca').aggregate([
        { $match: { fecha_ingreso: { $gte: desde } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$fecha_ingreso' } }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
    ]).toArray();
    return { dias, total: agg.reduce((s, g) => s + g.n, 0), serie: agg.map(g => ({ dia: g._id, n: g.n })) };
}
