/**
 * INTEGRIDAD — tarea única que consolida los chequeos y reparaciones del archivo (los antiguos
 * scripts auditoria-integridad / resolver-duplicados). Una sola llamada: `verificarIntegridad({reparar})`.
 *
 *   reparar=false → DIAGNÓSTICO (no toca nada): devuelve un informe con cuentas y muestras.
 *   reparar=true  → DIAGNÓSTICO + REPARACIÓN SEGURA (todo va a la Papelera, nunca borra sin red):
 *       · poda ramas vacías / sin hojas (E)
 *       · deja la BD apuntando a la carpeta con el fichero y recicla la duplicada (ruta_base desync, B)
 *       · recicla carpetas huérfanas (registro en disco sin documento en Mongo, B)
 *       · deduplica por hash: conserva el mejor, recicla el resto (C)
 *       · resuelve Cuarentena/duplicados por la política tamaño/fecha (reusa utils/duplicados)
 *   NO repara automáticamente: docs sin carpeta (A) ni docs sin el fichero original (D) — solo informa
 *   (requieren restaurar/recatalogar a mano).
 *
 * Se dispara a voluntad (panel / CLI scripts/integridad.js) o se programa (Task Scheduler de DSM).
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
import { conectarDB } from './database.js';
import { reciclar } from './utils/papelera.js';
import { esTituloArtefacto } from './utils/parsear-nombre.js';
import { metricasFichero, ganaEntrante, reemplazarFicheroDeDoc } from './utils/duplicados.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const dir = (env, def) => { const v = process.env[env] || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = dir('PATH_CDU', 'CDU');
const DIR_CUARENTENA = dir('PATH_CUARENTENA', 'Cuarentena');

const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const ignorar = (n) => n.startsWith('@') || n.startsWith('.') || n.startsWith('#');
const ext = (n) => path.extname(n).toLowerCase();
const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const webDe = (carpeta) => '/recursos/' + path.relative(DIR_CDU, carpeta).split(path.sep).join('/');
const absDe = (web) => web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null;
const tieneDocFichero = async (d) => { if (!d) return false; try { return (await fs.readdir(d)).some(n => EXT_DOC.includes(ext(n))); } catch { return false; } };
const ficheroOriginal = async (carpeta) => { if (!carpeta) return null; try { const n = (await fs.readdir(carpeta)).find(x => EXT_DOC.includes(ext(x))); return n ? path.join(carpeta, n) : null; } catch { return null; } };

async function reciclarCarpeta(carpeta, etiqueta) {
    let ents; try { ents = await fs.readdir(carpeta, { withFileTypes: true }); } catch { return; }
    const ficheros = ents.filter(e => e.isFile()).map(e => path.join(carpeta, e.name));
    if (ficheros.length) await reciclar(ficheros, etiqueta);
    await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
}

// Puntúa un documento para elegir el "mejor" de un grupo de copias idénticas (hash).
function puntuaDoc(d) {
    let s = 0;
    if (d.estado_verificacion === 'completado') s += 4;
    if (d.isbn) s += 3;
    if (d.titulo && !esTituloArtefacto(d.titulo)) s += 2;
    if (d.cdu && !/sin_clasificar/i.test(d.cdu)) s += 1;
    if (Array.isArray(d.autores) && d.autores.length) s += 1;
    if (d.sinopsis) s += 1;
    if (d.nombre_archivo && /\(\d+\)\.[^.]+$/.test(d.nombre_archivo)) s -= 2; // copia "(N)" del sistema de ficheros
    return s;
}

/**
 * Ejecuta el diagnóstico (y reparación si reparar=true) y devuelve un informe estructurado.
 */
