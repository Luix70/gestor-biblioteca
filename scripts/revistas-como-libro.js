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

// ─── Fecha, número y cabecera a partir del NOMBRE del fichero ───────────────────────────────────────────
const MESES = {
    jan: 1, january: 1, ene: 1, enero: 1, feb: 2, february: 2, febrero: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4,
    abr: 4, abril: 4, may: 5, mayo: 5, jun: 6, june: 6, junio: 6, jul: 7, july: 7, julio: 7, aug: 8, august: 8, ago: 8,
    agosto: 8, sep: 9, sept: 9, september: 9, septiembre: 9, oct: 10, october: 10, octubre: 10, nov: 11, november: 11,
    noviembre: 11, dec: 12, december: 12, dic: 12, diciembre: 12,
    janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9,
    octobre: 10, novembre: 11, decembre: 12, décembre: 12,
    // Las estaciones (números trimestrales): el primer mes de cada una.
    winter: 1, invierno: 1, spring: 4, primavera: 4, summer: 7, verano: 7, autumn: 10, fall: 10, otono: 10,
};
const NOMBRES_MES = Object.keys(MESES).sort((a, b) => b.length - a.length).join('|');

// Fecha DELANTE: «2021 07 01 Crochet Now», «2023-01-01 Watercolor Artist».
const RE_FECHA_DELANTE = /^((?:19|20)\d{2})[-_ ](0[1-9]|1[0-2])[-_ ](\d{2})\b/;
// Fecha AL FINAL (antes de la extensión), con un sufijo corto opcional («US», «UK») o un «(1)» de copia.
const RE_FECHA_FINAL = /(?<!\d)((?:19|20)\d{2})[-_ .]?(0[1-9]|1[0-2])(?:[-_ .]?\d{2})?(?:\s*[A-Z]{2,3})?\s*(?:\(\d\))?\.[a-z0-9]+$/;
// Mes (o estación) y año PEGADOS al nombre: «UltraRunningMay2014», «AsimovsScienceFictionMarch2015»,
// «WatercolorArtistFall2023». Separados no valen: los nombres de lote de libros acaban en «…Scruton,_Roger.Mar.2009»
// (la fecha de la edición; medido el 5-oct: los VSI de Oxford salían todos como revistas).
const RE_MES_ANIO = new RegExp(`[a-z](${NOMBRES_MES})((?:19|20)\\d{2})(?!\\d)`, 'i');
// Mes (por su nombre) y año SEPARADOS: «Avril 2015», «December 2014». Solo como apoyo: con un «No.» delante, o en
// un documento que ya está dentro de la cabecera de una revista (los libros también llevan la fecha de su edición).
const RE_MES_ANIO_SEPARADOS = new RegExp(`(?<![a-z])(${NOMBRES_MES})\\.?[ ,]+((?:19|20)\\d{2})(?!\\d)`, 'i');
// Año-mes en cualquier parte del nombre («Harvard Business Review USA 2015-05.bak.pdf»): también solo como apoyo.
const RE_ANIO_MES_SUELTO = /(?<!\d)((?:19|20)\d{2})[-_ .](0[1-9]|1[0-2])(?!\d)/;
// Número de la revista: «Issue 3», «Vol 7 Issue 3», «No.179», «nº 13», «Magazine 5», «#12».
// «Issue 3», «Magazine 5»: número de revista sin más. «No.179», «nº 13»: solo si además hay una fecha en el nombre
// («Marketing No.184 - Avril 2015»), porque también los usan los libros («L'Ecluse n°1» de Maigret, «No.10 Commando»).
// Sin «#»: lo usan las series de libros («Osprey, Men at Arms #121», «Fortress #2»).
const RE_NUMERO_ISSUE = /\b(?:issue|magazine)\s*0*(\d{1,4})\b/i;
const RE_NUMERO_NO = /\b(?:no\.?|n[º°])\s*0*(\d{1,4})\b/i;
const RE_ANIO = /(?<!\d)(?:19|20)\d{2}(?!\d)/;
const esAnio = (n) => n >= 1800 && n <= 2100;
const RE_VOL_ISSUE = /\bvol(?:ume)?\.?\s*\d+\s*(?:issue|no\.?|n[º°])\s*\d+/i;

const empiezaPorIsbn = (nombre) => !!validarISBN(String(nombre).split(/[ ._-]/)[0]);
const sinExtension = (nombre) => String(nombre || '').replace(/\.[a-z0-9]{2,5}$/i, '');

/** { anio, mes, numero } que se leen en el nombre del fichero (los que haya). */
const sinEntidades = (s) => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

