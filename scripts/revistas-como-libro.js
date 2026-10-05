/**
 * REVISTAS CATALOGADAS COMO LIBRO — las pasa a revista, con su cabecera, su fecha y su número.
 *
 * Por qué (5-oct, a petición del usuario; el caso inverso de scripts/libros-como-revista.js): números de revista que
 * entraron como LIBRO porque un catálogo de libros les atribuyó el ISBN —y con él el título, los autores, la sinopsis
 * y la editorial— de un libro parecido: «2023-01-01 Watercolor Artist.pdf» se llama «Painting Beautiful Watercolor
 * Landscapes», «2021 07 01 Family Crosswords.pdf» se llama «The Family Crossword Book». Con un ISBN, la ingesta los
 * daba por libros. Medido el 5-oct: ~110 con fecha o número claros en el nombre y 67 más dentro de una cabecera sin
 * más señales.
 *
 * CANDIDATOS (documentos tipados como libro):
 *   · PASAN A REVISTA solos, si el nombre del fichero lo dice claro y no empieza por un ISBN:
 *       – fecha delante «2021 07 01 Crochet Now.pdf» · fecha al final «Beautiful Kitchens 2010-09.pdf»,
 *         «BBCKnowledge201506.pdf», «Men's Health 2009-11 US.pdf» · mes y año pegados «UltraRunningMay2014.pdf» ·
 *         número de revista «Issue 3», «Vol 7 Issue 3», «Isaac Asimov Magazine 5»;
 *     y no hay señal de libro (editorial de solo libros —Apress, O'Reilly…—, serie académica, «2nd edition»).
 *   · A REVISAR (selección «¿Revista catalogada como libro?»): dentro de la cabecera de una revista pero sin esas
 *     señales («Introduction to Linear Logic» es un libro mal metido; «BBCKnowledgeAsiaVol7Issue3», un número), y los
 *     cómics (álbum o número: lo decide una persona).
 *
 * QUÉ SE HACE con cada número (con --ejecutar; dry-run por defecto):
 *   1. tipo revista, con año / mes / nº sacados del nombre y su clave de número (AAAA-MM → nNNN → AAAA);
 *   2. su CABECERA: la revista en la que ya estuviera, o la que se llame como el nombre del fichero sin la fecha
 *      (se crea si no existe); entra en su inventario de números; toma su ISSN si lo tiene;
 *   3. fuera lo que le puso el catálogo de libros: ISBN, autores, contribuciones, Dewey/LCC, ediciones candidatas;
 *      el título pasa a ser el compuesto («Watercolor Artist (enero 2023)»). La sinopsis, la editorial y las palabras
 *      clave las juzga después `sanear-numeros-revista.js --contaminadas` (conserva lo que es de la revista);
 *   4. la carpeta, de libros/ a revistas/ (recolocarSegunCdu); sidecars e índice al día.
 * Todo con diario `deshacer[]` (origen «revistas-como-libro») y selección «Pasadas de libro a revista». Mueve carpetas:
 * correr en el NAS, con copia de la base antes.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/revistas-como-libro.js                 (en seco: la lista)
 *   sudo docker exec -it gestor-biblioteca node scripts/revistas-como-libro.js --ejecutar --limite 5
 *   sudo docker exec -it gestor-biblioteca node scripts/revistas-como-libro.js --ejecutar
 *   sudo docker exec -it gestor-biblioteca node scripts/sanear-numeros-revista.js --contaminadas [--ejecutar]
 *   … --id <id>,<id>    solo esos documentos (los pasa aunque no sean candidatos automáticos)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { validarISBN } from '../src/utils/identificadores.js';
import { parsearNombre } from '../src/utils/parsear-nombre.js';
import { claveNumero, tituloCabecera, tituloDeNumero, pareceSerieLibros, esEditorialDeLibros, capitalizarCabecera } from '../src/utils/revistas.js';
import { resolverCabecera, registrarNumeroEnColeccion } from '../src/utils/colecciones.js';
import { recolocarSegunCdu, carpetaDeDoc, aplicarCambio } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { cabeceraDeNombreDeFichero } from '../src/utils/cabecera-de-fichero.js';
import { datosDelNombre, clasificarPorNombre } from '../src/utils/revista-por-nombre.js';
import { mismaSerie } from '../src/utils/serie-autoridad.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = Number(arg('--limite')) || 0;
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));
const ORIGEN = 'revistas-como-libro';

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · revistas catalogadas como libro\n`);

// La lectura del nombre (fecha, número, cabecera) y la decisión viven en utils/revista-por-nombre.js: la ingesta
// aplica el mismo criterio.
const clasificar = clasificarPorNombre;
const cabeceraDelNombre = cabeceraDeNombreDeFichero;

// ─── Candidatos ──────────────────────────────────────────────────────────────────────────────────────────
const colecciones = new Map((await colCol.find({}, { projection: { nombre: 1, tipo: 1, issn: 1 } }).toArray()).map((c) => [String(c._id), c]));
// Nombre sin espacios, acentos ni signos: para reconocer una cabecera escrita de otra forma.
const compacto = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
const revistasPorNombreCompacto = new Map([...colecciones.values()].filter((x) => x.tipo === 'revista').map((x) => [compacto(x.nombre), x]));
const PROY = { titulo: 1, naturaleza: 1, isbn: 1, issn: 1, coleccion: 1, coleccion_nombre: 1, nombre_archivo: 1, año_edicion: 1,
    mes_publicacion: 1, numero_issue: 1, clave_numero: 1, autores: 1, contribuciones: 1, dewey: 1, lcc: 1, tipo_recurso: 1,
    obra: 1, ediciones_candidatas: 1, isbn_probable: 1 };
const filtro = IDS.length ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } } : { tipo_recurso: 'libro', obra: { $exists: false } };
const aRevista = [];
const aRevisar = [];
const pc = progreso(await bib.countDocuments(filtro), 'Mirando los libros');
for await (const d of bib.find(filtro, { projection: PROY })) {
    pc.paso(d.titulo);
    const c = d.coleccion ? colecciones.get(String(d.coleccion)) : null;
    const r = IDS.length ? { clase: 'revista', motivo: 'pedido con --id', datos: datosDelNombre(d.nombre_archivo) } : clasificar(d, c);
    if (r.clase === 'revista') {
        // La cabecera en la que ya está, salvo que el nombre del fichero diga OTRA revista («2017-03-01 Destination
        // Portugal.pdf» metido en «National Geographic Traveler»): entonces manda el nombre del fichero.
        const delNombre = cabeceraDelNombre(d.nombre_archivo);
        const suya = c && c.tipo === 'revista' && (!delNombre || mismaSerie(c.nombre, delNombre)) ? c : null;
        // Una cabecera que ya existe escrita junta o sin acentos («HistoriadeIberiaVieja» = «Historia de Iberia Vieja»).
        const existente = !suya && delNombre ? revistasPorNombreCompacto.get(compacto(delNombre)) : null;
        const cab = suya || existente || null;
        aRevista.push({ d, c: cab, ...r, cabecera: cab ? cab.nombre : delNombre });
    }
    else if (r.clase === 'revisar') aRevisar.push({ d, c, ...r });
}
pc.fin();

const lista = LIMITE ? aRevista.slice(0, LIMITE) : aRevista;
const fecha = ({ anio, mes, numero }) => [numero ? `nº ${numero}` : '', anio ? `${anio}${mes ? '-' + String(mes).padStart(2, '0') : ''}` : ''].filter(Boolean).join(' · ') || '—';
console.log(`\nPASAN A REVISTA: ${aRevista.length}${LIMITE ? ` (con --limite, ${lista.length})` : ''}`);
for (const { d, motivo, datos, cabecera } of aRevista) {
    console.log(`  ${d._id} · ${String(d.nombre_archivo).slice(0, 55)} → «${cabecera || '?'}» ${fecha(datos)}  [${motivo}]${d.isbn ? ` · fuera ISBN y título «${String(d.titulo).slice(0, 35)}»` : ''}`);
}
console.log(`\nA REVISAR: ${aRevisar.length}`);
for (const { d, motivo } of aRevisar.slice(0, 70)) console.log(`  ${d._id} · «${String(d.titulo).slice(0, 45)}» · ${String(d.nombre_archivo || '').slice(0, 50)} — ${motivo}`);
if (aRevisar.length > 70) console.log(`  … y ${aRevisar.length - 70} más (en la selección)`);
const sinCabecera = aRevista.filter((x) => !x.cabecera);
if (sinCabecera.length) console.log(`\n⚠ ${sinCabecera.length} sin nombre de cabecera legible: pasan a revista, pero sin cabecera (asígnala a mano).`);

// ─── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────
const resumen = { pasadas: 0, cabeceras_nuevas: 0, recolocadas: 0, errores: 0 };
const aRevisarTarde = [];
if (EJECUTAR && lista.length) {
    const pe = progreso(lista.length, 'Pasando a revista');
    for (const x of lista) {
        const { d, c, datos, motivo } = x;
        pe.paso(d.titulo);
        try {
            // 1. La cabecera: la revista en la que ya estaba, o la del nombre del fichero (se crea si no existe).
            let cab = c && c.tipo === 'revista' ? c : null;
            if (!cab && x.cabecera) {
                const r = await resolverCabecera(db, { nombre: x.cabecera, tipo: 'revista' });
                if (r._id) {
                    cab = await colCol.findOne({ _id: r._id }, { projection: { nombre: 1, tipo: 1, issn: 1 } });
                    if (r.creada) resumen.cabeceras_nuevas++;
                }
            }
            // Si con ese nombre ya hay una SERIE DE LIBROS, no se mete un número en ella: a revisar.
            if (cab && cab.tipo && cab.tipo !== 'revista') {
                aRevisarTarde.push(d._id);
                pe.nota(`  · ${d._id}: «${cab.nombre}» es una colección de libros; se deja para revisar.`);
                continue;
            }

            // 2. Tipo, fecha, número, clave y título compuesto; fuera lo que puso el catálogo de libros.
            const anio = datos.anio || d.año_edicion || null;
            const mes = datos.mes || d.mes_publicacion || null;
            const numero = datos.numero || d.numero_issue || null;
            const clave = claveNumero({ año_edicion: anio, mes_publicacion: mes, numero_issue: numero });
            const antes = {
                tipo_recurso: d.tipo_recurso, titulo: d.titulo, isbn: d.isbn ?? null, issn: d.issn ?? null, autores: d.autores ?? null,
                contribuciones: d.contribuciones ?? null, dewey: d.dewey ?? null, lcc: d.lcc ?? null, coleccion: d.coleccion ?? null,
                coleccion_nombre: d.coleccion_nombre ?? null, año_edicion: d.año_edicion ?? null, mes_publicacion: d.mes_publicacion ?? null,
                numero_issue: d.numero_issue ?? null, clave_numero: d.clave_numero ?? null,
                ediciones_candidatas: d.ediciones_candidatas ?? null, isbn_probable: d.isbn_probable ?? null,
            };
            const set = { tipo_recurso: 'revista', fecha_actualizacion: new Date() };
            if (anio) set.año_edicion = anio;
            if (mes) set.mes_publicacion = mes;
            if (numero) set.numero_issue = numero;
            if (clave) set.clave_numero = clave;
            if (cab) {
                Object.assign(set, { coleccion: cab._id, coleccion_nombre: cab.nombre, coleccion_fuente: 'archivo' });
                if (cab.issn) set.issn = cab.issn;
                set.titulo = tituloDeNumero(cab.nombre, { numero_issue: numero, mes_publicacion: mes, año_edicion: anio });
            }
            const unset = { isbn: '', autores: '', contribuciones: '', dewey: '', lcc: '', ediciones_candidatas: '', isbn_probable: '', isbn_provisional: '', isbn_dudoso: '' };
            await bib.updateOne({ _id: d._id }, {
                $set: set, $unset: unset,
                $push: {
                    deshacer: { fecha: new Date(), origen: ORIGEN, antes },
                    alertas_agente: `Pasado de libro a revista (${motivo} en el nombre del fichero)${cab ? `, en la cabecera «${cab.nombre}»` : ''}; retirados el ISBN, los autores y el título que le dio un catálogo de libros (scripts/revistas-como-libro).`,
                },
            });
            // 3. En el inventario de números de la cabecera.
            if (cab) await registrarNumeroEnColeccion(db, cab._id, { clave, 'año': anio, mes, numero_issue: numero }, d._id);
            resumen.pasadas++;

            // 4. La carpeta, de libros/ a revistas/; sidecars e índice.
            let doc = await bib.findOne({ _id: d._id });
            // recolocarSegunCdu MUEVE la carpeta pero no escribe la base: devuelve el cambio (ruta_base, portada, imágenes)
            // y hay que aplicarlo (como recolocar-por-cdu). Sin esto, el 5-oct 31 libros quedaron apuntando a la carpeta
            // vieja ya vacía.
            const reub = await recolocarSegunCdu(doc).catch(() => null);
            if (reub?.set?.ruta_base) {
                await aplicarCambio(bib, doc, reub.carpetaNueva || carpetaDeDoc({ ...doc, ...reub.set }),
                    { set: reub.set, alertas: ['Carpeta recolocada según su tipo (scripts/revistas-como-libro).', ...(reub.alertas || [])] });
                resumen.recolocadas++;
            }
            doc = await bib.findOne({ _id: d._id });
            await regenerarSidecarsDoc(db, doc, carpetaDeDoc(doc)).catch(() => {});
            await indexarDoc(db, d._id).catch(() => {});
        } catch (e) {
            resumen.errores++;
            pe.nota(`  ⚠ ${d._id} «${d.titulo}»: ${e.message}`);
        }
    }
    pe.fin();
}

/** Crea la selección o, si ya existe con ese nombre, le AÑADE los documentos (se puede ejecutar por tandas). */
async function guardarSeleccion(nombre, descripcion, ids) {
    if (!ids.length) return;
    const existe = await db.collection('selecciones').findOne({ nombre });
    if (existe) {
        await db.collection('selecciones').updateOne({ _id: existe._id }, { $addToSet: { docs: { $each: ids } }, $set: { fecha_actualizacion: new Date() } });
        return;
    }
    await crearSeleccion(db, { nombre, descripcion, docs: ids });
}
if (EJECUTAR) {
    const hechas = lista.map((x) => x.d._id).filter((id) => !aRevisarTarde.some((r) => String(r) === String(id)));
    await guardarSeleccion('Pasadas de libro a revista', 'Números de revista que estaban catalogados como libro (fecha o número en el nombre del fichero) y se pasaron a revista con su cabecera (scripts/revistas-como-libro). Para comprobar el resultado.', hechas);
    await guardarSeleccion('¿Revista catalogada como libro?', 'Documentos tipados como libro dentro de la cabecera de una revista pero sin fecha ni número en el nombre, cómics, o cuya cabecera por nombre es una colección de libros (scripts/revistas-como-libro). Si es un número: 🔀 Cambiar tipo → Revista.', [...aRevisar.map((x) => x.d._id), ...aRevisarTarde]);
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${EJECUTAR
    ? `${resumen.pasadas} pasadas a revista · ${resumen.cabeceras_nuevas} cabeceras nuevas · ${resumen.recolocadas} carpetas recolocadas · ${resumen.errores} errores`
    : `${lista.length} pasarían a revista`} · ${aRevisar.length + aRevisarTarde.length} a revisar ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js), en el NAS, y repite con --ejecutar (prueba primero con --limite 5).');
else console.log('▶ Después: sanear-numeros-revista.js --contaminadas (en seco y luego --ejecutar) juzga sinopsis, editorial y palabras clave.');
process.exit(0);
