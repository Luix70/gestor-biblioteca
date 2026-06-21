/**
 * Reprocesa depósitos de Cuarentena devolviendo sus ficheros al Inbox para que el vigilante los
 * vuelva a catalogar con el pipeline actual (que ya NO descarta lo que tiene ISBN/ISSN válido).
 *
 * Los que ahora se identifiquen quedarán catalogados (pendiente → re-enriquecidos por ISBN); los
 * duplicados exactos los reenviará el propio pipeline a Cuarentena/duplicados; los irreconocibles
 * de verdad volverán a Cuarentena. Nada se pierde: los ficheros se MUEVEN (rename atómico) y la
 * carpeta del depósito solo se borra tras confirmar que todos sus ficheros salieron.
 *
 *   node scripts/reprocesar-cuarentena.js                          (DRY-RUN, toda la Cuarentena)
 *   node scripts/reprocesar-cuarentena.js --categoria no-identificados
 *   node scripts/reprocesar-cuarentena.js --solo-isbn --ejecutar
 *
 * ⚠️  Conviene tener la app ARRANCADA (el vigilante procesará el Inbox). NO reproceses la
 *     categoría 'duplicados' salvo que quieras reconfirmarlos.
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { validarISBN } from '../src/utils/identificadores.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CUARENTENA = resolver('PATH_CUARENTENA', 'Cuarentena');
const DIR_INBOX = resolver('PATH_INBOX', 'Inbox');

const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];
const EXT_IMG = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];
const esReprocesable = (n) => [...EXT_DOC, ...EXT_IMG].includes(path.extname(n).toLowerCase());

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SOLO_ISBN = args.includes('--solo-isbn');
const idxCat = args.indexOf('--categoria');
const CATEGORIA = idxCat >= 0 ? args[idxCat + 1] : null;

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Carpetas-depósito (con estado.json o algún fichero reprocesable) bajo 'raiz'. */
async function listarDepositos(raiz) {
    const out = [];
    async function walk(dir) {
        let entradas; try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        const esDeposito = entradas.some(e => e.isFile() && (e.name === 'estado.json' || esReprocesable(e.name)));
        if (esDeposito) { out.push(dir); return; }
        for (const e of entradas) if (e.isDirectory()) await walk(path.join(dir, e.name));
    }
    await walk(raiz);
    return out;
}

/** Nombre libre en el Inbox (añade " (reN)" si colisiona). */
async function destinoLibre(nombre) {
    let destino = path.join(DIR_INBOX, nombre);
    if (!await existe(destino)) return destino;
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let n = 1;
    while (await existe(destino)) destino = path.join(DIR_INBOX, `${base} (re${n++})${ext}`);
    return destino;
}

async function main() {
    const raiz = CATEGORIA ? path.join(DIR_CUARENTENA, CATEGORIA) : DIR_CUARENTENA;
    console.log(`\nReprocesar Cuarentena → Inbox  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  Origen: ${raiz}`);
    console.log(`  Inbox:  ${DIR_INBOX}`);
    if (SOLO_ISBN) console.log('  Filtro: solo depósitos con ISBN válido (nombre o estado.json).');
    console.log('');

    const depositos = await listarDepositos(raiz);
    let reprocesados = 0, movidos = 0, saltados = 0;

    for (const dep of depositos) {
        let estado = {};
        try { estado = JSON.parse(await fs.readFile(path.join(dep, 'estado.json'), 'utf8')); } catch {}

        let ficheros;
        try { ficheros = (await fs.readdir(dep)).filter(esReprocesable); } catch { ficheros = []; }
        if (!ficheros.length) { saltados++; continue; }

        if (SOLO_ISBN) {
            const idEstado = validarISBN(estado.identificador || '');
            const idNombre = ficheros.some(f => validarISBN(path.basename(f, path.extname(f))));
            if (!idEstado && !idNombre) { saltados++; continue; }
        }

        console.log(`  ▶ ${path.relative(DIR_CUARENTENA, dep)}  (${ficheros.length} fichero/s)`);
        reprocesados++;
        if (!EJECUTAR) continue;

        await fs.mkdir(DIR_INBOX, { recursive: true });
        let todos = true;
        for (const f of ficheros) {
            const destino = await destinoLibre(path.basename(f));
            try { await fs.rename(path.join(dep, f), destino); movidos++; }
            catch (e) { console.warn(`     ⚠️ ${f}: ${e.message}`); todos = false; }
        }
        // Solo se elimina el depósito si TODOS sus ficheros salieron (anti-pérdida).
        if (todos) await fs.rm(dep, { recursive: true, force: true }).catch(() => {});
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Reprocesados' : 'A reprocesar'}: ${reprocesados}`);
    console.log(`  Saltados:     ${saltados}`);
    if (EJECUTAR) console.log(`  Ficheros al Inbox: ${movidos}`);
    if (!EJECUTAR) console.log(`\n  DRY-RUN: añade --ejecutar para mover al Inbox.`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
