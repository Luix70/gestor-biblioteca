/**
 * MOVER LAS CACHÉS Y ARCHIVOS A LA BASE AUXILIAR — segundo clúster Atlas gratuito (`MONGO_URI_AUX`).
 *
 * El Atlas M0 da 512 MB por clúster; el 26-nov la base iba por 461 MB. Las colecciones de
 * database·COLECCIONES_AUXILIARES (descripciones CDU/Dewey/LCC, tablas oficiales, equivalencias, archivos de
 * retirados, registro de actividad: ~95 MB) pasan a otro clúster. Con `MONGO_URI_AUX` definida la app ya las
 * lee y escribe allí (database.js las enruta); este script traslada lo que hay.
 *
 * Procedimiento (en el NAS; ver docs/tareas-pendientes.md):
 *   1. Copia de la base:  node scripts/copia-base.js
 *   2. node scripts/mover-a-bd-auxiliar.js                   → en seco: qué se mueve, cuánto, y si la auxiliar responde
 *   3. node scripts/mover-a-bd-auxiliar.js --ejecutar        → COPIA (índices, validadores y documentos)
 *   4. Reiniciar el contenedor: desde ahí la app usa la auxiliar
 *   5. node scripts/mover-a-bd-auxiliar.js --ejecutar        → otra vez: copia lo que la app escribió en la
 *                                                              principal entre el paso 3 y el 4
 *   6. Comprobar el panel (ⓘ de las CDU, Mantenimiento…) y entonces:
 *      node scripts/mover-a-bd-auxiliar.js --borrar-origen              → en seco: verifica que no falta nada
 *      node scripts/mover-a-bd-auxiliar.js --borrar-origen --ejecutar   → borra las copias viejas de la principal
 *
 * Seguridad: la copia SOLO AÑADE los documentos que faltan en la auxiliar (por _id), nunca sobrescribe —
 * repetirla es inocuo y no pisa lo que la app ya escribió allí—. El borrado de la principal se hace solo si
 * CADA _id de la principal está en la auxiliar; si falta uno, esa colección no se toca.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { COLECCIONES_AUXILIARES, conectarDBPrincipal, conectarDBAuxiliar } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const BORRAR_ORIGEN = args.includes('--borrar-origen');
const LOTE = 1000;
const mb = (b) => (b / 1048576).toFixed(1);

if (!(process.env.MONGO_URI_AUX || '').trim()) {
    console.error('\n❌ Falta MONGO_URI_AUX en el .env (la cadena de conexión del segundo clúster Atlas). Ver docs/tareas-pendientes.md.\n');
    process.exit(1);
}

const principal = await conectarDBPrincipal();
let auxiliar;
try {
    auxiliar = await conectarDBAuxiliar();
    await auxiliar.command({ ping: 1 });
} catch (e) {
    console.error(`\n❌ La base auxiliar no responde: ${e.message}\n   Revisa MONGO_URI_AUX, el usuario de la base y el acceso de red (Network Access) del nuevo proyecto.\n`);
    process.exit(1);
}
if (principal.client?.options?.hosts?.join() === auxiliar.client?.options?.hosts?.join()) {
    console.error('\n❌ MONGO_URI_AUX apunta al MISMO clúster que MONGO_URI: no ganaría espacio. Usa un clúster de otro proyecto.\n');
    process.exit(1);
}

/** ¿Existe la colección en esa base? */
const existe = async (db, nombre) => (await db.listCollections({ name: nombre }, { nameOnly: true }).toArray()).length > 0;

/** Tamaño lógico (datos + índices) de una colección, o 0 si no existe. */
async function tamano(db, nombre) {
    if (!(await existe(db, nombre))) return { docs: 0, bytes: 0 };
    const s = await db.command({ collStats: nombre });
    return { docs: s.count, bytes: (s.size || 0) + (s.totalIndexSize || 0) };
}

/** Crea la colección en la auxiliar con el MISMO validador y los mismos índices que en la principal. */
async function prepararEstructura(nombre) {
    const info = (await principal.listCollections({ name: nombre }).toArray())[0];
    if (!(await existe(auxiliar, nombre))) {
        const o = info?.options || {};
        const opciones = {};
        for (const k of ['validator', 'validationLevel', 'validationAction', 'collation']) if (o[k] !== undefined) opciones[k] = o[k];
        await auxiliar.createCollection(nombre, opciones);
    }
    for (const ind of await principal.collection(nombre).listIndexes().toArray()) {
        if (ind.name === '_id_') continue;
        const { v, key, ns, ...opciones } = ind;   // nombre, unique, sparse, expireAfterSeconds (TTL), parcial, texto…
        await auxiliar.collection(nombre).createIndex(key, opciones);
    }
}

/**
 * Copia a la auxiliar los documentos de la principal que aún no están (por _id). Nunca sobrescribe.
 * `bypassDocumentValidation`: el validador 'moderate' de la principal toleraba documentos antiguos que hoy no
 * pasarían; el traslado no debe perderlos.
 */
