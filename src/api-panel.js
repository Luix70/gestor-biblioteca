import express from 'express';
import { ObjectId } from 'mongodb';
import { conectarDB } from './database.js';
import { configurarVigilante, estadoVigilante, estadoConformador } from './vigilante.js';
import {
    infoPapelera, contenidoPapelera, vaciarPapelera,
    listarCuarentena, reingestarCuarentena, descartarCuarentena, descartarCategoria, reingestarTodosDuplicados, ingestaPorDia,
} from './utils/inspeccion.js';
import { verificarPasswordAdmin } from './auth.js';
import { compararDuplicado, resolverDuplicado } from './utils/duplicados.js';
import { verificarIntegridad } from './integridad.js';
import { purgarObra } from './utils/purga.js';
import { resolverObraPorIsbn } from './utils/obra-autoridad.js';
import { ultimasLineas, infoLog, purgarLog } from './utils/registro-logs.js';
import { resolverNombres } from './utils/registro.js';
import { sanitizarCDU } from './utils/cdu-arbol.js';
import { fuentesCopia, procesarSaneamiento, estadoSaneamiento } from './utils/saneamiento.js';
import { describirCDU } from './utils/descripcion-cdu.js';
import { describirClasificacion } from './utils/descripcion-clasificacion.js';

// Proyección mínima de un documento para mostrarlo como "tomo" en la vista de obra.
const PROY_VOL = { titulo: 1, volumen_titulo: 1, volumen_numero: 1, formatos: 1, isbn: 1, portada: 1, paginas: 1, tipo_recurso: 1 };

// URL servible (en /recursos) del fichero original de un documento. Solo se codifica el nombre del
// fichero: ruta_base ya viene saneada para web (utils/rutas.js) y sus segmentos son seguros.
const urlArchivo = (doc) => (doc.ruta_base && doc.nombre_archivo)
    ? `${doc.ruta_base}/${encodeURIComponent(doc.nombre_archivo)}` : null;

// Descripción legible (ES/EN) de un código CDU desde 'cdu_descripciones' (clave = código saneado).
async function cduDesc(db, cdu) {
    if (!cdu) return null;
    const codigo = sanitizarCDU(cdu);
    if (!codigo) return null;
    return await db.collection('cdu_descripciones').findOne(
        { codigo }, { projection: { titulo_es: 1, descripcion_es: 1, titulo_en: 1, descripcion_en: 1 } });
}

// Resuelve un ObjectId → nombre (editorial/colección/obra…) sin reventar si falta.
async function nombrePorId(db, coleccion, id, campo = 'nombre') {
    if (!id) return null;
    const d = await db.collection(coleccion).findOne({ _id: id }, { projection: { [campo]: 1 } });
    return d ? d[campo] : null;
}

