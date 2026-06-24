/**
 * Auditoría de integridad del archivo digital.
 *
 * Detecta seis clases de problemas:
 *   A. Documentos MongoDB sin carpeta en disco  (doc huérfano)
 *   B. Carpetas en el árbol CDU sin documento MongoDB (carpeta huérfana)
 *   C. Documentos duplicados por hash_contenido (copias exactas ya en BD)
 *   D. Documentos cuya carpeta existe pero le FALTA el fichero original (.epub/.pdf
 *      desaparecido). Localiza el original por nombre en Inbox/Cuarentena/Reintentos.
 *   E. Estructura del árbol: carpetas vacías y RAMAS SIN HOJAS (subárboles sin ningún
 *      documento/registro/imagen — podables) y carpetas con registro/sidecars pero SIN documento.
 *
 * Solo informa por defecto. Ejecutar:
 *   node scripts/auditoria-integridad.js [--fix-rutas] [--limpiar]
 *
 * --fix-rutas: REPARA las inconsistencias de B (un doc con DOS carpetas en disco: la viva, donde
 *   ruta_base apunta y está el fichero, y una stale sobrante). Deja la BD apuntando a la carpeta que
 *   SÍ tiene el fichero y RECICLA la otra → match 1:1 BD↔disco. Nunca borra sin reciclar.
 * --limpiar:   ELIMINA las carpetas vacías y ramas sin hojas (E) — son podas seguras: no contienen
 *   ningún documento/registro/imagen. NO toca nada que tenga contenido.
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');

function resolverDir(envVar, defecto) {
    const v = process.env[envVar] || defecto;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
}
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
const DIR_INBOX = resolverDir('PATH_INBOX', 'Inbox');
const DIR_CUARENTENA = resolverDir('PATH_CUARENTENA', 'Cuarentena');
const DIR_REINTENTOS = resolverDir('PATH_REINTENTOS', 'Reintentos');
const FIX_RUTAS = process.argv.includes('--fix-rutas');
const LIMPIAR = process.argv.includes('--limpiar');
const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const ignorarEntrada = (n) => n.startsWith('@') || n.startsWith('.') || n.startsWith('#');

// Extensiones del fichero "original" (no las imágenes/sidecars que genera el sistema).
const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function existeDir(p) {
    return fs.access(p).then(() => true).catch(() => false);
}

/** Indexa recursivamente los ficheros de un directorio: Map<nombreBase, [rutas...]>. */
async function indexarFicheros(raiz, indice, etiqueta) {
    async function walk(dir) {
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const ruta = path.join(dir, e.name);
            if (e.isDirectory()) { await walk(ruta); continue; }
            if (!EXT_DOC.includes(path.extname(e.name).toLowerCase())) continue;
            if (!indice.has(e.name)) indice.set(e.name, []);
            indice.get(e.name).push(`${etiqueta}: ${ruta}`);
        }
    }
    if (await existeDir(raiz)) await walk(raiz);
}

/** Camina recursivamente el árbol CDU y devuelve todas las hojas (carpetas con registro.json). */
async function listarCarpetasCDU(raiz) {
    const hojas = [];
    async function walk(dir, nivel = 0) {
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        const tieneRegistro = entradas.some(e => e.isFile() && e.name === 'registro.json');
        if (tieneRegistro) {
            hojas.push(dir);
            return; // no descender más: la hoja se encontró
        }
        for (const e of entradas) {
            if (e.isDirectory()) await walk(path.join(dir, e.name), nivel + 1);
        }
    }
    await walk(raiz);
    return hojas;
}

/** Ruta web (/recursos/...) a partir de la ruta absoluta de la carpeta. */
function rutaWebDeCarpeta(carpeta) {
    const rel = path.relative(DIR_CDU, carpeta).split(path.sep).join('/');
    return '/recursos/' + rel;
}

// ── Principal ─────────────────────────────────────────────────────────────────

