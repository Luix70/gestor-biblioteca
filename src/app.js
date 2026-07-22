// src/app.js — API REST de ingesta + vigilante del Inbox.
import './utils/consola-timestamp.js'; // marca de tiempo en todos los logs (debe ir lo primero)
import 'dotenv/config';
import './config.js';                  // ajustes por defecto (env > config); debe ir tras dotenv
import axios from 'axios';
// Timeout global para TODA llamada HTTP (APIs bibliográficas). Sin él, una petición que no
// responde bloquea el pipeline indefinidamente y el Inbox parece colgado (CPU al ralentí).
// Un timeout se clasifica como error de red → degradación elegante / Reintentos.
axios.defaults.timeout = Number(process.env.HTTP_TIMEOUT_MS || 20000);
import express from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestarRecurso } from './servicio-ingesta.js';
import { agrupar } from './utils/agrupador.js';
import { enviarACuarentena, enviarAReintentos } from './gestor-fallos.js';
import { esFalloDeConexionMongo } from './database.js';
import { reciclar } from './utils/papelera.js';
import { iniciarVigilante, mantenimientoManual, configurarConformador, estadoConformador } from './vigilante.js';
import { obtenerEstadisticas } from './estadisticas.js';
import { rutasPanel, rutasPublicas } from './api-panel.js';
import { prepararReemplazo } from './utils/saneamiento.js';
import { completarDoc, adjuntarMaterial } from './utils/completar-doc.js';   // adjuntar audio/texto o material a un doc ya catalogado
import { conectarDB } from './database.js';
import { login, logout, validar, autenticar, tokenDe, listarUsuarios, loginBasic } from './auth.js';

