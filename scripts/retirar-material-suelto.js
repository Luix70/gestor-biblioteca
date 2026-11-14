#!/usr/bin/env node
/**
 * RETIRAR MATERIAL SUELTO — las fichas «Libro, material» que no cuelgan de ningún libro (regla del usuario, 14-nov:
 * son ruido). Motor y criterio: src/utils/retirar-material.js. La ingesta ya no las crea.
 *
 * Por cada ficha `naturaleza:'material'`:
 *   · sus ficheros siguen en la carpeta de un documento de verdad (su colección, una carpeta compartida) → se borra
 *     solo la ficha; el fichero no se mueve;
 *   · si no → se borra la ficha y su carpeta vuelve a `PreProceso/_Material sin libro/<ruta que tenía en el CDU>`.
 * Además: fuera de sus selecciones y de su colección (la colección se borra si queda vacía) y del índice de búsqueda.
 * No se recicla ni se borra ningún fichero.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/retirar-material-suelto.js              (en seco: la lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/retirar-material-suelto.js --ejecutar
 *   … --id <id>,<id>      solo esas fichas
 *
 * ⚠ Borra fichas y mueve carpetas: en el NAS, con copia de la base antes (scripts/copia-base.js).
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { otroDocEnCarpeta } from '../src/utils/carpeta-en-uso.js';
import { planRetirada, borrarFicha, devolverCarpeta, CARPETA_MATERIAL_SIN_LIBRO } from '../src/utils/retirar-material.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · retirar fichas de material sin libro\n`);

const filtro = { naturaleza: 'material', ...(IDS.length ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } } : {}) };
const fichas = await bib.find(filtro, { projection: { titulo: 1, ruta_base: 1, nombre_archivo: 1, coleccion: 1, cdu: 1 } }).toArray();
const ids = fichas.map((d) => d._id);
console.log(`${fichas.length} ficha(s) de material.\n`);

// 1) Decidir (no escribe nada).
const planes = [];
const p1 = progreso(fichas.length, 'Decidiendo');
for (const doc of fichas) {
    planes.push({ doc, plan: await planRetirada(db, doc, ids) });
    p1.paso(doc.titulo);
}
p1.fin();

const quitar = planes.filter((x) => x.plan.accion === 'quitar-ficha');
const devolver = planes.filter((x) => x.plan.accion === 'devolver');
console.log(`\n· Solo se borra la ficha (el fichero sigue con su documento): ${quitar.length}`);
for (const { doc, plan } of quitar) console.log(`    ${doc._id}  «${doc.titulo}»${doc.nombre_archivo ? ` (${doc.nombre_archivo})` : ''} — ${plan.motivo}`);
console.log(`\n· Ficha borrada y carpeta de vuelta a PreProceso/${CARPETA_MATERIAL_SIN_LIBRO}: ${devolver.length}`);
for (const { doc, plan } of devolver) console.log(`    ${doc._id}  «${doc.titulo}» → ${plan.destino}`);

if (!EJECUTAR) {
    console.log('\n(En seco: no se ha tocado nada. Repite con --ejecutar, tras una copia de la base.)');
    process.exit(0);
}

// 2) Aplicar: primero todas las fichas; luego cada carpeta, una vez, si ya nadie vive en ella.
const p2 = progreso(planes.length, 'Borrando fichas');
for (const { doc } of planes) {
    await borrarFicha(db, doc);
    p2.paso(doc.titulo);
}
p2.fin();

// Una carpeta que está DENTRO de otra que también vuelve viaja con ella (si se moviera antes la de dentro, la de fuera
// acabaría en «… (2)»): de la más corta a la más larga, y fuera las que cuelgan de una ya apuntada.
const carpetas = new Map();   // carpeta → { destino, ruta_base }
const porLongitud = [...devolver].sort((a, b) => a.plan.carpeta.length - b.plan.carpeta.length);
for (const { doc, plan } of porLongitud) {
    const yaVa = [...carpetas.keys()].some((c) => plan.carpeta === c || plan.carpeta.startsWith(c + path.sep));
    if (!yaVa) carpetas.set(plan.carpeta, { destino: plan.destino, rutaBase: doc.ruta_base });
}
let devueltas = 0, faltan = 0, ocupadas = 0, fallos = 0;
const p3 = progreso(carpetas.size, 'Devolviendo carpetas');
for (const [carpeta, { destino, rutaBase }] of carpetas) {
    p3.paso(rutaBase);
    if (!(await fs.access(carpeta).then(() => true).catch(() => false))) { faltan++; continue; }
    // Comprobación final: alguien pudo llegar a esta carpeta entre tanto. Entonces se queda.
    if (await otroDocEnCarpeta(db, rutaBase, [])) { ocupadas++; p3.nota(`se queda (otro documento vive en ella): ${rutaBase}`); continue; }
    try {
        await devolverCarpeta(carpeta, destino);
        devueltas++;
    } catch (e) {
        fallos++;
        p3.nota(`✗ ${rutaBase}: ${e.message}`);
    }
}
p3.fin();

const quedan = await bib.countDocuments(filtro);
console.log(`\n✅ ${planes.length} ficha(s) borradas · ${devueltas} carpeta(s) devueltas a PreProceso`
    + `${faltan ? ` · ${faltan} ya no estaban en disco` : ''}${ocupadas ? ` · ${ocupadas} se quedan (otro documento)` : ''}`
    + `${fallos ? ` · ${fallos} con error (se quedan donde estaban)` : ''}.`);
console.log(`   Fichas de material que quedan: ${quedan} (debería ser 0).`);
process.exit(0);
