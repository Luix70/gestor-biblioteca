import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { reciclar, reciclarCarpeta } from './papelera.js';
import { ingestarRecurso } from '../servicio-ingesta.js';
import { repararPdf } from './qpdf.js'; // reparación de PDF rotos (reconstruye el xref)

/**
 * SANEAMIENTO de ficheros problemáticos de la Cuarentena (ilegibles / no-identificados / otros):
 * el usuario busca una COPIA SANA (enlaces a buscadores) y la SUBE → se PREPARA dentro del depósito
 * (subcarpeta `.reemplazo/` + `estado.listo`) sin catalogar todavía; cuando hay varias listas, se
 * PROCESAN EN LOTE en segundo plano (catalogar por el pipeline + retirar el depósito a la Papelera).
 * 'duplicados' NO entra aquí (tiene su comparador).
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const SUBDIR_REEMPLAZO = '.reemplazo';

const DEFECTO_FUENTES = [
    { nombre: "Anna's Archive", url: 'https://annas-archive.gl/search?q={q}' },
    { nombre: 'Z-Library', url: 'https://z-library.sk/s/?q={q}' },
    { nombre: 'Libgen', url: 'https://libgen.bz/index.php?req={q}' },
    { nombre: 'Gutenberg', url: 'https://www.gutenberg.org/ebooks/search/?query={q}' },
];

/** Fuentes para "buscar copia" (config FUENTES_COPIA = JSON [{nombre,url}]; {q} = consulta). */
export function fuentesCopia() {
    try {
        const j = JSON.parse(process.env.FUENTES_COPIA || '');
        if (Array.isArray(j) && j.length) return j.filter(f => f && f.nombre && f.url);
    } catch { /* JSON inválido → defecto */ }
    return DEFECTO_FUENTES;
}

/** Resuelve y valida el id '<categoria>/<carpeta>' → ruta absoluta (sin escapar de Cuarentena). */
function depDirDe(idDeposito) {
    const partes = String(idDeposito || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { error: 'identificador de depósito inválido' };
    if (partes[0] === 'duplicados') return { error: 'los duplicados se resuelven desde su comparador' };
    return { id: partes.join('/'), dir: path.join(DIR_CUARENTENA, ...partes) };
}

/** Primeros n bytes de un fichero (para comprobar la firma). */
async function cabecera(ruta, n = 8) {
    const fh = await fs.open(ruta, 'r');
    try { const b = Buffer.alloc(n); await fh.read(b, 0, n, 0); return b; }
    finally { await fh.close().catch(() => {}); }
}

/** "No es basura": firma de PDF (%PDF) o ZIP/EPUB (PK). Otros formatos: solo tamaño. Caza el caso
 *  típico de una descarga fallida guardada como .epub/.pdf (una página HTML de error). */
function firmaValida(buf, ext) {
    const s = buf.toString('latin1');
    if (ext === 'pdf') return s.startsWith('%PDF');
    if (['epub', 'cbz', 'zip', 'kepub'].includes(ext)) return s.startsWith('PK');
    return true;
}

/**
 * PREPARA una copia sana para un depósito: valida (tamaño + firma) y la deja LISTA dentro del depósito
 * (`.reemplazo/`) marcando `estado.listo`. NO cataloga aún (eso lo hace el proceso por lotes). El
 * nombre puede diferir del original roto (los descargados traen un hash): se identifica por contenido.
 */
export async function prepararReemplazo(idDeposito, rutaSubida, { nombreOriginal } = {}) {
    if (!rutaSubida) return { ok: false, motivo: 'no se recibió el fichero sano' };
    const { dir: depDir, error } = depDirDe(idDeposito);
    if (error) return { ok: false, motivo: error };
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'el depósito ya no existe' }; }

    const nombre = path.basename(nombreOriginal || 'copia');
    const ext = (nombre.split('.').pop() || '').toLowerCase();
    let st;
    try { st = await fs.stat(rutaSubida); } catch { return { ok: false, motivo: 'no se pudo leer el fichero subido' }; }
    if (st.size < 1024) {
        await reciclar([rutaSubida], 'saneamiento-vacio').catch(() => {});
        return { ok: false, motivo: `la copia está vacía o es demasiado pequeña (${st.size} B)` };
    }
    if (!firmaValida(await cabecera(rutaSubida).catch(() => Buffer.alloc(8)), ext)) {
        await reciclar([rutaSubida], 'saneamiento-invalida').catch(() => {});
        return { ok: false, motivo: `el fichero no parece un ${ext.toUpperCase() || 'documento'} válido (¿una página de error?)` };
    }

    // Dejar la copia LISTA en `.reemplazo/` (sustituye una anterior si la hubiera).
    const repDir = path.join(depDir, SUBDIR_REEMPLAZO);
    await fs.rm(repDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(repDir, { recursive: true });
    await fs.copyFile(rutaSubida, path.join(repDir, nombre));
    await reciclar([rutaSubida], 'subida-saneamiento').catch(() => {}); // temporal de multer

    const estadoPath = path.join(depDir, 'estado.json');
    let estado = {}; try { estado = JSON.parse(await fs.readFile(estadoPath, 'utf8')); } catch { /* sin estado previo */ }
    estado.listo = true;
    estado.reemplazo = nombre;
    estado.reemplazo_bytes = st.size;
    estado.reemplazo_fecha = new Date().toISOString();
    delete estado.error_proceso;
    await fs.writeFile(estadoPath, JSON.stringify(estado, null, 2), 'utf8');

    console.log(`🩹 Saneamiento: copia LISTA para ${idDeposito} («${nombre}», ${st.size} B).`);
    return { ok: true, reemplazo: nombre, bytes: st.size };
}

