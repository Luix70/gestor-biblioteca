#!/usr/bin/env node
/**
 * AGRUPA VARIOS DOCUMENTOS SUELTOS EN UNA OBRA MULTIVOLUMEN, bajo UNA sola CDU y UNA sola carpeta.
 *
 * Para qué: una colección que se cataloga tomo a tomo sin ISBN ni capa de texto (unos cbz de láminas, por
 * ejemplo) hace que el clasificador tenga que ADIVINAR la CDU en cada volumen. El resultado real con los
 * grabados de la Encyclopédie fueron 16 documentos repartidos por SEIS CDU distintas —siete de ellas en el
 * comodín `000` y una en «literatura española»—, cada una en su carpeta. Ninguno es un error de catalogación
 * recuperable con más datos: es que no hay datos. Se arregla a mano, y esto lo automatiza.
 *
 * Deja exactamente lo que habría dejado una ingesta normal de obra multivolumen:
 *   <clase>/<division>/<cdu>/obras/<obra>/vol-1, vol-2, …   (ver utils/rutas.js · rutaCatalogo)
 *
 *   node scripts/agrupar-en-obra.js --patron "<regex sobre nombre_archivo>" --titulo "<título de la obra>" \
 *                                   --cdu <cdu> [--esperados <n>] [--ejecutar]
 *
 * Por DEFECTO es dry-run. `--esperados` es una RED: si el patrón no casa exactamente ese número de
 * documentos, no se hace nada (un regex de más arrastraría documentos ajenos a la obra).
 *
 * ⚠ ANTES DE `--ejecutar`: copia de seguridad de la base de datos. Esto reescribe 16 documentos y mueve sus
 * carpetas. Los ficheros se MUEVEN (nunca se borran) y si la carpeta destino ya existe, ese tomo se salta.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { rutaCatalogo } from '../src/utils/rutas.js';
import { resolverObra, registrarVolumenEnObra } from '../src/utils/obras.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const escribir = (s = '') => process.stdout.write(s + '\n');   // NO console.log: consola-timestamp lo silenciaría

const args = process.argv.slice(2);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EJECUTAR = args.includes('--ejecutar');
const patron = valor('--patron');
const tituloObra = valor('--titulo');
const cduObra = valor('--cdu');
const esperados = valor('--esperados') ? Number(valor('--esperados')) : null;

if (!patron || !tituloObra || !cduObra) {
    escribir('\nFaltan argumentos.');
    escribir('  node scripts/agrupar-en-obra.js --patron "<regex>" --titulo "<obra>" --cdu <cdu> [--esperados n] [--ejecutar]\n');
    process.exit(1);
}

/** Ruta FÍSICA de un `ruta_base` web (`/recursos/a/b/c` → <DIR_CDU>/a/b/c). */
const aDisco = (web) => path.join(DIR_CDU, String(web || '').replace(/^\/recursos\/?/, ''));

const db = await conectarDB();
const docs = await db.collection('biblioteca')
    .find({ nombre_archivo: { $regex: patron, $options: 'i' } })
    .sort({ nombre_archivo: 1 })   // el orden natural del nombre ES el orden de los tomos
    .toArray();

escribir(`\n${EJECUTAR ? '⚙️  EJECUTAR' : '🔍 DRY-RUN'} · agrupar en obra «${tituloObra}» (CDU ${cduObra})`);
escribir(`   patrón: ${patron}`);
escribir(`   ${docs.length} documento(s) encontrados\n`);

if (!docs.length) { escribir('Nada que hacer.\n'); process.exit(1); }
if (esperados != null && docs.length !== esperados) {
    escribir(`⛔ Se esperaban ${esperados} documentos y el patrón casa ${docs.length}. No se toca nada:`);
    escribir('   afinar el patrón es más barato que deshacer un movimiento en masa.\n');
    for (const d of docs) escribir(`     · ${d.nombre_archivo}`);
    escribir('');
    process.exit(1);
}

// La obra: se resuelve (o se crea) ANTES, porque su _id forma parte de la ruta de cada tomo.
let obraId = null, obraSeg = null;
if (EJECUTAR) {
    const obra = await resolverObra(db, { titulo: tituloObra, cdu: cduObra, total: docs.length });
    obraId = obra._id;
    obraSeg = obra.isbn_obra || obra.titulo || String(obra._id);
    escribir(`   obra ${obra.creada ? 'CREADA' : 'reutilizada'}: ${obraId}\n`);
} else {
    const ya = await db.collection('obras').findOne({ titulo: tituloObra });
    obraId = ya?._id || '<nueva>';
    obraSeg = ya?.isbn_obra || ya?.titulo || tituloObra;
    escribir(`   obra: ${ya ? 'ya existe · ' + obraId : 'se crearía'}\n`);
}

