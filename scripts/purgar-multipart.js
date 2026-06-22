import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { reciclar } from '../src/utils/papelera.js';

/**
 * Purga una OBRA multivolumen mal catalogada para re-ingerirla limpia: elimina la obra y TODOS sus
 * tomos de `biblioteca`, y MUEVE sus carpetas CDU a la Papelera (política "nunca borrar"). Pensado
 * para deshacer una ingesta defectuosa (p. ej. tomos fusionados) antes de volver a soltar la obra.
 *
 *   node scripts/purgar-multipart.js <isbn_obra|título> [...más] [--ejecutar]
 *
 * Sin --ejecutar es una SIMULACIÓN (no toca nada): lista lo que haría.
 * Ejemplos:
 *   node scripts/purgar-multipart.js 0787674249 0787653829           (simulación)
 *   node scripts/purgar-multipart.js 0787674249 0787653829 --ejecutar (aplica)
 */

const args = process.argv.slice(2);
const ejecutar = args.includes('--ejecutar');
const claves = args.filter(a => a !== '--ejecutar');
if (!claves.length) {
    console.error('Uso: node scripts/purgar-multipart.js <isbn_obra|título> [...] [--ejecutar]');
    process.exit(1);
}

const db = await conectarDB();
const obras = db.collection('obras');
const bib = db.collection('biblioteca');

for (const clave of claves) {
    const obra = await obras.findOne({ $or: [{ isbn_obra: clave }, { titulo: clave }] });
    if (!obra) { console.log(`\n⚠️  No hay obra con isbn_obra/título = "${clave}".`); continue; }

    const tomos = await bib.find({ obra: obra._id }).toArray();
    console.log(`\n📚 Obra "${obra.titulo}" (isbn_obra ${obra.isbn_obra || '—'}) · ${tomos.length} tomo(s) en biblioteca:`);
    for (const t of tomos) console.log(`   - vol ${t.volumen_numero ?? '?'}  ${String(t._id)}  isbn=${t.isbn || '—'}  «${t.titulo}»`);

    if (!ejecutar) { console.log('   (simulación: se eliminarían estos tomos + la obra, y sus carpetas CDU irían a la Papelera)'); continue; }

    // 1) Carpetas CDU de cada tomo → Papelera (mover ficheros, luego retirar la carpeta vacía).
    for (const t of tomos) {
        const carpeta = carpetaDeDoc(t);
        let entradas = [];
        try { entradas = await fs.readdir(carpeta); } catch { /* ya no está */ }
        if (entradas.length) {
            await reciclar(entradas.map(n => path.join(carpeta, n)), `purga-${obra.isbn_obra || obra._id}-vol${t.volumen_numero ?? ''}`);
            await fs.rm(carpeta, { recursive: true, force: true }).catch(() => {});
        }
    }
    // 2) Documentos de biblioteca y la propia obra.
    const r = await bib.deleteMany({ obra: obra._id });
    await obras.deleteOne({ _id: obra._id });
    console.log(`   ✅ Eliminados ${r.deletedCount} tomo(s) + la obra. Carpetas CDU movidas a la Papelera. Ya puedes re-soltar la obra.`);
}

process.exit(0);