/**
 * INTENTA REPARAR el PDF roto de un depósito (qpdf reconstruye el xref) y deja el resultado en el MISMO
 * staging que una copia subida (`.reemplazo/` + `estado.listo`), para que el flujo «inspeccionar → Procesar»
 * ya existente sirva igual. NO cataloga nada: la decisión es tuya.
 *
 * CLAVE (lo pide el usuario): NUNCA se afirma «reparado» a secas. Una reparación puede devolver un documento
 * MUTILADO —las webs tipo iLovePDF a veces reconstruyen 25 páginas de un libro de cientos— y dar eso por bueno
 * sería FALSA SEGURIDAD: creerías tener un libro que no tienes. Por eso se devuelve (y se guarda en el estado)
 * el INFORME: páginas recuperadas, bytes antes/después y la sospecha razonada de mutilación. El original ROTO
 * se conserva intacto por si quieres reintentar con otra herramienta.
 */
export async function repararDeposito(idDeposito) {
    const { dir: depDir, error } = depDirDe(idDeposito);
    if (error) return { ok: false, motivo: error };
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'el depósito ya no existe' }; }

    // El fichero ROTO es el documento del primer nivel del depósito (sin contar sidecars ni el staging).
    let entradas = [];
    try { entradas = await fs.readdir(depDir, { withFileTypes: true }); } catch { /* vacío */ }
    const roto = entradas.find((e) => e.isFile() && !e.name.startsWith('.') && e.name !== 'estado.json'
        && path.extname(e.name).toLowerCase() === '.pdf');
    if (!roto) return { ok: false, motivo: 'en este depósito no hay un PDF que reparar (solo se pueden reparar PDF)' };

    const origen = path.join(depDir, roto.name);
    const repDir = path.join(depDir, SUBDIR_REEMPLAZO);
    await fs.rm(repDir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(repDir, { recursive: true });
    const destino = path.join(repDir, roto.name);

    const inf = await repararPdf(origen, destino);
    if (!inf.ok) {
        await fs.rm(repDir, { recursive: true, force: true }).catch(() => {});
        return { ok: false, sinQpdf: !!inf.sinQpdf, motivo: inf.sinQpdf ? 'qpdf no está instalado en el contenedor' : inf.motivo };
    }

    const estadoPath = path.join(depDir, 'estado.json');
    let estado = {}; try { estado = JSON.parse(await fs.readFile(estadoPath, 'utf8')); } catch { /* sin estado previo */ }
    estado.listo = true;                 // hay candidato en staging → el botón «Procesar» ya lo ve
    estado.reemplazo = roto.name;
    estado.reemplazo_bytes = inf.bytesDestino;
    estado.reemplazo_fecha = new Date().toISOString();
    estado.reparado = true;              // distingue «reparado por nosotros» de «copia sana subida»
    estado.reparacion = {                 // el INFORME, para que la UI lo enseñe tal cual
        paginas: inf.paginas, paginasAntes: inf.paginasAntes ?? null,
        bytesOrigen: inf.bytesOrigen, bytesDestino: inf.bytesDestino, ratio: inf.ratio,
        sospecha: inf.sospecha, motivoSospecha: inf.motivoSospecha,
    };
    delete estado.error_proceso;
    await fs.writeFile(estadoPath, JSON.stringify(estado, null, 2), 'utf8');

    console.log(`🔧 Reparación de ${idDeposito}: ${inf.paginas} págs., ${inf.ratio}× del original${inf.sospecha ? ` ⚠️ SOSPECHA: ${inf.motivoSospecha}` : ''}.`);
    return { ok: true, nombre: roto.name, ...inf };
}

