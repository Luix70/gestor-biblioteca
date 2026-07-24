/**
 * LIMPIAR AUTORES HUÉRFANOS — borra de la colección `autores` los que NO figuran en ningún documento (ni como
 * autor ni como contribuyente) Y que además están VACÍOS (sin inversión: sin biografía, sin foto, sin fechas
 * de nacimiento/fallecimiento). Son, sobre todo, restos del volcado OL+BNE y menciones de responsabilidad mal
 * parseadas que se crearon como «autor» y quedaron sin libro.
 *
 * SE CONSERVAN SIEMPRE: (1) los que tienen algún documento; (2) los que, aun sin libros, tienen datos
 * biográficos o foto — no se tira lo que costó obtener. Un autor borrado se RECREA solo si más adelante entra
 * un libro que lo cite (la ingesta hace check-then-create), así que borrar es reversible en la práctica.
 *
 * Uso:
 *   node scripts/limpiar-autores-huerfanos.js            (DRY-RUN: solo informa, no borra nada)
 *   node scripts/limpiar-autores-huerfanos.js --ejecutar (BORRA los vacíos)
 *
 * ⚠ Es un BORRADO MASIVO en la BD: haz COPIA DE SEGURIDAD antes de --ejecutar.
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { autorTieneInversion } from '../src/utils/gestion-autores.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const db = await conectarDB();
const autoresCol = db.collection('autores');
const bib = db.collection('biblioteca');

console.log(`\n=== Limpiar autores huérfanos ${EJECUTAR ? '· MODO EJECUCIÓN (BORRA)' : '· SIMULACIÓN (dry-run)'} ===\n`);

// Conjunto de personas referenciadas por ALGÚN documento (como autor o como contribuyente). distinct() usa el
// índice y devuelve solo los _id presentes, así que es barato aunque haya decenas de miles de autores.
const refAutor = await bib.distinct('autores');
const refContrib = await bib.distinct('contribuciones.persona');
const conLibros = new Set([...refAutor, ...refContrib].map(String));
console.log(`Referenciados por algún documento: ${conLibros.size}`);

const total = await autoresCol.estimatedDocumentCount();
console.log(`Autores en la colección:           ${total}`);

// Recorre la colección con CURSOR (no carga 18k en memoria): clasifica cada huérfano.
const aBorrar = [];
let conObras = 0, conInversion = 0;
const cursor = autoresCol.find({}, { projection: { nombre: 1, biografia: 1, foto: 1, fotos: 1, nacimiento: 1, fallecimiento: 1 } });
for await (const a of cursor) {
    if (conLibros.has(String(a._id))) { conObras++; continue; }
    if (autorTieneInversion(a)) { conInversion++; continue; }
    aBorrar.push(a);
}

console.log(`\nHuérfanos (0 documentos): ${aBorrar.length + conInversion}`);
console.log(`  · con inversión (bio/foto/fechas) → SE CONSERVAN: ${conInversion}`);
console.log(`  · vacíos → ${EJECUTAR ? 'SE BORRAN' : 'se borrarían'}:              ${aBorrar.length}`);

if (aBorrar.length) {
    console.log('\nEjemplos de los que se ' + (EJECUTAR ? 'borran' : 'borrarían') + ':');
    for (const a of aBorrar.slice(0, 15)) console.log(`  · ${String(a.nombre || '(sin nombre)').slice(0, 90)}`);
    if (aBorrar.length > 15) console.log(`  … y ${aBorrar.length - 15} más`);
}

if (!EJECUTAR) {
    console.log('\n(simulación) Nada se ha tocado. Haz COPIA DE SEGURIDAD y re-ejecuta con --ejecutar para borrar.');
    process.exit(0);
}

if (!aBorrar.length) { console.log('\nNada que borrar.'); process.exit(0); }

const ids = aBorrar.map((a) => a._id);
let borrados = 0;
// En lotes de 500 (deleteMany por _id $in) para no montar un filtro gigante.
for (let i = 0; i < ids.length; i += 500) {
    const r = await autoresCol.deleteMany({ _id: { $in: ids.slice(i, i + 500) } });
    borrados += r.deletedCount;
}
console.log(`\n✅ Borrados ${borrados} autores huérfanos vacíos. Conservados: ${conObras} con obras + ${conInversion} con datos.`);
process.exit(0);
