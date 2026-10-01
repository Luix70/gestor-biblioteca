/**
 * EDITORIAL DE LAS COLECCIONES — pone como editorial de cada colección la de la MAYORÍA de sus libros, cuando la que
 * tiene apuntada es otra, falta o apunta a una editorial que ya no existe.
 *
 * Por qué (1-oct): 58 colecciones decían una editorial que no es la de sus libros — «Biblioteca Clásica Gredos» →
 * RBA (245 de sus 292 libros son de Gredos), «Valdemar: El Club Diógenes» → Gredos, «Solaris Ficción» → Ediciones B
 * (sus libros, de La Factoría de Ideas), «Tus Libros Anaya» → una editorial borrada. Esa editorial se usa como PISTA
 * al identificar ediciones y al corregir editoriales, así que un error aquí se contagia.
 *
 * UN LIBRO PUEDE ESTAR MAL ASIGNADO A UNA COLECCIÓN (advertencia del usuario): por eso se exige una mayoría clara
 * —5 libros o más con la misma editorial y al menos el 60 % de los que la tienen—, de modo que unos pocos libros
 * mal metidos no deciden; si la que tiene apuntada es también la de 3+ de sus libros (un sello, una coedición), se
 * respeta; las cabeceras de revista no se tocan (su editorial cambia con los años). No se cuentan los maquetadores (ePubLibre…) ni los nombres-ruido de 1-2 letras. Y el
 * cambio es SOLO en la ficha de la colección: no se toca la editorial de ningún libro (los que no son de la mayoría
 * pueden ser justo los mal asignados; para ellos está la selección de editoriales a revisar).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/editorial-de-colecciones.js              (en seco: la lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/editorial-de-colecciones.js --ejecutar
 *   … --excluir <id>,<id>    colecciones que no se deben tocar (las que hayas puesto tú a propósito)
 *
 * SEGUNDA PARTE — LOS LIBROS (1-oct, a petición del usuario: «hay muchos libros de Biblioteca Clásica Gredos que
 * están asignados a RBA»). Dentro de una colección con editorial mayoritaria X, un libro cuyo ISBN es del MISMO
 * registrante que los libros de X (su prefijo, p. ej. 978-84-249 de Gredos) pero lleva otra editorial toma X: lo
 * dicen a la vez su colección y su ISBN. El prefijo dominante de X se calcula con sus propios libros de la colección
 * (5+ y 60 %+). Un libro MAL ASIGNADO a la colección no se toca, porque su ISBN es de otro registrante. No se tocan
 * los ISBN provisionales, dudosos o sospechosos, ni las editoriales que hayas confirmado. Se aplica ANTES que la
 * primera parte, así la editorial de la colección se decide con los libros ya corregidos.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { esEditorialFalsa } from '../src/utils/editoriales-falsas.js';
import { esNombreRuido } from '../src/utils/editorial-por-prefijo.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const EXCLUIR = new Set(String(arg('--excluir') || '').split(',').map((s) => s.trim()).filter(Boolean));
const MIN_LIBROS = 5;
const MAYORIA = 0.6;

const db = await conectarDB();
const col = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · editorial de las colecciones según la de sus libros\n`);

const nombrePorId = new Map();
for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombrePorId.set(String(e._id), e.nombre);

// Editoriales de los libros de cada colección (una sola pasada por la biblioteca).
const porColeccion = new Map();
const p1 = progreso(await col.countDocuments({ coleccion: { $ne: null }, editorial: { $ne: null } }), 'Leyendo los libros');
const librosDe = new Map();   // colección → sus libros (para la segunda parte)
for await (const d of col.find({ coleccion: { $ne: null }, editorial: { $ne: null } }, { projection: { coleccion: 1, editorial: 1, isbn: 1, titulo: 1, isbn_provisional: 1, isbn_dudoso: 1, isbn_sospechoso: 1, editorial_confirmada: 1 } })) {
    p1.paso();
    if (!librosDe.has(String(d.coleccion))) librosDe.set(String(d.coleccion), []);
    librosDe.get(String(d.coleccion)).push(d);
    const nombre = nombrePorId.get(String(d.editorial));
    if (!nombre || esEditorialFalsa(nombre) || esNombreRuido(nombre)) continue;
    const clave = String(d.coleccion);
    if (!porColeccion.has(clave)) porColeccion.set(clave, new Map());
    const cuenta = porColeccion.get(clave);
    cuenta.set(String(d.editorial), (cuenta.get(String(d.editorial)) || 0) + 1);
}
p1.fin();

// ─── SEGUNDA PARTE (va primero): los libros cuyo ISBN y cuya colección dicen la misma editorial ─────────────
const prefijo8 = (isbn) => {
    const c = String(isbn || '').replace(/[^0-9Xx]/g, '');
    const c13 = c.length === 10 ? `978${c}` : c;
    return c13.length === 13 ? c13.slice(0, 8) : null;   // 978 + grupo + comienzo del registrante (978-84-249…)
};
const cambiosLibros = [];
const tiposDeColeccion = new Map((await colCol.find({}, { projection: { tipo: 1 } }).toArray()).map((c) => [String(c._id), c.tipo]));
for (const [idCol, cuenta] of porColeccion) {
    if (EXCLUIR.has(idCol) || tiposDeColeccion.get(idCol) === 'revista') continue;
    const total = [...cuenta.values()].reduce((s, n) => s + n, 0);
    const [idX, nX] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];
    if (nX < MIN_LIBROS || nX / total < MAYORIA) continue;
    const libros = librosDe.get(idCol) || [];
    // El prefijo de los libros de X en esta colección.
    const prefijos = new Map();
    for (const l of libros) if (String(l.editorial) === idX && prefijo8(l.isbn)) prefijos.set(prefijo8(l.isbn), (prefijos.get(prefijo8(l.isbn)) || 0) + 1);
    const conIsbn = [...prefijos.values()].reduce((s, n) => s + n, 0);
    const [prefX, nPref] = [...prefijos.entries()].sort((a, b) => b[1] - a[1])[0] || [];
    if (!prefX || nPref < MIN_LIBROS || nPref / conIsbn < MAYORIA) continue;
    for (const l of libros) {
        if (String(l.editorial) === idX || prefijo8(l.isbn) !== prefX) continue;
        if (l.isbn_provisional || l.isbn_dudoso || l.isbn_sospechoso || l.editorial_confirmada) continue;
        cambiosLibros.push({ l, idX, idCol, prefX });
        // La cuenta de la colección, ya corregida (para la primera parte).
        if (cuenta.has(String(l.editorial))) cuenta.set(String(l.editorial), cuenta.get(String(l.editorial)) - 1);
        cuenta.set(idX, (cuenta.get(idX) || 0) + 1);
    }
}
const transLibros = new Map();
for (const { l, idX } of cambiosLibros) {
    const k = `${nombrePorId.get(String(l.editorial)) || '(ninguna)'} → ${nombrePorId.get(idX)}`;
    transLibros.set(k, (transLibros.get(k) || 0) + 1);
}
console.log(`LIBROS cuya colección y cuyo ISBN dicen otra editorial: ${cambiosLibros.length}. Por transición:`);
for (const [k, n] of [...transLibros].sort((a, b) => b[1] - a[1]).slice(0, 60)) console.log(`  ${String(n).padStart(4)} · ${k}`);
if (EJECUTAR && cambiosLibros.length) {
    const { ObjectId } = await import('mongodb');
    const { regenerarSidecarsDoc } = await import('../src/utils/registro.js');
    const { carpetaDeDoc } = await import('../src/mantenimiento/util-mantenimiento.js');
    const { indexarDoc } = await import('../src/utils/indice-busqueda.js');
    const pl = progreso(cambiosLibros.length, 'Corrigiendo libros');
    for (const { l, idX, prefX } of cambiosLibros) {
        pl.paso(l.titulo);
        const ahora = new Date();
        await col.updateOne({ _id: l._id }, {
            $set: { editorial: new ObjectId(idX), fecha_actualizacion: ahora },
            $push: {
                deshacer: { fecha: ahora, origen: 'editorial-de-colecciones', antes: { editorial: l.editorial ?? null } },
                alertas_agente: `Editorial «${nombrePorId.get(String(l.editorial)) || '∅'}» → «${nombrePorId.get(idX)}»: la de su colección y la del registrante de su ISBN (${prefX}…) (scripts/editorial-de-colecciones).`,
            },
        });
        const doc = await col.findOne({ _id: l._id });
        await regenerarSidecarsDoc(db, doc, carpetaDeDoc(doc)).catch(() => {});
        await indexarDoc(db, l._id).catch(() => {});
    }
    pl.fin();
}

// ─── PRIMERA PARTE: la editorial de la colección ───────────────────────────────────────────────────────────
console.log('\nCOLECCIONES:');
const cambios = [];
const p2 = progreso(await colCol.countDocuments({}), 'Revisando colecciones');
for await (const c of colCol.find({}, { projection: { nombre: 1, editorial: 1, tipo: 1 } })) {
    p2.paso(c.nombre);
    if (EXCLUIR.has(String(c._id))) continue;
    // Las cabeceras de REVISTA no: su editorial cambia con los años (Muy Historia: Zinet, antes Zeta) y una edición
    // nacional no es la matriz (National Geographic España no es la National Geographic Society).
    if (c.tipo === 'revista') continue;
    const cuenta = porColeccion.get(String(c._id));
    if (!cuenta) continue;
    const total = [...cuenta.values()].reduce((s, n) => s + n, 0);
    const [idMayoria, n] = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n < MIN_LIBROS || n / total < MAYORIA) continue;
    if (c.editorial && String(c.editorial) === idMayoria) continue;
    // La que tiene apuntada también es la de 3+ libros de la colección: es un sello o una coedición plausible
    // («Thinking in Action»: Routledge y Taylor & Francis). No se cambia.
    if (c.editorial && (cuenta.get(String(c.editorial)) || 0) >= 3) continue;
    const actual = c.editorial ? (nombrePorId.get(String(c.editorial)) || '(editorial borrada)') : '(ninguna)';
    cambios.push({ c, idMayoria, n, total, actual });
}
p2.fin();

for (const { c, idMayoria, n, total, actual } of cambios) {
    console.log(`  «${c.nombre}»: ${actual} → ${nombrePorId.get(idMayoria)} (${n} de ${total} libros)  [${c._id}]`);
}

if (EJECUTAR) {
    const { ObjectId } = await import('mongodb');
    const p3 = progreso(cambios.length, 'Corrigiendo');
    for (const { c, idMayoria, n, total, actual } of cambios) {
        p3.paso(c.nombre);
        await colCol.updateOne({ _id: c._id }, {
            $set: { editorial: new ObjectId(idMayoria), fecha_actualizacion: new Date() },
            $push: {
                deshacer: { fecha: new Date(), origen: 'editorial-de-colecciones', antes: { editorial: c.editorial ?? null } },
                alertas_agente: `Editorial de la colección «${actual}» → «${nombrePorId.get(idMayoria)}»: la de ${n} de sus ${total} libros (scripts/editorial-de-colecciones).`,
            },
        });
    }
    p3.fin();
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${cambiosLibros.length} libro(s) y ${cambios.length} colección(es) ${EJECUTAR ? 'corregidos' : 'que se corregirían'} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar (y --excluir <id>,… para dejar alguna como está).');
process.exit(0);