let movidos = 0, saltados = 0;
const coleccionesHuerfanas = new Set();

for (const [i, d] of docs.entries()) {
    const volumen = i + 1;
    const destino = rutaCatalogo({
        cdu: cduObra, tipo_recurso: d.tipo_recurso || 'libro', id: d._id,
        obra: obraSeg, volumen_numero: volumen,
    });
    const origenDisco = aDisco(d.ruta_base);
    const destinoDisco = aDisco(destino.web);

    escribir(`  vol-${String(volumen).padStart(2, ' ')} · ${d.nombre_archivo}`);
    escribir(`         cdu  ${d.cdu} → ${cduObra}`);
    escribir(`         de   ${d.ruta_base}`);
    escribir(`         a    ${destino.web}`);

    if (d.coleccion) coleccionesHuerfanas.add(String(d.coleccion));
    if (!EJECUTAR) { movidos++; continue; }

    // MOVER la carpeta. Si el destino ya existe no se fusiona nada: se avisa y se deja el documento como
    // está. Fusionar a ciegas es la clase de atajo que hace perder ficheros.
    if (origenDisco !== destinoDisco) {
        if (await fs.stat(destinoDisco).then(() => true).catch(() => false)) {
            escribir('         ⚠ el destino YA existe → se salta (revísalo a mano)');
            saltados++;
            continue;
        }
        try {
            await fs.mkdir(path.dirname(destinoDisco), { recursive: true });
            await fs.rename(origenDisco, destinoDisco);
        } catch (e) {
            escribir(`         ✖ no se pudo mover (${e.message}) → se salta, el documento queda intacto`);
            saltados++;
            continue;
        }
    }

    // Y AHORA la base de datos. Las rutas internas (portada, carrusel) cuelgan de ruta_base: basta
    // reemplazar el prefijo, que es exactamente lo que cambia.
    const rebase = (p) => (typeof p === 'string' && p.startsWith(d.ruta_base) ? destino.web + p.slice(d.ruta_base.length) : p);
    await db.collection('biblioteca').updateOne({ _id: d._id }, {
        $set: {
            cdu: cduObra,
            obra: obraId,
            volumen_numero: volumen,
            ruta_base: destino.web,
            ...(d.portada ? { portada: rebase(d.portada) } : {}),
            ...(Array.isArray(d.imagenes) ? { imagenes: d.imagenes.map(rebase) } : {}),
        },
        // La colección de un solo miembro que arrastraba cada tomo es ruido: la obra la sustituye.
        $unset: { coleccion: '', clave_numero: '' },
    });
    await registrarVolumenEnObra(db, obraId, volumen, d._id, docs.length);
    movidos++;
}

// Carpetas madre que hayan quedado VACÍAS tras mover los tomos. Solo si están literalmente vacías: la regla
// de la casa es que una carpeta con ficheros NO se toca.
if (EJECUTAR) {
    for (const d of docs) {
        let dir = path.dirname(aDisco(d.ruta_base));
        for (let n = 0; n < 3; n++) {
            const dentro = await fs.readdir(dir).catch(() => null);
            if (!dentro || dentro.length) break;
            await fs.rmdir(dir).catch(() => {});
            dir = path.dirname(dir);
        }
    }
    // Colecciones que se han quedado sin ningún miembro.
    for (const cid of coleccionesHuerfanas) {
        const { ObjectId } = await import('mongodb');
        let _id; try { _id = new ObjectId(cid); } catch { continue; }
        const quedan = await db.collection('biblioteca').countDocuments({ coleccion: _id });
        if (quedan === 0) {
            await db.collection('colecciones').deleteOne({ _id });
            escribir(`  🧹 colección vacía eliminada: ${cid}`);
        }
    }
}

escribir(`\n${'─'.repeat(70)}`);
escribir(`  ${EJECUTAR ? 'Agrupados' : 'Se agruparían'}: ${movidos}` + (saltados ? ` · saltados: ${saltados}` : ''));
if (!EJECUTAR) {
    escribir('\n  (DRY-RUN) No se ha tocado nada.');
    escribir('  ⚠ Haz COPIA DE SEGURIDAD de la base de datos antes de repetir con --ejecutar.\n');
} else {
    escribir(`\n  Obra ${obraId} con ${movidos} volumen(es). Reindexa la búsqueda si usas el índice local.\n`);
}
process.exit(0);
