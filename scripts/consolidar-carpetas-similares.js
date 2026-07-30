/**
 * CONSOLIDAR CARPETAS SIMILARES — en una carpeta dada, agrupa las SUBCARPETAS cuyo nombre coincide al quitarle lo
 * que va entre paréntesis (), corchetes [], llaves {} y los símbolos sueltos (+, #, …); y fusiona TODO su
 * contenido en UNA sola carpeta con ese nombre «limpio». Ejemplo:
 *     Routledge Studies in Medieval Literature and Culture (21 Books) [Complete]
 *     Routledge Studies in Medieval Literature and Culture (23 Books)+
 *   → Routledge Studies in Medieval Literature and Culture   (con el contenido de ambas)
 *
 * SEGURIDAD (máxima del proyecto: no perder información):
 *   · Ficheros IDÉNTICOS byte a byte (mismo SHA-256) en las dos carpetas → se queda UNA sola versión (el entrante,
 *     que es un duplicado, se elimina — lo único que se borra, y solo tras confirmar que su copia ya está allí).
 *   · Ficheros con el MISMO nombre pero DISTINTO contenido → NO se pisan: el entrante se guarda con un sufijo
 *     ANTES de la extensión, «Libro.pdf» → «Libro_(1).pdf» (_(2), _(3)… si hiciera falta). Las subcarpetas
 *     homónimas se FUSIONAN recursivamente (tampoco se pisan).
 *   · Una carpeta ORIGEN solo se elimina si queda VACÍA tras mover su contenido.
 *   · DRY-RUN por defecto: enseña qué grupos y qué fusiones haría, sin tocar nada. --ejecutar para hacerlo.
 *
 * Solo agrupa cuando el nombre limpio COINCIDE EXACTAMENTE (no usa parecido difuso: mover ficheros a ciegas por
 * similitud sería arriesgado). Opera sobre las subcarpetas DIRECTAS de la carpeta dada.
 *
 * Uso:
 *   node scripts/consolidar-carpetas-similares.js "<carpeta>"              (DRY-RUN)
 *   node scripts/consolidar-carpetas-similares.js "<carpeta>" --ejecutar   (fusiona)
 */
import fs from 'fs/promises';
import path from 'path';
import { calcularHashArchivo } from '../src/utils/hash-archivo.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const RAIZ = args.find((a) => !a.startsWith('--'));
if (!RAIZ) {
    console.error('Uso: node scripts/consolidar-carpetas-similares.js "<carpeta>" [--ejecutar]');
    process.exit(1);
}

