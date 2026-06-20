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
import { aMARCXML } from '../src/marc21.js';

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

/** Construye la versión legible (autores/editorial por NOMBRE) para el sidecar. */
function aLegible(doc, autorMap, editorialMap) {
    const legible = { ...doc };
    legible._id = String(doc._id);
    legible.autores = (doc.autores || []).map(id => autorMap.get(String(id)) || String(id));
    if (doc.editorial) legible.editorial = editorialMap.get(String(doc.editorial)) || undefined;
    // La colección se muestra por su nombre denormalizado; se descarta el ObjectId crudo.
    delete legible.coleccion;
    // Campos internos que no van al sidecar.
    delete legible.mantenimiento;
    delete legible.mantenimiento_firma;
    delete legible._portadas_remotas;
    // Limpia claves con valor nulo/indefinido.
    for (const k of Object.keys(legible)) {
        const v = legible[k];
        if (v === undefined || v === null || v === '') delete legible[k];
    }
    return legible;
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

        const legible = aLegible(doc, autorMap, editorialMap);
        if (!EJECUTAR) { escritos++; continue; }
        try {
            await fs.writeFile(path.join(carpeta, 'registro.json'), JSON.stringify(legible, null, 2), 'utf8');
            await fs.writeFile(path.join(carpeta, 'registro.marc.xml'), aMARCXML(legible), 'utf8');
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
