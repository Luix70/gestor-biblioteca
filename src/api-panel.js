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
import { lanzarIntegridad, estadoIntegridad } from './integridad.js';
import { sanearCatalogo, lanzarSaneador, estadoSaneador } from './sanear-catalogo.js';
import { purgarObra } from './utils/purga.js';
import { reprocesarDocumento, eliminarDocumento } from './utils/reproceso.js';
import { reordenarImagenes, eliminarImagen, anadirImagen, reemplazarImagen } from './utils/imagenes-doc.js';
import { editarDocumento } from './utils/editar-doc.js';
import { buscar as buscarIndice, estadoIndice, lanzarReindexado, estadoReindexado } from './utils/indice-busqueda.js';
import { descubrirEnFichero } from './utils/fichero-descubrir.js';
import { asignarColeccion, asignarObra } from './utils/agrupar-docs.js';
import { fusionarColecciones, explotarColeccion, eliminarColeccionVacia, fusionarObras, explotarObra, eliminarObraVacia } from './utils/gestion-grupos.js';
import { listarUbicacionesGestion, crearUbicaciones, renombrarUbicacion, moverEstanteria, fusionarEstanteria, explotarUbicacion, eliminarUbicacion, asignarUbicacion, registrarNfcUbicacion } from './utils/gestion-ubicaciones.js';
import { reenriquecerDoc } from './utils/reenriquecer.js';
import { conformarAlIngerir } from './mantenimiento/conformador.js';
import { carpetaDeDoc } from './mantenimiento/util-mantenimiento.js';
import { contarPaginasComic, leerPaginaComic } from './utils/comic-paginas.js';
import { contarPaginasDjvu, leerPaginaDjvu } from './utils/djvu.js';
import path from 'node:path';

const EXT_PAGINABLE = new Set(['.cbz', '.cbr', '.cb7', '.djvu']);
import { resolverObraPorIsbn } from './utils/obra-autoridad.js';
import { ultimasLineas, infoLog, purgarLog } from './utils/registro-logs.js';
import { setVerboso, getVerboso } from './utils/consola-timestamp.js';
import { estadoVision, configurarProveedor, probarProveedor } from './utils/vision.js';
import { resolverNombres } from './utils/registro.js';
import { sanitizarCDU } from './utils/cdu-arbol.js';
import { fuentesCopia, procesarSaneamiento, estadoSaneamiento } from './utils/saneamiento.js';
import { describirCDU } from './utils/descripcion-cdu.js';
import { describirClasificacion } from './utils/descripcion-clasificacion.js';

// Proyección mínima de un documento para mostrarlo como "tomo" en la vista de obra.
const PROY_VOL = { titulo: 1, volumen_titulo: 1, volumen_numero: 1, formatos: 1, isbn: 1, portada: 1, paginas: 1, tipo_recurso: 1, nsfw: 1, locked: 1 };

// Ruta (en /recursos) del fichero original de un documento, SIN codificar: el front la %-codifica por
// segmentos al usarla (así funciona aunque la carpeta tenga caracteres heredados como '#', '%', espacios).
const urlArchivo = (doc) => (doc.ruta_base && doc.nombre_archivo)
    ? `${doc.ruta_base}/${doc.nombre_archivo}` : null;

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

// Filtros "especiales" del Dashboard → condición sobre 'biblioteca' (clic en un contador para ver
// EXACTAMENTE esos documentos en la Búsqueda). Los de obras resuelven a sus tomos vía la colección 'obras'.
const ausenteCampo = (campo) => ({ $or: [{ [campo]: { $exists: false } }, { [campo]: null }, { [campo]: '' }] });
async function filtroEspecial(db, nombre) {
    switch (nombre) {
        case 'sin_isbn':         return { tipo_recurso: 'libro', ...ausenteCampo('isbn') };
        case 'sin_hash':         return ausenteCampo('hash_contenido');
        case 'sin_portada':      return ausenteCampo('portada');
        case 'cdu_generica':     return { cdu: { $in: ['00', '0', '000'] } };
        case 'pendientes':       return { estado_verificacion: 'pendiente' };
        case 'sin_coleccion':    return ausenteCampo('coleccion');
        case 'revision':         return { revision_requerida: true };
        case 'tomos_sin_numero': return { obra: { $exists: true }, $or: [{ volumen_numero: { $exists: false } }, { volumen_numero: null }] };
        case 'obras_incompletas': {
            const ids = (await db.collection('obras').find({ completa: false }, { projection: { _id: 1 } }).toArray()).map(o => o._id);
            return { obra: { $in: ids } };
        }
        case 'obras_revision': {
            const ids = (await db.collection('obras').find({ revision_requerida: true }, { projection: { _id: 1 } }).toArray()).map(o => o._id);
            return { obra: { $in: ids } };
        }
        default: return null;
    }
}

// Ajuste persistido (colección `ajustes`, doc _id:'guest_nsfw'): ¿pueden los INVITADOS ver contenido
// NSFW? Por defecto NO. Cacheado 10 s. Se conmuta desde el panel (Actividad → Permisos de invitados).
let _guestNsfw = null, _guestNsfwTs = 0;
async function guestPuedeNsfw() {
    if (_guestNsfw !== null && Date.now() - _guestNsfwTs < 10000) return _guestNsfw;
    try { const db = await conectarDB(); _guestNsfw = !!(await db.collection('ajustes').findOne({ _id: 'guest_nsfw' }))?.enabled; }
    catch { _guestNsfw = false; }
    _guestNsfwTs = Date.now();
    return _guestNsfw;
}
// ¿Hay que OCULTAR el NSFW a este rol? Solo a invitados, y solo si el ajuste NO se lo permite.
async function ocultarNsfw(rol) { return rol === 'guest' && !(await guestPuedeNsfw()); }

