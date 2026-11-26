/**
 * ADELGAZAR LA BASE — recorta de `biblioteca` lo que ocupa sitio sin aportar información, para no llegar al
 * límite de 512 MB del Atlas gratuito (alerta «Logical Size has gone above 440 MB», 26-nov: 461 MB).
 *
 * Dos recortes, los dos sin perder nada:
 *   1. `mantenimiento_firma`: la lista entera de tareas+versiones (≈355 caracteres por ficha, ~27 MB) pasa a
 *      su resumen corto (conformador·FIRMA_MANTENIMIENTO). Una firma larga de una versión ANTERIOR (ficha aún
 *      no conforme) se quita: sin firma la ficha sigue pendiente igual, y su estado real está en
 *      `mantenimiento`. Las marcas especiales ('pendiente-…') no se tocan.
 *   2. `alertas_agente`: fuera las notas de traza y las repetidas (utils/alertas-informativas — la MISMA lista
 *      que aplica ya la ingesta). Se conserva todo el rastro de cambios, avisos y procedencia de los datos.
 *
 * Seguro ante escrituras simultáneas (vigilante / Conformador en marcha): cada ficha se actualiza solo si su
 * firma y su nº de alertas siguen como se leyeron; si no, se salta y basta con volver a pasar el script.
 *
 * Uso (en el NAS, tras una copia: node scripts/copia-base.js):
 *   node scripts/adelgazar-bd.js              → en seco: cuenta qué se recortaría y cuánto se ahorra
 *   node scripts/adelgazar-bd.js --ejecutar   → lo aplica
 *   --limite N                                → solo las N primeras fichas con algo que recortar (prueba)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { BSON } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { alertasDepuradas } from '../src/utils/alertas-informativas.js';
import { FIRMA_MANTENIMIENTO, FIRMA_MANTENIMIENTO_LARGA } from '../src/mantenimiento/conformador.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const iLimite = args.indexOf('--limite');
const LIMITE = iLimite >= 0 ? Number(args[iLimite + 1]) || 0 : 0;
const LOTE_ESCRITURA = 500;

const mb = (bytes) => (bytes / 1048576).toFixed(1);
const tamano = (v) => (v === undefined ? 0 : BSON.calculateObjectSize({ x: v }));

/** Firma larga = la lista «tarea:versión|…» de antes. Las marcas 'pendiente-…' y la firma corta no lo son. */
const esFirmaLarga = (f) => typeof f === 'string' && f.includes('|') && f.includes(':');

/**
 * Qué cambiaría en una ficha. Devuelve null si nada, o { filtro, update, ahorro, firma, alertas }.
 * El filtro incluye la firma y el nº de alertas leídos: si alguien la toca entretanto, no casa y se salta.
 */
function planDe(doc) {
    const set = {};
    const unset = {};
    let ahorro = 0;
    let firma = null;
    let alertas = 0;

    // 1. Firma del Conformador.
    const f = doc.mantenimiento_firma;
    if (esFirmaLarga(f)) {
        if (f === FIRMA_MANTENIMIENTO_LARGA) {
            set.mantenimiento_firma = FIRMA_MANTENIMIENTO;
            ahorro += tamano(f) - tamano(FIRMA_MANTENIMIENTO);
            firma = 'corta';
        } else {
            unset.mantenimiento_firma = '';
            ahorro += tamano(f);
            firma = 'antigua';
        }
    }

    // 2. Alertas.
    const originales = Array.isArray(doc.alertas_agente) ? doc.alertas_agente : null;
    if (originales) {
        const quedan = alertasDepuradas(originales);
        if (quedan.length !== originales.length) {
            alertas = originales.length - quedan.length;
            ahorro += tamano(originales) - (quedan.length ? tamano(quedan) : 0);
            if (quedan.length) set.alertas_agente = quedan;
            else unset.alertas_agente = '';   // nunca persistir un array vacío ($jsonSchema)
        }
    }

    if (!firma && !alertas) return null;
    const update = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    const filtro = {
        _id: doc._id,
        mantenimiento_firma: f === undefined ? { $exists: false } : f,
        alertas_agente: originales ? { $size: originales.length } : { $exists: false },
    };
    return { filtro, update, ahorro, firma, alertas };
}

