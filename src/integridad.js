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
import { reciclar, reciclarCarpeta as reciclarArbolAPapelera } from './utils/papelera.js';
import { esTituloArtefacto } from './utils/parsear-nombre.js';
import { esDocumentoLeible, esMaterialNotable, esVideo } from './utils/criba-material.js';
import { metricasFichero, ganaEntrante, reemplazarFicheroDeDoc } from './utils/duplicados.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const dir = (env, def) => { const v = process.env[env] || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = dir('PATH_CDU', 'CDU');
const DIR_CUARENTENA = dir('PATH_CUARENTENA', 'Cuarentena');

// Respaldo para documentos ANTIGUOS sin `nombre_archivo`. Se apoya en la FUENTE ÚNICA (criba-material.js) en
// vez de mantener otra lista: la de antes (['.epub','.pdf','.mobi','.cbr','.djvu','.zip','.rar']) ni siquiera
// cuadraba con FORMATOS_DOC de aquí abajo —le faltaban .cbz, .azw3, .cb7, .chm, .docx— y por eso denunciaba
// cómics y ebooks perfectamente presentes. Se añaden .zip/.rar (originales que no se llegaron a expandir).
// Sidecars que escribe el propio sistema: NUNCA son «el original» de nada (si contaran, una carpeta con solo
// el manifiesto parecería tener contenido y taparíamos un caso real).
const ES_SIDECAR = /^(registro\.json|registro\.marc\.xml|_contenido\.txt)$/i;
const esFicheroOriginal = (n) =>
    !ES_SIDECAR.test(n) && (esDocumentoLeible(n) || esVideo(n) || esMaterialNotable(n, Infinity) || /\.(zip|rar)$/i.test(n));
const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
// Formatos de DOCUMENTO: los que sí deben tener un fichero de texto/imagen como original. Un AUDIOLIBRO sin
// ninguno de estos es audio-only: su «original» son las pistas de audio, no un pdf/epub → NO cuenta como «sin
// fichero» (sus pistas las audita `docsConAudiosRotos`).
const FORMATOS_DOC = ['pdf', 'epub', 'mobi', 'azw3', 'cbr', 'cbz', 'cb7', 'djvu'];
// ¿Es un audiolibro audio-only (tiene audio y NO espera un fichero de documento)? Entonces la comprobación
// «falta el fichero original» no aplica. Un audiolibro CON pdf sí se comprueba.
const esAudioSinDoc = (d) => {
    const f = d.formatos || [];
    const tieneAudio = (Array.isArray(d.audios) && d.audios.length) || d.naturaleza === 'audiolibro' || f.includes('audio');
    return tieneAudio && !f.some((x) => FORMATOS_DOC.includes(x));
};
// Marcador de ÁRBOL PRESERVADO (transmedia/audiolibro): un fichero .ruta_fija en la raíz de un árbol
// protege TODO su subárbol — Integridad no lo poda, ni lo recicla como huérfano, ni lo reubica (estructura
// intacta, política «borrar nunca»). Los documentos de dentro llevan además `ruta_fija:true`.
const MARCA_RUTA_FIJA = '.ruta_fija';
const ignorar = (n) => n.startsWith('@') || n.startsWith('.') || n.startsWith('#');
const ext = (n) => path.extname(n).toLowerCase();
const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const webDe = (carpeta) => '/recursos/' + path.relative(DIR_CDU, carpeta).split(path.sep).join('/');
const absDe = (web) => web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null;
const tieneDocFichero = async (d) => { if (!d) return false; try { return (await fs.readdir(d)).some(esFicheroOriginal); } catch { return false; } };
const ficheroOriginal = async (carpeta) => { if (!carpeta) return null; try { const n = (await fs.readdir(carpeta)).find(esFicheroOriginal); return n ? path.join(carpeta, n) : null; } catch { return null; } };

