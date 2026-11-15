#!/usr/bin/env node
/**
 * REVISAR LIBROS HTML — vuelve a pasar el detector (src/utils/libro-html.js·esLibroHtml, corregido el 15-nov) por
 * cada ficha `naturaleza:'libro-html'`.
 *
 * Incidente: lo que quedó de «Medical/Combat Medical» (una página .html suelta, dos .txt, dos instaladores .exe y la
 * carpeta del libro HTML «Scuba Diving Explained») se catalogó como UN libro HTML, con el título de la página suelta
 * («Antibiotic Use in the Austere Environment, Part 2») y la portada del libro de buceo. El detector tomaba la única
 * página de la raíz como entrada y contaba como suyas las páginas del libro de la subcarpeta.
 *
 * Por cada ficha:
 *   · su carpeta YA NO es un libro HTML (es un contenedor) → se borra la ficha (y sale de sus selecciones y de su
 *     colección), sus registro.json/.marc.xml van a la Papelera y la carpeta entera vuelve a PreProceso, que la
 *     inspecciona con IA y pasa al Inbox cada libro de verdad que haya dentro. No se borra ni se recicla nada más.
 *   · sigue siendo un libro pero su título es un artefacto («contents.htm», «Index of /…») → se lista para corregirlo
 *     a mano con ✏️ Editar (la ingesta ya no los pone: parsear-nombre·esTituloArtefacto).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/revisar-libros-html.js              (en seco: la lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/revisar-libros-html.js --ejecutar
 *   … --id <id>,<id>      solo esas fichas
 *
 * ⚠ Borra fichas y mueve carpetas: con copia de la base antes (scripts/copia-base.js).
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { esLibroHtml } from '../src/utils/libro-html.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';
import { otroDocEnCarpeta } from '../src/utils/carpeta-en-uso.js';
import { borrarFicha, devolverCarpeta } from '../src/utils/retirar-material.js';
import { reciclar } from '../src/utils/papelera.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · revisar los libros HTML con el detector corregido\n`);

const filtro = { naturaleza: 'libro-html', ...(IDS.length ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } } : {}) };
const fichas = await bib.find(filtro, { projection: { titulo: 1, ruta_base: 1, coleccion: 1, html: 1 } }).toArray();
console.log(`${fichas.length} libro(s) HTML.\n`);

// 1) Decidir (solo lee).
const noSonLibro = [], tituloBasura = [], sinCarpeta = [];
const p1 = progreso(fichas.length, 'Revisando');
for (const doc of fichas) {
    const carpeta = carpetaDeDoc(doc);
    if (!(await fs.access(carpeta).then(() => true, () => false))) sinCarpeta.push(doc);
    else if (!(await esLibroHtml(carpeta))) noSonLibro.push({ doc, carpeta });
    else if (esTituloArtefacto(doc.titulo)) tituloBasura.push(doc);
    p1.paso(doc.titulo);
}
p1.fin();

console.log(`\n· NO son un libro (contenedores): ${noSonLibro.length} → ficha borrada, carpeta de vuelta a PreProceso`);
for (const { doc, carpeta } of noSonLibro) console.log(`    ${doc._id}  «${doc.titulo}»\n        ${carpeta} → ${path.join(DIR_PRE, path.basename(carpeta))}`);
console.log(`\n· Libros con título basura (corrígelo con ✏️ Editar): ${tituloBasura.length}`);
for (const doc of tituloBasura) console.log(`    ${doc._id}  «${doc.titulo}»  (${doc.ruta_base})`);
if (sinCarpeta.length) {
    console.log(`\n· Sin carpeta en disco (no se tocan): ${sinCarpeta.length}`);
    for (const doc of sinCarpeta) console.log(`    ${doc._id}  «${doc.titulo}»  (${doc.ruta_base})`);
}

if (!EJECUTAR) {
    console.log('\n(En seco: no se ha tocado nada. Repite con --ejecutar, tras una copia de la base.)');
    process.exit(0);
}

// 2) Aplicar: cada contenedor, solo si nadie más vive en su carpeta.
let devueltas = 0, quedan = 0, fallos = 0;
const p2 = progreso(noSonLibro.length, 'Devolviendo');
for (const { doc, carpeta } of noSonLibro) {
    p2.paso(doc.titulo);
    const otro = await otroDocEnCarpeta(db, doc.ruta_base, [doc._id]);
    if (otro) { quedan++; p2.nota(`se queda: en su carpeta vive también «${otro.titulo}»`); continue; }
    try {
        // Los sidecars describen la ficha que se borra, y .ruta_fija marca su sitio en el CDU: a la Papelera
        // (recuperables), no viajan con la carpeta.
        await reciclar(['registro.json', 'registro.marc.xml', '.ruta_fija'].map((n) => path.join(carpeta, n)), `libro-html-retirado-${String(doc._id).slice(-6)}`);
        const destino = await devolverCarpeta(carpeta, path.join(DIR_PRE, path.basename(carpeta)));
        await borrarFicha(db, doc);
        devueltas++;
        p2.nota(`✓ «${doc.titulo}» → ${destino}`);
    } catch (e) {
        fallos++;
        p2.nota(`✗ «${doc.titulo}»: ${e.message} (la ficha y la carpeta se quedan como estaban)`);
    }
}
p2.fin();
console.log(`\n✅ ${devueltas} carpeta(s) de vuelta a PreProceso${quedan ? ` · ${quedan} se quedan (otro documento)` : ''}${fallos ? ` · ${fallos} con error` : ''}.`);
console.log(`   Libros HTML que quedan: ${await bib.countDocuments({ naturaleza: 'libro-html' })}.`);
process.exit(0);