export async function verificarIntegridad({ reparar = false } = {}) {
    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const docs = await col.find({}, { projection: { titulo: 1, ruta_base: 1, isbn: 1, issn: 1, nombre_archivo: 1, formatos: 1, hash_contenido: 1, estado_verificacion: 1, cdu: 1, autores: 1, sinopsis: 1, obra: 1 } }).toArray();
    const rutasWeb = new Set(docs.map(d => d.ruta_base).filter(Boolean));
    const porId = new Map(docs.map(d => [String(d._id), d]));

    const informe = {
        ts: new Date().toISOString(), reparar, totalDocs: docs.length,
        diagnostico: {}, reparado: reparar ? {} : null, muestras: {},
    };
    const D = informe.diagnostico, R = informe.reparado, M = informe.muestras;

    // ── A. Docs sin carpeta en disco (solo informa) ──
    const sinCarpeta = [];
    for (const d of docs) { if (d.ruta_base && !await existe(absDe(d.ruta_base))) sinCarpeta.push(d); }
    D.docsSinCarpeta = sinCarpeta.length;
    M.docsSinCarpeta = sinCarpeta.slice(0, 10).map(d => ({ id: String(d._id), titulo: d.titulo, ruta: d.ruta_base }));

    // ── D. Docs cuya carpeta existe pero falta el fichero original (solo informa) ──
    const sinFichero = [];
    for (const d of docs) {
        if ((d.formatos || []).includes('papel') || !d.ruta_base) continue;
        const carpeta = absDe(d.ruta_base);
        if (await existe(carpeta) && !await tieneDocFichero(carpeta)) sinFichero.push(d);
    }
    D.docsSinFicheroOriginal = sinFichero.length;
    M.docsSinFicheroOriginal = sinFichero.slice(0, 10).map(d => ({ id: String(d._id), titulo: d.titulo, archivo: d.nombre_archivo }));

    // ── Recorrido del árbol CDU: hojas (registro/doc/img), ramas muertas, registro sin doc, huérfanas/desync ──
    const carpetasHuerfanas = [], rutaBaseDesync = [], registroSinDoc = [], sinHoja = new Set();
    async function recorrer(d) {
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return false; }
        const files = ents.filter(e => e.isFile() && !ignorar(e.name)).map(e => e.name);
        const subdirs = ents.filter(e => e.isDirectory() && !ignorar(e.name));
        const tieneDoc = files.some(n => EXT_DOC.includes(ext(n)));
        const tieneImg = files.some(n => EXT_IMG.includes(ext(n)));
        const tieneReg = files.includes('registro.json');
        let hojaAbajo = false;
        for (const s of subdirs) hojaAbajo = (await recorrer(path.join(d, s.name))) || hojaAbajo;
        const contenido = tieneDoc || tieneImg || tieneReg;
        if (d !== DIR_CDU) {
            if (!contenido && !hojaAbajo) sinHoja.add(d);
            else if (tieneReg && !tieneDoc && !tieneImg) registroSinDoc.push(d);
            if (tieneReg) {
                const web = webDe(d);
                if (!rutasWeb.has(web)) {
                    let regId = null; try { regId = JSON.parse(await fs.readFile(path.join(d, 'registro.json'), 'utf8'))._id || null; } catch { /* */ }
                    if (regId && porId.has(String(regId))) rutaBaseDesync.push({ carpeta: d, web, doc: porId.get(String(regId)) });
                    else carpetasHuerfanas.push(d);
                }
            }
        }
        return contenido || hojaAbajo;
    }
    if (await existe(DIR_CDU)) await recorrer(DIR_CDU);
    const ramasMuertas = [...sinHoja].filter(d => !sinHoja.has(path.dirname(d)));
    D.ramasMuertas = ramasMuertas.length;
    D.registroSinDocumento = registroSinDoc.length;
    D.carpetasHuerfanas = carpetasHuerfanas.length;
    D.rutaBaseDesajustada = rutaBaseDesync.length;
    M.ramasMuertas = ramasMuertas.slice(0, 15).map(webDe);
    M.carpetasHuerfanas = carpetasHuerfanas.slice(0, 10).map(webDe);
    M.registroSinDocumento = registroSinDoc.slice(0, 15).map(webDe);
    M.rutaBaseDesajustada = rutaBaseDesync.slice(0, 10).map(x => ({ id: String(x.doc._id), titulo: x.doc.titulo, enDisco: x.web, enBD: x.doc.ruta_base }));

    // ── F. Varios documentos comparten la MISMA ruta_base (rompe 1-doc↔1-carpeta). Solo informa: se
    //     arregla recatalogando a mano (botón «Reprocesar» de la ficha) — la carpeta tiene 2+ ficheros
    //     distintos y separarlos automáticamente sin riesgo no es trivial. ──
    const porRuta = new Map();
    for (const d of docs) {
        if (!d.ruta_base) continue;
        if (!porRuta.has(d.ruta_base)) porRuta.set(d.ruta_base, []);
        porRuta.get(d.ruta_base).push(d);
    }
    const rutaCompartida = [...porRuta.values()].filter(g => g.length > 1);
    D.rutaBaseCompartida = rutaCompartida.length;
    M.rutaBaseCompartida = rutaCompartida.slice(0, 10).map(g => ({
        ruta: g[0].ruta_base,
        docs: g.map(d => ({ id: String(d._id), titulo: d.titulo, archivo: d.nombre_archivo })),
    }));

    // ── C. Duplicados exactos por hash ──
    const hashDups = await col.aggregate([
        { $match: { hash_contenido: { $exists: true, $ne: null } } },
        { $group: { _id: '$hash_contenido', n: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { n: { $gt: 1 } } },
    ]).toArray();
    D.hashDuplicadosGrupos = hashDups.length;
    D.hashDuplicadosDocs = hashDups.reduce((s, g) => s + (g.n - 1), 0); // sobrantes
    M.hashDuplicados = hashDups.slice(0, 10).map(g => ({
        docs: g.ids.map(id => porId.get(String(id))).filter(Boolean)
            .map(d => ({ id: String(d._id), titulo: d.titulo, isbn: d.isbn || null, archivo: d.nombre_archivo })),
    }));

    // ── Cuarentena/duplicados pendientes ──
    let depositos = [];
    try { depositos = (await fs.readdir(path.join(DIR_CUARENTENA, 'duplicados'), { withFileTypes: true })).filter(e => e.isDirectory()); } catch { /* */ }
    D.cuarentenaDuplicados = depositos.length;
    M.cuarentenaDuplicados = depositos.slice(0, 15).map(e => e.name);

    if (!reparar) return informe;

    // ════════════════════════ REPARACIÓN (todo a la Papelera) ════════════════════════
    // E. Podar ramas muertas.
    let podadas = 0;
    for (const d of ramasMuertas) { await reciclarCarpeta(d, 'rama-muerta'); podadas++; }
    R.ramasPodadas = podadas;

    // B. ruta_base desajustada: que la BD apunte a la carpeta con el fichero; reciclar la otra.
    let rutasReparadas = 0;
    for (const { carpeta, web, doc } of rutaBaseDesync) {
        const rbFolder = absDe(doc.ruta_base);
        if (await tieneDocFichero(rbFolder)) { await reciclarCarpeta(carpeta, 'carpeta-stale'); rutasReparadas++; }
        else if (await tieneDocFichero(carpeta)) { await col.updateOne({ _id: doc._id }, { $set: { ruta_base: web } }); if (rbFolder) await reciclarCarpeta(rbFolder, 'carpeta-vacia'); rutasReparadas++; }
    }
    R.rutasReparadas = rutasReparadas;

    // B. Carpetas huérfanas (registro sin doc en Mongo) → reciclar.
    let huerfanasRecicladas = 0;
    for (const d of carpetasHuerfanas) { await reciclarCarpeta(d, 'carpeta-huerfana'); huerfanasRecicladas++; }
    R.carpetasHuerfanasRecicladas = huerfanasRecicladas;

    // C. Deduplicar por hash: conservar el mejor, reciclar el resto + borrar sus docs.
    let hashEliminados = 0;
    for (const g of hashDups) {
        const grupo = g.ids.map(id => porId.get(String(id))).filter(Boolean);
        if (grupo.length < 2 || grupo.some(d => d.obra)) continue; // tomos de obra: no tocar
        grupo.sort((a, b) => puntuaDoc(b) - puntuaDoc(a));
        const [, ...perdedores] = grupo;
        for (const p of perdedores) {
            if (p.ruta_base) await reciclarCarpeta(absDe(p.ruta_base), `hashdup-${p.isbn || p._id}`);
            await col.deleteOne({ _id: p._id });
            hashEliminados++;
        }
    }
    R.hashDuplicadosEliminados = hashEliminados;

    // Cuarentena/duplicados: resolver por la política tamaño/fecha (reusa utils/duplicados).
    let cuarentenaResueltos = 0;
    for (const dep of depositos) {
        const depDir = path.join(DIR_CUARENTENA, 'duplicados', dep.name);
        try {
            const estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8'));
            const fichs = (await fs.readdir(depDir)).filter(n => n !== 'estado.json').map(n => path.join(depDir, n));
            const entrante = fichs[0]; if (!entrante) continue;
            const idEx = estado.documento_existente_id;
            const doc = (idEx && ObjectId.isValid(idEx)) ? await col.findOne({ _id: new ObjectId(idEx) }) : null;
            const en = await metricasFichero(entrante);
            const ex = await metricasFichero(doc ? await ficheroOriginal(absDe(doc.ruta_base)) : null);
            if (doc && ganaEntrante(ex, en)) await reemplazarFicheroDeDoc(doc, entrante);
            for (const f of fichs) { await fs.chmod(f, 0o666).catch(() => {}); await fs.rm(f, { force: true }).catch(() => {}); }
            await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
            cuarentenaResueltos++;
        } catch { /* deja el depósito si algo falla */ }
    }
    R.cuarentenaResueltos = cuarentenaResueltos;

    return informe;
}
