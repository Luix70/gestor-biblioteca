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
import { reciclar } from './utils/papelera.js';
import { iniciarVigilante, mantenimientoManual, configurarConformador, estadoConformador } from './vigilante.js';
import { obtenerEstadisticas } from './estadisticas.js';
import { rutasPanel, rutasPublicas } from './api-panel.js';
import { prepararReemplazo } from './utils/saneamiento.js';
import { login, logout, validar, autenticar, tokenDe, listarUsuarios, loginBasic } from './auth.js';

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

// Commit en ejecución: se registra LO PRIMERO (a nivel de módulo, no dentro de un callback de listen), para
// que salga siempre al arrancar, sin depender del orden de arranque de los puertos.
{
    const v = versionEnEjecucion();
    console.log(`📦 Versión en ejecución: commit ${v.commit}${v.rama ? ` (${v.rama})` : ''}${v.origen ? ` · vía ${v.origen}` : ''}`);
    if (v.commit === 'desconocido') {
        console.log('   ⓘ  El contenedor no expone el commit: que el script de despliegue exporte GIT_COMMIT (o incluya la carpeta .git).');
    }
}

await fs.mkdir(DIR_TMP, { recursive: true });

// Guardamos las subidas conservando el nombre original (la extensión guía la detección de tipo).
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_TMP),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
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
            const r = await ingestarRecurso({ rutas: unidad.rutas, contexto: ctx });
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
            if (e.tipo === 'infraestructura') {
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
    return { commit: 'desconocido', rama: null, origen: null };
}

app.listen(PUERTO, () => {
    console.log(`🚀 API REST de ingesta activa en el puerto ${PUERTO}`);
    if (process.env.DESACTIVAR_VIGILANTE !== '1') {
        iniciarVigilante().catch(e => console.error('No se pudo iniciar el vigilante:', e.message));
    }
});

// El mismo servidor (API + estáticos + panel) escucha también en el puerto del PANEL, para
// acceder al cuadro de mando sin CORS (la página y su /api comparten origen).
if (PUERTO_PANEL && PUERTO_PANEL !== PUERTO) {
    app.listen(PUERTO_PANEL, () => {
        console.log(`🎛️  Panel de control en http://localhost:${PUERTO_PANEL}`);
        if (!process.env.ADMIN_PWD && !process.env.PANEL_ADMIN_PASSWORD)
            console.warn('⚠️  ADMIN_PWD no definido: el admin "Luis" no podrá entrar (solo "guest"/lectura). Defínelo en .env.');
    });
}