// NSFW para INVITADOS (guest): no ven docs marcados nsfw NI los que pertenezcan a una obra/colección
// marcada nsfw (propaga hacia abajo) — salvo que el ajuste les permita verlo. Array de condiciones a
// AND-ear, o null si no hay que ocultar nada (admin, o invitados con permiso NSFW).
async function condicionNsfwDocs(db, rol) {
    if (!(await ocultarNsfw(rol))) return null; // admin, o invitado con permiso NSFW → ve todo
    const [obras, cols] = await Promise.all([
        db.collection('obras').find({ nsfw: true }, { projection: { _id: 1 } }).toArray(),
        db.collection('colecciones').find({ nsfw: true }, { projection: { _id: 1 } }).toArray(),
    ]);
    const cond = [{ nsfw: { $ne: true } }];
    if (obras.length) cond.push({ obra: { $nin: obras.map(o => o._id) } });
    if (cols.length) cond.push({ coleccion: { $nin: cols.map(c => c._id) } });
    return cond;
}

// ¿Está OCULTO este doc para un invitado? (nsfw propio o de su obra/colección.)
async function docOcultoParaGuest(db, doc) {
    if (doc.nsfw) return true;
    if (doc.obra && (await db.collection('obras').findOne({ _id: doc.obra }, { projection: { nsfw: 1 } }))?.nsfw) return true;
    if (doc.coleccion && (await db.collection('colecciones').findOne({ _id: doc.coleccion }, { projection: { nsfw: 1 } }))?.nsfw) return true;
    return false;
}

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

    // ── Integridad: proceso PESADO → se ejecuta en 2º plano y el panel sondea el progreso (así un proxy
    //    no corta la petición larga, que daba 405). POST arranca; GET /integridad/estado da fase + informe. ──
    r.post('/integridad', (req, res) => {
        if (req.usuario?.rol !== 'admin' && req.body?.reparar === true) return res.status(403).json({ ok: false, motivo: 'solo administradores' });
        res.json(lanzarIntegridad({ reparar: req.body?.reparar === true }));
    });
    r.get('/integridad/estado', (req, res) => res.json(estadoIntegridad()));

    // ── Visión (rotación multi-proveedor): estado, activar/desactivar y PROBAR una clave. Solo admin.
    //    No expone secretos (solo enmascarados). Las claves se gestionan en .env (numeradas). ──
    r.get('/vision/proveedores', async (req, res) => {
        try { if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json({ ok: true, proveedores: await estadoVision() }); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/vision/proveedor', async (req, res) => {
        try { if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json(await configurarProveedor(req.body?.id, { enabled: req.body?.enabled === true })); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/vision/probar', async (req, res) => {
        try { if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json(await probarProveedor(req.body?.id)); } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Sanear catálogo: re-deriva con el pipeline actual (re-home #, portadas, re-clasificar). admin. ──
    r.post('/sanear', async (req, res) => {        // DRY-RUN (diagnóstico): síncrono y rápido
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json({ ok: true, ...await sanearCatalogo({ ejecutar: false }) });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/sanear/ejecutar', (req, res) => {     // EJECUTA en 2º plano (puede tardar / usar IA)
        if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
        res.json(lanzarSaneador({ reclasificar: req.body?.reclasificar === true }));
    });
    r.get('/sanear/estado', (req, res) => res.json(estadoSaneador()));

    // ── Permisos de invitados: ¿pueden ver contenido NSFW? (estado abierto; conmutar solo admin) ──
    r.get('/ajustes/guest-nsfw', async (req, res) => {
        try { res.json({ ok: true, enabled: await guestPuedeNsfw() }); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/ajustes/guest-nsfw', async (req, res) => {
        if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
        try {
            const enabled = !!req.body?.enabled;
            const db = await conectarDB();
            await db.collection('ajustes').updateOne({ _id: 'guest_nsfw' }, { $set: { enabled } }, { upsert: true });
            _guestNsfw = enabled; _guestNsfwTs = Date.now();   // refrescar caché al instante
            res.json({ ok: true, enabled });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Búsqueda (índice FTS local): estado + reconstrucción en 2º plano (con progreso, sin 405). El
    //    índice se mantiene solo al ingerir/editar/borrar; reindexar es para la 1ª carga o una recuperación. ──
    r.get('/busqueda/estado', async (req, res) => {
        try { res.json({ ok: true, indice: await estadoIndice(), trabajo: estadoReindexado() }); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/busqueda/reindexar', async (req, res) => {
        if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
        try { res.json(lanzarReindexado(await conectarDB())); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.get('/busqueda/reindexar/estado', (req, res) => res.json(estadoReindexado()));

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
    r.get('/logs/info', (req, res) => res.json({ ...infoLog(), verbose: getVerboso() }));
    r.post('/logs/purgar', (req, res) => {
        const { dias, todo } = req.body || {};
        res.json(purgarLog({ dias, todo: todo === true }));
    });
    // Verbosidad del log: OFF = simple (titulares + resúmenes + avisos); ON = detallado. Solo admin.
    r.post('/logs/verbose', (req, res) => {
        if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
        setVerboso(req.body?.verbose === true);
        res.json({ ok: true, verbose: getVerboso() });
    });

    // Lista de obras (con su estado de completitud) para el panel.
    r.get('/obras', async (req, res) => {
        try {
            const db = await conectarDB();
            const filtroObras = await ocultarNsfw(req.usuario?.rol) ? { nsfw: { $ne: true } } : {};
            const obras = await db.collection('obras')
                .find(filtroObras, { projection: { titulo: 1, isbn_obra: 1, total_volumenes: 1, volumenes_presentes: 1, completa: 1, revision_requerida: 1, nsfw: 1, valoracion: 1 } })
                .sort({ revision_requerida: -1, completa: 1, titulo: 1 }).limit(500).toArray();
            // Hasta 3 portadas de tomos (para la cubierta apilada / previsualización).
            const portO = obras.length ? await db.collection('biblioteca').aggregate([
                { $match: { obra: { $in: obras.map(o => o._id) }, portada: { $exists: true, $ne: null } } },
                { $group: { _id: '$obra', portadas: { $push: '$portada' } } },
            ]).toArray() : [];
            const mapaP = new Map(portO.map(x => [String(x._id), (x.portadas || []).slice(0, 3)]));
            res.json(obras.map(o => { const ps = mapaP.get(String(o._id)) || []; return { ...o, _id: String(o._id), portada: ps[0] || null, portadas: ps }; }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Búsqueda + navegación del catálogo (página "Búsqueda"). Sin `q` = navegar todo (recientes).
    // Filtros: q (título/subtítulo/obra/colección/palabras_clave/nombre_archivo/ISBN/ISSN + autor/editorial
    // por nombre), tipo (libro|revista), cdu (prefijo), orden (reciente|titulo|antiguo). Paginado (24).
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
            // Tipo: libro/revista por tipo_recurso; 'comic' por naturaleza (un cómic puede ser libro=GN o
            // revista/serie, así que se filtra por su clase, no por tipo_recurso).
            if (tipo === 'libro' || tipo === 'revista') match.tipo_recurso = tipo;
            else if (tipo === 'comic') match.naturaleza = { $in: ['comic', 'novela-grafica'] };
            // Soporte: 'papel' = escaneado/físico (formatos incluye 'papel'); 'digital' = el resto
            // (epub/pdf/mobi/djvu/cbz…). Vacío = ambos.
            const soporte = String(req.query.soporte || '').trim();
            if (soporte === 'papel') match.formatos = 'papel';
            else if (soporte === 'digital') match.formatos = { $ne: 'papel' };
            // Ubicación: por ámbito y, dentro de él, por estantería (la estantería sin ámbito sería
            // ambigua —un «Estante 1» puede existir en varios ámbitos—, así que solo cuenta con ámbito).
            const ambito = String(req.query.ambito || '').trim();
            if (ambito) {
                match['ubicacion.ambito'] = ambito;
                const estanteria = String(req.query.estanteria || '').trim();
                if (estanteria) match['ubicacion.estanteria'] = estanteria;
            }
            if (cdu) match.cdu = { $regex: '^' + escapeRegex(cdu) };
            // Filtro EXACTO por clasificación (clic en el contador de la ficha/dashboard).
            const clasSistema = String(req.query.clasSistema || '').toLowerCase();
            const clasCodigo = String(req.query.clasCodigo || '').trim();
            if (['cdu', 'dewey', 'lcc'].includes(clasSistema) && clasCodigo) match[clasSistema] = clasCodigo;
            // Filtro por colección (clic en la colección desde la ficha).
            const colId = String(req.query.coleccion || '').trim();
            if (colId && ObjectId.isValid(colId)) match.coleccion = new ObjectId(colId);
            // Búsqueda de texto: si el ÍNDICE FTS local está disponible lo usa (rápido, ranqueado e
            // INSENSIBLE A ACENTOS: "matematicas" encuentra "Matemáticas"), devolviendo _id por relevancia;
            // si no, CAE a la búsqueda Mongo $regex de siempre. Los IDENTIFICADORES (ISBN/ISSN, tolerando
            // separadores + ISSN de serie en la colección) van SIEMPRE por Mongo, en unión con el texto.
            let idsRanked = null, ordenRelevancia = false;
            if (q) {
                const or = [];
                const ftsIds = await buscarIndice(q, { limite: 1000 }).catch(() => null);
                if (ftsIds) {
                    idsRanked = ftsIds;
                    if (ftsIds.length) or.push({ _id: { $in: ftsIds.map(id => new ObjectId(id)) } });
                    ordenRelevancia = orden === 'reciente';   // por defecto, ordenar por relevancia
                } else {
                    const rx = { $regex: escapeRegex(q), $options: 'i' };
                    or.push({ titulo: rx }, { subtitulo: rx }, { obra_titulo: rx },
                        { coleccion_nombre: rx }, { palabras_clave: rx }, { nombre_archivo: rx });
                    const [autores, edits] = await Promise.all([
                        db.collection('autores').find({ nombre: rx }, { projection: { _id: 1 } }).limit(80).toArray(),
                        db.collection('editoriales').find({ nombre: rx }, { projection: { _id: 1 } }).limit(80).toArray(),
                    ]);
                    if (autores.length) or.push({ autores: { $in: autores.map(a => a._id) } });
                    if (edits.length) or.push({ editorial: { $in: edits.map(e => e._id) } });
                }
                // Identificadores (SIEMPRE Mongo): el ISSN se guarda CON guion (1699-7913) y el ISBN sin él.
                const qId = q.replace(/[^0-9Xx]/g, '');
                if (qId.length >= 8) {
                    const irx = { $regex: '^' + qId.split('').join('[\\s-]?'), $options: 'i' };
                    or.push({ isbn: irx }, { issn: irx }, { isbn_obra: irx }, { 'isbns_alternativos.isbn': irx });
                    // El ISSN de una serie de libros vive en la COLECCIÓN (no en el libro): buscar la
                    // cabecera/serie por su ISSN y traer sus miembros.
                    const colsISSN = await db.collection('colecciones').find({ issn: irx }, { projection: { _id: 1 } }).limit(50).toArray();
                    if (colsISSN.length) or.push({ coleccion: { $in: colsISSN.map(c => c._id) } });
                }
                // Con q SIEMPRE filtramos por $or; si quedó vacío (FTS sin aciertos y sin identificador) →
                // "sin resultados" en vez de devolver el catálogo entero.
                match.$or = or.length ? or : [{ _id: { $in: [] } }];
            }

            // Filtros del Dashboard: por día de ingesta y/o por contador especial (se combinan con AND).
            const extras = [];
            const dia = String(req.query.dia || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(dia)) {
                const d0 = new Date(dia + 'T00:00:00');
                const d1 = new Date(d0); d1.setDate(d1.getDate() + 1);
                extras.push({ fecha_ingreso: { $gte: d0, $lt: d1 } });
            }
            const fe = await filtroEspecial(db, String(req.query.filtro || '').trim());
            if (fe) extras.push(fe);
            // Filtro por VALORACIÓN (estrellas): CSV de valores 0..5 (multi-selección, p. ej. "0,1,2").
            // 0 = sin valorar (valoracion ausente/null/0). Si están los 6, no filtra (equivale a "todas").
            const estrellas = [...new Set(String(req.query.estrellas || '').split(',')
                .map(s => parseInt(s, 10)).filter(n => n >= 0 && n <= 5))];
            if (estrellas.length && estrellas.length < 6) {
                const ors = [];
                const pos = estrellas.filter(n => n > 0);
                if (pos.length) ors.push({ valoracion: { $in: pos } });
                if (estrellas.includes(0)) ors.push({ valoracion: { $in: [0, null] } }, { valoracion: { $exists: false } });
                extras.push({ $or: ors });
            }
            // NSFW: los invitados no ven material marcado (ni el que cuelga de una obra/colección nsfw).
            const nsfwCond = await condicionNsfwDocs(db, req.usuario?.rol);
            if (nsfwCond) extras.push(...nsfwCond);
            const consulta = extras.length ? { $and: [...(Object.keys(match).length ? [match] : []), ...extras] } : match;

            const sort = orden === 'titulo' ? { titulo: 1 } : orden === 'antiguo' ? { fecha_ingreso: 1 } : { fecha_ingreso: -1 };
            const opciones = orden === 'titulo' ? { collation: { locale: 'es', strength: 1 } } : {};
            // Orden por RELEVANCIA cuando hay índice FTS: respeta el ranking bm25 (orden de idsRanked); los
            // aciertos por identificador que no estén en el ranking caen al final (_rank grande).
            const etapasOrden = (ordenRelevancia && idsRanked && idsRanked.length)
                ? [
                    { $addFields: { _rank: { $indexOfArray: [idsRanked, { $toString: '$_id' }] } } },
                    { $addFields: { _rank: { $cond: [{ $lt: ['$_rank', 0] }, 1e9, '$_rank'] } } },
                    { $sort: { _rank: 1, fecha_ingreso: -1 } },
                  ]
                : [{ $sort: sort }];
            const total = await db.collection('biblioteca').countDocuments(consulta);
            const docs = await db.collection('biblioteca').aggregate([
                { $match: consulta }, ...etapasOrden, { $skip: (page - 1) * porPagina }, { $limit: porPagina },
                { $lookup: { from: 'autores', localField: 'autores', foreignField: '_id', as: '_au' } },
                { $project: {
                    titulo: 1, subtitulo: 1, portada: 1, formatos: 1, cdu: 1, isbn: 1, issn: 1,
                    tipo_recurso: 1, 'año_edicion': 1, volumen_numero: 1, obra_titulo: 1, nsfw: 1, locked: 1,
                    valoracion: 1, naturaleza: 1, autores: '$_au.nombre',
                } },
            ], opciones).toArray();

            res.json({
                ok: true, total, page, porPagina, paginas: Math.max(1, Math.ceil(total / porPagina)),
                docs: docs.map(d => ({ ...d, _id: String(d._id) })),
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── DESCUBRIR: busca en el FICHERO (OL+BNE, 58,7 M) libros que NO tienes — FTS por título/subtítulo/
    //    autor — y propone enlaces de adquisición (FUENTES_COPIA). Marca los que YA están en la biblioteca
    //    (por ISBN). Solo admin (son enlaces de adquisición, como el saneamiento de ilegibles). ──
    r.get('/descubrir', async (req, res) => {
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            const q = (req.query.q || '').trim();
            if (q.length < 2) return res.json({ ok: true, disponible: true, candidatos: [] });
            // Corre en un WORKER (no bloquea el event loop; better-sqlite3 es síncrono). Bajo demanda.
            const cands = await descubrirEnFichero(q, { limite: 100 });
            if (cands === null) return res.json({ ok: true, disponible: false, candidatos: [], motivo: 'Fichero sin índice de texto o no disponible' });
            const db = await conectarDB();
            const isbns = cands.map(c => c.isbn).filter(Boolean);
            const owned = new Set((isbns.length
                ? await db.collection('biblioteca').find({ isbn: { $in: isbns } }, { projection: { isbn: 1 } }).toArray()
                : []).map(d => d.isbn));
            const fuentes = fuentesCopia();
            const candidatos = cands.map(c => {
                const consulta = encodeURIComponent([c.titulo, (c.autores || []).join(' ')].filter(Boolean).join(' ').trim());
                return {
                    ...c,
                    enBiblioteca: c.isbn ? owned.has(c.isbn) : false,
                    enlaces: fuentes.map(f => ({ nombre: f.nombre, url: String(f.url).replace('{q}', consulta) })),
                };
            });
            res.json({ ok: true, disponible: true, candidatos });
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
            if (await ocultarNsfw(req.usuario?.rol) && obra.nsfw) return res.status(404).json({ ok: false, motivo: 'obra no encontrada' });

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
                    valoracion: obra.valoracion || 0, nsfw: !!obra.nsfw,
                },
                volumenes, sin_numero,
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Lista de COLECCIONES (cabeceras de revista + series de libros) para el panel. ?tipo=revista|libro.
    r.get('/colecciones', async (req, res) => {
        try {
            const db = await conectarDB();
            const tipo = req.query.tipo;
            const filtro = await ocultarNsfw(req.usuario?.rol) ? { nsfw: { $ne: true } } : {};
            if (tipo === 'revista') filtro.tipo = 'revista';
            else if (tipo === 'libro') filtro.tipo = { $ne: 'revista' }; // libro o legado (sin tipo)
            const cols = await db.collection('colecciones')
                .find(filtro, { projection: { nombre: 1, tipo: 1, issn: 1, numeros_presentes: 1, revision_requerida: 1, nsfw: 1, valoracion: 1 } })
                .sort({ revision_requerida: -1, nombre: 1 }).limit(1000).toArray();
            // Nº de miembros + hasta 3 portadas (para la cubierta apilada) de un tirón, por agregación.
            const agg = cols.length ? await db.collection('biblioteca').aggregate([
                { $match: { coleccion: { $in: cols.map(c => c._id) } } },
                { $group: { _id: '$coleccion', n: { $sum: 1 }, portadas: { $push: '$portada' } } },
            ]).toArray() : [];
            const mapa = new Map(agg.map(x => [String(x._id), x]));
            res.json(cols.map(c => {
                const a = mapa.get(String(c._id));
                const ps = (a?.portadas || []).filter(Boolean).slice(0, 3);
                return { ...c, _id: String(c._id), tipo: c.tipo || 'libro', miembros: a?.n || 0, portada: ps[0] || null, portadas: ps };
            }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Mapa de ubicaciones: ámbito → estanterías, derivado de los documentos ya catalogados. Alimenta los
    // desplegables del Inbox y de la edición; la estantería va ASOCIADA a su ámbito (puede haber un
    // «Estante 1» en «Comedor» y otro distinto en «Biblioteca»). Se enriquece solo, según se da de alta.
    r.get('/ubicaciones', async (req, res) => {
        try {
            const db = await conectarDB();
            const agg = await db.collection('biblioteca').aggregate([
                { $match: { 'ubicacion.ambito': { $nin: [null, '', 'Sin asignar'] } } },
                { $group: { _id: '$ubicacion.ambito', estanterias: { $addToSet: '$ubicacion.estanteria' } } },
                { $sort: { _id: 1 } },
            ]).toArray();
            const colar = (a, b) => String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
            // Unir el REGISTRO (estanterías/ámbitos pre-creados, aún sin libros) para que aparezcan en los
            // desplegables aunque ninguna obra los use todavía.
            const mapa = new Map(agg.map(a => [a._id, new Set((a.estanterias || []).filter(e => e && e !== 'Sin asignar'))]));
            for (const row of await db.collection('ubicaciones').find({}).toArray()) {
                const a = String(row.ambito || '').trim(); if (!a) continue;
                if (!mapa.has(a)) mapa.set(a, new Set());
                const e = String(row.estanteria || '').trim();
                if (e && e !== 'Sin asignar') mapa.get(a).add(e);
            }
            const ambitos = [...mapa.entries()].sort((x, y) => colar(x[0], y[0]))
                .map(([ambito, set]) => ({ ambito, estanterias: [...set].sort(colar) }));
            res.json({ ok: true, ambitos });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Gestión de ubicaciones (estanterías como colecciones): árbol + crear(lote)/renombrar/mover/
    //    fusionar/explotar/eliminar/asignar/nfc. Las mutaciones (POST) ya las restringe `autenticar` a admin.
    r.get('/ubicaciones/gestion', async (req, res) => {
        try { res.json({ ok: true, ambitos: await listarUbicacionesGestion(await conectarDB()) }); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    const ubicPost = (ruta, fn) => r.post('/ubicaciones/' + ruta, async (req, res) => {
        try { res.json(await fn(await conectarDB(), req.body || {})); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    ubicPost('crear', crearUbicaciones);
    ubicPost('renombrar', renombrarUbicacion);
    ubicPost('mover', moverEstanteria);
    ubicPost('fusionar', fusionarEstanteria);
    ubicPost('explotar', explotarUbicacion);
    ubicPost('eliminar', eliminarUbicacion);
    ubicPost('asignar', asignarUbicacion);
    ubicPost('nfc', registrarNfcUbicacion);

    // Detalle de UNA colección: cabecera/serie resuelta (editorial/CDU+descripción) + sus miembros
    // (números de revista en orden cronológico, o libros de la serie) para el drill-down del panel.
    r.get('/colecciones/:id', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const col = await db.collection('colecciones').findOne({ _id: new ObjectId(req.params.id) });
            if (!col) return res.status(404).json({ ok: false, motivo: 'colección no encontrada' });
            if (await ocultarNsfw(req.usuario?.rol) && col.nsfw) return res.status(404).json({ ok: false, motivo: 'colección no encontrada' });

            const esRevista = col.tipo === 'revista';
            const matchMiembros = { coleccion: col._id };
            if (await ocultarNsfw(req.usuario?.rol)) matchMiembros.nsfw = { $ne: true };
            const proy = { ...PROY_VOL, clave_numero: 1, 'año_edicion': 1, mes_publicacion: 1, numero_issue: 1, coleccion_numero: 1 };
            const miembros = await db.collection('biblioteca')
                .find(matchMiembros, { projection: proy })
                .sort(esRevista ? { clave_numero: 1, 'año_edicion': 1 } : { titulo: 1 }).limit(2000).toArray();

            res.json({
                ok: true,
                coleccion: {
                    _id: String(col._id), nombre: col.nombre, tipo: col.tipo || 'libro', issn: col.issn || null,
                    descripcion: col.descripcion || null, cdu: col.cdu || null, cdu_desc: await cduDesc(db, col.cdu),
                    editorial: await nombrePorId(db, 'editoriales', col.editorial),
                    numeros_presentes: col.numeros_presentes || (esRevista ? miembros.length : 0),
                    revision_requerida: !!col.revision_requerida,
                    valoracion: col.valoracion || 0, nsfw: !!col.nsfw,
                },
                miembros: miembros.map(d => ({ ...d, _id: String(d._id) })),
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
            if (await ocultarNsfw(req.usuario?.rol) && await docOcultoParaGuest(db, doc))
                return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });

            const { autores, editorial } = await resolverNombres(db, doc);
            const colDoc = doc.coleccion
                ? await db.collection('colecciones').findOne({ _id: doc.coleccion }, { projection: { nombre: 1, tipo: 1, issn: 1 } })
                : null;
            const coleccion = colDoc?.nombre || doc.coleccion_nombre || null;
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
                coleccion_id: doc.coleccion ? String(doc.coleccion) : null,
                coleccion_tipo: colDoc?.tipo || null, coleccion_issn: colDoc?.issn || null,
                cdu_desc: cdesc, clasificaciones, obra,
                archivo_url: urlArchivo(doc), nombre_archivo: doc.nombre_archivo || null,
                imagenes: doc.imagenes || [], portada: doc.portada || null,
            });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // VALORACIÓN (estrellas 0..5, estilo Lightroom) y NSFW para documentos / obras / colecciones (solo
    // admin). La valoración es INDEPENDIENTE por nivel: una colección 1★ puede tener un documento 5★.
    // NSFW en una obra/colección PROPAGA a sus miembros actuales Y futuros vía el filtro de invitados
    // (condicionNsfwDocs/docOcultoParaGuest comprueban el nsfw del padre en cada consulta).
    const COLS_RATING = { documentos: 'biblioteca', obras: 'obras', colecciones: 'colecciones' };
    for (const [ruta, coleccion] of Object.entries(COLS_RATING)) {
        r.post(`/${ruta}/:id/valoracion`, async (req, res) => {
            try {
                if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
                if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
                const v = Math.round(Number(req.body?.valoracion));
                if (!(v >= 0 && v <= 5)) return res.status(400).json({ ok: false, motivo: 'valoración fuera de rango (0..5)' });
                const db = await conectarDB();
                const r2 = await db.collection(coleccion).updateOne({ _id: new ObjectId(req.params.id) }, { $set: { valoracion: v, fecha_actualizacion: new Date() } });
                if (!r2.matchedCount) return res.status(404).json({ ok: false, motivo: 'no encontrado' });
                res.json({ ok: true, valoracion: v });
            } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
        });
        r.post(`/${ruta}/:id/nsfw`, async (req, res) => {
            try {
                if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
                if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
                const nsfw = !!req.body?.nsfw;
                const db = await conectarDB();
                const _id = new ObjectId(req.params.id);
                const r2 = await db.collection(coleccion).updateOne({ _id }, { $set: { nsfw, fecha_actualizacion: new Date() } });
                if (!r2.matchedCount) return res.status(404).json({ ok: false, motivo: 'no encontrado' });
                // PROPAGAR a los miembros ACTUALES (obra/colección). Los FUTUROS heredan en la ingesta
                // (motor-catalogo) y, para invitados, el filtro nsfw del padre ya los oculta igualmente.
                let propagado = 0;
                if (ruta === 'obras') propagado = (await db.collection('biblioteca').updateMany({ obra: _id }, { $set: { nsfw } })).modifiedCount;
                else if (ruta === 'colecciones') propagado = (await db.collection('biblioteca').updateMany({ coleccion: _id }, { $set: { nsfw } })).modifiedCount;
                res.json({ ok: true, nsfw, propagado });
            } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
        });
    }

    // Campos relevantes a comparar antes/después de conformar para mostrar "qué cambió".
    const CAMPOS_DIFF = ['titulo', 'subtitulo', 'cdu', 'dewey', 'lcc', 'lccn', 'portada', 'ruta_base',
        'nombre_archivo', 'sinopsis', 'año_edicion', 'idioma', 'estado_verificacion', 'isbn', 'issn'];
    const snapshot = (d) => { const o = {}; for (const k of CAMPOS_DIFF) o[k] = d?.[k] ?? null; o.imagenes = (d?.imagenes || []).length; return o; };
    const diffSnap = (a, b) => {
        const out = [];
        for (const k of [...CAMPOS_DIFF, 'imagenes']) {
            const va = a[k], vb = b[k];
            if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ campo: k, de: va, a: vb });
        }
        return out;
    };

    // CONFORMADOR para UN documento (botón de la ficha): ejecuta las tareas de mantenimiento (portada,
    // re-clasificar CDU + mover carpeta, regenerar sidecars…) solo sobre este doc. Devuelve los cambios.
    r.post('/documentos/:id/conformar', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const col = db.collection('biblioteca');
            const id = new ObjectId(req.params.id);
            const antes = await col.findOne({ _id: id });
            if (!antes) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });
            const r2 = await conformarAlIngerir(id);
            if (!r2.ok) return res.json({ ok: false, motivo: r2.motivo === 'locked' ? 'documento bloqueado (locked): el Conformador no lo toca' : (r2.motivo === 'fuera-de-contenedor' ? 'el Conformador solo corre en el NAS (junto a los ficheros)' : r2.motivo) });
            const despues = await col.findOne({ _id: id });
            res.json({ ok: true, cambios: diffSnap(snapshot(antes), snapshot(despues)), n: r2.cambios });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // EDICIÓN MANUAL de un documento (ficha → ✏️ Editar; solo admin): lista blanca de campos + lock.
    r.post('/documentos/:id/editar', async (req, res) => {
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json(await editarDocumento(await conectarDB(), req.params.id, req.body || {}));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ENRIQUECEDOR para UN documento (botón de la ficha): re-consulta APIs/IA y mejora el registro
    // (rellena huecos; corrige título/autor solo si eran basura). Devuelve la lista de cambios.
    r.post('/documentos/:id/enriquecer', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(req.params.id) });
            if (!doc) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });
            if (doc.locked) return res.json({ ok: false, motivo: 'documento bloqueado (locked)' });
            const r2 = await reenriquecerDoc(db, doc);
            res.json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // REPROCESAR un documento (botón de la ficha): lo devuelve al Inbox para re-catalogarlo de cero,
    // recicla su carpeta CDU (sidecars/imágenes) y borra el doc. Requiere contraseña de admin.
    r.post('/documentos/:id/reprocesar', async (req, res) => {
        try {
            if (!verificarPasswordAdmin(req.body?.password)) return res.status(403).json({ ok: false, motivo: 'contraseña de administrador incorrecta' });
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(req.params.id) });
            if (!doc) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });
            const r2 = await reprocesarDocumento(db, doc);
            res.json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ELIMINAR un documento (botón de la ficha): borra el registro de Mongo y RECICLA su carpeta CDU
    // (sidecars/imágenes/original) a la Papelera — recuperable. Requiere contraseña de admin.
    r.post('/documentos/:id/eliminar', async (req, res) => {
        try {
            if (!verificarPasswordAdmin(req.body?.password)) return res.status(403).json({ ok: false, motivo: 'contraseña de administrador incorrecta' });
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const db = await conectarDB();
            const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(req.params.id) });
            if (!doc) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });
            const r2 = await eliminarDocumento(db, doc);
            res.json(r2);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // Borrado MASIVO desde la Búsqueda (solo admin, contraseña). Recicla la carpeta de cada doc a la
    // Papelera (recuperable), igual que el borrado individual. Devuelve cuántos se borraron / fallaron.
    r.post('/documentos/eliminar-lote', async (req, res) => {
        try {
            if (!verificarPasswordAdmin(req.body?.password)) return res.status(403).json({ ok: false, motivo: 'contraseña de administrador incorrecta' });
            const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(id => ObjectId.isValid(id));
            if (!ids.length) return res.status(400).json({ ok: false, motivo: 'sin documentos válidos' });
            const db = await conectarDB();
            let eliminados = 0; const fallidos = [];
            for (const id of ids) {
                try {
                    const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(id) });
                    if (!doc) { fallidos.push(id); continue; }
                    const r2 = await eliminarDocumento(db, doc);
                    if (r2?.ok !== false) eliminados++; else fallidos.push(id);
                } catch { fallidos.push(id); }
            }
            res.json({ ok: true, eliminados, fallidos: fallidos.length, total: ids.length });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // ── Imágenes del carrusel (gestión manual desde la ficha; las mutaciones ya las restringe a admin
    //    `autenticar`). Editar (rotar/recortar/perspectiva) se hace en el CLIENTE y llega en base64. ──
    r.post('/documentos/:id/imagenes/orden', async (req, res) => {
        try { res.json(await reordenarImagenes(await conectarDB(), req.params.id, req.body?.orden || [])); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/documentos/:id/imagenes/eliminar', async (req, res) => {
        try { res.json(await eliminarImagen(await conectarDB(), req.params.id, req.body?.ruta)); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/documentos/:id/imagenes/anadir', async (req, res) => {
        try { res.json(await anadirImagen(await conectarDB(), req.params.id, req.body?.base64)); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/documentos/:id/imagenes/reemplazar', async (req, res) => {
        try { res.json(await reemplazarImagen(await conectarDB(), req.params.id, req.body?.ruta, req.body?.base64)); }
        catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    // Dimensiones físicas del libro (cm), estimadas en el cliente sobre la alfombrilla reglada (solo admin).
    r.post('/documentos/:id/dimensiones', async (req, res) => {
        try {
            if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ ok: false, motivo: 'id inválido' });
            const a = Number(req.body?.ancho_cm), h = Number(req.body?.alto_cm);
            const set = { fecha_actualizacion: new Date() }, unset = {};
            const ok = (v) => Number.isFinite(v) && v > 0 && v < 200;       // cordura: 0–200 cm
            if (ok(a)) set.ancho_cm = Math.round(a * 10) / 10; else unset.ancho_cm = '';
            if (ok(h)) set.alto_cm = Math.round(h * 10) / 10; else unset.alto_cm = '';
            const upd = { $set: set }; if (Object.keys(unset).length) upd.$unset = unset;
            const db = await conectarDB();
            const r2 = await db.collection('biblioteca').updateOne({ _id: new ObjectId(req.params.id) }, upd);
            if (!r2.matchedCount) return res.status(404).json({ ok: false, motivo: 'documento no encontrado' });
            res.json({ ok: true, ancho_cm: set.ancho_cm ?? null, alto_cm: set.alto_cm ?? null });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // PREVISUALIZACIÓN paginada (cómic .cbz/.cbr/.cb7 y .djvu): nº de páginas + página N como imagen,
    // BAJO DEMANDA. Cómics: del comprimido (adm-zip/bsdtar). DjVu: rasterizando solo esa página (ddjvu→
    // pdftoppm). El visor del panel pide una página por vez (no se convierte el documento entero).
    const docPaginable = async (req, res) => {
        if (!ObjectId.isValid(req.params.id)) { res.status(400).json({ ok: false, motivo: 'id inválido' }); return null; }
        const db = await conectarDB();
        const doc = await db.collection('biblioteca').findOne({ _id: new ObjectId(req.params.id) });
        if (!doc) { res.status(404).json({ ok: false, motivo: 'documento no encontrado' }); return null; }
        if (await ocultarNsfw(req.usuario?.rol) && await docOcultoParaGuest(db, doc)) { res.status(404).json({ ok: false, motivo: 'documento no encontrado' }); return null; }
        if (!doc.nombre_archivo || !EXT_PAGINABLE.has(path.extname(doc.nombre_archivo).toLowerCase())) { res.status(400).json({ ok: false, motivo: 'no es paginable (.cbz/.cbr/.cb7/.djvu)' }); return null; }
        return path.join(carpetaDeDoc(doc), doc.nombre_archivo);
    };
    const esDjvu = (ruta) => path.extname(ruta).toLowerCase() === '.djvu';
    r.get('/documentos/:id/paginas', async (req, res) => {
        try {
            const ruta = await docPaginable(req, res);
            if (!ruta) return;
            res.json({ ok: true, paginas: esDjvu(ruta) ? await contarPaginasDjvu(ruta) : await contarPaginasComic(ruta) });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.get('/documentos/:id/paginas/:n', async (req, res) => {
        try {
            const ruta = await docPaginable(req, res);
            if (!ruta) return;
            const n = Math.max(0, parseInt(req.params.n, 10) || 0);
            const pag = esDjvu(ruta) ? await leerPaginaDjvu(ruta, n) : await leerPaginaComic(ruta, n);
            if (!pag) return res.status(404).json({ ok: false, motivo: 'página no encontrada' });
            res.set('Content-Type', pag.mimeType);
            res.set('Cache-Control', 'private, max-age=600');
            res.send(pag.buffer);
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // AGRUPADO MANUAL (selección múltiple en Búsqueda, solo admin): meter N documentos en una colección
    // o una obra (existente o nueva).
    r.post('/documentos/agrupar/coleccion', async (req, res) => {
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            const { ids, coleccionId, nombre, tipo } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, motivo: 'sin documentos seleccionados' });
            res.json(await asignarColeccion(await conectarDB(), ids, { coleccionId, nombre, tipo }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });
    r.post('/documentos/agrupar/obra', async (req, res) => {
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            const { ids, obraId, titulo } = req.body || {};
            if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, motivo: 'sin documentos seleccionados' });
            res.json(await asignarObra(await conectarDB(), ids, { obraId, titulo }));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    // GESTIÓN DE GRUPOS (revisión humana, solo admin): fusionar / explotar / eliminar-vacía colecciones y
    // obras. Sin pérdida de datos (solo vínculos en Mongo + borrar el padre abstracto vacío).
    const grupo = (fn, arg) => async (req, res) => {
        try {
            if (req.usuario?.rol !== 'admin') return res.status(403).json({ ok: false, motivo: 'solo administradores' });
            res.json(await fn(await conectarDB(), ...arg(req.body || {})));
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    };
    r.post('/colecciones/fusionar', grupo(fusionarColecciones, b => [b.ids || [], b.destino]));
    r.post('/colecciones/explotar', grupo(explotarColeccion, b => [b.id]));
    r.post('/colecciones/eliminar', grupo(eliminarColeccionVacia, b => [b.id]));
    r.post('/obras/fusionar', grupo(fusionarObras, b => [b.ids || [], b.destino]));
    r.post('/obras/explotar', grupo(explotarObra, b => [b.id]));
    r.post('/obras/eliminar', grupo(eliminarObraVacia, b => [b.id]));

    // Descripción (título conciso + texto extenso, ES) de un código de clasificación — de CACHÉ o
    // generada por IA al momento. CDU → cdu_descripciones/describirCDU; Dewey/LCC →
    // clasificacion_descripciones/describirClasificacion. Alimenta el popup ⓘ de la ficha/dashboard.
    r.get('/clasificacion', async (req, res) => {
        try {
            const sistema = String(req.query.sistema || '').toLowerCase();
            const codigo = String(req.query.codigo || '').trim();
            if (!codigo) return res.status(400).json({ ok: false, motivo: 'falta el código' });
            const db = await conectarDB();
            // Solo el ADMIN puede GENERAR (IA + escritura en la caché de descripciones). El invitado
            // NO dispara IA ni escribe en BD: lee la caché y, si falta, recibe null. (Cumple "los
            // invitados no cambian nada en la BD" y la regla de MINIMIZAR IA — sin coste por invitado.)
            const esAdmin = req.usuario?.rol === 'admin';
            if (sistema === 'cdu') {
                const cod = sanitizarCDU(codigo);
                let d = await db.collection('cdu_descripciones').findOne({ codigo: cod });
                if (!d && esAdmin) d = await describirCDU(db, codigo);
                return res.json({ ok: true, sistema, codigo, titulo: d?.titulo_es || null, descripcion: d?.descripcion_es || null });
            }
            if (sistema === 'dewey' || sistema === 'lcc') {
                let d = await db.collection('clasificacion_descripciones').findOne({ sistema, codigo });
                if (!d && esAdmin) d = await describirClasificacion(db, sistema, codigo);
                return res.json({ ok: true, sistema, codigo, titulo: d?.titulo_es || null, descripcion: d?.descripcion_es || null });
            }
            return res.status(400).json({ ok: false, motivo: 'sistema inválido (cdu|dewey|lcc)' });
        } catch (e) { res.status(500).json({ ok: false, motivo: e.message }); }
    });

    return r;
}
