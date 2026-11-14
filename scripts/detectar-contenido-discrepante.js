#!/usr/bin/env node
/**
 * DETECTAR FICHAS QUE NO CASAN CON SU FICHERO — p. ej. el capítulo «Hobbes on rhetoric» catalogado como «Cambridge
 * Companion to the Violin» (con el ISBN, la CDU y la portada de ese otro libro). Motor: src/utils/contenido-ficha.js.
 *
 * Por cada documento con fichero se compara el título de la ficha con el nombre del fichero y, si el nombre no lo
 * confirma, con el texto de sus primeras páginas (PDF con texto, EPUB). Solo LEE: no cambia ninguna ficha.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-contenido-discrepante.js              (lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-contenido-discrepante.js --ejecutar   (+ selección)
 *   … --dudosos        con --ejecutar, también la selección de los dudosos (sin texto con que confirmarlos)
 *   … --id <id>,<id>   solo esos
 *
 * Con --ejecutar crea (o actualiza) la selección «Ficha y contenido no casan (N)». En el panel, sobre cada ficha:
 *   «🧹 Reidentificar desde el contenido» (la ficha se rehace con lo que dice el fichero) o
 *   «🔁 Sustituir fichero» (la ficha es buena y el fichero no: se sube el bueno).
 * Gemelo en la ingesta: la guarda de las búsquedas por título (proveedor-metadatos·resultadoDeEsteLibro).
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { cotejarContenido } from '../src/utils/contenido-ficha.js';
import { crearSeleccion, reemplazarDocs } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const DUDOSOS = args.includes('--dudosos');
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · fichas que no casan con su fichero\n`);

// Documentos con un fichero propio. Las revistas se dejan fuera: su «título» es la cabecera + el número, que el
// fichero («1.pdf», «2016-07.pdf») no tiene por qué traer.
const filtro = IDS.length
    ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } }
    : { nombre_archivo: { $exists: true, $ne: '' }, formatos: { $ne: 'papel' }, tipo_recurso: { $ne: 'revista' }, naturaleza: { $nin: ['audiolibro', 'software'] } };
const docs = await bib.find(filtro, { projection: { titulo: 1, nombre_archivo: 1, ruta_base: 1, formatos: 1, isbn: 1, tipo_recurso: 1 } }).toArray();
console.log(`${docs.length} documento(s) con fichero.\n`);

const grupos = { casa: [], 'no-casa': [], dudoso: [], 'sin-datos': [] };
const p = progreso(docs.length, 'Cotejando');
for (const d of docs) {
    const r = await cotejarContenido(d).catch((e) => ({ veredicto: 'sin-datos', motivo: e.message }));
    grupos[r.veredicto].push({ d, r });
    p.paso(d.titulo);
}
p.fin();

const fila = ({ d, r }) => `    ${d._id}  «${String(d.titulo || '').slice(0, 55)}»  ←  ${String(d.nombre_archivo || '').slice(0, 70)}${d.isbn ? `  [ISBN ${d.isbn}]` : ''}\n        ${r.motivo}`;
console.log(`\n· Casan: ${grupos.casa.length}`);
console.log(`· Sin datos (sin fichero en disco, o título sin palabras con que comparar): ${grupos['sin-datos'].length}`);
console.log(`\n· NO CASAN: ${grupos['no-casa'].length}`);
for (const x of grupos['no-casa'].slice(0, 200)) console.log(fila(x));
if (grupos['no-casa'].length > 200) console.log(`    … y ${grupos['no-casa'].length - 200} más (todas en la selección)`);
console.log(`\n· Dudosos (no hay texto con que confirmarlo, o el parecido es parcial): ${grupos.dudoso.length}`);
for (const x of grupos.dudoso.slice(0, 40)) console.log(fila(x));
if (grupos.dudoso.length > 40) console.log(`    … y ${grupos.dudoso.length - 40} más`);

/** Crea la selección o, si ya existe una con ese prefijo, le pone estos documentos y el recuento nuevo. */
async function guardarSeleccion(prefijo, descripcion, lista) {
    if (!lista.length) return;
    const nombre = `${prefijo} (${lista.length})`;
    const ids = lista.map((x) => x.d._id);
    const prefijoRe = prefijo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ya = await db.collection('selecciones').findOne({ nombre: { $regex: `^${prefijoRe} \\(\\d+\\)$` } }, { projection: { _id: 1 } });
    if (ya) {
        await reemplazarDocs(db, ya._id, ids);
        await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { nombre } });
    } else {
        await crearSeleccion(db, { nombre, descripcion, docs: ids });
    }
    console.log(`📋 Selección «${nombre}».`);
}

if (!EJECUTAR) {
    console.log('\n(En seco: no se ha tocado nada. Con --ejecutar se crea la selección para revisarlas en el panel.)');
    process.exit(0);
}
if (!IDS.length) {
    console.log('');
    await guardarSeleccion('Ficha y contenido no casan',
        'El título de la ficha no aparece ni en el nombre del fichero ni en sus primeras páginas (detectar-contenido-discrepante.js). En cada ficha: «🧹 Reidentificar desde el contenido» o «🔁 Sustituir fichero».',
        grupos['no-casa']);
    if (DUDOSOS) {
        await guardarSeleccion('Ficha y contenido dudosos',
            'No se pudo confirmar que la ficha sea la de su fichero: sin texto legible (escaneo sin OCR) o parecido parcial. Revisar a mano.',
            grupos.dudoso);
    }
}
process.exit(0);
