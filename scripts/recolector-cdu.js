/**
 * Recolector de basura del árbol CDU. Reconcilia las carpetas-hoja en disco contra MongoDB y
 * deja el archivo en el invariante 1 documento ↔ 1 carpeta.
 *
 * Para cada carpeta con registro.json:
 *   OWNED      — algún documento la reclama (su ruta_base apunta aquí). Se conserva.
 *   DUPLICADO  — el MISMO documento (mismo _id del registro.json) vive en OTRA carpeta que
 *                conserva su fichero. Esta es una copia obsoleta → se ELIMINA (con --ejecutar).
 *   HUÉRFANA   — ningún documento la respalda (su _id no está en Mongo, o no hay registro.json).
 *                NO se borra: se mueve a _huerfanos/ para recatalogar (regla anti-pérdida).
 *   REVISAR    — el documento existe pero su carpeta canónica falta: esta copia podría ser la
 *                única. No se toca; se informa.
 *
 * Solo elimina cuando el MISMO documento tiene otra carpeta con su fichero presente.
 *
 *   node scripts/recolector-cdu.js                 (DRY-RUN: informa, no toca nada)
 *   node scripts/recolector-cdu.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU, EXT_DOC } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ignorar = (n) => n.startsWith('@') || n.startsWith('#') || n.startsWith('.') || n === '_huerfanos';
const DIR_HUERFANOS = path.join(DIR_CDU, '_huerfanos');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const webDe = (carpeta) => '/recursos/' + path.relative(DIR_CDU, carpeta).split(path.sep).join('/');

/** ¿La carpeta tiene un fichero de documento (epub/pdf/…)? */
async function tieneFichero(carpeta) {
    let e; try { e = await fs.readdir(carpeta); } catch { return false; }
    return e.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
}

/** Recorre el árbol y devuelve todas las carpetas-hoja (con registro.json o con fichero). */
async function listarHojas(raiz) {
    const hojas = [];
    async function walk(dir) {
        let entradas; try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        const esHoja = entradas.some(e => e.isFile() && (e.name === 'registro.json' || EXT_DOC.includes(path.extname(e.name).toLowerCase())));
        if (esHoja) { hojas.push(dir); return; }
        for (const e of entradas) if (e.isDirectory() && !ignorar(e.name)) await walk(path.join(dir, e.name));
    }
    await walk(raiz);
    return hojas;
}

async function main() {
    const { ObjectId } = await import('mongodb');
    console.log(`\nRecolector de basura CDU  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}\n`);

    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const docs = await col.find({}, { projection: { _id: 1, ruta_base: 1, titulo: 1 } }).toArray();
    const porId = new Map(docs.map(d => [String(d._id), d]));
    const rutas = new Set(docs.map(d => d.ruta_base).filter(Boolean));

    const hojas = await listarHojas(DIR_CDU);
    console.log(`Carpetas-hoja en disco: ${hojas.length}\n`);

    let owned = 0, duplicados = 0, huerfanas = 0, revisar = 0;
    const muestra = { dup: [], huerf: [], rev: [] };

    for (const carpeta of hojas) {
        const web = webDe(carpeta);
        if (rutas.has(web)) { owned++; continue; } // un documento la reclama → correcta

        // No la reclama nadie. ¿De qué documento es copia? (por el _id de su registro.json)
        let id = null;
        try { id = JSON.parse(await fs.readFile(path.join(carpeta, 'registro.json'), 'utf8'))._id || null; } catch {}
        const doc = id && porId.has(String(id)) ? porId.get(String(id)) : null;

        if (!doc) {
            // Huérfana: nadie la respalda → cuarentena (no se borra).
            huerfanas++;
            if (muestra.huerf.length < 15) muestra.huerf.push(web);
            if (EJECUTAR) {
                await fs.mkdir(DIR_HUERFANOS, { recursive: true });
                const destino = path.join(DIR_HUERFANOS, path.basename(carpeta) + '-' + Date.now());
                await fs.rename(carpeta, destino).catch(e => console.warn(`     ⚠️ cuarentena ${web}: ${e.message}`));
            }
            continue;
        }

        // El documento vive en doc.ruta_base. ¿Existe esa carpeta canónica con su fichero?
        const canonica = path.join(DIR_CDU, ...doc.ruta_base.replace(/^\/recursos\//, '').split('/'));
        const canonicaOk = await existe(canonica) && await tieneFichero(canonica);

        if (canonicaOk) {
            // Copia obsoleta del mismo documento → eliminar (el original está a salvo).
            duplicados++;
            if (muestra.dup.length < 20) muestra.dup.push(`${web}  (canónica: ${doc.ruta_base})`);
            if (EJECUTAR) await fs.rm(carpeta, { recursive: true, force: true }).catch(e => console.warn(`     ⚠️ borrar ${web}: ${e.message}`));
        } else {
            // La canónica falta: esta copia podría ser la única → no tocar, informar.
            revisar++;
            if (muestra.rev.length < 15) muestra.rev.push(`${web}  (canónica AUSENTE: ${doc.ruta_base})`);
        }
    }

    console.log(`${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  Correctas (con documento):         ${owned}`);
    console.log(`  ${EJECUTAR ? 'Duplicados eliminados' : 'Duplicados a eliminar'}:             ${duplicados}`);
    console.log(`  ${EJECUTAR ? 'Huérfanas a _huerfanos' : 'Huérfanas a cuarentena'}:            ${huerfanas}`);
    console.log(`  A revisar (canónica ausente):      ${revisar}`);
    const dump = (t, arr) => { if (arr.length) { console.log(`\n  ${t}:`); for (const x of arr) console.log(`     ${x}`); } };
    dump('Duplicados', muestra.dup);
    dump('Huérfanas', muestra.huerf);
    dump('Revisar', muestra.rev);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