// Nombre «limpio»: quita (…), […], {…} incluidos los delimitadores, y los símbolos sueltos; colapsa espacios y
// recorta puntuación/guiones sobrantes. Lo que quede vacío (una carpeta que fuese TODO paréntesis) no se agrupa.
function limpiar(nombre) {
    return String(nombre)
        .replace(/\([^()]*\)/g, ' ')       // (…)
        .replace(/\[[^\[\]]*\]/g, ' ')     // […]
        .replace(/\{[^{}]*\}/g, ' ')       // {…}
        .replace(/[()\[\]{}]/g, ' ')       // delimitadores sueltos que hayan quedado
        .replace(/[+#*~·|@]+/g, ' ')       // símbolos sueltos
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[\s.,;:+\-–—_]+$/, '')   // puntuación/guiones/espacios al final
        .trim();
}
// Nombre de carpeta válido en Windows+Linux (por si el limpio dejara algo raro; normalmente ya es válido).
const sanear = (n) => n.replace(/[/\\:*?"<>|]/g, '_').replace(/[ .]+$/, '').trim() || 'consolidado';
const existe = (p) => fs.access(p).then(() => true, () => false);

/** Nombre libre en la carpeta destino, añadiendo un sufijo «_(1)», «_(2)»… ANTES de la extensión (p. ej.
 *  «Libro.pdf» → «Libro_(1).pdf»), sin pisar nada. El original conserva su nombre; el entrante recibe el sufijo. */
async function rutaLibre(p) {
    const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
    let q = p, n = 1;
    while (await existe(q)) { q = path.join(dir, `${base}_(${n})${ext}`); n++; }
    return q;
}
async function mismoContenido(a, b) {
    try { const [ha, hb] = await Promise.all([calcularHashArchivo(a), calcularHashArchivo(b)]); return ha === hb; }
    catch { return false; }
}

/**
 * Fusiona el contenido de `src` dentro de `dst` (recursivo, sin pérdida). Mueve cada entrada; ante colisión:
 * subcarpeta homónima → fusiona dentro; fichero idéntico → borra el duplicado; distinto → sufijo « (n)».
 * Deja `src` vacío (el llamante lo elimina). `stats` acumula el recuento.
 */
async function fusionar(src, dst, stats) {
    await fs.mkdir(dst, { recursive: true });
    for (const e of await fs.readdir(src, { withFileTypes: true })) {
        const from = path.join(src, e.name);
        const to = path.join(dst, e.name);
        const hay = await existe(to);
        if (e.isDirectory()) {
            if (!hay) { await fs.rename(from, to); stats.movidos++; }
            else {
                const st = await fs.stat(to);
                if (st.isDirectory()) { await fusionar(from, to, stats); await fs.rmdir(from).catch(() => {}); }
                else { await fs.rename(from, await rutaLibre(to)); stats.movidos++; } // carpeta vs fichero → sufijo
            }
        } else {
            if (!hay) { await fs.rename(from, to); stats.movidos++; }
            else {
                const st = await fs.stat(to);
                if (st.isFile() && await mismoContenido(from, to)) { await fs.rm(from); stats.duplicados++; } // idéntico → dup
                else { await fs.rename(from, await rutaLibre(to)); stats.movidos++; }                          // distinto → sufijo
            }
        }
    }
}

async function main() {
    const raiz = path.resolve(RAIZ);
    console.log(`\nConsolidar carpetas similares  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]  · carpeta: ${raiz}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se mueve ni se borra nada.\n'); else console.log('');

    let ents;
    try { ents = (await fs.readdir(raiz, { withFileTypes: true })).filter((e) => e.isDirectory()); }
    catch (e) { console.error(`No se puede leer «${raiz}»: ${e.message}`); process.exit(1); }

    // Agrupa las subcarpetas por su nombre LIMPIO (clave en minúsculas para tolerar diferencias de mayúsculas).
    const grupos = new Map();
    for (const e of ents) {
        const limpio = limpiar(e.name);
        if (!limpio) continue; // nombre que era todo paréntesis/símbolos → no se agrupa
        const clave = limpio.toLowerCase();
        if (!grupos.has(clave)) grupos.set(clave, { nombre: limpio, dirs: [] });
        grupos.get(clave).dirs.push(e.name);
    }
    const aConsolidar = [...grupos.values()].filter((g) => g.dirs.length >= 2);
    if (!aConsolidar.length) { console.log('No hay grupos de carpetas con el mismo nombre limpio. Nada que hacer.'); process.exit(0); }
    console.log(`Grupos a consolidar: ${aConsolidar.length}\n`);

    let consolidados = 0, movidos = 0, duplicados = 0, sobrantes = 0;
    for (let i = 0; i < aConsolidar.length; i++) {
        const g = aConsolidar[i];
        const marca = `[${i + 1}/${aConsolidar.length}]`;
        const targetDir = path.join(raiz, sanear(g.nombre));
        const fuentes = g.dirs.map((d) => path.join(raiz, d));
        // Si UNA de las fuentes ya ES el nombre limpio, esa es el destino (las demás se vuelcan en ella).
        const target = fuentes.find((f) => f.toLowerCase() === targetDir.toLowerCase()) || targetDir;
        const aMover = fuentes.filter((f) => f !== target);

        if (!EJECUTAR) {
            console.log(`${marca} → «${sanear(g.nombre)}»`);
            for (const f of fuentes) console.log(`        ${f === target ? '· (destino)     ' : '· se fusiona →  '} ${path.basename(f)}`);
            continue;
        }

        await fs.mkdir(target, { recursive: true });
        const stats = { movidos: 0, duplicados: 0 };
        for (const src of aMover) {
            await fusionar(src, target, stats);
            // La carpeta origen solo se elimina si quedó VACÍA (rmdir falla si no lo está → se conserva y se avisa).
            try { await fs.rmdir(src); }
            catch { sobrantes++; console.log(`${marca} ⚠ «${path.basename(src)}» NO se borró (quedó con contenido) — revísala`); }
        }
        consolidados++; movidos += stats.movidos; duplicados += stats.duplicados;
        console.log(`${marca} ✔ «${path.basename(target)}» ← ${aMover.length} carpeta(s) · ${stats.movidos} movido(s)${stats.duplicados ? ` · ${stats.duplicados} duplicado(s) idéntico(s) descartado(s)` : ''}`);
    }

    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    if (!EJECUTAR) {
        console.log(`  Grupos que se consolidarían: ${aConsolidar.length}`);
        console.log('  (simulación) Nada tocado. Re-ejecuta con --ejecutar.');
    } else {
        console.log(`  Grupos consolidados: ${consolidados} · elementos movidos: ${movidos} · duplicados idénticos descartados: ${duplicados}` + (sobrantes ? ` · carpetas no vaciadas: ${sobrantes}` : ''));
    }
    process.exit(0);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
