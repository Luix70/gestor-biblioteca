/**
 * Auditoría de integridad del archivo digital.
 *
 * Detecta tres clases de problemas:
 *   A. Documentos MongoDB sin carpeta en disco  (doc huérfano)
 *   B. Carpetas en el árbol CDU sin documento MongoDB (carpeta huérfana)
 *   C. Documentos duplicados por hash_contenido (copias exactas ya en BD)
 *
 * Solo informa — no modifica nada. Ejecutar:
 *   node scripts/auditoria-integridad.js [--fix-rutas]
 *
 * --fix-rutas: actualiza ruta_base en Mongo para los docs cuya carpeta se
 *   encontró pero la ruta_base guardada no coincide (útil tras renombrar CDUs).
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
const FIX_RUTAS = process.argv.includes('--fix-rutas');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function existeDir(p) {
    return fs.access(p).then(() => true).catch(() => false);
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
        projection: { _id: 1, titulo: 1, ruta_base: 1, isbn: 1, issn: 1, nombre_archivo: 1, tipo_recurso: 1 }
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
            console.log('\n  Aplicando --fix-rutas…');
            const { ObjectId } = await import('mongodb');
            for (const { web, docId } of carpetasConDocErroneo) {
                try {
                    await col.updateOne({ _id: new ObjectId(docId) }, { $set: { ruta_base: web } });
                    console.log(`  ✅ [${docId}] ruta_base → ${web}`);
                } catch (e) {
                    console.warn(`  ⚠️  [${docId}] no se pudo actualizar: ${e.message}`);
                }
            }
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

    // ── Resumen ──────────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log('RESUMEN');
    console.log(`  Total docs en BD:            ${todos.length}`);
    console.log(`  Docs sin carpeta:             ${sinCarpeta.length}`);
    console.log(`  Docs sin ruta_base:           ${sinRutaBase.length}`);
    console.log(`  Carpetas sin doc:             ${carpetasHuerfanas.length}`);
    console.log(`  ruta_base desactualizada:     ${carpetasConDocErroneo.length}`);
    console.log(`  Grupos de duplicados exactos: ${hashDups.length}`);

    await client.close();
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