// stdout/stderr a un PIPE (contenedor Docker) es ASÍNCRONO: los logs muy tempranos del arranque pueden
// perderse (por eso no salían 📦/🚀 pero sí los posteriores, ya con el event loop drenando). Forzar
// escritura BLOQUEANTE garantiza que TODO log de arranque aparezca en `docker logs`.
try {
    process.stdout?._handle?.setBlocking?.(true);
    process.stderr?._handle?.setBlocking?.(true);
} catch { /* no-op si el handle no soporta setBlocking */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');
const DIR_TMP = path.join(RAIZ, 'temp');
const DIR_PUBLIC = path.join(RAIZ, 'public');
const PUERTO = Number(process.env.PORT || 3000);
const PUERTO_PANEL = Number(process.env.PANEL_PORT || 4000);


await fs.mkdir(DIR_TMP, { recursive: true });

// Guardamos las subidas conservando el nombre original (la extensión guía la detección de tipo).
// Defensa: colapsamos una extensión duplicada redundante (".jpg.jpg" → ".jpg") que algunos clientes o
// reductores de imagen generan, y acotamos el nombre para no estresar el sistema de ficheros — sin
// mutilar por lo demás el nombre (que además de la extensión aporta señales de identificación).
const colapsarExtDup = (n) => String(n || '').replace(/(\.[a-z0-9]{2,5})\1$/i, '$1');
const nombreSubida = (original) => {
    const base = colapsarExtDup(String(original || 'archivo').replace(/^.*[\\/]/, '')); // sin ruta
    const ext = (base.match(/\.[a-z0-9]{2,6}$/i) || [''])[0];
    const cuerpo = base.slice(0, base.length - ext.length);
    // Basura numérica larga (nombres de cámara) o nombre desmesurado → recorte breve; si no, se respeta.
    const limpio = (/^\d{9,}$/.test(cuerpo) ? '' : cuerpo).slice(0, 80) || 'archivo';
    return `${limpio}${ext}`;
};
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_TMP),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${nombreSubida(file.originalname)}`),
    }),
});

const app = express();
app.use(express.json({ limit: '25mb' })); // 25mb: admite imágenes editadas (rotar/recortar/perspectiva) en base64

// AUTO-LOGIN POR URL (https://user:pwd@host): el navegador manda esas credenciales como cabecera
// `Authorization: Basic` en la carga de la página. Las validamos y, si son correctas, sembramos una
// cookie `panel_token` (legible por JS, breve) que el panel recoge al cargar. Se omite si ya hay
// cookie (la cabecera Basic llega en cada petición; no re-mintear). El token real va luego por Bearer.
app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Basic ') && !(req.headers.cookie || '').includes('panel_token=')) {
        const r = loginBasic(auth);
        if (r) { res.cookie('panel_token', r.token, { maxAge: 600000, path: '/', sameSite: 'lax' }); console.log(`🔑 Auto-login por URL: ${r.usuario} (${r.rol}).`); }
        else console.warn('🔑 Auto-login por URL: cabecera Basic recibida pero credenciales inválidas.');
    }
    next();
});

// Servir el catálogo (portadas, imágenes y ficheros) como estático para el front-end.
// Forzamos Content-Disposition: inline en los formatos que el navegador sabe mostrar (PDF, imágenes)
// para que los PREVISUALICE en lugar de descargarlos (algunos navegadores de escritorio, sin esta
// cabecera, descargan el PDF embebido). Los demás formatos se sirven tal cual (el front ofrece descarga).
app.use('/recursos', express.static(DIR_CDU, {
    // `dotfiles:'allow'` sirve rutas con carpetas/archivos que empiezan por punto — necesario para las
    // portadas derivadas de las colecciones transmedia, que viven en «<colección>/.portadas/» (oculta a
    // propósito para que la verificación de copia la ignore). Por defecto express.static las 404. Aquí no
    // hay secretos bajo el árbol CDU (solo marcadores .ruta_fija/.transmedia y estas portadas).
    dotfiles: 'allow',
    setHeaders: (res, ruta) => {
        if (/\.(pdf|jpe?g|png|webp|gif|svg)$/i.test(ruta)) res.setHeader('Content-Disposition', 'inline');
    },
}));

// Panel de control (estático). La página y el login son públicos; los datos van por /api (protegido).
app.use(express.static(DIR_PUBLIC, {
    setHeaders: (res, ruta) => {
        // NO cachear lo que cambia en cada despliegue (así se ve YA, sin Ctrl+F5): el HTML, el service worker
        // y los ficheros del panel (app.js/styles.css). Los vendored (/vendor, qrcode.js) SÍ se cachean.
        if (/\.html$/i.test(ruta) || ruta.endsWith('sw.js') || ruta.endsWith('app.js') || ruta.endsWith('styles.css'))
            res.setHeader('Cache-Control', 'no-cache');
    },
}));

// AUTENTICACIÓN: login público + estado de sesión + logout, y la PUERTA del resto de /api.
// Regla: GET = lectura (admin y guest); cualquier mutación = solo admin.
app.post('/api/login', (req, res) => {
    const { usuario, password } = req.body || {};
    const r = login(usuario, password);
    if (!r) return res.status(401).json({ ok: false, motivo: 'usuario o contraseña incorrectos' });
    res.json({ ok: true, ...r });
});
app.get('/api/yo', (req, res) => res.json(validar(tokenDe(req)) || { rol: null }));
app.post('/api/logout', (req, res) => { logout(tokenDe(req)); res.json({ ok: true }); });
// Lista de usuarios (SIN contraseñas) para el desplegable del login. Público (antes de la puerta).
app.get('/api/usuarios', (req, res) => res.json({ usuarios: listarUsuarios() }));
// Versión desplegada («v1.<serie>»): PÚBLICA (antes de la puerta) para poder mostrarla en el pie del menú
// incluso antes del login. Sin datos sensibles (solo etiqueta/commit/rama).
app.get('/api/version', (req, res) => res.json({ ok: true, ...versionApp() }));
// EX-LIBRIS (cartela «Este libro pertenece a…» del panel y de las etiquetas NFC): nombre del bibliotecario +
// contacto para «devolver si se pierde», desde el .env. PÚBLICA a propósito (antes de la puerta): la idea es
// que quien ENCUENTRE un libro fuera de la biblioteca pueda ver de quién es y cómo devolverlo (datos que el
// dueño expone voluntariamente). NOMBRE_BIBLIOTECA opcional (por defecto «BIBLIOTHECA LUDOVICIANA»).
app.get('/api/exlibris', (req, res) => res.json({
    biblioteca: process.env.NOMBRE_BIBLIOTECA || 'BIBLIOTHECA LUDOVICIANA',
    nombre: process.env.NOMBRE_BIBLIOTECARIO || '',
    email: process.env.EMAIL || '',
    telefono: process.env.TELEFONO || '',
}));
// Vista COMPARTIDA por QR: pública (antes de la puerta), pero solo devuelve la ficha del documento cuyo
// token firmado se presenta — no autentica ni abre nada más de la app.
app.use('/api', rutasPublicas());
app.use('/api', autenticar); // todo lo que sigue bajo /api exige sesión

// Rutas de operación del panel (protegidas por la puerta anterior).
app.use('/api', rutasPanel());

/** Extrae la ubicación física del cuerpo de la petición (para libros/revistas en papel). */
function ubicacionDe(body) {
    if (!body) return undefined;
    if (body.ubicacion) {
        try { return typeof body.ubicacion === 'string' ? JSON.parse(body.ubicacion) : body.ubicacion; }
        catch { /* ignore */ }
    }
    if (body.ambito && body.estanteria) return { ambito: body.ambito, estanteria: body.estanteria };
    return undefined;
}

// Cota de tiempo por recurso ingerido (env > config). Si el pipeline se atasca con un fichero enorme,
// la carrera la gana el timeout → el `catch` lo manda a Cuarentena con aviso (nunca un cuelgue silencioso).
// El pipeline subyacente (poppler) tiene sus propios timeouts, así que la promesa perdedora termina sola;
// le colgamos un `.catch` para que no genere un rechazo sin gestionar.
const INGESTA_TIMEOUT_MS = Number(process.env.INGESTA_TIMEOUT_MS) || 1200000;
function conTimeoutIngesta(promesa, mensaje) {
    let t;
    const limite = new Promise((_, rej) => {
        t = setTimeout(() => { const e = new Error(mensaje); e.tipo = 'timeout'; rej(e); }, INGESTA_TIMEOUT_MS);
    });
    promesa.catch(() => {});   // la promesa que pierde la carrera no debe provocar un unhandledRejection
    return Promise.race([promesa, limite]).finally(() => clearTimeout(t));
}

app.post('/api/ingestar', upload.array('files'), async (req, res) => {
    const archivos = (req.files || []).map(f => f.path);
    if (archivos.length === 0) {
        return res.status(400).json({ status: 'error', message: 'No se recibieron archivos.' });
    }

    // Metadatos del FORMULARIO del Inbox que VIAJAN con la subida (igual que el contexto de un drop de
    // carpeta): ubicación física, colección, obra e ISBN conocido → el pipeline hace menos trabajo.
    const ubicacion = ubicacionDe(req.body);
    const coleccion = String(req.body?.coleccion || '').trim() || null;
    const obraTit   = String(req.body?.obra || '').trim() || null;
    const isbnForm  = String(req.body?.isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase() || null;
    const isbnOrigen = String(req.body?.isbn_origen || '').trim() || null;   // 'movil' = leído del código de barras en el cliente
    const conformar = req.body?.conformar === '1' || req.body?.conformar === true || req.query?.conformar === '1';
    const baseCtx = {};
    if (ubicacion) baseCtx.ubicacion = ubicacion;
    if (coleccion) { baseCtx.coleccion = coleccion; baseCtx.serieAuto = true; } // serie de libros → autonumera
    if (obraTit)   baseCtx.obra = { titulo: obraTit };
    if (conformar) baseCtx.conformar = true;

    const unidades = agrupar(archivos);
    const resultados = [];

    for (const unidad of unidades) {
        const ctx = { ...baseCtx };
        // El ISBN del formulario solo aplica a UN libro (un grupo de imágenes, o una única unidad subida).
        if (isbnForm && (unidad.esImagenes || unidades.length === 1)) { ctx.isbn = isbnForm; if (isbnOrigen) ctx.isbn_origen = isbnOrigen; }
        try {
            const r = await conTimeoutIngesta(
                ingestarRecurso({ rutas: unidad.rutas, contexto: ctx }),
                `La ingesta tardó más de ${Math.round(INGESTA_TIMEOUT_MS / 1000)} s y se detuvo (fichero demasiado grande o pesado). Enviado a Cuarentena para revisión manual.`,
            );
            resultados.push({
                ok: true, operacion: r.operacion, estado: r.estado,
                id: String(r._id), isbn: r.isbn, issn: r.issn,
                // Aviso «ya ingresado» (doc preexistente): fecha de alta y ubicación reales del existente.
                ya_existia: !!r.ya_existia || r.operacion === 'duplicado' || r.operacion === 'duplicado_exacto' || r.operacion === 'posible_duplicado',
                fecha_ingreso: r.fecha_ingreso || null,
                ubicacion_existente: r.ubicacion || null,
                titulo: r.documento.titulo, ruta: r.rutaWeb,
                // Pistas del proceso para el Inbox (qué se hizo y dónde): tipo, soporte, nº de páginas/
                // imágenes extraídas y la última nota del agente (p. ej. "sin visión IA" / "libro físico").
                tipo_recurso: r.documento.tipo_recurso || null,
                formatos: r.documento.formatos || [],
                nImagenes: (r.documento.imagenes || []).length,
                nota: (r.documento.alertas_agente || []).slice(-1)[0] || null,
            });
        } catch (e) {
            // Igual que en el Vigilante: un error crudo del driver de Mongo no trae `.tipo` y acababa en
            // Cuarentena como «sin identificar». Es infraestructura → Reintentos, que es reversible.
            if (e.tipo === 'infraestructura' || esFalloDeConexionMongo(e)) {
                await enviarAReintentos(unidad.rutas, { error: { tipo: e.tipo, mensaje: e.message }, documento: e.documentoParcial || null });
                resultados.push({ ok: false, destino: 'reintentos', error: e.message });
            } else {
                await enviarACuarentena(unidad.rutas, { error: { tipo: e.tipo || 'desconocido', mensaje: e.message } });
                resultados.push({ ok: false, destino: 'cuarentena', error: e.message });
            }
        }
    }

    // Política "nunca borrar": los temporales de subida (ya copiados al catálogo) se MUEVEN a la
    // Papelera de Reciclaje en vez de eliminarse, por si hiciera falta recuperarlos.
    await reciclar(archivos, 'subida-api');

    const huboError = resultados.some(r => !r.ok);
    res.status(huboError ? 207 : 200).json({ status: huboError ? 'partial' : 'success', resultados });
});

// SANEAMIENTO: PREPARAR una copia sana para un depósito de Cuarentena (ilegible/no-identificado/otro).
// Valida (tamaño + firma) y la deja LISTA dentro del depósito; NO cataloga aún (eso lo hace el proceso
// por lotes). Mutación → la puerta `autenticar` ya exige rol admin. Body: { id } (idDeposito) + file.
// nombreOriginal = el nombre REAL subido (multer lo guarda con prefijo de fecha); el catálogo lo
// conservará. Puede diferir del original roto (los descargados traen un hash): se identifica por contenido.
app.post('/api/saneamiento/reemplazar', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, motivo: 'no se recibió ningún fichero' });
    try {
        const r = await prepararReemplazo(req.body?.id, req.file.path, { nombreOriginal: req.file.originalname });
        res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
        await reciclar([req.file.path], 'saneamiento-error').catch(() => {});
        res.status(500).json({ ok: false, motivo: e.message });
    }
});

// COMPLETAR un documento ya catalogado: adjuntarle los ficheros que le faltaban (el PDF de un audiolibro, los
// audios de un libro…). El audio entra en `audios[]` (playlist) y el texto en `textos[]` (selector del visor);
// lo demás se queda como material en su carpeta. Mutación → la puerta `autenticar` ya exige rol admin.
// Body: files[] (multipart) + `naturaleza` opcional ('audiolibro' | 'libro') = destino elegido en el diálogo.
app.post('/api/documentos/:id/completar', upload.array('files'), async (req, res) => {
    const subidos = req.files || [];
    if (!subidos.length) return res.status(400).json({ ok: false, motivo: 'no se recibió ningún fichero' });
    try {
        const r = await completarDoc(await conectarDB(), req.params.id, {
            ficheros: subidos.map((f) => ({ ruta: f.path, nombre: f.originalname })),
            naturaleza: ['audiolibro', 'libro'].includes(req.body?.naturaleza) ? req.body.naturaleza : null,
        });
        // Los temporales de multer ya se copiaron a la carpeta del doc: se retiran a la Papelera (nunca borrar).
        await reciclar(subidos.map((f) => f.path), r.ok ? 'completar-ingerido' : 'completar-error').catch(() => {});
        res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
        await reciclar(subidos.map((f) => f.path), 'completar-error').catch(() => {});
        res.status(500).json({ ok: false, motivo: e.message });
    }
});

// ADJUNTAR MATERIAL VERBATIM a un documento ya catalogado: una CARPETA entera (software, datasets) o ficheros
// sueltos (un PDF con la crítica del libro). Se copian a la carpeta del doc CONSERVANDO subcarpetas y quedan en
// «🗂️ Archivos» + «📎 Material». El cliente manda los ficheros en `files` y, en paralelo, `rutas` = JSON con la
// ruta relativa de cada uno (webkitRelativePath, para preservar la estructura al subir una carpeta).
app.post('/api/documentos/:id/adjuntar', upload.array('files'), async (req, res) => {
    const subidos = req.files || [];
    if (!subidos.length) return res.status(400).json({ ok: false, motivo: 'no se recibió ningún fichero' });
    let rutas = [];
    try { rutas = JSON.parse(req.body?.rutas || '[]'); } catch { rutas = []; }
    try {
        const items = subidos.map((f, i) => ({
            ruta: f.path,
            // La ruta relativa (con subcarpetas) viaja en `rutas[i]`; si falta, se agrupa bajo «adjuntos/».
            rel: (Array.isArray(rutas) && rutas[i]) ? String(rutas[i]) : ('adjuntos/' + (f.originalname || 'archivo')),
        }));
        const soloAdmin = req.body?.soloAdmin === '1' || req.body?.soloAdmin === 'true';
        const r = await adjuntarMaterial(await conectarDB(), req.params.id, { items, soloAdmin });
        await reciclar(subidos.map((f) => f.path), r.ok ? 'adjuntar-ingerido' : 'adjuntar-error').catch(() => {});
        res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
        await reciclar(subidos.map((f) => f.path), 'adjuntar-error').catch(() => {});
        res.status(500).json({ ok: false, motivo: e.message });
    }
});

// Dispara el Conformador MANUALMENTE (no corre solo). Vacía el backlog en rondas de
// MANTENIMIENTO_LOTE (25) en segundo plano, cediendo a la ingesta y reintentando hasta vaciarlo.
// Parámetros (query o body):
//   activar (M): CUÁNDO arrancar — 0 = ya · N>0 = en N s · -1 = cuando el Inbox quede inactivo.
//   intervalo (N): pausa en segundos entre rondas — 0 = continuo.
//   POST /api/mantenimiento?activar=-1&intervalo=30   ó   body { "activar": -1, "intervalo": 30 }
// Detén un mantenimiento en curso con POST /api/mantenimiento/modo { "modo": "apagado" }.
// 409 si ya hay un mantenimiento manual en curso.
app.post('/api/mantenimiento', (req, res) => {
    const intervaloSegundos = Number(req.query.intervalo ?? req.body?.intervalo ?? 0) || 0;
    const activarSegundos = Number(req.query.activar ?? req.query.activate ?? req.body?.activar ?? req.body?.activate ?? 0) || 0;
    const r = mantenimientoManual({ intervaloSegundos, activarSegundos });
    res.status(r.ok ? 202 : 409).json(r);
});

// Estado actual del Conformador: modo, si está dormido, cuándo expira un apagado, última revisión.
app.get('/api/mantenimiento/estado', (req, res) => {
    res.json(estadoConformador());
});

// Cambia el modo del Conformador en caliente.
// Body: { "modo": "diferido"|"apagado"|"apagado-hasta", "hasta": "proxima-hora"|"proximo-dia"|"proxima-semana" }
// "hasta" solo es necesario cuando modo="apagado-hasta".
app.post('/api/mantenimiento/modo', (req, res) => {
    const { modo, hasta } = req.body || {};
    const r = configurarConformador({ modo, hasta });
    res.status(r.ok ? 200 : 400).json(r);
});

// Estadísticas del catálogo: totales libros/revistas, cabeceras de revista con nº de números,
// CDU con descripción y recuento, y defectos (sin ISBN/hash/portada…). ?detalle=0 → solo resumen.
app.get('/api/estadisticas', async (req, res) => {
    try {
        const detalle = req.query.detalle !== '0' && req.query.detalle !== 'false';
        res.json(await obtenerEstadisticas({ detalle }));
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Commit que está corriendo el contenedor (observabilidad: verificar que un despliegue trae lo último).
// Se detecta, en orden: variable de entorno GIT_COMMIT (si el script de despliegue la define, lo más fiable),
// lectura directa de .git/HEAD (sin binario git), binario `git`, o «desconocido».
function versionEnEjecucion() {
    if (process.env.GIT_COMMIT) {
        return { commit: String(process.env.GIT_COMMIT).slice(0, 10), rama: process.env.GIT_BRANCH || null, origen: 'env' };
    }
    // Fichero VERSION en la raíz (lo escribe el script de despliegue). Funciona con TARBALL, que no trae
    // carpeta .git — es la vía fiable en el NAS. Formato: «<sha> <rama> <serie>» (rama y serie opcionales).
    // La SERIE es el nº de commit (build incremental) → se muestra como «v1.<serie>» para no adivinar.
    try {
        const txt = readFileSync(path.join(RAIZ, 'VERSION'), 'utf8').trim();
        if (txt) {
            const [sha, rama, serie] = txt.split(/\s+/);
            return { commit: sha.slice(0, 10), rama: rama || null, serie: serie || null, origen: 'VERSION' };
        }
    } catch { /* sin fichero VERSION */ }
    try {
        const gitDir = path.join(RAIZ, '.git');
        const head = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*(.+)$/);
        if (ref) {
            const rama = ref[1].replace('refs/heads/', '');
            let commit = null;
            try {
                commit = readFileSync(path.join(gitDir, ref[1]), 'utf8').trim();
            } catch {
                const packed = readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
                const linea = packed.split('\n').find((l) => l.endsWith(' ' + ref[1]));
                if (linea) commit = linea.split(' ')[0];
            }
            if (commit) return { commit: commit.slice(0, 10), rama, origen: '.git' };
        } else if (/^[0-9a-f]{7,40}$/i.test(head)) {
            return { commit: head.slice(0, 10), rama: '(detached)', origen: '.git' };
        }
    } catch { /* sin carpeta .git en el contenedor */ }
    try {
        const commit = execSync('git rev-parse --short HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        const rama = execSync('git rev-parse --abbrev-ref HEAD', { cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        if (commit) return { commit, rama, origen: 'git' };
    } catch { /* sin binario git */ }
    return { commit: 'desconocido', rama: null, serie: null, origen: null };
}

// Versión mayor (el «1» de «v1.<serie>»), tomada de package.json. Se lee una vez; si falla, «1».
const VERSION_MAYOR = (() => {
    try { return String(JSON.parse(readFileSync(path.join(RAIZ, 'package.json'), 'utf8')).version || '1').split('.')[0] || '1'; }
    catch { return '1'; }
})();

// Versión legible para mostrar en la app: «v1.<serie>» (nº de commit incremental) cuando el despliegue
// resolvió la serie; si no, se cae al commit corto. Devuelve todo (etiqueta + commit + rama + serie) para
// el endpoint /api/version y el log de arranque.
function versionApp() {
    const v = versionEnEjecucion();
    const etiqueta = v.serie ? `v${VERSION_MAYOR}.${v.serie}` : (v.commit && v.commit !== 'desconocido' ? `commit ${v.commit}` : 'desconocida');
    return { etiqueta, ...v };
}

// Node corta la RECEPCIÓN de una petición a los 5 min por defecto (requestTimeout) → una subida grande
// (100+ MB) por un enlace lento se abortaría a mitad. Lo subimos a REQUEST_TIMEOUT_MS en cada servidor.
// El socket no tiene timeout de INACTIVIDAD por defecto (server.timeout=0), así que el PROCESADO largo
// posterior NO se corta (su cota es INGESTA_TIMEOUT_MS a nivel de app). OJO: un proxy inverso delante
// (DSM) puede tener su propio timeout de lectura (p. ej. 60 s) — súbelo allí si las subidas grandes fallan.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 1200000;
function ajustarTimeoutsServidor(servidor) {
    servidor.requestTimeout = REQUEST_TIMEOUT_MS;
    if (servidor.headersTimeout && servidor.headersTimeout > REQUEST_TIMEOUT_MS) servidor.headersTimeout = REQUEST_TIMEOUT_MS;
}

ajustarTimeoutsServidor(app.listen(PUERTO, () => {
    console.log(`🚀 API REST de ingesta activa en el puerto ${PUERTO}`);
    if (process.env.DESACTIVAR_VIGILANTE !== '1') {
        iniciarVigilante().catch(e => console.error('No se pudo iniciar el vigilante:', e.message));
    }
}));

// El mismo servidor (API + estáticos + panel) escucha también en el puerto del PANEL, para
// acceder al cuadro de mando sin CORS (la página y su /api comparten origen).
if (PUERTO_PANEL && PUERTO_PANEL !== PUERTO) {
    ajustarTimeoutsServidor(app.listen(PUERTO_PANEL, () => {
        // El puerto es el INTERNO del contenedor; el acceso real suele ser por proxy inverso + HTTPS
        // (p. ej. https://j56.diskstation.me:4443). Se muestra PANEL_PUBLIC_URL si está definida en .env.
        const urlPublica = process.env.PANEL_PUBLIC_URL || '';
        console.log(`🎛️  Panel de control: puerto ${PUERTO_PANEL} (interno del contenedor)${urlPublica ? ` · acceso: ${urlPublica}` : ' · accede por tu proxy/HTTPS configurado'}`);
        // Versión en ejecución JUNTO al log del panel (que sí se imprime siempre; los logs de arranque más
        // tempranos se pierden en el pipe del contenedor). Así tienes el commit a la vista de forma fiable.
        const v = versionApp();
        console.log(`📦  Versión en ejecución: ${v.etiqueta}${v.commit && v.commit !== 'desconocido' ? ` · commit ${v.commit}` : ''}${v.rama ? ` (${v.rama})` : ''}${v.origen ? ` · vía ${v.origen}` : ''}`);
        if (!process.env.ADMIN_PWD && !process.env.PANEL_ADMIN_PASSWORD)
            console.warn('⚠️  ADMIN_PWD no definido: el admin "Luis" no podrá entrar (solo "guest"/lectura). Defínelo en .env.');
    }));
}
