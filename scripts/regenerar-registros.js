/**
 * Regenera los sidecars registro.json y registro.marc.xml de cada documento a partir de
 * MongoDB (la fuente de verdad). Resuelve las referencias ObjectId (autores, editorial,
 * contribuciones) a sus NOMBRES para que el registro sea legible, igual que en la ingesta, y
 * marca `sidecars_fecha` en el doc (para que la campaña de fondo «sidecars» sepa que están al día).
 *
 * Los sidecars son la COPIA EN DISCO desde la que se puede reconstruir la base de datos ante una
 * catástrofe: tras correcciones masivas (re-enriquecimiento, cambios de CDU/autores/colección…)
 * hay que regenerarlos para que reflejen el estado real.
 *
 *   node scripts/regenerar-registros.js                         (DRY-RUN: cuenta, no escribe)
 *   node scripts/regenerar-registros.js --ejecutar              (regenera TODOS)
 *   node scripts/regenerar-registros.js --solo-desactualizados  (solo los modificados tras su sidecar)
 *   node scripts/regenerar-registros.js --solo-desactualizados --ejecutar
 *
 * Reutiliza el MISMO regenerador que la campaña de fondo (utils/registro.js·regenerarSidecarsDoc),
 * así que el backfill y la campaña producen sidecars idénticos. Recomendado tras el primer despliegue
 * (con --ejecutar) para sembrar `sidecars_fecha` y dejar la campaña casi vacía en régimen normal.
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../src/database.js';
import { regenerarSidecarsDoc, FILTRO_SIDECARS_DESACTUALIZADOS } from '../src/utils/registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolverDir = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
const EJECUTAR = process.argv.includes('--ejecutar');
const SOLO_STALE = process.argv.includes('--solo-desactualizados');

/** Carpeta absoluta del documento a partir de su ruta_base (/recursos/...). */
function carpetaDeDoc(doc) {
    if (!doc.ruta_base) return null;
    const rel = doc.ruta_base.startsWith('/recursos/') ? doc.ruta_base.slice('/recursos/'.length) : doc.ruta_base;
    return path.join(DIR_CDU, ...rel.split('/'));
}
const existe = (p) => fs.access(p).then(() => true).catch(() => false);

async function main() {
    console.log(`\nRegeneración de sidecars registro.json / registro.marc.xml  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}${SOLO_STALE ? ' · solo desactualizados' : ''}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se escribe nada.\n'); else console.log('');

    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const filtro = SOLO_STALE ? FILTRO_SIDECARS_DESACTUALIZADOS : {};
    const docs = await col.find(filtro).toArray();
    console.log(`Documentos a revisar: ${docs.length}\n`);

    let escritos = 0, sinCarpeta = 0, fallos = 0;
    for (const doc of docs) {
        const carpeta = carpetaDeDoc(doc);
        // DRY-RUN: solo comprueba si hay carpeta y contaría; no escribe ni sella.
        if (!EJECUTAR) {
            if (carpeta && await existe(carpeta)) escritos++; else sinCarpeta++;
            continue;
        }
        try {
            const r = await regenerarSidecarsDoc(db, doc, carpeta);   // escribe los 2 sidecars + sella sidecars_fecha
            if (r.ok) escritos++; else sinCarpeta++;                  // sinCarpeta también queda sellado (drena la cola)
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