/**
 * DESCARTA el candidato en staging (una reparación que no convence, o una copia subida que no valía) y deja el
 * depósito EXACTAMENTE como estaba: con su fichero ORIGINAL intacto y marcado como NO listo.
 *
 * Hacía falta porque el único «descartar» que existía tiraba el DEPÓSITO ENTERO —original incluido— a la
 * Papelera. Si una reparación no convence, lo que quieres es quedarte con el original en Cuarentena para
 * reintentar con otra herramienta o buscar una copia sana, no perderlo. Y quitar el `listo` importa: si no, el
 * depósito seguiría entrando en el «Procesar» por lotes y se catalogaría un documento mutilado sin querer.
 *
 * El candidato descartado va a la Papelera (no se borra) por coherencia con el resto del proyecto, aunque sea
 * un fichero DERIVADO y siempre reproducible a partir del original.
 */
export async function descartarReemplazo(idDeposito) {
    const { dir: depDir, error } = depDirDe(idDeposito);
    if (error) return { ok: false, motivo: error };
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'el depósito ya no existe' }; }

    const repDir = path.join(depDir, SUBDIR_REEMPLAZO);
    if (await fs.access(repDir).then(() => true, () => false)) {
        await reciclarCarpeta(repDir, `candidato-descartado-${path.basename(depDir)}`).catch(() => {});
        await fs.rm(repDir, { recursive: true, force: true }).catch(() => {});   // si el reciclado ya lo movió, no-op
    }
    const estadoPath = path.join(depDir, 'estado.json');
    let estado = {}; try { estado = JSON.parse(await fs.readFile(estadoPath, 'utf8')); } catch { /* sin estado */ }
    for (const k of ['listo', 'reemplazo', 'reemplazo_bytes', 'reemplazo_fecha', 'reparado', 'reparacion', 'error_proceso'])
        delete estado[k];
    await fs.writeFile(estadoPath, JSON.stringify(estado, null, 2), 'utf8');
    console.log(`↩️  Candidato descartado en ${idDeposito}: el original sigue en Cuarentena.`);
    return { ok: true };
}

