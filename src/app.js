// src/app.js — API REST de ingesta + vigilante del Inbox.
import './utils/consola-timestamp.js'; // marca de tiempo en todos los logs (debe ir lo primero)
import 'dotenv/config';
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
import { iniciarVigilante } from './vigilante.js';

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

    // Limpieza de los temporales de subida (el servicio ya copió lo necesario al catálogo).
    for (const f of archivos) await fs.rm(f, { force: true }).catch(() => {});

    const huboError = resultados.some(r => !r.ok);
    res.status(huboError ? 207 : 200).json({ status: huboError ? 'partial' : 'success', resultados });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PUERTO, () => {
    console.log(`🚀 API REST de ingesta activa en el puerto ${PUERTO}`);
    if (process.env.DESACTIVAR_VIGILANTE !== '1') {
        iniciarVigilante().catch(e => console.error('No se pudo iniciar el vigilante:', e.message));
    }
});