// Escapa una cadena para usarla literal dentro de una expresión regular de MongoDB.
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    // Descartar un depósito: a la Papelera (carpeta intacta) + fuera de Cuarentena. Body { id }.
    r.post('/cuarentena/descartar', async (req, res) => {
        try {
            const r2 = await descartarCuarentena(req.body?.id);
            res.status(r2.ok ? 200 : 400).json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    // Descartar una CATEGORÍA entera (destructivo) → exige re-confirmar la contraseña de admin.
    r.post('/cuarentena/categoria/descartar', async (req, res) => {
        const { cat, password } = req.body || {};
        if (!verificarPasswordAdmin(password)) return res.status(403).json({ ok: false, motivo: 'contraseña de administrador incorrecta' });
        try { res.json(await descartarCategoria(cat)); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
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

    // Fuentes de "buscar copia" para sanear ilegibles (configurables en config.js / .env FUENTES_COPIA).
    r.get('/saneamiento/fuentes', (req, res) => res.json({ ok: true, fuentes: fuentesCopia() }));

    // Procesar EN LOTE (segundo plano) las copias preparadas. Body { ids:[...] }. (POST → solo admin.)
    r.post('/saneamiento/procesar', (req, res) => {
        const r2 = procesarSaneamiento(req.body?.ids);
        res.status(r2.ok ? 202 : 409).json(r2);
    });
    // Progreso del trabajo de saneamiento por lotes (para el panel).
    r.get('/saneamiento/estado', (req, res) => res.json(estadoSaneamiento()));

    // ── Integridad: diagnóstico (o diagnóstico+reparación) a voluntad. (POST → solo admin.) ──
    let integridadEnCurso = false;
    r.post('/integridad', async (req, res) => {
        if (integridadEnCurso) return res.status(409).json({ ok: false, motivo: 'ya hay una verificación de integridad en curso' });
        integridadEnCurso = true;
        try {
            const informe = await verificarIntegridad({ reparar: req.body?.reparar === true });
            res.json({ ok: true, ...informe });
        } catch (e) {
            res.status(500).json({ ok: false, motivo: e.message });
        } finally { integridadEnCurso = false; }
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

    // Búsqueda + navegación del catálogo (página "Búsqueda"). Sin `q` = navegar todo (recientes).
    // Filtros: q (título/subtítulo/obra/colección/palabras_clave/ISBN/ISSN + autor/editorial por
    // nombre), tipo (libro|revista), cdu (prefijo), orden (reciente|titulo|antiguo). Paginado (24).
    // Devuelve fichas mínimas con autores ya resueltos (vía $lookup) para pintar tarjetas con portada.
    r.get('/catalogo', async (req, res) => {
        try {
            const db = await conectarDB();
            const q = (req.query.q || '').trim();
            const tipo = req.query.tipo;
            const cdu = (req.query.cdu || '').trim();
            const orden = req.query.orden || 'reciente';
            const page = Math.max(1, Number(req.query.page) || 1);
            const porPagina = 24;

            const match = {};
            if (tipo === 'libro' || tipo === 'revista') match.tipo_recurso = tipo;
            if (cdu) match.cdu = { $regex: '^' + escapeRegex(cdu) };
            // Filtro EXACTO por clasificación (clic en el contador de la ficha/dashboard).
            const clasSistema = String(req.query.clasSistema || '').toLowerCase();
            const clasCodigo = String(req.query.clasCodigo || '').trim();
            if (['cdu', 'dewey', 'lcc'].includes(clasSistema) && clasCodigo) match[clasSistema] = clasCodigo;
            if (q) {
                const rx = { $regex: escapeRegex(q), $options: 'i' };
                const or = [{ titulo: rx }, { subtitulo: rx }, { obra_titulo: rx },
                    { coleccion_nombre: rx }, { palabras_clave: rx }];
                const qIsbn = q.replace(/[^0-9Xx]/g, '');
                if (qIsbn.length >= 8) {
                    const irx = { $regex: '^' + qIsbn };
                    or.push({ isbn: irx }, { issn: irx }, { isbn_obra: irx });
                }
                const [autores, edits] = await Promise.all([
                    db.collection('autores').find({ nombre: rx }, { projection: { _id: 1 } }).limit(80).toArray(),
                    db.collection('editoriales').find({ nombre: rx }, { projection: { _id: 1 } }).limit(80).toArray(),
                ]);
                if (autores.length) or.push({ autores: { $in: autores.map(a => a._id) } });
                if (edits.length) or.push({ editorial: { $in: edits.map(e => e._id) } });
                match.$or = or;
            }

            const sort = orden === 'titulo' ? { titulo: 1 } : orden === 'antiguo' ? { fecha_ingreso: 1 } : { fecha_ingreso: -1 };
            const opciones = orden === 'titulo' ? { collation: { locale: 'es', strength: 1 } } : {};
            const total = await db.collection('biblioteca').countDocuments(match);
            const docs = await db.collection('biblioteca').aggregate([
                { $match: match }, { $sort: sort }, { $skip: (page - 1) * porPagina }, { $limit: porPagina },
                { $lookup: { from: 'autores', localField: 'autores', foreignField: '_id', as: '_au' } },
                { $project: {
                    titulo: 1, subtitulo: 1, portada: 1, formatos: 1, cdu: 1, isbn: 1, issn: 1,
                    tipo_recurso: 1, 'año_edicion': 1, volumen_numero: 1, obra_titulo: 1, autores: '$_au.nombre',
                } },
            ], opciones).toArray();

            res.json({
                ok: true, total, page, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)),
                docs: docs.map(d => ({ ...d, _id: String(d._id) })),
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Detalle de UNA obra: cabecera resuelta (editorial/colección/CDU+descripción) + inventario de
    // tomos — presentes con su ficha mínima (portada/formatos/título), ausentes como hueco — para
    // la vista de drill-down del panel (obra → tomo → ficha).
    r.get('/obras/:id', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const obra = await db.collection('obras').findOne({ _id: new ObjectId(req.params.id) });
            if (!obra) return res.status(404).json({ ok: false, motivo: 'obra no encontrada' });

            const idsPresentes = (obra.volumenes || []).filter(v => v && v._id).map(v => v._id);
            const idsSin = (obra.volumenes_sin_numero || []).filter(Boolean);
            const todos = [...idsPresentes, ...idsSin];
            const docs = todos.length
                ? await db.collection('biblioteca').find({ _id: { $in: todos } }, { projection: PROY_VOL }).toArray()
                : [];
            const mapa = new Map(docs.map(d => [String(d._id), { ...d, _id: String(d._id) }]));

            const volumenes = (obra.volumenes || []).map(v => ({
                numero: v.numero, presente: !!v._id,
                doc: v._id ? (mapa.get(String(v._id)) || null) : null,
            }));
            const sin_numero = idsSin.map(id => mapa.get(String(id))).filter(Boolean);

            res.json({
                ok: true,
                obra: {
                    _id: String(obra._id), titulo: obra.titulo, isbn_obra: obra.isbn_obra || null,
                    cdu: obra.cdu || null, cdu_desc: await cduDesc(db, obra.cdu),
                    editorial: await nombrePorId(db, 'editoriales', obra.editorial),
                    coleccion: await nombrePorId(db, 'colecciones', obra.coleccion),
                    total_volumenes: obra.total_volumenes || 0, volumenes_presentes: obra.volumenes_presentes || 0,
                    completa: !!obra.completa, revision_requerida: !!obra.revision_requerida,
                },
                volumenes, sin_numero,
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Ficha COMPLETA de un documento: nombres resueltos (autores/editorial/colección/CDU+descripción),
    // imágenes y portada, y la URL del fichero original (servido en /recursos) para previsualizar
    // (PDF embebido), abrir en pestaña o descargar. Se omiten los ObjectId crudos y campos internos.
    r.get('/documentos/:id', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(req.params.id) });
            if (!doc) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });

            const { autores, editorial } = await resolverNombres(db, doc);
            const coleccion = doc.coleccion_nombre || await nombrePorId(db, 'colecciones', doc.coleccion);
            const obra = doc.obra
                ? { _id: String(doc.obra), titulo: await nombrePorId(db, 'obras', doc.obra, 'titulo') } : null;

            const limpio = { ...doc, _id: String(doc._id) };
            for (const k of ['autores', 'editorial', 'coleccion', 'coleccion_nombre', 'obra',
                '_portadas_remotas', 'mantenimiento', 'mantenimiento_firma']) delete limpio[k];

            // Clasificaciones (CDU/Dewey/LCC): código + título CONCISO (de caché, SIN IA aquí) + nº de
            // documentos con ese mismo código. El texto extenso se pide aparte en GET /clasificacion.
            const coll = db.collection('biblioteca');
            const cdesc = await cduDesc(db, doc.cdu);
            const tituloCache = async (sistema, codigo) => {
                if (!codigo) return null;
                const d = await db.collection('clasificacion_descripciones').findOne({ sistema, codigo }, { projection: { titulo_es: 1 } });
                return d?.titulo_es || null;
            };
            const clasificaciones = [];
            if (doc.cdu)   clasificaciones.push({ sistema: 'cdu',   codigo: doc.cdu,   titulo: cdesc?.titulo_es || null, n: await coll.countDocuments({ cdu: doc.cdu }) });
            if (doc.dewey) clasificaciones.push({ sistema: 'dewey', codigo: doc.dewey, titulo: await tituloCache('dewey', doc.dewey), n: await coll.countDocuments({ dewey: doc.dewey }) });
            if (doc.lcc)   clasificaciones.push({ sistema: 'lcc',   codigo: doc.lcc,   titulo: await tituloCache('lcc', doc.lcc), n: await coll.countDocuments({ lcc: doc.lcc }) });

            res.json({
                ok: true, doc: limpio, autores, editorial, coleccion,
                cdu_desc: cdesc, clasificaciones, obra,
                archivo_url: urlArchivo(doc), nombre_archivo: doc.nombre_archivo || null,
                imagenes: doc.imagenes || [], portada: doc.portada || null,
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Descripción (título conciso + texto extenso, ES) de un código de clasificación — de CACHÉ o
    // generada por IA al momento. CDU → cdu_descripciones/describirCDU; Dewey/LCC →
    // clasificacion_descripciones/describirClasificacion. Alimenta el popup ⓘ de la ficha/dashboard.
    r.get('/clasificacion', async (req, res) => {
        try {
            const sistema = String(req.query.sistema || '').toLowerCase();
            const codigo = String(req.query.codigo || '').trim();
            if (!codigo) return res.status(400).json({ ok: false, motivo: 'falta el código' });
            const db = await conectarDB();
            if (sistema === 'cdu') {
                const cod = sanitizarCDU(codigo);
                let d = await db.collection('cdu_descripciones').findOne({ codigo: cod });
                if (!d) d = await describirCDU(db, codigo);
                return res.json({ ok: true, sistema, codigo, titulo: d?.titulo_es || null, descripcion: d?.descripcion_es || null });
            }
            if (sistema === 'dewey' || sistema === 'lcc') {
                const d = await describirClasificacion(db, sistema, codigo);
                return res.json({ ok: true, sistema, codigo, titulo: d?.titulo_es || null, descripcion: d?.descripcion_es || null });
            }
            return res.status(400).json({ ok: false, motivo: 'sistema inválido (cdu|dewey|lcc)' });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    return r;
}
