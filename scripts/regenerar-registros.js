/**
 * Regenera los sidecars registro.json y registro.marc.xml de cada documento a partir de
 * MongoDB (la fuente de verdad). Resuelve las referencias ObjectId (autores, editorial) a sus
 * NOMBRES para que el registro sea legible, igual que en la ingesta.
 *
 * Útil tras correcciones masivas (re-enriquecimiento, cambios de colección…) para que los
 * ficheros en disco reflejen el estado real de la base de datos.
 *
 * Solo escribe los dos sidecars dentro de cada carpeta CDU existente; no toca nada más.
 *   node scripts/regenerar-registros.js                 (DRY-RUN: cuenta, no escribe)
 *   node scripts/regenerar-registros.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../src/database.js';
import { aRegistroLegible, escribirSidecars } from '../src/utils/registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolverDir = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
const EJECUTAR = process.argv.includes('--ejecutar');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Carpeta absoluta del documento a partir de su ruta_base (/recursos/...). */
function carpetaDeDoc(doc) {
    if (!doc.ruta_base) return null;
    const rel = doc.ruta_base.startsWith('/recursos/') ? doc.ruta_base.slice('/recursos/'.length) : doc.ruta_base;
    return path.join(DIR_CDU, ...rel.split('/'));
}

async function main() {
    console.log(`\nRegeneración de sidecars registro.json / registro.marc.xml  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se escribe nada.\n'); else console.log('');

    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // Mapas id→nombre para resolver referencias sin una consulta por documento.
    const autorMap = new Map();
    for (const a of await db.collection('autores').find({}, { projection: { nombre: 1 } }).toArray())
        autorMap.set(String(a._id), a.nombre);
    const editorialMap = new Map();
    for (const e of await db.collection('editoriales').find({}, { projection: { nombre: 1 } }).toArray())
        editorialMap.set(String(e._id), e.nombre);

    const docs = await col.find({}).toArray();
    let escritos = 0, sinCarpeta = 0, fallos = 0;

    for (const doc of docs) {
        const carpeta = carpetaDeDoc(doc);
        if (!carpeta || !await existe(carpeta)) { sinCarpeta++; continue; }

        const autores = (doc.autores || []).map(id => autorMap.get(String(id)) || String(id));
        const editorial = doc.editorial ? (editorialMap.get(String(doc.editorial)) || null) : null;
        const legible = aRegistroLegible(doc, { autores, editorial });
        if (!EJECUTAR) { escritos++; continue; }
        try {
            await escribirSidecars(carpeta, legible);
            escritos++;
        } catch (e) {
            console.error(`  ⛔ [${doc._id}] "${doc.titulo}": ${e.message}`);
            fallos++;
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Sidecars regenerados' : 'A regenerar'}: ${escritos}`);
    console.log(`  Docs sin carpeta:     ${sinCarpeta}`);
    if (EJECUTAR) console.log(`  Fallos:               ${fallos}`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