/** Ruta ABSOLUTA del candidato en staging de un depósito (para inspeccionarlo antes de decidir). null si no hay. */
export async function rutaReemplazo(idDeposito) {
    const { dir: depDir, error } = depDirDe(idDeposito);
    if (error) return null;
    try {
        const estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8'));
        if (!estado.reemplazo) return null;
        const p = path.join(depDir, SUBDIR_REEMPLAZO, path.basename(estado.reemplazo));
        await fs.access(p);
        return p;
    } catch { return null; }
}

/** Cataloga la copia preparada de UN depósito y, si entra, retira el depósito a la Papelera. */
async function catalogarPreparado(idDeposito) {
    const { dir: depDir, error } = depDirDe(idDeposito);
    if (error) return { ok: false, motivo: error };
    const estadoPath = path.join(depDir, 'estado.json');
    let estado = {}; try { estado = JSON.parse(await fs.readFile(estadoPath, 'utf8')); } catch { /* */ }
    if (!estado.reemplazo) return { ok: false, motivo: 'el depósito no tiene copia preparada' };
    const repFile = path.join(depDir, SUBDIR_REEMPLAZO, estado.reemplazo);
    try { await fs.access(repFile); } catch { return { ok: false, motivo: 'falta el fichero de reemplazo preparado' }; }

    let resultado;
    try {
        resultado = await ingestarRecurso({ rutas: [repFile] });
    } catch (e) {
        estado.error_proceso = e.message;
        await fs.writeFile(estadoPath, JSON.stringify(estado, null, 2), 'utf8').catch(() => {});
        console.error(`🩹 Saneamiento FALLÓ (${idDeposito}): ${e.message}`);
        return { ok: false, motivo: e.message };
    }
    // Éxito → retirar el depósito (original roto + sidecar + .reemplazo) a la Papelera.
    let archivos = [];
    try { archivos = (await fs.readdir(depDir)).filter(n => n !== SUBDIR_REEMPLAZO).map(n => path.join(depDir, n)); } catch { /* */ }
    await reciclar(archivos, 'saneado-ilegible');
    await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    console.log(`🩹 Saneamiento OK (${idDeposito}): «${resultado.documento?.titulo || '—'}» (${resultado.operacion}).`);
    return { ok: true, id: String(resultado._id), titulo: resultado.documento?.titulo || null, operacion: resultado.operacion };
}

// Estado del trabajo por lotes (en memoria; un trabajo a la vez).
let trabajo = { enCurso: false, total: 0, hechos: 0, fallos: 0, actual: null, fin: null, resumen: [] };
export function estadoSaneamiento() { return { ...trabajo, resumen: trabajo.resumen.slice(-50) }; }

/**
 * Procesa EN LOTE (secuencial, en segundo plano) las copias preparadas de los depósitos indicados.
 * Devuelve de inmediato; el progreso se consulta con estadoSaneamiento(). Un solo trabajo a la vez.
 */
export function procesarSaneamiento(ids) {
    if (trabajo.enCurso) return { ok: false, motivo: 'ya hay un proceso de saneamiento en curso' };
    const lista = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean);
    if (!lista.length) return { ok: false, motivo: 'no se seleccionaron depósitos' };
    trabajo = { enCurso: true, total: lista.length, hechos: 0, fallos: 0, actual: null, fin: null, resumen: [] };
    (async () => {
        for (const id of lista) {
            trabajo.actual = id;
            try {
                const r = await catalogarPreparado(id);
                if (r.ok) { trabajo.hechos++; trabajo.resumen.push({ id, ok: true, titulo: r.titulo }); }
                else { trabajo.fallos++; trabajo.resumen.push({ id, ok: false, motivo: r.motivo }); }
            } catch (e) { trabajo.fallos++; trabajo.resumen.push({ id, ok: false, motivo: e.message }); }
        }
        trabajo.actual = null; trabajo.enCurso = false; trabajo.fin = new Date().toISOString();
        console.log(`🩹 Saneamiento por lotes terminado: ${trabajo.hechos} OK · ${trabajo.fallos} fallo(s).`);
    })();
    return { ok: true, ...estadoSaneamiento() };
}