/** ¿Hay ALGÚN fichero, a CUALQUIER profundidad, que no sea basura del sistema (@eaDir, .DS_Store, Thumbs.db)? */
async function tieneAlgunFichero(dir) {
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
        if (e.isFile() && !ignorar(e.name)) return true;
        if (e.isDirectory() && !ignorar(e.name) && await tieneAlgunFichero(path.join(dir, e.name))) return true;
    }
    return false;
}

/**
 * Retira una carpeta del árbol CDU. Si tiene CUALQUIER contenido —a cualquier profundidad— se va ENTERA a la
 * Papelera, con su manifiesto, restaurable a su sitio exacto. Solo se BORRA lo que está literalmente vacío.
 *
 * ESTO ERA EL AGUJERO. Antes había aquí una `reciclarCarpeta` propia (ignorando la de papelera.js) que
 * reciclaba los ficheros del PRIMER NIVEL y hacía `fs.rm(recursive)` de todo lo demás: lo que colgara de una
 * subcarpeta NO pasaba por la Papelera, se BORRABA. Con un audiolibro cuyas pistas viven en
 * `.../Audio/Version 1/*.mp3`, podar la «rama muerta» Audio/ (que no tiene ficheros directos) borraba los mp3
 * sin dejar rastro en ninguna parte. Por ahí se fue «una carpeta entera sin dejar rastro en Mongo».
 * La de papelera.js copia el ÁRBOL, lo verifica, y solo entonces borra el origen; y anota el manifiesto.
 */
