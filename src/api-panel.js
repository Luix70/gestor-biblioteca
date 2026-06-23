import express from 'express';
import { ObjectId } from 'mongodb';
import { conectarDB } from './database.js';
import { configurarVigilante, estadoVigilante, estadoConformador } from './vigilante.js';
import {
    infoPapelera, contenidoPapelera, vaciarPapelera,
    listarCuarentena, reingestarCuarentena, reingestarTodosDuplicados, ingestaPorDia,
} from './utils/inspeccion.js';
import { compararDuplicado, resolverDuplicado } from './utils/duplicados.js';
import { purgarObra } from './utils/purga.js';
import { resolverObraPorIsbn } from './utils/obra-autoridad.js';
import { ultimasLineas, infoLog, purgarLog } from './utils/registro-logs.js';

/**
 * Rutas del PANEL DE CONTROL (montadas bajo /api). Acciones de operación: vigilante, papelera,
 * cuarentena, purga de obras, ingesta por día. (Mantenimiento y estadísticas viven en app.js.)
 */
export function rutasPanel() {
    const r = express.Router();

    // Estado consolidado (vigilante + conformador) para la cabecera del panel.
    r.get('/estado', (req, res) => {
        res.json({ vigilante: estadoVigilante(), conformador: estadoConformador() });
    });

    // Pausar / reanudar el vigilante. Body { activo: bool }.
    r.post('/vigilante', (req, res) => {
        const { activo } = req.body || {};
        if (typeof activo !== 'boolean') return res.status(400).json({ ok: false, motivo: 'falta { activo: true|false }' });
        res.json({ ok: true, ...configurarVigilante({ activo }) });
    });

    // Ingesta por día (gráfica). ?dias=30
    r.get('/ingesta', async (req, res) => {
        try { res.json(await ingestaPorDia(Math.min(365, Math.max(1, Number(req.query.dias) || 30)))); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Papelera (Recycling) ──
    r.get('/papelera', async (req, res) => {
        try { res.json(await infoPapelera()); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.get('/papelera/contenido', async (req, res) => {
        try { res.json({ sub: req.query.sub || null, ficheros: await contenidoPapelera(req.query.sub) }); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/papelera/vaciar', async (req, res) => {
        try { res.json(await vaciarPapelera(req.body?.sub || null)); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Cuarentena ──
    r.get('/cuarentena', async (req, res) => {
        try { res.json(await listarCuarentena()); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/cuarentena/reingestar', async (req, res) => {
        try {
            const r2 = await reingestarCuarentena(req.body?.id);
            res.status(r2.ok ? 200 : 400).json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    // Comparar un duplicado: catalogado vs entrante (tamaño/páginas/fecha/legible + recomendación).
    r.get('/cuarentena/duplicado', async (req, res) => {
        try {
            const r2 = await compararDuplicado(req.query.id);
            res.status(r2.ok ? 200 : 400).json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    // Resolver un duplicado. Body { id, quedarse: 'existente'|'entrante'|'ambos' }. (POST → solo admin.)
    r.post('/cuarentena/duplicado/resolver', async (req, res) => {
        try {
            const { id, quedarse } = req.body || {};
            const r2 = await resolverDuplicado(id, quedarse);
            res.status(r2.ok ? 200 : 400).json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    // Reprocesar TODO Cuarentena/duplicados (vuelven al Inbox; la lógica actual los resuelve sola).
    r.post('/cuarentena/duplicados/reprocesar-todos', async (req, res) => {
        try { res.json(await reingestarTodosDuplicados()); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Purga de obra multivolumen (simulación por defecto; ejecutar:true aplica) ──
    r.post('/obras/purgar', async (req, res) => {
        try {
            const { clave, ejecutar } = req.body || {};
            if (!clave) return res.status(400).json({ ok: false, motivo: 'falta { clave: isbn_obra|título }' });
            const db = await conectarDB();
            res.json(await purgarObra(db, String(clave), { ejecutar: ejecutar === true }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Re-consultar a la autoridad el título/sinopsis de una obra por su isbn_obra (botón del panel).
    r.post('/obras/requery', async (req, res) => {
        try {
            const id = req.body?.id;
            if (!id || !ObjectId.isValid(id)) return res.status(400).json({ ok: false, motivo: 'falta { id } válido' });
            const db = await conectarDB();
            res.json(await resolverObraPorIsbn(db, new ObjectId(id), { force: true }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Logs (vista en vivo + tamaño + purga) ──
    r.get('/logs', (req, res) => res.json({ lineas: ultimasLineas(Math.min(2000, Math.max(20, Number(req.query.n) || 400))) }));
    r.get('/logs/info', (req, res) => res.json(infoLog()));
    r.post('/logs/purgar', (req, res) => {
        const { dias, todo } = req.body || {};
        res.json(purgarLog({ dias, todo: todo === true }));
    });

    // Lista de obras (con su estado de completitud) para el panel.
    r.get('/obras', async (req, res) => {
        try {
            const db = await conectarDB();
            const obras = await db.collection('obras')
                .find({}, { projection: { titulo: 1, isbn_obra: 1, total_volumenes: 1, volumenes_presentes: 1, completa: 1, revision_requerida: 1 } })
                .sort({ revision_requerida: -1, completa: 1, titulo: 1 }).limit(500).toArray();
            res.json(obras.map(o => ({ ...o, _id: String(o._id) })));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    return r;
}
