#!/usr/bin/env node
/**
 * RESTAURAR DESDE UNA COPIA DE LA BASE (hecha con scripts/copia-base.js). En seco por defecto.
 *
 * Devuelve cada documento de la copia a como estaba (replaceOne por _id; si se había borrado, se vuelve a crear).
 * NO borra los documentos creados DESPUÉS de la copia (se listan como aviso): restaurar nunca pierde lo nuevo.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/restaurar-base.js                                 (lista las copias)
 *   sudo docker exec -t gestor-biblioteca node scripts/restaurar-base.js --desde 20260929-193000 --coleccion biblioteca
 *   … --ids id1,id2,…     solo esos documentos (lo normal: deshacer un lote concreto)
 *   … --fichero <ruta>    en vez de --desde: un fichero de `mongoexport` (una línea JSON por documento, .json o
 *                         .json.gz), p. ej. el de la copia del PC (D:\Bibliobak\…\Colecciones\biblioteca.json).
 *                         Se lanza en el PC:  node scripts/restaurar-base.js --fichero "D:\…\biblioteca.json"
 *                         --coleccion biblioteca --ids … [--ejecutar]
 *   … --ejecutar          aplica (sin esto, solo dice qué cambiaría)
 *
 * Los ficheros del disco (carpetas movidas) no están en la base: si una restauración devuelve una ruta_base que ya no
 * existe, Integridad lo detecta; la copia del disco la hace scripts/sincronizar-copia.sh.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const DESDE = arg('--desde');
const FICHERO = arg('--fichero');   // exportación de mongoexport (en vez de una copia de copia-base.js)
const COLECCION = arg('--coleccion');
const IDS = arg('--ids') ? new Set(arg('--ids').split(',').map((x) => x.trim()).filter(Boolean)) : null;
const EJECUTAR = args.includes('--ejecutar');

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR_LOGS = (() => { const v = process.env.PATH_LOGS || 'logs'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const DIR_COPIAS = path.join(DIR_LOGS, 'copias-bd');

if (!DESDE && !FICHERO) {
    const copias = (await fsp.readdir(DIR_COPIAS).catch(() => [])).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort().reverse();
    console.log(copias.length ? `Copias disponibles en ${DIR_COPIAS}:` : `No hay copias en ${DIR_COPIAS}.`);
    for (const c of copias) {
        const m = JSON.parse(await fsp.readFile(path.join(DIR_COPIAS, c, 'manifiesto.json'), 'utf8').catch(() => '{}'));
        const n = Object.entries(m.colecciones || {}).map(([k, v]) => `${k}:${v.documentos}`).join(' · ');
        console.log(`  ${c}   ${n}`);
    }
    console.log('\nUso: --desde <copia> --coleccion <nombre> [--ids a,b,c] [--ejecutar]');
    process.exit(0);
}
if (!COLECCION) { console.error('Falta --coleccion <nombre> (p. ej. biblioteca).'); process.exit(1); }

const fichero = FICHERO ? path.resolve(FICHERO) : path.join(DIR_COPIAS, DESDE, `${COLECCION}.jsonl.gz`);
try { await fsp.access(fichero); } catch { console.error(`No existe ${fichero}`); process.exit(1); }
const manifiesto = FICHERO ? {} : JSON.parse(await fsp.readFile(path.join(DIR_COPIAS, DESDE, 'manifiesto.json'), 'utf8'));
const total = IDS ? IDS.size : manifiesto.colecciones?.[COLECCION]?.documentos || 0;

const db = await conectarDB();
const col = db.collection(COLECCION);
console.log(`\n${EJECUTAR ? '⚙️  RESTAURANDO' : '🔍 DRY-RUN'} «${COLECCION}» desde ${FICHERO ? fichero : `la copia ${DESDE}`}${IDS ? ` · ${IDS.size} documento(s) elegidos` : ' · TODOS sus documentos'}\n`);

const st = { iguales: 0, distintos: 0, borrados: 0 };
const vistos = new Set();
const p = progreso(total, EJECUTAR ? 'Restaurando' : 'Comparando');
// .gz (copia-base.js o un export comprimido) o texto plano (mongoexport). mongoexport escribe EJSON «relajado»
// ({"$oid"}, {"$date"}): EJSON.parse lo devuelve igualmente a ObjectId y Date.
const flujo = fs.createReadStream(fichero);
const lineas = readline.createInterface({ input: /\.gz$/i.test(fichero) ? flujo.pipe(zlib.createGunzip()) : flujo, crlfDelay: Infinity });
for await (const linea of lineas) {
    if (!linea.trim()) continue;
    const doc = BSON.EJSON.parse(linea.trim().replace(/,$/, ''), { relaxed: false });
    const id = String(doc._id);
    if (IDS && !IDS.has(id)) continue;
    vistos.add(id);
    p.paso(doc.titulo || doc.nombre || id);
    const actual = await col.findOne({ _id: doc._id });
    if (!actual) st.borrados++;
    else if (BSON.EJSON.stringify(actual, { relaxed: false }) === BSON.EJSON.stringify(doc, { relaxed: false })) { st.iguales++; continue; }
    else st.distintos++;
    if (EJECUTAR) await col.replaceOne({ _id: doc._id }, doc, { upsert: true });
}
const tiempo = p.fin();

// Documentos nuevos (posteriores a la copia): no se tocan, solo se avisa.
let nuevos = 0;
if (!IDS) nuevos = (await col.countDocuments({})) - vistos.size + (EJECUTAR ? 0 : st.borrados);
console.log(`\n=== ${EJECUTAR ? 'RESTAURADO' : 'dry-run'} · ${tiempo} ===`);
console.log(`  sin cambios desde la copia        : ${st.iguales}`);
console.log(`  cambiados → ${EJECUTAR ? 'devueltos a la copia' : 'se devolverían'}    : ${st.distintos}`);
console.log(`  borrados → ${EJECUTAR ? 'recreados' : 'se recrearían'}              : ${st.borrados}`);
if (IDS && vistos.size < IDS.size) console.log(`  ids que no estaban en la copia    : ${IDS.size - vistos.size}`);
if (nuevos > 0) console.log(`  creados después de la copia (no se tocan): ~${nuevos}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo.');
process.exit(0);
