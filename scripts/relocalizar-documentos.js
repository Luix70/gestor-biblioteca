#!/usr/bin/env node
/**
 * RELOCALIZA DOCUMENTOS CUYA CARPETA NO ESTÁ DONDE DICE LA BASE DE DATOS.
 *
 * `ruta_base` puede quedarse obsoleta cuando algo mueve carpetas por debajo. El caso que lo motivó: un número
 * ingerido SIN AÑO tenía como `ruta_base` la carpeta de la CABECERA entera (la versión antigua de
 * `rutaCatalogo` no le añadía segmento de número), así que al reubicar la serie se movió esa carpeta con las
 * de sus 27 hermanos dentro. Los ficheros NO se perdieron —siguen en el árbol— pero sus documentos apuntan a
 * un sitio que ya no existe.
 *
 * Esto lo arregla al revés: en vez de fiarse de la ruta, BUSCA EL FICHERO por su nombre en el árbol y corrige
 * `ruta_base` (y de paso portada e imágenes, que cuelgan de ella). No mueve NADA: solo repara la referencia.
 *
 *   node scripts/relocalizar-documentos.js [--coleccion <id>] [--ejecutar]
 *
 * Por DEFECTO es dry-run. Si un nombre de fichero aparece en VARIOS sitios no se toca ese documento: elegir a
 * ciegas entre dos candidatos es peor que dejarlo señalado para mirarlo.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const escribir = (s = '') => process.stdout.write(s + '\n');

const args = process.argv.slice(2);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EJECUTAR = args.includes('--ejecutar');
const idCol = valor('--coleccion');

const aDisco = (web) => path.join(DIR_CDU, String(web || '').replace(/^\/recursos\/?/, ''));
const aWeb = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');

const db = await conectarDB();

const filtro = {};
if (idCol) {
    try { filtro.coleccion = new ObjectId(idCol); } catch { escribir('\n⛔ id de colección no válido\n'); process.exit(1); }
}
const docs = await db.collection('biblioteca').find(filtro)
    .project({ titulo: 1, nombre_archivo: 1, ruta_base: 1, portada: 1, imagenes: 1 }).toArray();

escribir(`\n${EJECUTAR ? '⚙️  EJECUTAR' : '🔍 DRY-RUN'} · ${docs.length} documento(s) a comprobar\n`);

// 1) ¿Cuáles tienen la carpeta donde dicen? Se mira antes de recorrer el árbol: si no falta ninguno, no hay
//    que pagar el paseo por el disco.
const perdidos = [];
for (const d of docs) {
    if (!d.ruta_base) continue;
    if (await fs.stat(aDisco(d.ruta_base)).then(() => true).catch(() => false)) continue;
    perdidos.push(d);
}
escribir(`  ${perdidos.length} documento(s) apuntan a una carpeta que NO existe\n`);
if (!perdidos.length) { escribir('  Nada que reparar.\n'); process.exit(0); }

// 2) Índice nombre-de-fichero → rutas, recorriendo el árbol UNA vez.
escribir('  Recorriendo el árbol de CDU…');
const indice = new Map();
async function recorrer(dir, nivel = 12) {
    if (nivel < 0) return;
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { await recorrer(p, nivel - 1); continue; }
        if (!indice.has(e.name)) indice.set(e.name, []);
        indice.get(e.name).push(p);
    }
}
await recorrer(DIR_CDU);
escribir(`  ${indice.size} nombre(s) de fichero indexados\n`);

let reparados = 0, ambiguos = 0, ausentes = 0;
for (const d of perdidos) {
    const nombre = d.nombre_archivo;
    const candidatos = nombre ? (indice.get(nombre) || []) : [];

    if (!candidatos.length) {
        escribir(`  ✖ «${d.titulo}»: su fichero «${nombre || '—'}» NO aparece en el árbol`);
        ausentes++;
        continue;
    }
    if (candidatos.length > 1) {
        escribir(`  ? «${d.titulo}»: «${nombre}» aparece en ${candidatos.length} sitios → se deja, míralo tú`);
        for (const c of candidatos.slice(0, 3)) escribir(`        ${aWeb(c)}`);
        ambiguos++;
        continue;
    }

    const nueva = aWeb(path.dirname(candidatos[0]));
    escribir(`  ✔ «${d.titulo}»`);
    escribir(`        ${d.ruta_base}`);
    escribir(`     →  ${nueva}`);
    reparados++;
    if (!EJECUTAR) continue;

    const rebase = (x) => (typeof x === 'string' && x.startsWith(d.ruta_base) ? nueva + x.slice(d.ruta_base.length) : x);
    await db.collection('biblioteca').updateOne({ _id: d._id }, {
        $set: {
            ruta_base: nueva,
            ...(d.portada ? { portada: rebase(d.portada) } : {}),
            ...(Array.isArray(d.imagenes) ? { imagenes: d.imagenes.map(rebase) } : {}),
        },
    });
}

escribir(`\n${'─'.repeat(70)}`);
escribir(`  ${EJECUTAR ? 'Reparados' : 'Se repararían'}: ${reparados}`
    + (ambiguos ? ` · ambiguos: ${ambiguos}` : '') + (ausentes ? ` · sin fichero: ${ausentes}` : ''));
if (!EJECUTAR) escribir('\n  (DRY-RUN) No se ha tocado nada. Repite con --ejecutar.\n');
else escribir('');
process.exit(0);
