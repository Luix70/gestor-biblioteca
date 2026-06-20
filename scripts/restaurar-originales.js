/**
 * Restaura los ficheros originales "desaparecidos" de su carpeta CDU.
 *
 * Para cada documento cuyo carpeta existe pero le falta el .epub/.pdf, busca el original por
 * nombre en las zonas de respaldo (Reintentos, Inbox, Cuarentena, _ER Room) y lo copia de
 * vuelta a su carpeta. La copia es NO DESTRUCTIVA (temporal oculto → verifica tamaño → rename)
 * y NUNCA borra el origen de respaldo (queda como red de seguridad hasta que verifiques).
 *
 * No toca MongoDB ni re-cataloga: solo devuelve el fichero a su sitio. La metadata del registro
 * (que en lotes degradados pueda ser pobre) se corrige aparte, re-enriqueciendo después.
 *
 *   node scripts/restaurar-originales.js                 (DRY-RUN: informa, no copia)
 *   node scripts/restaurar-originales.js --ejecutar      (aplica)
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolverDir = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
// Orden de preferencia de búsqueda del original.
const ZONAS = [
    ['Reintentos', resolverDir('PATH_REINTENTOS', 'Reintentos')],
    ['Inbox',      resolverDir('PATH_INBOX', 'Inbox')],
    ['Cuarentena', resolverDir('PATH_CUARENTENA', 'Cuarentena')],
    ['_ER Room',   resolverDir('PATH_ER_ROOM', '_ER Room')],
];
const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
const EJECUTAR = process.argv.includes('--ejecutar');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Indexa Map<nombreBase, rutaAbsoluta> (primera zona que lo tenga gana). */
async function indexarZona(raiz, indice) {
    async function walk(dir) {
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entradas) {
            const ruta = path.join(dir, e.name);
            if (e.isDirectory()) { await walk(ruta); continue; }
            if (!EXT_DOC.includes(path.extname(e.name).toLowerCase())) continue;
            if (!indice.has(e.name)) indice.set(e.name, ruta); // no pisar: gana la zona más prioritaria
        }
    }
    if (await existe(raiz)) await walk(raiz);
}

/** Copia origen → carpeta/<basename> de forma transaccional y no destructiva. */
async function copiarSeguro(origen, carpeta) {
    const destino = path.join(carpeta, path.basename(origen));
    const tmp = path.join(carpeta, `.tmp-restore-${Date.now()}-${path.basename(origen)}`);
    const stOrig = await fs.stat(origen);
    if (stOrig.size <= 0) throw new Error('origen de 0 bytes');
    await fs.copyFile(origen, tmp);
    const stTmp = await fs.stat(tmp);
    if (stTmp.size !== stOrig.size) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        throw new Error(`copia no íntegra (${stOrig.size}B → ${stTmp.size}B)`);
    }
    await fs.rename(tmp, destino);
    return { destino, bytes: stOrig.size };
}

async function main() {
    const uri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME || 'biblioteca';
    if (!uri) { console.error('MONGO_URI no definida en .env'); process.exit(1); }

    console.log(`\nRestauración de originales  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se copia nada. Añade --ejecutar para aplicar.\n');
    else console.log('  ⚠️  Copiando ficheros de vuelta a sus carpetas (no se borra ningún respaldo).\n');

    // Índice de las zonas de respaldo.
    const indice = new Map();
    for (const [, dir] of ZONAS) await indexarZona(dir, indice);

    const client = new MongoClient(uri);
    await client.connect();
    const col = client.db(dbName).collection('biblioteca');
    const docs = await col.find({}, {
        projection: { _id: 1, titulo: 1, ruta_base: 1, nombre_archivo: 1, archivos_originales: 1, formatos: 1 }
    }).toArray();

    let restaurados = 0, yaEstaban = 0, noLocalizados = 0, fallos = 0, bytes = 0;
    const sinRastro = [];

    for (const doc of docs) {
        const formatos = Array.isArray(doc.formatos) ? doc.formatos : [];
        if (formatos.includes('papel')) continue;      // escaneos: solo imágenes, sin original
        if (!doc.ruta_base) continue;

        const rel = doc.ruta_base.startsWith('/recursos/') ? doc.ruta_base.slice('/recursos/'.length) : doc.ruta_base;
        const carpeta = path.join(DIR_CDU, ...rel.split('/'));
        let entradas;
        try { entradas = await fs.readdir(carpeta); } catch { continue; } // sin carpeta: otro problema
        if (entradas.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()))) { yaEstaban++; continue; }

        // Falta el original: localizarlo por nombre.
        const nombres = [doc.nombre_archivo, ...(doc.archivos_originales || [])].filter(Boolean);
        const origen = nombres.map(n => indice.get(n)).find(Boolean);
        if (!origen) { noLocalizados++; sinRastro.push(doc); continue; }

        if (!EJECUTAR) {
            console.log(`  ↩️  [${doc._id}] "${doc.titulo}"  ←  ${origen}`);
            restaurados++;
            continue;
        }
        try {
            const { destino, bytes: b } = await copiarSeguro(origen, carpeta);
            console.log(`  ✅ [${doc._id}] "${doc.titulo}"  ←  ${origen}  (${b} B)`);
            restaurados++; bytes += b;
        } catch (e) {
            console.error(`  ⛔ [${doc._id}] "${doc.titulo}": ${e.message}`);
            fallos++;
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Restaurados' : 'A restaurar'}:        ${restaurados}`);
    console.log(`  Ya tenían su fichero: ${yaEstaban}`);
    console.log(`  Sin localizar:        ${noLocalizados}`);
    if (EJECUTAR) console.log(`  Fallos de copia:      ${fallos}`);
    if (EJECUTAR) console.log(`  Bytes copiados:       ${(bytes / 1048576).toFixed(1)} MB`);
    if (sinRastro.length) {
        console.log(`\n  Sin rastro del original (revisar a mano):`);
        for (const d of sinRastro.slice(0, 30)) console.log(`   ❓ [${d._id}] "${d.titulo}" (${d.nombre_archivo || 'sin nombre'})`);
        if (sinRastro.length > 30) console.log(`   … y ${sinRastro.length - 30} más`);
    }

    await client.close();
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
