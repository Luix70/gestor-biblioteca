/**
 * Purga SEGURA de Cuarentena/duplicados. Por cada depósito, RE-VERIFICA por contenido que su
 * gemelo catalogado existe Y conserva su fichero en disco; solo entonces lo borra. Si el original
 * catalogado no está (fichero desaparecido), NO borra: ese "duplicado" podría ser la única copia.
 *
 *   node scripts/purgar-duplicados.js                 (DRY-RUN: informa, no borra)
 *   node scripts/purgar-duplicados.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../src/database.js';
import { calcularHashArchivo } from '../src/utils/hash-archivo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CUARENTENA = resolver('PATH_CUARENTENA', 'Cuarentena');
const DIR_CDU = resolver('PATH_CDU', 'CDU');
const DIR_DUP = path.join(DIR_CUARENTENA, 'duplicados');
const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
const EJECUTAR = process.argv.includes('--ejecutar');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const tieneFichero = async (dir) => {
    let e; try { e = await fs.readdir(dir); } catch { return false; }
    return e.some(n => EXT_DOC.includes(path.extname(n).toLowerCase()));
};
const carpetaDeDoc = (doc) => doc.ruta_base
    ? path.join(DIR_CDU, ...doc.ruta_base.replace(/^\/recursos\//, '').split('/')) : null;

async function listarDepositos(raiz) {
    const out = [];
    async function walk(dir) {
        let entradas; try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        const esDeposito = entradas.some(e => e.isFile() && (e.name === 'estado.json' || EXT_DOC.includes(path.extname(e.name).toLowerCase())));
        if (esDeposito) { out.push(dir); return; }
        for (const e of entradas) if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
    await walk(raiz);
    return out;
}

async function main() {
    console.log(`\nPurga segura de Cuarentena/duplicados  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  ${DIR_DUP}\n`);
    if (!await existe(DIR_DUP)) { console.log('  (no existe duplicados/ — ¿ya organizaste la Cuarentena?)'); process.exit(0); }

    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const depositos = await listarDepositos(DIR_DUP);

    let borrables = 0, conservados = 0, sinFichero = 0, bytes = 0;
    const muestraConserva = [];

    for (const dep of depositos) {
        let ficheros;
        try { ficheros = (await fs.readdir(dep)).filter(n => EXT_DOC.includes(path.extname(n).toLowerCase())); } catch { ficheros = []; }
        if (!ficheros.length) { sinFichero++; continue; }

        // Verificar TODOS los ficheros del depósito: cada uno debe tener gemelo catalogado con su
        // fichero en disco. Si alguno no lo tiene, se conserva el depósito entero.
        let seguro = true, detalle = null;
        for (const f of ficheros) {
            const ruta = path.join(dep, f);
            let h; try { h = await calcularHashArchivo(ruta); } catch { seguro = false; detalle = 'hash falló'; break; }
            const doc = await col.findOne({ hash_contenido: h }, { projection: { _id: 1, titulo: 1, ruta_base: 1 } });
            const carpeta = doc && carpetaDeDoc(doc);
            const gemeloOk = carpeta && await existe(carpeta) && await tieneFichero(carpeta);
            if (!gemeloOk) { seguro = false; detalle = doc ? `gemelo SIN fichero en disco (${doc._id})` : 'sin gemelo catalogado'; break; }
        }

        if (seguro) {
            borrables++;
            if (EJECUTAR) {
                for (const f of ficheros) { try { bytes += (await fs.stat(path.join(dep, f))).size; } catch {} }
                await fs.rm(dep, { recursive: true, force: true }).catch(e => console.warn(`  ⚠️ ${dep}: ${e.message}`));
            }
        } else {
            conservados++;
            if (muestraConserva.length < 20) muestraConserva.push(`${path.relative(DIR_CUARENTENA, dep)} — ${detalle}`);
        }
    }

    console.log(`${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Borrados (gemelo verificado)' : 'Borrables (gemelo verificado)'}: ${borrables}`);
    console.log(`  Conservados (no verificados):  ${conservados}`);
    console.log(`  Depósitos sin fichero:         ${sinFichero}`);
    if (EJECUTAR) console.log(`  Liberado:                      ${(bytes / 1048576).toFixed(1)} MB`);
    if (muestraConserva.length) {
        console.log(`\n  Conservados (revisar — posible única copia):`);
        for (const m of muestraConserva) console.log(`     ${m}`);
    }
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
