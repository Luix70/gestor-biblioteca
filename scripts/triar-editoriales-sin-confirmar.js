/**
 * TRIAR LA SELECCIÓN «Editorial sin confirmar» — resuelve sola la parte que tiene respaldo, para que la revisión a
 * mano se quede en lo que de verdad la necesita.
 *
 * Esa selección (la crea la fase 10 de reparar-tras-reidentificacion) reúne libros SIN ISBN cuya editorial sustituyó
 * a la de un maquetador (ePubLibre…): casi siempre la leyó la visión en la cubierta. Muchas veces acierta (la cubierta
 * de ePubLibre suele reproducir la de la edición original, con su logotipo), pero nada la confirmaba. Aquí:
 *
 *   · QUITAR  — la «editorial» es un maquetador o un nombre-ruido (Lectulandia, «ge»…): se quita (mejor sin editorial
 *               que una falsa). Va al diario `deshacer[]`.
 *   · CONFIRMAR por la COLECCIÓN — al menos 2 libros más de su colección tienen esa misma editorial y son la mitad o
 *               más de los que la tienen. (Si su colección dice OTRA, NO se cambia nada: el libro puede estar mal
 *               asignado a la colección, y hay colecciones revueltas; esos se quedan para revisar.)
 *   · CONFIRMAR por el AUTOR — otro libro del mismo autor, CON ISBN, es de esa editorial.
 *
 * Lo confirmado se marca `editorial_confirmada` y sale de las selecciones de revisión (utils/confirmar-editorial.js,
 * lo mismo que hace el botón «✅ Confirmar editorial» del panel). El resto se queda en la selección para revisarlo
 * en Búsqueda ordenando por «Editorial» (ver instructions.txt).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/triar-editoriales-sin-confirmar.js             (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/triar-editoriales-sin-confirmar.js --ejecutar
 *   … --seleccion "<nombre>"   otra selección (por defecto, la que empieza por «Editorial sin confirmar»)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { esEditorialFalsa } from '../src/utils/editoriales-falsas.js';
import { esNombreRuido } from '../src/utils/editorial-por-prefijo.js';
import { confirmarEditorial } from '../src/utils/confirmar-editorial.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const NOMBRE_SELECCION = arg('--seleccion');

const db = await conectarDB();
const col = db.collection('biblioteca');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · triar las editoriales sin confirmar\n`);

const seleccion = await db.collection('selecciones').findOne(
    NOMBRE_SELECCION ? { nombre: NOMBRE_SELECCION } : { nombre: /^Editorial sin confirmar/ },
);
if (!seleccion) {
    console.log('No encuentro la selección.');
    process.exit(1);
}
console.log(`Selección «${seleccion.nombre}»: ${(seleccion.docs || []).length} documentos.\n`);

const nombrePorId = new Map();
for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombrePorId.set(String(e._id), e.nombre);

// Nombre comparable: sin acentos, mayúsculas ni las palabras de relleno («Ediciones», «Editorial», «S.A.»…), para
// que «Siglo XXI Editores» y «Siglo XXI de España Editores» o «Ediciones Destino» y «Destino» cuenten como iguales.
const comparable = (nombre) => String(nombre || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(ediciones|edicions|editorial|editores|editors|s\.?\s?a\.?|s\.?\s?l\.?|de espana|libros)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

const docs = await col.find(
    { _id: { $in: seleccion.docs || [] } },
    { projection: { titulo: 1, editorial: 1, coleccion: 1, autores: 1, editorial_confirmada: 1 } },
).toArray();

const quitar = [];                 // { doc, nombre }
const porColeccion = [];           // { doc, nombre, n }
const porAutor = [];               // { doc, nombre }
let yaConfirmados = 0;
let sinEditorial = 0;

const p = progreso(docs.length, 'Triando');
for (const doc of docs) {
    p.paso(doc.titulo);
    if (doc.editorial_confirmada) { yaConfirmados++; continue; }
    const nombre = nombrePorId.get(String(doc.editorial));
    if (!doc.editorial || !nombre) { sinEditorial++; continue; }

    if (esEditorialFalsa(nombre) || esNombreRuido(nombre)) {
        quitar.push({ doc, nombre });
        continue;
    }
    const clave = comparable(nombre);

    // ¿La respalda su colección? (los demás libros de la colección con editorial)
    if (doc.coleccion) {
        const otros = await col.find(
            { coleccion: doc.coleccion, _id: { $ne: doc._id }, editorial: { $ne: null } },
            { projection: { editorial: 1 } },
        ).toArray();
        const iguales = otros.filter((o) => comparable(nombrePorId.get(String(o.editorial))) === clave).length;
        if (iguales >= 2 && iguales / otros.length >= 0.5) {
            porColeccion.push({ doc, nombre, n: iguales });
            continue;
        }
    }

    // ¿La respalda otro libro del mismo autor que SÍ tiene ISBN?
    if (doc.autores?.length) {
        const otros = await col.find(
            { autores: { $in: doc.autores }, _id: { $ne: doc._id }, isbn: { $nin: [null, ''] }, editorial: { $ne: null } },
            { projection: { editorial: 1 } },
        ).toArray();
        if (otros.some((o) => comparable(nombrePorId.get(String(o.editorial))) === clave)) {
            porAutor.push({ doc, nombre });
            continue;
        }
    }
}
p.fin();

const recorta = (t) => String(t || '').slice(0, 60);
console.log(`\nQUITAR (no es una editorial): ${quitar.length}`);
for (const { doc, nombre } of quitar) console.log(`  ${doc._id} · «${nombre}» · ${recorta(doc.titulo)}`);
console.log(`\nCONFIRMAR por la colección: ${porColeccion.length}`);
for (const { doc, nombre, n } of porColeccion.slice(0, 40)) console.log(`  ${doc._id} · «${nombre}» (+${n} en su colección) · ${recorta(doc.titulo)}`);
console.log(`\nCONFIRMAR por el autor: ${porAutor.length}`);
for (const { doc, nombre } of porAutor.slice(0, 40)) console.log(`  ${doc._id} · «${nombre}» · ${recorta(doc.titulo)}`);

const resto = docs.length - quitar.length - porColeccion.length - porAutor.length - yaConfirmados - sinEditorial;

if (EJECUTAR) {
    const pq = progreso(quitar.length, 'Quitando editoriales falsas');
    for (const { doc, nombre } of quitar) {
        pq.paso(doc.titulo);
        await col.updateOne({ _id: doc._id }, {
            $unset: { editorial: '' },
            $set: { fecha_actualizacion: new Date() },
            $push: {
                deshacer: { fecha: new Date(), origen: 'triar-editoriales-sin-confirmar', antes: { editorial: doc.editorial } },
                alertas_agente: `Editorial «${nombre}» quitada: es un maquetador o un nombre-ruido, no una editorial (scripts/triar-editoriales-sin-confirmar).`,
            },
        });
    }
    pq.fin();
    // Sin editorial ya no hay nada que confirmar: fuera de la selección.
    if (quitar.length) {
        await db.collection('selecciones').updateOne(
            { _id: seleccion._id },
            { $pull: { docs: { $in: quitar.map((q) => q.doc._id) } }, $set: { fecha_actualizacion: new Date() } },
        );
    }
    const r1 = await confirmarEditorial(db, porColeccion.map((x) => x.doc._id), { motivo: 'la tienen también otros libros de su colección (scripts/triar-editoriales-sin-confirmar).' });
    const r2 = await confirmarEditorial(db, porAutor.map((x) => x.doc._id), { motivo: 'otro libro del mismo autor, con ISBN, es de esa editorial (scripts/triar-editoriales-sin-confirmar).' });
    console.log(`\nConfirmadas ${r1.n + r2.n}; quitadas ${quitar.length}.`);
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${quitar.length} a quitar · ${porColeccion.length + porAutor.length} a confirmar · ${resto} para revisar a mano`
    + `${yaConfirmados ? ` · ${yaConfirmados} ya confirmados` : ''}${sinEditorial ? ` · ${sinEditorial} sin editorial` : ''} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar.');
process.exit(0);
