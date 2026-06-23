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
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestarRecurso } from './servicio-ingesta.js';
import { agrupar } from './utils/agrupador.js';
import { enviarACuarentena, enviarAReintentos } from './gestor-fallos.js';
import { reciclar } from './utils/papelera.js';
import { iniciarVigilante, mantenimientoManual, configurarConformador, estadoConformador } from './vigilante.js';
import { obtenerEstadisticas } from './estadisticas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');
const DIR_TMP = path.join(RAIZ, 'temp');
const PUERTO = Number(process.env.PORT || 3000);

await fs.mkdir(DIR_TMP, { recursive: true });

// Guardamos las subidas conservando el nombre original (la extensión guía la detección de tipo).
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, DIR_TMP),
        filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
    }),
});

const app = express();
app.use(express.json());

// Servir el catálogo (portadas e imágenes) como estático para el front-end.
app.use('/recursos', express.static(DIR_CDU));

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

    const ubicacion = ubicacionDe(req.body);
    const contexto = ubicacion ? { ubicacion } : {};
    const unidades = agrupar(archivos);
    const resultados = [];

    for (const unidad of unidades) {
        const ctx = unidad.esImagenes ? contexto : (ubicacion ? { ubicacion } : {});
        try {
            const r = await ingestarRecurso({ rutas: unidad.rutas, contexto: ctx });
            resultados.push({
                ok: true, operacion: r.operacion, estado: r.estado,
                id: String(r._id), isbn: r.isbn, issn: r.issn,
                titulo: r.documento.titulo, ruta: r.rutaWeb,
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

app.listen(PUERTO, () => {
    console.log(`🚀 API REST de ingesta activa en el puerto ${PUERTO}`);
    if (process.env.DESACTIVAR_VIGILANTE !== '1') {
        iniciarVigilante().catch(e => console.error('No se pudo iniciar el vigilante:', e.message));
    }
});
