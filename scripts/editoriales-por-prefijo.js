/**
 * EDITORIALES POR EL PREFIJO DEL ISBN — corrige la editorial de los libros que contradicen lo que la biblioteca ya
 * sabe del prefijo de su ISBN, y rellena la de los que no tienen.
 *
 * Por qué (30-sep): con 84-7702 (Valdemar) hay 142 libros de Valdemar… y también «SE», «ge», «Sexto Piso»,
 * «Rama Publishing Company», «I[nstituto] N[acional de la] J[uventud] M[exicana]»: editoriales que llegaron de APIs
 * por título, de otra edición, o basura de las fichas. El ISBN lleva dentro el código de la editorial; si casi todos
 * los libros de un prefijo son de una editorial, la rareza es un error.
 *
 * Reglas (src/utils/editorial-por-prefijo.js · editorialDominante):
 *   · prefijo = los 9 primeros dígitos del ISBN-13; mayoría clara = 3+ libros, ≥ 60 % y el triple que la segunda
 *     (sin contar maquetadores como ePubLibre ni nombres-ruido de 1-2 letras);
 *   · una editorial con 3+ libros en ese prefijo es plausible (un sello del grupo, una coedición) y se deja;
 *   · una VARIANTE del mismo nombre («Springer International Publishing» / «Springer») no se toca;
 *   · se CORRIGE (automático) solo si la actual está vacía, es un maquetador/distribuidor o es basura («SE», «ge»,
 *     «Unknown», «Other», «n/a»);
 *   · si además su COLECCIÓN dice lo mismo que el prefijo y no la que tiene el libro (1-oct: «En busca del gato de
 *     Schrödinger», ISBN 978-84-345 de Salvat, «Biblioteca Científica Salvat», tenía «Siglo XXI», leída por la visión
 *     en la cubierta), va a una selección APARTE, «Editorial a revisar — su colección coincide con el prefijo»: es
 *     la de más probabilidad de error y se revisa primero. Tampoco se cambia sola: en el ensayo, esa regla habría
 *     convertido sellos legítimos en su matriz (Routledge → Taylor & Francis, Clarendon → Oxford, A Bradford Book →
 *     MIT, Booket → Tusquets).
 *   · una editorial REAL distinta NUNCA se cambia sola: puede ser un SELLO del mismo grupo (Routledge/Taylor &
 *     Francis, Clarendon/Oxford, A Bradford Book/MIT, Garland/T&F — medido en el primer ensayo, 30-sep) o un error
 *     («Rama Publishing Company» o «Sexto Piso» en un Valdemar). Va a la selección «Editorial a revisar (prefijo
 *     ISBN)» para que lo decidas tú. Nunca se pierde un sello bueno.
 *   · no se tocan los libros con un ISBN sospechoso (isbn_sospechoso) ni los que comparten ISBN con OTRO título
 *     (ISBN falso compartido: los Osprey con 0140110925 habrían recibido «Penguin»);
 *   · cada cambio se anota en el diario `deshacer[]` (origen «editorial-prefijo») con la editorial anterior.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/editoriales-por-prefijo.js              (DRY-RUN: lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/editoriales-por-prefijo.js --ejecutar
 *   … --solo-vacias      solo rellenar libros SIN editorial (no corregir ninguna)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { editorialDominante, prefijoEditorialISBN, claveEditorial, esNombreRuido } from '../src/utils/editorial-por-prefijo.js';
import { esEditorialFalsa, limpiarNombreEditorial } from '../src/utils/editoriales-falsas.js';
import { mismoTituloLibro } from '../src/utils/titulo-libro.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { resolverEditorial as resolverEditorialComun } from '../src/utils/resolver-editorial.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const SOLO_VACIAS = process.argv.includes('--solo-vacias');

const db = await conectarDB();
const col = db.collection('biblioteca');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · editoriales contrastadas con el prefijo del ISBN${SOLO_VACIAS ? ' (solo las vacías)' : ''}\n`);

// ─── 1. Todo el catálogo con ISBN, en memoria (una sola pasada; luego todo es local) ─────────────────────────
const nombrePorId = new Map();
for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombrePorId.set(String(e._id), e.nombre);

const filtro = { tipo_recurso: 'libro', isbn: { $exists: true, $nin: [null, ''] } };
const libros = [];
const p1 = progreso(await col.countDocuments(filtro), 'Leyendo el catálogo');
for await (const d of col.find(filtro, { projection: { isbn: 1, editorial: 1, titulo: 1, isbn_sospechoso: 1, coleccion: 1, editorial_confirmada: 1 } })) {
    p1.paso();
    const prefijo = prefijoEditorialISBN(d.isbn);
    if (prefijo) libros.push({ ...d, prefijo, nombreEd: d.editorial ? nombrePorId.get(String(d.editorial)) || null : null });
}
p1.fin();

// ISBN compartidos por libros de títulos DISTINTOS: ISBN falso, no se opina sobre su editorial.
const porIsbn = new Map();
for (const l of libros) {
    const lista = porIsbn.get(l.isbn) || [];
    lista.push(l);
    porIsbn.set(l.isbn, lista);
}
const isbnFalso = new Set();
for (const [isbn, lista] of porIsbn) {
    if (lista.length > 1 && lista.some((x) => !mismoTituloLibro(x.titulo, lista[0].titulo))) isbnFalso.add(isbn);
}

// Editorial dominante de cada prefijo (sin contar los ISBN falsos).
const porPrefijo = new Map();
for (const l of libros) {
    if (isbnFalso.has(l.isbn)) continue;
    const lista = porPrefijo.get(l.prefijo) || [];
    lista.push(l.nombreEd);
    porPrefijo.set(l.prefijo, lista);
}
const dominante = new Map();
for (const [prefijo, nombres] of porPrefijo) {
    const d = editorialDominante(nombres);
    if (d) dominante.set(prefijo, d);
}
console.log(`\n${libros.length} libros con ISBN · ${porPrefijo.size} prefijos · ${dominante.size} con una editorial dominante · ${isbnFalso.size} ISBN compartidos por títulos distintos (se saltan)\n`);

// ¿Comparten alguna palabra propia? (variante del mismo nombre)
const palabras = (clave) => new Set(clave.split(' ').filter((w) => w.length >= 4 && !['press', 'publishing', 'publishers', 'books', 'group', 'university', 'libros'].includes(w)));
const variante = (a, b) => { const B = palabras(b); return [...palabras(a)].some((w) => B.has(w)); };

// Las editoriales de cada COLECCIÓN: la suya y las aprendidas de sus libros.
const editorialesDeColeccion = new Map();
for await (const c of db.collection('colecciones').find({}, { projection: { editorial: 1, editoriales_indicios: 1 } })) {
    const nombres = [c.editorial ? nombrePorId.get(String(c.editorial)) : null, ...(c.editoriales_indicios || []).map((i) => i.nombre)]
        .filter(Boolean).map(claveEditorial).filter(Boolean);
    if (nombres.length) editorialesDeColeccion.set(String(c._id), nombres);
}
// La colección CONFIRMA la del prefijo y DESMIENTE la actual: entre sus editoriales está la del prefijo y NO la que
// tiene el libro. (Si la actual también es de la colección —Routledge en «Routledge Library Editions», Clarendon en
// una serie de Oxford—, es un sello del grupo y no se toca: medido en el primer ensayo del 1-oct.)
const coleccionLoConfirma = (l, dom) => {
    const deLaColeccion = editorialesDeColeccion.get(String(l.coleccion)) || [];
    const actual = claveEditorial(l.nombreEd || '');
    const esDeLaColeccion = (clave) => deLaColeccion.some((c) => c === clave || variante(c, clave));
    return esDeLaColeccion(dom.clave) && !esDeLaColeccion(actual);
};

// ─── 2. Los que no cuadran ───────────────────────────────────────────────────────────────────────────────────
const cambios = [];
const aRevisar = [];
const aRevisarColeccion = [];   // otra editorial real, pero su colección dice lo mismo que el prefijo: más sospechosa
for (const l of libros) {
    if (l.isbn_sospechoso || isbnFalso.has(l.isbn)) continue;
    const dom = dominante.get(l.prefijo);
    if (!dom) continue;
    const vacia = !l.nombreEd || esEditorialFalsa(l.nombreEd);
    if (!vacia) {
        if (SOLO_VACIAS) continue;
        const clave = claveEditorial(l.nombreEd);
        if (clave === dom.clave) continue;                       // ya es esa (quizá con otra grafía)
        if ((dom.grupos[clave] || 0) >= 3) continue;             // plausible: sello o coedición con 3+ libros
        if (variante(clave, dom.clave)) continue;                // «Springer International» ~ «Springer»
        if (l.editorial_confirmada) continue;                    // la confirmaste tú en la ficha
        const ruido = esNombreRuido(l.nombreEd);
        // Otra editorial real (¿sello? ¿error?): tú decides… salvo que la colección del libro diga lo mismo que el prefijo.
        if (!ruido) { (coleccionLoConfirma(l, dom) ? aRevisarColeccion : aRevisar).push({ l, dom }); continue; }
    }
    cambios.push({ l, dom, vacia });
}

// Resumen por transición (lo más útil para revisar en seco).
const transiciones = new Map();
for (const c of cambios) {
    const k = `${c.vacia ? (c.l.nombreEd ? `(${c.l.nombreEd})` : '(vacía)') : c.l.nombreEd} → ${c.dom.nombre}`;
    transiciones.set(k, (transiciones.get(k) || 0) + 1);
}
console.log(`${cambios.length} libro(s) a ${EJECUTAR ? 'corregir' : 'corregir (en seco)'} · ${transiciones.size} transiciones distintas. Las más frecuentes:`);
for (const [k, n] of [...transiciones.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`  ${String(n).padStart(4)} · ${k}`);

const transRev = new Map();
for (const { l, dom } of aRevisar) transRev.set(`${l.nombreEd} ↔ ${dom.nombre}`, (transRev.get(`${l.nombreEd} ↔ ${dom.nombre}`) || 0) + 1);
console.log(`
${aRevisar.length} libro(s) con OTRA editorial real (sello del grupo o error): NO se cambian${EJECUTAR ? ', van a la selección «Editorial a revisar (prefijo ISBN)»' : ''}. Las más frecuentes:`);
for (const [k, n] of [...transRev.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(n).padStart(4)} · ${k}`);

// ─── 3. Aplicar ─────────────────────────────────────────────────────────────────────────────────────────────
let hechos = 0, fallos = 0;
if (EJECUTAR && cambios.length) {
    const idPorNombre = new Map();
    const resolver = async (nombre) => {
        const limpio = limpiarNombreEditorial(nombre);
        if (idPorNombre.has(limpio)) return idPorNombre.get(limpio);
        const id = await resolverEditorialComun(db, limpio);   // por nombre o grafía
        idPorNombre.set(limpio, id);
        return id;
    };
    const p3 = progreso(cambios.length, 'Corrigiendo');
    for (const { l, dom } of cambios) {
        p3.paso(l.titulo);
        try {
            const nuevaId = await resolver(dom.nombre);
            const ahora = new Date();
            await col.updateOne({ _id: l._id }, {
                $set: { editorial: nuevaId, fecha_actualizacion: ahora },
                $push: {
                    deshacer: { fecha: ahora, origen: 'editorial-prefijo', antes: { editorial: l.editorial ?? null } },
                    alertas_agente: `Editorial «${l.nombreEd || '∅'}» → «${dom.nombre}»: la del prefijo ${l.prefijo} del ISBN (${dom.libros} de ${dom.total} libros; scripts/editoriales-por-prefijo).`,
                },
            });
            const doc = await col.findOne({ _id: l._id });
            await regenerarSidecarsDoc(db, doc, carpetaDeDoc(doc)).catch(() => {});
            await indexarDoc(db, l._id).catch(() => {});
            hechos++;
        } catch (e) {
            fallos++;
            p3.nota(`⛔ ${l._id}: ${e.message}`);
        }
    }
    p3.fin();
}
console.log(`
${aRevisarColeccion.length} libro(s) más en los que su COLECCIÓN dice lo mismo que el prefijo y no la editorial que tienen: los más sospechosos${EJECUTAR ? ' → selección «Editorial a revisar — su colección coincide con el prefijo»' : ''}.`);

/** Crea la selección o, si ya existe una de una pasada anterior, la ACTUALIZA (el 30-sep quedaron duplicadas). */
async function guardarSeleccion(prefijoNombre, descripcion, ids) {
    const { crearSeleccion, reemplazarDocs, editarSeleccion } = await import('../src/utils/selecciones.js');
    const nombre = `${prefijoNombre} ${new Date().toISOString().slice(0, 10)}`;
    const escapado = prefijoNombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const previa = await db.collection('selecciones').findOne({ nombre: new RegExp(`^${escapado}`) }, { sort: { fecha_creacion: -1 } });
    if (previa) {
        await reemplazarDocs(db, previa._id, ids);
        await editarSeleccion(db, previa._id, { nombre });
    } else {
        await crearSeleccion(db, { nombre, descripcion, docs: ids });
    }
}
if (EJECUTAR && aRevisarColeccion.length) {
    await guardarSeleccion('Editorial a revisar — su colección coincide con el prefijo',
        'Su editorial no es la del prefijo de su ISBN, y su colección dice lo mismo que el prefijo: lo más probable es que la editorial esté mal (o sea un sello del grupo). Revísalos primero.',
        aRevisarColeccion.map(({ l }) => l._id));
}
if (EJECUTAR && aRevisar.length) {
    await guardarSeleccion('Editorial a revisar (prefijo ISBN)',
        'Libros cuya editorial no es la dominante del prefijo de su ISBN, pero es una editorial real conocida en ese país: puede ser un sello del mismo grupo (bien) o un error. scripts/editoriales-por-prefijo.js no los cambia.',
        aRevisar.map(({ l }) => l._id));
    console.log(`
Selección creada con ${aRevisar.length} libro(s) para revisar.`);
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${hechos} corregidos · ${fallos} fallos` : 'DRY-RUN: no se ha cambiado nada. Repite con --ejecutar.'} ===\n`);
process.exit(fallos ? 1 : 0);