async function copiar(nombre, total) {
    const origen = principal.collection(nombre);
    const destino = auxiliar.collection(nombre);
    const p = progreso(total, `Copiando ${nombre}`);
    let copiados = 0;
    let lote = [];
    const volcar = async () => {
        if (!lote.length) return;
        const ids = lote.map((d) => d._id);
        const ya = new Set((await destino.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
        const faltan = lote.filter((d) => !ya.has(String(d._id)));
        if (faltan.length) {
            await destino.insertMany(faltan, { ordered: false, bypassDocumentValidation: true });
            copiados += faltan.length;
        }
        lote = [];
    };
    for await (const doc of origen.find({}, { batchSize: LOTE })) {
        lote.push(doc);
        p.paso();
        if (lote.length >= LOTE) await volcar();
    }
    await volcar();
    p.fin();
    return copiados;
}

/** _id de la principal que NO están en la auxiliar (para no borrar nada que no se haya copiado). */
async function faltantesEnAuxiliar(nombre, total) {
    const p = progreso(total, `Verificando ${nombre}`);
    const faltan = [];
    let lote = [];
    const mirar = async () => {
        if (!lote.length) return;
        const ya = new Set((await auxiliar.collection(nombre).find({ _id: { $in: lote } }, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));
        for (const id of lote) if (!ya.has(String(id))) faltan.push(id);
        lote = [];
    };
    for await (const d of principal.collection(nombre).find({}, { projection: { _id: 1 }, batchSize: LOTE })) {
        lote.push(d._id);
        p.paso();
        if (lote.length >= LOTE) await mirar();
    }
    await mirar();
    p.fin();
    return faltan;
}

const modo = BORRAR_ORIGEN ? 'borrar las copias viejas de la principal' : 'copiar a la auxiliar';
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · mover cachés y archivos a la base auxiliar — ${modo}\n`);

const antes = await principal.command({ dbStats: 1 });
console.log(`   Principal ahora: ${mb(antes.dataSize + antes.indexSize)} MB (límite 512)\n`);

let totalBytes = 0;
const resumen = [];
for (const nombre of [...COLECCIONES_AUXILIARES].sort()) {
    const enP = await tamano(principal, nombre);
    const enA = await tamano(auxiliar, nombre);
    if (!enP.docs && !(await existe(principal, nombre))) {
        resumen.push(`   · ${nombre.padEnd(40)} no está en la principal${enA.docs ? ` (auxiliar: ${enA.docs})` : ''}`);
        continue;
    }
    totalBytes += enP.bytes;

    if (!BORRAR_ORIGEN) {
        if (!EJECUTAR) {
            resumen.push(`   · ${nombre.padEnd(40)} ${String(enP.docs).padStart(7)} docs · ${mb(enP.bytes).padStart(6)} MB   (auxiliar: ${enA.docs})`);
            continue;
        }
        await prepararEstructura(nombre);
        const copiados = await copiar(nombre, enP.docs);
        resumen.push(`   ✅ ${nombre.padEnd(40)} ${String(copiados).padStart(7)} copiados (auxiliar ahora: ${(await tamano(auxiliar, nombre)).docs})`);
        continue;
    }

    // --borrar-origen
    const faltan = await faltantesEnAuxiliar(nombre, enP.docs);
    if (faltan.length) {
        resumen.push(`   ⛔ ${nombre.padEnd(40)} faltan ${faltan.length} en la auxiliar (p. ej. ${faltan.slice(0, 3).join(', ')}) → NO se borra; repite --ejecutar sin --borrar-origen`);
        totalBytes -= enP.bytes;
        continue;
    }
    if (EJECUTAR) {
        await principal.collection(nombre).drop();
        resumen.push(`   🗑  ${nombre.padEnd(40)} ${String(enP.docs).padStart(7)} docs · ${mb(enP.bytes)} MB borrados de la principal (todos están en la auxiliar)`);
    } else {
        resumen.push(`   ✔  ${nombre.padEnd(40)} ${String(enP.docs).padStart(7)} docs · ${mb(enP.bytes)} MB — todos en la auxiliar, se puede borrar`);
    }
}

console.log(resumen.join('\n'));
console.log(`\n   Total: ${mb(totalBytes)} MB ${BORRAR_ORIGEN ? (EJECUTAR ? 'liberados en la principal' : 'que se liberarían en la principal') : (EJECUTAR ? 'copiados' : 'que se moverían')}`);
if (EJECUTAR && BORRAR_ORIGEN) {
    const despues = await principal.command({ dbStats: 1 });
    console.log(`   Principal después: ${mb(despues.dataSize + despues.indexSize)} MB (el panel del Atlas tarda unos minutos en reflejarlo)`);
}
if (!EJECUTAR) console.log(`\n   Nada escrito. Para aplicarlo: node scripts/mover-a-bd-auxiliar.js ${BORRAR_ORIGEN ? '--borrar-origen ' : ''}--ejecutar`);
else if (!BORRAR_ORIGEN) console.log('\n   Siguiente: reiniciar el contenedor, repetir este mismo comando, comprobar el panel y luego --borrar-origen.');
console.log('');
process.exit(0);