const db = await conectarDB();
const col = db.collection('biblioteca');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · adelgazar la base (firma del Conformador + alertas de traza)${LIMITE ? ` · límite ${LIMITE}` : ''}\n`);

// Tamaño de partida (lo que cuenta el Atlas gratuito: datos sin comprimir + índices).
const statsAntes = await db.command({ dbStats: 1 });
console.log(`   Base ahora: ${mb(statsAntes.dataSize)} MB de datos + ${mb(statsAntes.indexSize)} MB de índices = ${mb(statsAntes.dataSize + statsAntes.indexSize)} MB (límite 512).\n`);

const total = await col.estimatedDocumentCount();
const p = progreso(total, EJECUTAR ? 'Adelgazando' : 'Mirando');
const cuenta = { fichas: 0, firmaCorta: 0, firmaAntigua: 0, alertas: 0, ahorro: 0, aplicadas: 0, saltadas: 0 };
let pendientes = [];

/** Escribe un lote; las que no casen (tocadas entretanto) se cuentan como saltadas. */
async function escribir() {
    if (!pendientes.length) return;
    const r = await col.bulkWrite(pendientes.map((x) => ({ updateOne: { filter: x.filtro, update: x.update } })), { ordered: false });
    cuenta.aplicadas += r.modifiedCount;
    cuenta.saltadas += pendientes.length - r.matchedCount;
    pendientes = [];
}

const cursor = col.find({}, { projection: { mantenimiento_firma: 1, alertas_agente: 1, titulo: 1 }, batchSize: 1000 });
for await (const doc of cursor) {
    p.paso(doc.titulo);
    const plan = planDe(doc);
    if (!plan) continue;
    cuenta.fichas++;
    if (plan.firma === 'corta') cuenta.firmaCorta++;
    if (plan.firma === 'antigua') cuenta.firmaAntigua++;
    cuenta.alertas += plan.alertas;
    cuenta.ahorro += plan.ahorro;
    if (EJECUTAR) {
        pendientes.push(plan);
        if (pendientes.length >= LOTE_ESCRITURA) await escribir();
    }
    if (LIMITE && cuenta.fichas >= LIMITE) break;
}
if (EJECUTAR) await escribir();
const duracion = p.fin();

console.log(`   Fichas con algo que recortar: ${cuenta.fichas}`);
console.log(`     · firma larga → corta:          ${cuenta.firmaCorta}`);
console.log(`     · firma antigua quitada:        ${cuenta.firmaAntigua}  (siguen pendientes del Conformador, como antes)`);
console.log(`     · alertas de traza/repetidas:   ${cuenta.alertas}`);
console.log(`   Ahorro estimado: ${mb(cuenta.ahorro)} MB  (${duracion})`);

if (EJECUTAR) {
    console.log(`\n   ✅ Aplicadas: ${cuenta.aplicadas}${cuenta.saltadas ? ` · ⏭ saltadas (cambiaron mientras tanto): ${cuenta.saltadas} — vuelve a pasar el script` : ''}`);
    const statsDespues = await db.command({ dbStats: 1 });
    console.log(`   Base después: ${mb(statsDespues.dataSize)} MB de datos + ${mb(statsDespues.indexSize)} MB de índices = ${mb(statsDespues.dataSize + statsDespues.indexSize)} MB.`);
    console.log('   (El Atlas puede tardar unos minutos en reflejar el nuevo tamaño en su panel y en sus alertas.)');
} else {
    console.log('\n   Nada escrito. Para aplicarlo: node scripts/adelgazar-bd.js --ejecutar   (antes: node scripts/copia-base.js)');
}
process.exit(0);
