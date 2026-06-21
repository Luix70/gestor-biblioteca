/**
 * Organiza la Cuarentena en subcarpetas por CATEGORÍA:
 *   duplicados        — el fichero ya está catalogado (confirmado por hash contra la biblioteca),
 *                       o el depósito se marcó como duplicado_exacto.
 *   no-identificados  — no se pudo identificar (sin título/ISBN).
 *   otros             — el resto.
 *
 * Va más allá del motivo registrado: HASHEA cada fichero en cuarentena y lo compara con
 * hash_contenido de la biblioteca; si coincide, es un duplicado real de algo ya en estantería
 * (aunque originalmente fallara por otra causa) y anota a qué documento corresponde.
 *
 *   node scripts/organizar-cuarentena.js                 (DRY-RUN)
 *   node scripts/organizar-cuarentena.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../src/database.js';
import { calcularHashArchivo } from '../src/utils/hash-archivo.js';
import { categoriaCuarentena } from '../src/gestor-fallos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CUARENTENA = (() => {
    const v = process.env.PATH_CUARENTENA || 'Cuarentena';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
})();
const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
const CATEGORIAS = ['duplicados', 'no-identificados', 'otros'];
const EJECUTAR = process.argv.includes('--ejecutar');

async function main() {
    console.log(`\nOrganizar Cuarentena por categoría  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CUARENTENA: ${DIR_CUARENTENA}\n`);

    const db = await conectarDB();
    const col = db.collection('biblioteca');

    let entradas;
    try { entradas = await fs.readdir(DIR_CUARENTENA, { withFileTypes: true }); }
    catch (e) { console.error('No se pudo leer Cuarentena:', e.message); process.exit(1); }

    // Depósitos = subcarpetas que NO son ya una categoría.
    const depositos = entradas.filter(e => e.isDirectory() && !CATEGORIAS.includes(e.name));
    console.log(`Depósitos a clasificar: ${depositos.length}\n`);

    const conteo = { duplicados: 0, 'no-identificados': 0, otros: 0 };
    let dupPorHash = 0;

    for (const e of depositos) {
        const carpeta = path.join(DIR_CUARENTENA, e.name);
        let estado = {};
        try { estado = JSON.parse(await fs.readFile(path.join(carpeta, 'estado.json'), 'utf8')); } catch {}

        // 1) ¿Es un duplicado REAL de algo ya catalogado? (hash de sus ficheros vs biblioteca).
        let duplicadoDe = null;
        let ficheros;
        try { ficheros = (await fs.readdir(carpeta)).filter(n => EXT_DOC.includes(path.extname(n).toLowerCase())); } catch { ficheros = []; }
        for (const f of ficheros) {
            try {
                const h = await calcularHashArchivo(path.join(carpeta, f));
                const doc = await col.findOne({ hash_contenido: h }, { projection: { _id: 1, titulo: 1 } });
                if (doc) { duplicadoDe = { id: String(doc._id), titulo: doc.titulo, archivo: f }; break; }
            } catch {}
        }

        const categoria = duplicadoDe ? 'duplicados' : categoriaCuarentena(estado);
        if (duplicadoDe) dupPorHash++;
        conteo[categoria] = (conteo[categoria] || 0) + 1;

        const nota = duplicadoDe ? `  ↔ ya catalogado: "${duplicadoDe.titulo}" [${duplicadoDe.id}]` : '';
        console.log(`  ${categoria.padEnd(16)} ${e.name}${nota}`);

        if (EJECUTAR) {
            const destinoCat = path.join(DIR_CUARENTENA, categoria);
            await fs.mkdir(destinoCat, { recursive: true });
            const destino = path.join(destinoCat, e.name);
            // Anotar la categoría / duplicado en el estado.json antes de mover.
            try {
                const nuevoEstado = { ...estado, categoria, ...(duplicadoDe ? { duplicado_de: duplicadoDe } : {}) };
                await fs.writeFile(path.join(carpeta, 'estado.json'), JSON.stringify(nuevoEstado, null, 2), 'utf8');
            } catch {}
            await fs.rename(carpeta, destino).catch(err => console.warn(`     ⚠️ ${e.name}: ${err.message}`));
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    for (const c of CATEGORIAS) console.log(`  ${c.padEnd(18)} ${conteo[c] || 0}`);
    console.log(`  (de ellos, duplicados confirmados por hash: ${dupPorHash})`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