function datosDelNombre(nombre) {
    const base = sinEntidades(nombre);
    const out = { anio: null, mes: null, numero: null, señal: null };
    let m = base.match(RE_FECHA_DELANTE);
    if (m) Object.assign(out, { anio: +m[1], mes: +m[2], señal: 'fecha delante' });
    if (!out.anio && (m = base.match(RE_FECHA_FINAL))) Object.assign(out, { anio: +m[1], mes: +m[2], señal: 'fecha al final' });
    if (!out.anio && (m = sinExtension(base).match(RE_MES_ANIO))) {
        Object.assign(out, { anio: +m[2], mes: MESES[m[1].toLowerCase()] || null, señal: 'mes y año' });
    }
    const pn = parsearNombre(base);
    const ni = base.match(RE_NUMERO_ISSUE);
    const nn = base.match(RE_NUMERO_NO);
    if (ni && !esAnio(+ni[1])) { out.numero = +ni[1]; out.señal = out.señal || 'número de revista'; }
    else if (nn && !esAnio(+nn[1]) && ((out.anio && out.mes) || RE_MES_ANIO_SEPARADOS.test(base))) {
        out.numero = +nn[1];
        out.señal = out.señal || 'número y fecha';
    }
    else if (pn.coleccion_numero && /magazine|revista|dimensi[oó]n|bolet[ií]n/i.test(pn.coleccion_nombre || '')) {
        out.numero = +pn.coleccion_numero;
        out.señal = out.señal || 'número de revista';
    }
    if (RE_VOL_ISSUE.test(base)) out.señal = out.señal || 'volumen y número';
    // Apoyos (no bastan solos): mes y año separados, o año-mes en cualquier parte. Se guardan aparte.
    let a;
    if (!out.anio && (a = base.match(RE_MES_ANIO_SEPARADOS))) Object.assign(out, { anio: +a[2], mes: MESES[a[1].toLowerCase()] || null, apoyo: 'mes y año' });
    else if (!out.anio && (a = base.match(RE_ANIO_MES_SUELTO))) Object.assign(out, { anio: +a[1], mes: +a[2], apoyo: 'año-mes' });
    return out;
}

/** El nombre de la cabecera según el fichero: sin la fecha, el número ni la basura de la descarga. */
function cabeceraDelNombre(nombre) {
    nombre = sinEntidades(nombre);
    // Cabecera ePubLibre «[Isaac Asimov Magazine 05]», «[Nueva Dimension 020]»: el nombre de la colección sin el nº.
    const pn = parsearNombre(nombre);
    if (pn.coleccion_nombre && pn.coleccion_numero) return pn.coleccion_nombre.replace(/\s+extra$/i, '').trim();
    let t = sinExtension(nombre)
        .replace(RE_FECHA_DELANTE, ' ')
        .replace(/\bvol(?:ume)?\.?\s*\d+.*$/i, ' ')
        .replace(/(?<!\d)(?:19|20)\d{2}[-_ .]?(?:0[1-9]|1[0-2])(?:[-_ .]?\d{2})?.*$/, ' ')
        .replace(new RegExp(`(${NOMBRES_MES})\\.?[-_ ]?(?:19|20)\\d{2}.*$`, 'i'), ' ')
        .replace(/\b(?:issue|no\.?|n[º°]|#)\s*\d+.*$/i, ' ')
        .replace(/\bdownmagaz(?:\.com)?\b|\bstoremags?\b|\bfantamag(?:\.com)?\b/gi, ' ')
        .replace(/[_.]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')            // «CustomPC» → «Custom PC», «BBCKnowledge» → «BBC Knowledge»
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/\s*\(\d\)\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    t = t.replace(new RegExp(`[\\s,.-]*\\b(${NOMBRES_MES})\\.?\\s*$`, 'i'), '').trim();   // un mes suelto al final («… Juin»)
    t = tituloCabecera(t) || t;
    return t.length >= 3 ? capitalizarCabecera(t) : null;
}

/** 'revista' | 'revisar' | null, con el motivo y los datos leídos. */
function clasificar(d, c) {
    const nombre = sinEntidades(d.nombre_archivo);
    if (!nombre || empiezaPorIsbn(nombre)) return { clase: null };
    // Una imagen o un escaneo («Scan_20260628_201205.jpg»): la fecha es la del escáner.
    if (/\.(jpe?g|png|tiff?|gif|webp|heic)$/i.test(nombre) || /^scan[_ -]/i.test(nombre)) return { clase: null };
    // Un ISBN válido en cualquier parte del nombre («2011-10-24-#-0691141207.djvu»): es un libro.
    if ((nombre.match(/\d{9}[\dXx]|\d{13}/g) || []).some((x) => validarISBN(x))) return { clase: null };
    if (pareceSerieLibros(d.titulo) || pareceSerieLibros(nombre) || esEditorialDeLibros(nombre)) return { clase: null };
    const datos = datosDelNombre(nombre);
    const esComic = ['comic', 'novela-grafica', 'tebeo', 'manga'].includes(String(d.naturaleza || '').toLowerCase())
        || /\.(cbr|cbz|cb7)$/i.test(nombre);
    const enCabecera = !!(c && c.tipo === 'revista');
    if (datos.señal && !esComic) return { clase: 'revista', motivo: datos.señal, datos };
    // Dentro de la cabecera de una revista, una fecha con el mes basta («MSDN - April 2010», «Mother Earth News
    // (December 2014 - January 2015)», «03. The Woodworker & Woodturner - March 2016»).
    if (enCabecera && datos.apoyo && !esComic) return { clase: 'revista', motivo: `${datos.apoyo} y está en la cabecera`, datos };
    if (enCabecera || (datos.señal && esComic)) {
        return { clase: 'revisar', motivo: esComic ? 'es un cómic: álbum o número' : `está en la cabecera «${c.nombre}» sin fecha ni número en el nombre`, datos };
    }
    return { clase: null };
}

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