async function main() {
    const uri = process.env.MONGO_URI;
    const db_name = process.env.MONGO_DB_NAME || 'biblioteca';
    if (!uri) { console.error('MONGO_URI no definida en .env'); process.exit(1); }

    console.log('Conectando a MongoDB…');
    const client = new MongoClient(uri);
    await client.connect();
    const db = client.db(db_name);
    const col = db.collection('biblioteca');

    // ── A. Docs sin carpeta ──────────────────────────────────────────────────
    console.log('\n── A. Documentos sin carpeta en disco ──────────────────────────────');
    const todos = await col.find({}, {
        projection: { _id: 1, titulo: 1, ruta_base: 1, isbn: 1, issn: 1, nombre_archivo: 1, tipo_recurso: 1, formatos: 1, archivos_originales: 1 }
    }).toArray();

    const sinCarpeta = [];
    const sinRutaBase = [];
    for (const doc of todos) {
        if (!doc.ruta_base) { sinRutaBase.push(doc); continue; }
        const rel = doc.ruta_base.startsWith('/recursos/')
            ? doc.ruta_base.slice('/recursos/'.length)
            : doc.ruta_base;
        const carpeta = path.join(DIR_CDU, ...rel.split('/'));
        if (!await existeDir(carpeta)) sinCarpeta.push({ doc, carpeta });
    }
    console.log(`Sin ruta_base en BD:        ${sinRutaBase.length}`);
    console.log(`Con ruta_base pero sin dir: ${sinCarpeta.length}`);
    if (sinCarpeta.length) {
        for (const { doc, carpeta } of sinCarpeta.slice(0, 20)) {
            console.log(`  ❌ [${doc._id}] "${doc.titulo}" → ${carpeta}`);
        }
        if (sinCarpeta.length > 20) console.log(`  … y ${sinCarpeta.length - 20} más`);
    }
    if (sinRutaBase.length) {
        console.log('\n  Docs sin ruta_base (primeros 10):');
        for (const doc of sinRutaBase.slice(0, 10)) {
            console.log(`  ⚠️  [${doc._id}] "${doc.titulo}" isbn=${doc.isbn || '-'}`);
        }
    }

    // ── B. Carpetas sin doc MongoDB ──────────────────────────────────────────
    console.log('\n── B. Carpetas sin documento en MongoDB ────────────────────────────');
    const rutasWeb = new Set(todos.map(d => d.ruta_base).filter(Boolean));

    let carpetasCDU = [];
    if (await existeDir(DIR_CDU)) {
        carpetasCDU = await listarCarpetasCDU(DIR_CDU);
    } else {
        console.log(`  ⚠️  DIR_CDU no existe en esta máquina: ${DIR_CDU}`);
    }

    const carpetasHuerfanas = [];
    const carpetasConDocErroneo = [];
    for (const carpeta of carpetasCDU) {
        const web = rutaWebDeCarpeta(carpeta);
        if (!rutasWeb.has(web)) {
            // Intentar leer el registro.json para ver si hay un _id que sí esté en BD
            let registroId = null;
            try {
                const reg = JSON.parse(await fs.readFile(path.join(carpeta, 'registro.json'), 'utf8'));
                registroId = reg._id || null;
            } catch { /* sin registro legible */ }

            if (registroId) {
                const { ObjectId } = await import('mongodb');
                let oid;
                try { oid = new ObjectId(registroId); } catch { oid = null; }
                const enBD = oid ? await col.findOne({ _id: oid }, { projection: { _id: 1, ruta_base: 1 } }) : null;
                if (enBD) {
                    carpetasConDocErroneo.push({ carpeta, web, docId: registroId, rutaBDActual: enBD.ruta_base });
                    continue;
                }
            }
            carpetasHuerfanas.push({ carpeta, web });
        }
    }
    console.log(`Total carpetas CDU escaneadas: ${carpetasCDU.length}`);
    console.log(`Sin doc en MongoDB:            ${carpetasHuerfanas.length}`);
    console.log(`Doc existe pero ruta_base ≠:   ${carpetasConDocErroneo.length}`);

    if (carpetasHuerfanas.length) {
        console.log('\n  Carpetas huérfanas (primeras 20):');
        for (const { web } of carpetasHuerfanas.slice(0, 20)) console.log(`  📂 ${web}`);
        if (carpetasHuerfanas.length > 20) console.log(`  … y ${carpetasHuerfanas.length - 20} más`);
    }
    if (carpetasConDocErroneo.length) {
        console.log('\n  Docs con ruta_base desactualizada (primeras 10):');
        for (const { web, docId, rutaBDActual } of carpetasConDocErroneo.slice(0, 10)) {
            console.log(`  🔀 [${docId}]`);
            console.log(`     En disco: ${web}`);
            console.log(`     En BD:    ${rutaBDActual || '(vacío)'}`);
        }
        if (FIX_RUTAS) {
            console.log('\n  Aplicando --fix-rutas (reparación: la BD apunta a la carpeta que TIENE el fichero; la otra se RECICLA → match 1:1)…');
            const { ObjectId } = await import('mongodb');
            const { reciclar } = await import('../src/utils/papelera.js');
            const aAbs = (web) => web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null;
            const tieneFichero = async (dir) => { if (!dir) return false; try { return (await fs.readdir(dir)).some(n => EXT_DOC.includes(path.extname(n).toLowerCase())); } catch { return false; } };
            const reciclarCarpeta = async (dir) => {
                let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
                const ficheros = ents.filter(e => e.isFile()).map(e => path.join(dir, e.name));
                if (ficheros.length) await reciclar(ficheros, 'carpeta-stale-' + path.basename(dir));
                await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
            };
            let reparados = 0;
            for (const { carpeta: diskFolder, web, docId, rutaBDActual } of carpetasConDocErroneo) {
                try {
                    const rbFolder = aAbs(rutaBDActual);
                    const rbFile = await tieneFichero(rbFolder);
                    const diskFile = await tieneFichero(diskFolder);
                    if (rbFile) {
                        // La BD YA apunta a la carpeta con el fichero → la escaneada es una DUPLICADA stale → reciclar.
                        await reciclarCarpeta(diskFolder);
                        console.log(`  ♻️  [${docId}] carpeta duplicada reciclada (${web}); BD correcta → ${rutaBDActual}`);
                        reparados++;
                    } else if (diskFile) {
                        // El fichero vive en la carpeta escaneada; la BD apunta a una SIN fichero → corregir ruta_base y reciclar la otra.
                        await col.updateOne({ _id: new ObjectId(docId) }, { $set: { ruta_base: web } });
                        if (rbFolder) await reciclarCarpeta(rbFolder);
                        console.log(`  ✅ [${docId}] ruta_base → ${web} (la otra carpeta, sin fichero, reciclada)`);
                        reparados++;
                    } else {
                        console.log(`  ❓ [${docId}] ninguna de las dos carpetas tiene el fichero — revisar a mano.`);
                    }
                } catch (e) {
                    console.warn(`  ⚠️  [${docId}] no se pudo reparar: ${e.message}`);
                }
            }
            console.log(`  → ${reparados}/${carpetasConDocErroneo.length} reparados (match BD↔disco).`);
        } else {
            console.log('  ℹ️  Re-ejecuta con --fix-rutas para repararlos (la BD apuntará a la carpeta con el fichero; la duplicada se recicla).');
        }
    }

    // ── C. Duplicados exactos por hash ───────────────────────────────────────
    console.log('\n── C. Duplicados exactos por hash_contenido ────────────────────────');
    const hashPipeline = [
        { $match: { hash_contenido: { $exists: true, $ne: null } } },
        { $group: { _id: '$hash_contenido', count: { $sum: 1 }, docs: { $push: { id: '$_id', titulo: '$titulo', nombre: '$nombre_archivo' } } } },
        { $match: { count: { $gt: 1 } } },
        { $sort: { count: -1 } }
    ];
    const hashDups = await col.aggregate(hashPipeline).toArray();
    console.log(`Grupos con hash repetido: ${hashDups.length}`);
    if (hashDups.length) {
        for (const g of hashDups.slice(0, 10)) {
            console.log(`\n  hash: ${g._id.slice(0, 16)}… (${g.count} copias)`);
            for (const d of g.docs) console.log(`    [${d.id}] "${d.titulo}" (${d.nombre || 'sin nombre'})`);
        }
    }

    // ── D. Carpeta presente pero SIN el fichero original ─────────────────────
    console.log('\n── D. Documentos cuya carpeta existe pero falta el fichero original ─');
    // Índice de ficheros en las zonas donde un original "desaparecido" puede sobrevivir.
    const indice = new Map();
    await indexarFicheros(DIR_INBOX, indice, 'Inbox');
    await indexarFicheros(DIR_CUARENTENA, indice, 'Cuarentena');
    await indexarFicheros(DIR_REINTENTOS, indice, 'Reintentos');

    const sinFichero = [];
    for (const doc of todos) {
        // Solo recursos con fichero digital propio: los escaneos ('papel') solo tienen imágenes.
        const formatos = Array.isArray(doc.formatos) ? doc.formatos : [];
        if (formatos.includes('papel')) continue;
        if (!doc.ruta_base) continue; // ya contabilizado en A
        const rel = doc.ruta_base.startsWith('/recursos/') ? doc.ruta_base.slice('/recursos/'.length) : doc.ruta_base;
        const carpeta = path.join(DIR_CDU, ...rel.split('/'));
        let entradas;
        try { entradas = await fs.readdir(carpeta); } catch { continue; } // sin carpeta → ya está en A
        const tieneDoc = entradas.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
        if (tieneDoc) continue;

        // Falta el original: intentar localizarlo por nombre en las zonas de respaldo.
        const nombres = [doc.nombre_archivo, ...(doc.archivos_originales || [])].filter(Boolean);
        const ubicaciones = [];
        for (const n of nombres) if (indice.has(n)) ubicaciones.push(...indice.get(n));
        sinFichero.push({ doc, carpeta, ubicaciones });
    }
    console.log(`Documentos sin fichero original: ${sinFichero.length}`);
    const localizables = sinFichero.filter(x => x.ubicaciones.length);
    console.log(`  · localizables (original hallado en otra zona): ${localizables.length}`);
    console.log(`  · sin rastro del original:                      ${sinFichero.length - localizables.length}`);
    for (const { doc, ubicaciones } of sinFichero.slice(0, 30)) {
        console.log(`  ${ubicaciones.length ? '🔎' : '❓'} [${doc._id}] "${doc.titulo}" (${doc.nombre_archivo || 'sin nombre'})`);
        for (const u of ubicaciones) console.log(`       ↳ ${u}`);
    }
    if (sinFichero.length > 30) console.log(`  … y ${sinFichero.length - 30} más`);

    // ── E. Estructura del árbol: vacías / ramas sin hojas / registro sin documento ──
    console.log('\n── E. Estructura del árbol CDU ─────────────────────────────────────');
    const sinHoja = new Set();          // carpetas cuyo subárbol NO tiene NINGUNA hoja (podables)
    const registroSinDoc = [];          // carpeta con registro/sidecars pero sin el documento ni imágenes
    async function recorrerArbol(dir) {
        let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
        const files = ents.filter(e => e.isFile() && !ignorarEntrada(e.name)).map(e => e.name);
        const subdirs = ents.filter(e => e.isDirectory() && !ignorarEntrada(e.name));
        const tieneDoc = files.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
        const tieneImg = files.some(n => EXT_IMG.includes(path.extname(n).toLowerCase()));
        const tieneRegistro = files.includes('registro.json') || files.includes('registro.marc.xml');
        let hojaAbajo = false;
        for (const s of subdirs) hojaAbajo = (await recorrerArbol(path.join(dir, s.name))) || hojaAbajo;
        const hayContenido = tieneDoc || tieneImg || tieneRegistro;
        if (dir !== DIR_CDU) {
            if (!hayContenido && !hojaAbajo) sinHoja.add(dir);                  // vacía o rama muerta
            else if (tieneRegistro && !tieneDoc && !tieneImg) registroSinDoc.push(dir); // metadatos sin contenido
        }
        return hayContenido || hojaAbajo;
    }
    if (await existeDir(DIR_CDU)) await recorrerArbol(DIR_CDU);
    // Ramas muertas = nodos TOPE de cada subárbol sin hojas (el padre sí tiene hojas o es la raíz).
    const ramasMuertas = [...sinHoja].filter(d => !sinHoja.has(path.dirname(d)));
    console.log(`Carpetas vacías / ramas sin hojas (tope): ${ramasMuertas.length}  (nodos totales sin hoja: ${sinHoja.size})`);
    console.log(`Carpetas con registro pero SIN documento: ${registroSinDoc.length}`);
    for (const d of ramasMuertas.slice(0, 20)) console.log(`  🍂 ${rutaWebDeCarpeta(d)}`);
    if (ramasMuertas.length > 20) console.log(`  … y ${ramasMuertas.length - 20} más`);
    for (const d of registroSinDoc.slice(0, 20)) console.log(`  📄 (registro sin doc) ${rutaWebDeCarpeta(d)}`);
    if (registroSinDoc.length > 20) console.log(`  … y ${registroSinDoc.length - 20} más`);
    if (LIMPIAR && ramasMuertas.length) {
        console.log('\n  --limpiar: eliminando carpetas vacías / ramas sin hojas (sin documentos)…');
        let podadas = 0;
        for (const d of ramasMuertas) { await fs.rm(d, { recursive: true, force: true }).then(() => podadas++).catch(() => {}); }
        console.log(`  ✅ ${podadas} rama(s) podada(s).`);
    } else if (ramasMuertas.length) {
        console.log('  ℹ️  Re-ejecuta con --limpiar para eliminarlas (es seguro: no contienen documentos).');
    }

    // ── Resumen ──────────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('RESUMEN');
    console.log(`  Total docs en BD:             ${todos.length}`);
    console.log(`  Docs sin carpeta:             ${sinCarpeta.length}`);
    console.log(`  Docs sin ruta_base:           ${sinRutaBase.length}`);
    console.log(`  Carpetas sin doc:             ${carpetasHuerfanas.length}`);
    console.log(`  ruta_base desactualizada:     ${carpetasConDocErroneo.length}`);
    console.log(`  Grupos de duplicados exactos: ${hashDups.length}`);
    console.log(`  Docs sin fichero original:    ${sinFichero.length} (localizables: ${localizables.length})`);
    console.log(`  Ramas vacías / sin hojas:     ${ramasMuertas.length}${LIMPIAR ? ' (limpiadas)' : ''}`);
    console.log(`  Carpetas con registro sin doc:${registroSinDoc.length}`);

    await client.close();
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