async function reciclarCarpeta(carpeta, etiqueta) {
    if (!carpeta) return;
    if (await tieneAlgunFichero(carpeta)) await reciclarArbolAPapelera(carpeta, etiqueta);
    else await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
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
export async function verificarIntegridad({ reparar = false, onProgress = null } = {}) {
    const prog = (fase, extra = {}) => { try { onProgress?.({ fase, ...extra }); } catch { /* el progreso nunca rompe */ } };
    prog('cargando');
    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const docs = await col.find({}, { projection: { titulo: 1, ruta_base: 1, isbn: 1, issn: 1, nombre_archivo: 1, formatos: 1, audios: 1, naturaleza: 1, hash_contenido: 1, estado_verificacion: 1, cdu: 1, autores: 1, sinopsis: 1, obra: 1, ruta_fija: 1 } }).toArray();
    const rutasWeb = new Set(docs.map(d => d.ruta_base).filter(Boolean));
    const porId = new Map(docs.map(d => [String(d._id), d]));

    const informe = {
        ts: new Date().toISOString(), reparar, totalDocs: docs.length,
        diagnostico: {}, reparado: reparar ? {} : null, muestras: {}, detalles: {},
    };
    const D = informe.diagnostico, R = informe.reparado, M = informe.muestras, T = informe.detalles;

    // `muestras` = lo que ve el panel (RECORTADA: se sondea cada 1,5 s, no puede ir cargada).
    // `detalles`  = la lista COMPLETA, para el informe .txt descargable (`estadoIntegridad` la quita del sondeo).
    // Las dos salen del MISMO mapeador: así jamás pueden contar cosas distintas.
    const anotar = (clave, lista, mapear, tope = 12) => {
        M[clave] = lista.slice(0, tope).map(mapear);
        T[clave] = lista.map(mapear);
    };
    // Ficha de un documento para los listados: lo justo para IDENTIFICARLO sin tener que abrir Mongo.
    const fichaDoc = (d, extra = {}) => ({
        id: String(d._id), titulo: d.titulo || '(sin título)', archivo: d.nombre_archivo || null,
        ruta: d.ruta_base || null, isbn: d.isbn || null, issn: d.issn || null,
        cdu: d.cdu || null, formatos: d.formatos || [], ...extra,
    });

    // ── A. Docs sin carpeta en disco (solo informa) ──
    const sinCarpeta = [];
    let _iA = 0;
    for (const d of docs) { if (d.ruta_base && !await existe(absDe(d.ruta_base))) sinCarpeta.push(d); if (++_iA % 50 === 0) prog('docs-sin-carpeta', { i: _iA, total: docs.length }); }
    D.docsSinCarpeta = sinCarpeta.length;
    anotar('docsSinCarpeta', sinCarpeta, d => fichaDoc(d));

    // ── D. Docs cuya carpeta existe pero falta el fichero original (solo informa) ──
    prog('docs-sin-fichero', { i: 0, total: docs.length });
    const sinFichero = [];
    let _iD = 0;
    for (const d of docs) {
        if (++_iD % 50 === 0) prog('docs-sin-fichero', { i: _iD, total: docs.length });
        // 'papel' (sin fichero digital) y AUDIOLIBROS audio-only (su original son las pistas) no aplican.
        if ((d.formatos || []).includes('papel') || !d.ruta_base || esAudioSinDoc(d)) continue;
        const carpeta = absDe(d.ruta_base);
        if (!await existe(carpeta)) continue;   // eso ya lo cuenta «docs sin carpeta»
        // NO SE ADIVINA POR EXTENSIÓN: el documento YA SABE cómo se llama su fichero (`nombre_archivo`), así
        // que se comprueba ESE. Antes se buscaba «algún fichero con una extensión de la lista EXT_DOC», una
        // lista estrecha que ni siquiera coincidía con FORMATOS_DOC de aquí al lado: le faltaban .cbz, .azw3,
        // .cb7, .chm, .docx y los vídeos → un cómic .cbz se denunciaba «sin fichero original» CON el .cbz al
        // lado (174 falsos positivos, confirmado por el usuario con «Don Miki 101»). Y lo peor: tanto ruido
        // ESCONDE los casos reales — una alarma que miente no la mira nadie.
        const falta = d.nombre_archivo
            ? !await existe(path.join(carpeta, d.nombre_archivo))
            : !await tieneDocFichero(carpeta);   // sin nombre_archivo (docs antiguos) → respaldo por extensión
        if (falta) sinFichero.push(d);
    }
    D.docsSinFicheroOriginal = sinFichero.length;
    anotar('docsSinFicheroOriginal', sinFichero, d => fichaDoc(d));

    // ── D-bis. AUDIOS ROTOS: docs cuyo `audios[]` apunta a ficheros que NO están en disco (solo informa) ──
    // PUNTO CIEGO que esto tapa: la comprobación de arriba EXCLUYE a los audiolibros (`esAudioSinDoc`) porque
    // su original no es un EXT_DOC — razonable, pero dejaba SIN AUDITAR justo a los que solo tienen audio. Un
    // audiolibro cuyos mp3 desaparecieron era INVISIBLE para la auditoría: el documento existe, se lista en el
    // catálogo, y solo al pulsar «reproducir» descubres que no hay nada. Caso real: una colección anidada cuya
    // padre recicló el origen antes de que se copiara la hija → docs apuntando a una carpeta vacía.
    prog('audios-rotos', { i: 0, total: docs.length });
    const audiosRotos = [];
    let _iAR = 0;
    for (const d of docs) {
        if (++_iAR % 50 === 0) prog('audios-rotos', { i: _iAR, total: docs.length });
        const pistas = Array.isArray(d.audios) ? d.audios : [];
        if (!pistas.length) continue;
        // Se anota QUÉ pistas faltan, no solo cuántas: en el informe, «faltan 3 de 12» no sirve para arreglar
        // nada — hace falta saber cuáles para ir a buscarlas a la Papelera o al origen.
        const rotas = [];
        for (const a of pistas) {
            const abs = absDe(a?.ruta);
            if (!abs || !(await existe(abs))) rotas.push(a?.ruta || '(pista sin ruta)');
        }
        if (rotas.length) audiosRotos.push({ d, faltan: rotas.length, total: pistas.length, rotas });
    }
    D.docsConAudiosRotos = audiosRotos.length;
    anotar('docsConAudiosRotos', audiosRotos, x => fichaDoc(x.d, {
        faltan: `${x.faltan}/${x.total} pistas`, pistas: x.rotas,
    }));

    // ── Recorrido del árbol CDU: hojas (registro/doc/img), ramas muertas, registro sin doc, huérfanas/desync ──
    prog('recorrido-arbol', { carpetas: 0 });
    const carpetasHuerfanas = [], rutaBaseDesync = [], registroSinDoc = [], sinHoja = new Set();
    let _carp = 0;
    async function recorrer(d) {
        if (++_carp % 50 === 0) prog('recorrido-arbol', { carpetas: _carp });
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return false; }
        // ÁRBOL PRESERVADO: el marcador .ruta_fija protege TODO el subárbol. Se cuenta como "con contenido"
        // (para que el padre no sea rama muerta) y NO se desciende → no se poda/recicla nada de dentro
        // (Audio/, Activities/, portadas…). (ignorar() filtra los «.», por eso se mira sobre las entradas crudas.)
        if (ents.some(e => e.isFile() && e.name === MARCA_RUTA_FIJA)) return true;
        const files = ents.filter(e => e.isFile() && !ignorar(e.name)).map(e => e.name);
        const subdirs = ents.filter(e => e.isDirectory() && !ignorar(e.name));
        // Estos tres son para el DIAGNÓSTICO (distinguir «registro sin documento»), no para decidir qué se poda.
        const tieneDoc = files.some(esFicheroOriginal);
        const tieneImg = files.some(n => EXT_IMG.includes(ext(n)));
        const tieneReg = files.includes('registro.json');
        let hojaAbajo = false;
        for (const s of subdirs) hojaAbajo = (await recorrer(path.join(d, s.name))) || hojaAbajo;
        // CONTENIDO (lo que decide si esto es una «rama muerta» PODABLE) = CUALQUIER fichero que no sea basura
        // del sistema. NO una lista blanca de formatos.
        //
        // Esto es la lección del día entero. La lista blanca decide «no reconozco esta extensión → esto está
        // vacío → se poda», y ni la lista vieja ni la nueva contemplan .mp3/.m4b/.flac: una carpeta Audio/ con
        // las pistas de un audiolibro se declaraba VACÍA. Lo mismo le pasaría a cualquier formato que no
        // hayamos previsto — y siempre habrá uno. Una lista blanca puede fallar decidiendo qué se INDEXA; no
        // puede fallar decidiendo qué se BORRA. Aquí el defecto es CONSERVAR: se poda lo literalmente vacío.
        const contenido = files.length > 0;
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
    anotar('ramasMuertas', ramasMuertas, webDe, 15);
    anotar('carpetasHuerfanas', carpetasHuerfanas, webDe);
    anotar('registroSinDocumento', registroSinDoc, webDe, 15);
    anotar('rutaBaseDesajustada', rutaBaseDesync, x => fichaDoc(x.doc, { enDisco: x.web, enBD: x.doc.ruta_base }));

    // ── F. Varios documentos comparten la MISMA ruta_base (rompe 1-doc↔1-carpeta). Solo informa: se
    //     arregla recatalogando a mano (botón «Reprocesar» de la ficha) — la carpeta tiene 2+ ficheros
    //     distintos y separarlos automáticamente sin riesgo no es trivial. ──
    const porRuta = new Map();
    for (const d of docs) {
        if (!d.ruta_base || d.ruta_fija) continue; // transmedia: varios miembros comparten carpeta A PROPÓSITO
        if (!porRuta.has(d.ruta_base)) porRuta.set(d.ruta_base, []);
        porRuta.get(d.ruta_base).push(d);
    }
    const rutaCompartida = [...porRuta.values()].filter(g => g.length > 1);
    D.rutaBaseCompartida = rutaCompartida.length;
    anotar('rutaBaseCompartida', rutaCompartida, g => ({ ruta: g[0].ruta_base, docs: g.map(d => fichaDoc(d)) }));

    // ── C. Duplicados exactos por hash ──
    prog('duplicados-hash');
    const hashDups = await col.aggregate([
        // Se EXCLUYEN los árboles preservados (ruta_fija): en transmedia, ficheros de igual hash conviven a
        // propósito y NUNCA se reciclan; ni se diagnostican como duplicados.
        { $match: { hash_contenido: { $exists: true, $ne: null }, ruta_fija: { $ne: true } } },
        { $group: { _id: '$hash_contenido', n: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { n: { $gt: 1 } } },
    ]).toArray();
    D.hashDuplicadosGrupos = hashDups.length;
    D.hashDuplicadosDocs = hashDups.reduce((s, g) => s + (g.n - 1), 0); // sobrantes
    anotar('hashDuplicados', hashDups, g => ({
        hash: g._id,
        docs: g.ids.map(id => porId.get(String(id))).filter(Boolean).map(d => fichaDoc(d)),
    }));

    // ── Cuarentena/duplicados pendientes ──
    let depositos = [];
    try { depositos = (await fs.readdir(path.join(DIR_CUARENTENA, 'duplicados'), { withFileTypes: true })).filter(e => e.isDirectory()); } catch { /* */ }
    D.cuarentenaDuplicados = depositos.length;
    anotar('cuarentenaDuplicados', depositos, e => e.name, 15);

    if (!reparar) { prog('hecho'); return informe; }

    // ════════════════════════ REPARACIÓN (todo a la Papelera) ════════════════════════
    prog('reparando');
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
        // No tocar: tomos de obra (identidad = obra+nº) NI árboles preservados (transmedia: dos PDF de igual
        // hash → un doc, pero AMBOS ficheros permanecen; el dedup no debe reciclar ninguno).
        if (grupo.length < 2 || grupo.some(d => d.obra || d.ruta_fija)) continue;
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

    prog('hecho');
    return informe;
}

// ── Ejecución en SEGUNDO PLANO (para el panel): la POST arranca y devuelve al instante; el progreso y el
//    informe final se consultan con estadoIntegridad(). Evita que un proxy corte la petición larga (405). ──
let trabajoInteg = { en_curso: false, fase: null, progreso: {}, reparar: false, ts: null, informe: null, error: null };
// El panel SONDEA esto cada 1,5 s → se le manda el informe SIN `detalles` (que puede traer miles de entradas:
// mandarlas en cada sondeo sería absurdo). El detalle completo se sirve UNA vez, bajo demanda, como .txt.
export function estadoIntegridad() {
    if (!trabajoInteg.informe) return { ...trabajoInteg };
    const { detalles, ...informeLigero } = trabajoInteg.informe;
    return { ...trabajoInteg, informe: informeLigero };
}
/** Informe COMPLETO (con `detalles`) del último diagnóstico, para el .txt descargable. */
export function ultimoInformeIntegridad() { return trabajoInteg.informe || null; }
export function lanzarIntegridad({ reparar = false } = {}) {
    if (trabajoInteg.en_curso) return { ok: false, motivo: 'ya hay una verificación en curso' };
    trabajoInteg = { en_curso: true, fase: 'cargando', progreso: {}, reparar: !!reparar, ts: new Date().toISOString(), informe: null, error: null };
    (async () => {
        try {
            const inf = await verificarIntegridad({ reparar, onProgress: (p) => { trabajoInteg.fase = p.fase; trabajoInteg.progreso = p; } });
            trabajoInteg.informe = inf;
        } catch (e) { trabajoInteg.error = e.message; }
        finally { trabajoInteg.en_curso = false; trabajoInteg.fase = 'hecho'; }
    })();
    return { ok: true };
}
