/**
 * Detecta y purga los PDF ya catalogados que son ILEGIBLES (estructura dañada: pdfinfo no halla
 * páginas). Mueve el fichero a Cuarentena/ilegibles y elimina su documento + carpeta CDU, para
 * que no queden registros apuntando a ficheros rotos.
 *
 *   node scripts/purgar-ilegibles.js                 (DRY-RUN: lista los ilegibles, no toca nada)
 *   node scripts/purgar-ilegibles.js --ejecutar
 *
 * Ejecutar dentro del contenedor (necesita pdfinfo/poppler y acceso a los ficheros del CDU).
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../src/mantenimiento/util-mantenimiento.js';
import { enviarACuarentena } from '../src/gestor-fallos.js';

const EJECUTAR = process.argv.includes('--ejecutar');

async function main() {
    console.log(`\nPurga de PDF ilegibles  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]\n`);
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    const pdfs = await col.find(
        { formatos: 'pdf' },
        { projection: { _id: 1, titulo: 1, ruta_base: 1, cdu: 1, nombre_archivo: 1 } }
    ).toArray();
    console.log(`PDFs catalogados: ${pdfs.length}\n`);

    let ilegibles = 0, purgados = 0, sinFichero = 0;
    for (const doc of pdfs) {
        const carpeta = carpetaDeDoc(doc);
        const fichero = await archivoOriginal(carpeta);
        if (!fichero) { sinFichero++; continue; } // sin fichero en disco: lo cubre la auditoría de integridad

        const pgs = await numeroPaginasPdf(fichero); // pdfinfo → nº de páginas, o null si falla
        if (pgs && pgs > 0) continue;                // legible

        ilegibles++;
        console.log(`  ${EJECUTAR ? '🗑️' : '⚠️'} ilegible: [${doc._id}] "${doc.titulo}"  (${doc.ruta_base})`);
        if (!EJECUTAR) continue;

        try {
            // Mueve el fichero a Cuarentena/ilegibles (depositar con categoría 'ilegibles').
            await enviarACuarentena([fichero], {
                titulo: doc.titulo,
                error: { tipo: 'ilegible', mensaje: 'PDF ilegible (pdfinfo no halló páginas): estructura dañada.' },
                documento_id: String(doc._id),
                fase: 'auditoria',
            });
            // Elimina el documento y su carpeta CDU (ya sin original).
            await col.deleteOne({ _id: doc._id });
            await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
            purgados++;
        } catch (e) {
            console.error(`     ⛔ no se pudo purgar: ${e.message}`);
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  PDFs revisados:     ${pdfs.length}`);
    console.log(`  Ilegibles:          ${ilegibles}`);
    console.log(`  Sin fichero (omit): ${sinFichero}`);
    if (EJECUTAR) console.log(`  Purgados → Cuarentena/ilegibles: ${purgados}`);
    else console.log(`\n  DRY-RUN: añade --ejecutar para mover a Cuarentena/ilegibles y borrar sus registros.`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
