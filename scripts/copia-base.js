#!/usr/bin/env node
/**
 * COPIA DE SEGURIDAD DE LA BASE DE DATOS (MongoDB Atlas) — todas las colecciones, a ficheros comprimidos en el NAS.
 *
 * Atlas en su plan gratuito no hace copias. Esto exporta cada colección a `<coleccion>.jsonl.gz` (una línea EJSON por
 * documento: conserva exactos los ObjectId, las fechas y los tipos) y un `manifiesto.json` con las cuentas. Se guarda
 * en /app/logs/copias-bd/<AAAAMMDD-HHMMSS>/ (logs/ no lo toca el despliegue). Restaurar: scripts/restaurar-base.js.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/copia-base.js                 (todas las colecciones)
 *   … --conservar N      deja solo las N copias más recientes (por defecto 10)
 *   … --coleccion X      solo esa colección (se puede repetir)
 *
 * Lee de Atlas en streaming (poca RAM, apto para el Atom). Es solo lectura: no cambia nada.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const CONSERVAR = Math.max(1, parseInt(arg('--conservar'), 10) || 10);
const SOLO = args.flatMap((a, i) => (a === '--coleccion' ? [args[i + 1]] : [])).filter(Boolean);

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR_LOGS = (() => { const v = process.env.PATH_LOGS || 'logs'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const DIR_COPIAS = path.join(DIR_LOGS, 'copias-bd');
const dd = (n) => String(n).padStart(2, '0');
const ahora = new Date();
const sello = `${ahora.getFullYear()}${dd(ahora.getMonth() + 1)}${dd(ahora.getDate())}-${dd(ahora.getHours())}${dd(ahora.getMinutes())}${dd(ahora.getSeconds())}`;
const destino = path.join(DIR_COPIAS, sello);
await fsp.mkdir(destino, { recursive: true });

const db = await conectarDB();
const colecciones = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.') && (!SOLO.length || SOLO.includes(n))).sort();
console.log(`\n💾 Copia de la base «${db.databaseName}» → ${destino}\n   ${colecciones.length} colección(es)\n`);

const manifiesto = { fecha: ahora.toISOString(), base: db.databaseName, colecciones: {} };
for (const nombre of colecciones) {
    const col = db.collection(nombre);
    const total = await col.estimatedDocumentCount();
    const p = progreso(total, `${nombre}`);
    const fichero = path.join(destino, `${nombre}.jsonl.gz`);
    const gz = zlib.createGzip({ level: 6 });
    const salida = fs.createWriteStream(fichero);
    gz.pipe(salida);
    let n = 0;
    for await (const doc of col.find({}, { batchSize: 500 })) {
        // EJSON canónico: {"$oid":…}, {"$date":…} — al restaurar vuelven a ser ObjectId y Date.
        if (!gz.write(BSON.EJSON.stringify(doc, { relaxed: false }) + '\n')) await new Promise((r) => gz.once('drain', r));
        n++;
        p.paso();
    }
    gz.end();
    await new Promise((r) => salida.on('finish', r));
    p.fin();
    const bytes = (await fsp.stat(fichero)).size;
    manifiesto.colecciones[nombre] = { documentos: n, bytes };
    console.log(`   ✅ ${nombre.padEnd(30)} ${String(n).padStart(7)} documentos · ${(bytes / 1048576).toFixed(1)} MB`);
}
await fsp.writeFile(path.join(destino, 'manifiesto.json'), JSON.stringify(manifiesto, null, 2));

// Conservar solo las N más recientes.
const copias = (await fsp.readdir(DIR_COPIAS)).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
for (const vieja of copias.slice(0, Math.max(0, copias.length - CONSERVAR))) {
    await fsp.rm(path.join(DIR_COPIAS, vieja), { recursive: true, force: true });
    console.log(`   🗑  copia antigua retirada: ${vieja}`);
}
const totalMB = Object.values(manifiesto.colecciones).reduce((s, c) => s + c.bytes, 0) / 1048576;
console.log(`\n💾 Copia completa: ${destino} (${totalMB.toFixed(1)} MB). Para restaurar: scripts/restaurar-base.js --desde ${sello}\n`);
process.exit(0);
