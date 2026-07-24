/**
 * REPARAR CONTRIBUCIONES CORRUPTAS — arregla los documentos cuyo `contribuciones[].persona` (o algún elemento
 * de `autores[]`) quedó guardado como el OBJETO { _id, creada, nombre } en vez de como el ObjectId. Lo causó un
 * bug de la asignación en lote (resolverPersonaFlex devolvía el objeto de resolverPersona en vez de su `_id`);
 * la ficha lo mostraba como «⚠ [object Object]». El bug ya está corregido; esto sanea lo que se escribió antes.
 *
 * Uso:
 *   node scripts/reparar-contribuciones.js            (DRY-RUN: solo informa)
 *   node scripts/reparar-contribuciones.js --ejecutar (repara)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
// Un ObjectId tiene _bsontype 'ObjectId'; un objeto plano { _id, creada, nombre }, no.
const esWrapper = (v) => v && typeof v === 'object' && v._bsontype !== 'ObjectId' && v._id;
const idDe = (v) => (esWrapper(v) ? v._id : v);

const db = await conectarDB();
const bib = db.collection('biblioteca');

const corruptos = await bib.find(
    { $or: [{ 'contribuciones.persona': { $type: 'object' } }, { autores: { $type: 'object' } }] },
    { projection: { contribuciones: 1, autores: 1, titulo: 1 } },
).toArray();

console.log(`\n=== Reparar contribuciones/autores corruptos ${EJECUTAR ? '· EJECUCIÓN' : '· SIMULACIÓN'} ===`);
console.log(`Documentos afectados: ${corruptos.length}\n`);

let reparados = 0;
for (const d of corruptos) {
    const set = {};
    if (Array.isArray(d.contribuciones) && d.contribuciones.some((c) => esWrapper(c?.persona)))
        set.contribuciones = d.contribuciones.map((c) => (esWrapper(c?.persona) ? { persona: idDe(c.persona), rol: c.rol } : c));
    if (Array.isArray(d.autores) && d.autores.some(esWrapper))
        set.autores = d.autores.map(idDe);
    if (!Object.keys(set).length) continue;

    const muestra = (set.contribuciones || []).find((c) => c) || (set.autores || [])[0];
    console.log(`  · «${String(d.titulo || d._id).slice(0, 55)}» → ${set.contribuciones ? set.contribuciones.length + ' contrib.' : ''}${set.autores ? ' ' + set.autores.length + ' autor(es)' : ''}`);
    if (EJECUTAR) {
        await bib.updateOne({ _id: d._id }, { $set: { ...set, fecha_actualizacion: new Date() } });
        await indexarDoc(db, d._id).catch(() => {});
    }
    reparados++;
}

console.log(EJECUTAR
    ? `\n✅ ${reparados} documento(s) reparados.`
    : `\n(simulación) Se repararían ${reparados} documento(s). Re-ejecuta con --ejecutar.`);
process.exit(0);
