/**
 * LIBROS CATALOGADOS COMO REVISTA — los pasa a libro y los vuelve a identificar.
 *
 * Por qué (detectado el 17-sep, recordatorio del usuario del 29-sep; caso «Rosen», 2-oct): un libro que imprime el
 * ISSN de su SERIE (Springer «Lecture Notes in Physics», guías DK…) y del que no se tomó el ISBN entraba como
 * `tipo_recurso: 'revista'`: carpeta …/revistas/<issn>/<año>, título sacado del nombre del fichero («Rosen», «Givant»,
 * «Untitled-7»), sin identificar por ISBN (el motor no busca revistas en los catálogos de libros) y con una CDU
 * deducida de cualquier cosa («Rosen» acabó en 82-3, novela). La ingesta ya no lo hace (un ISBN o un bloque CIP ⇒
 * libro; el ISSN solo no hace una revista), pero quedan los de antes.
 *
 * CANDIDATOS (de los documentos tipados como revista):
 *   · PASAN A LIBRO solos, si
 *       – su ISSN es de una SERIE DE LIBROS (Crossref/Fichero), salvo que el nombre lleve un mes («… June 2021»); o
 *       – tienen ISBN propio (en la ficha o leído de su fichero) y NINGUNA señal de número de revista: ni fecha
 *         año-mes en el nombre o el título, ni mes o «nº» en el título, ni clave de número AAAA-MM / nNNN, ni un
 *         título que sea la cabecera de su colección («Nueva Dimensión 3» es un número aunque traiga un ISBN).
 *   · A REVISAR (selección «¿Libro catalogado como revista?»): sin ISBN ni señales de número, y con 120+ páginas o
 *     dentro de una colección de libros («Teach yourself Photoshop»).
 *   · El resto son revistas de verdad y no se tocan (las que llevan un ISBN de un libro homónimo y una fecha —«Direction
 *     Italie 2020-06»— siguen siendo revistas: ese ISBN se lo atribuyó por error un catálogo de libros).
 *
 * QUÉ SE HACE con cada libro (con --ejecutar; dry-run por defecto):
 *   1. tipo libro; fuera la clave/mes/nº de número; su ISSN pasa a la COLECCIÓN de la serie (la que tiene ese ISSN, o
 *      una nueva con el nombre que da la autoridad), nunca al libro; sale del inventario de números de la cabecera.
 *   2. «Extraer ISBN» forzado (utils/reidentificar-doc): ISBN de su fichero → Fichero/APIs gratuitas → título, autores,
 *      editorial… (sin IA). Un título-artefacto se sustituye por el de la autoridad.
 *   3. «Investigar CDU» forzado (sin IA): la CDU de la BNE o del Dewey/LCC; mueve la carpeta.
 *   4. La carpeta a libros/ (recolocarSegunCdu) y sidecars e índice al día.
 * Todo con diario `deshacer[]` (origen «libros-como-revista», más los de reidentificar/editar). Mueve carpetas: correr
 * en el NAS, con copia de la base antes.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/libros-como-revista.js                 (en seco: la lista)
 *   sudo docker exec -it gestor-biblioteca node scripts/libros-como-revista.js --ejecutar
 *   … --limite N        solo los N primeros (para probar)
 *   … --id <id>,<id>    solo esos documentos (los pasa a libro aunque no sean candidatos automáticos)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { validarISBN } from '../src/utils/identificadores.js';
import { parsearNombre } from '../src/utils/parsear-nombre.js';
import { naturalezaISSN, palabrasDeSerie } from '../src/utils/serie-autoridad.js';
import { serieCrossrefLocal } from '../src/utils/crossref-local.js';
import { seriesDeISSN } from '../src/utils/buscador-series.js';
import { resolverCabecera } from '../src/utils/colecciones.js';
import { reidentificarDoc, resolverCduDoc } from '../src/utils/reidentificar-doc.js';
import { recolocarSegunCdu, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = Number(arg('--limite')) || 0;
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));
const ORIGEN = 'libros-como-revista';

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · libros catalogados como revista\n`);

// ─── Señales ─────────────────────────────────────────────────────────────────────────────────────────────
// Fecha de número año-mes («2019-08», «201503», «Taste Of Home 2009 06 07»), sin confundirla con dígitos de un ISBN.
const RE_FECHA = new RegExp(String.raw`(?<!\d)(19|20)\d{2}[-_. ]?(0[1-9]|1[0-2])(?!\d)`);
// Mes, estación o «nº» en el título: «… June 2021», «WatercolorArtistFall2023», «nº 73».
const RE_MES = new RegExp(String.raw`(jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|january|february|march|april|june|july|august|september|october|november|december|spring|summer|autumn|fall|winter|primavera|verano|otoño|invierno)\s*-?\s*(19|20)\d{2}|\b(issue|n[º°o]\.?)\s*\d`, 'i');

const RE_NUMERO_SUELTO = /\b\d{1,4}\b/;
const sinIsbnDeFichero = (s) => String(s || '').replace(/\d{10,13}/g, '');

function senalesDeNumero(d, c) {
    if (d.nombre_archivo && parsearNombre(d.nombre_archivo).esFechada) return 'fecha en el nombre del fichero';
    if (RE_FECHA.test(String(d.titulo || '')) || RE_FECHA.test(sinIsbnDeFichero(d.nombre_archivo))) return 'año-mes en el título o el nombre';
    if (RE_MES.test(String(d.titulo || '')) || RE_MES.test(sinIsbnDeFichero(d.nombre_archivo))) return 'mes o nº en el título';
    if (/^\d{4}-\d{2}$|^n\d+$/.test(String(d.clave_numero || ''))) return 'clave de número';
    // Un título que es solo un número («01.pdf» … «12.pdf» de «BBC Good Food UK»): es el número del mes.
    if (/^\s*\d{1,3}\s*$/.test(String(d.titulo || ''))) return 'el título es solo un número';
    if (c) {
        // El nombre de su colección en el título o en el nombre del fichero, con un número: «Más Allá 1»,
        // «[Mas Alla 02] AA. VV. - Mas Alla 2» (a ese, el título ya se lo había pisado el de un libro de Wiley).
        const cab = [...palabrasDeSerie(c.nombre)];
        const texto = new Set([...palabrasDeSerie(d.titulo), ...palabrasDeSerie(d.nombre_archivo)]);
        const conNumero = RE_NUMERO_SUELTO.test(String(d.titulo || '')) || RE_NUMERO_SUELTO.test(sinIsbnDeFichero(d.nombre_archivo));
        if (cab.length && cab.every((p) => texto.has(p)) && (conNumero || c.tipo === 'revista')) return 'lleva el nombre de su cabecera';
    }
    return null;
}

const isbnPropio = (d) => validarISBN(d.isbn || '') || (d.isbn_candidatos || []).map((x) => validarISBN(x)).find(Boolean) || null;

/** 'libro' | 'revisar' | null, con el motivo. */
function clasificar(d, c) {
    const numero = senalesDeNumero(d, c);
    const naturaleza = d.issn ? naturalezaISSN(d.issn) : null;
    const isbn = isbnPropio(d);
    // Un cómic (los especiales de Don Miki con ISBN) puede ser un álbum o un número: lo decide una persona.
    const esComic = ['comic', 'novela-grafica', 'tebeo', 'manga'].includes(String(d.naturaleza || '').toLowerCase())
        || /\.(cbr|cbz|cb7)$/i.test(String(d.nombre_archivo || ''));
    if (esComic && !numero) return { clase: 'revisar', motivo: 'es un cómic: álbum o número' };
    if (naturaleza === 'serie' && !(numero && /mes|fecha/.test(numero))) return { clase: 'libro', motivo: `el ISSN ${d.issn} es de una serie de libros` };
    if (isbn && !numero) return { clase: 'libro', motivo: `tiene ISBN (${isbn}) y nada de número de revista` };
    if (!isbn && !numero && ((d.paginas || 0) >= 120 || (c && c.tipo !== 'revista'))) {
        return { clase: 'revisar', motivo: (d.paginas || 0) >= 120 ? `${d.paginas} páginas y nada de número` : 'está en una colección de libros' };
    }
    return { clase: null, motivo: numero };
}

// ─── Candidatos ──────────────────────────────────────────────────────────────────────────────────────────
const colecciones = new Map((await colCol.find({}, { projection: { nombre: 1, tipo: 1, issn: 1 } }).toArray()).map((c) => [String(c._id), c]));
const PROY = { titulo: 1, naturaleza: 1, isbn: 1, isbn_candidatos: 1, issn: 1, coleccion: 1, coleccion_nombre: 1, nombre_archivo: 1, clave_numero: 1,
    mes_publicacion: 1, numero_issue: 1, paginas: 1, tipo_recurso: 1, cdu: 1, ruta_base: 1 };
const filtro = IDS.length ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } } : { tipo_recurso: 'revista' };
const total = await bib.countDocuments(filtro);
const aLibro = [];
const aRevisar = [];
const pc = progreso(total, 'Mirando las revistas');
for await (const d of bib.find(filtro, { projection: PROY })) {
    pc.paso(d.titulo);
    const c = d.coleccion ? colecciones.get(String(d.coleccion)) : null;
    if (IDS.length) { aLibro.push({ d, c, motivo: 'pedido con --id' }); continue; }
    const r = clasificar(d, c);
    if (r.clase === 'libro') aLibro.push({ d, c, motivo: r.motivo });
    else if (r.clase === 'revisar') aRevisar.push({ d, c, motivo: r.motivo });
}
pc.fin();

const lista = LIMITE ? aLibro.slice(0, LIMITE) : aLibro;
console.log(`\nPASAN A LIBRO: ${aLibro.length}${LIMITE ? ` (con --limite, ${lista.length})` : ''}`);
for (const { d, c, motivo } of aLibro) console.log(`  ${d._id} · «${String(d.titulo).slice(0, 50)}» · ${String(d.nombre_archivo || '').slice(0, 60)}${c ? ` · en «${c.nombre}»` : ''} — ${motivo}`);
console.log(`\nA REVISAR: ${aRevisar.length}`);
for (const { d, motivo } of aRevisar.slice(0, 60)) console.log(`  ${d._id} · «${String(d.titulo).slice(0, 50)}» · ${String(d.nombre_archivo || '').slice(0, 60)} — ${motivo}`);
if (aRevisar.length > 60) console.log(`  … y ${aRevisar.length - 60} más (en la selección)`);

// ─── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────
/** La colección de la serie de ese ISSN: la que ya lo tenga (pasa a tipo libro si era cabecera), o una nueva. */
async function coleccionDeLaSerie(issn) {
    const existente = await colCol.findOne({ issn });
    if (existente) {
        if (existente.tipo === 'revista') {
            await colCol.updateOne({ _id: existente._id }, {
                $set: { tipo: 'libro', fecha_actualizacion: new Date() },
                $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { tipo: 'revista' } } },
            });
        }
        return { _id: existente._id, nombre: existente.nombre };
    }
    const nombre = serieCrossrefLocal(issn)?.nombre || seriesDeISSN(issn)[0]?.nombre || null;
    if (!nombre) return null;
    const { _id } = await resolverCabecera(db, { nombre, issn, tipo: 'libro' });
    return _id ? { _id, nombre: (await colCol.findOne({ _id }, { projection: { nombre: 1 } }))?.nombre || nombre } : null;
}

const resumen = { pasados: 0, isbn: 0, cdu: 0, recolocados: 0, errores: 0 };
if (EJECUTAR && lista.length) {
    const pe = progreso(lista.length, 'Pasando a libro');
    for (const { d, motivo } of lista) {
        pe.paso(d.titulo);
        try {
            // 1. Tipo libro; el ISSN, a la colección de su serie.
            const antes = {
                tipo_recurso: d.tipo_recurso, issn: d.issn ?? null, clave_numero: d.clave_numero ?? null, mes_publicacion: d.mes_publicacion ?? null,
                numero_issue: d.numero_issue ?? null, coleccion: d.coleccion ?? null, coleccion_nombre: d.coleccion_nombre ?? null,
            };
            const set = { tipo_recurso: 'libro', fecha_actualizacion: new Date() };
            const unset = { clave_numero: '', mes_publicacion: '', numero_issue: '', issn: '' };
            if (d.issn) {
                const serie = await coleccionDeLaSerie(d.issn);
                if (serie) Object.assign(set, { coleccion: serie._id, coleccion_nombre: serie.nombre, coleccion_fuente: 'autoridad' });
            }
            await bib.updateOne({ _id: d._id }, {
                $set: set, $unset: unset,
                $push: {
                    deshacer: { fecha: new Date(), origen: ORIGEN, antes },
                    alertas_agente: `Pasado de revista a libro: ${motivo} (scripts/libros-como-revista).`,
                },
            });
            // Fuera del inventario de números de la cabecera en que estuviera.
            if (d.coleccion) {
                await colCol.updateOne({ _id: d.coleccion }, { $pull: { numeros: { _id: d._id }, numeros_sin_fecha: d._id } });
            }
            resumen.pasados++;

            // 2. Extraer ISBN forzado (sin IA).
            let doc = await bib.findOne({ _id: d._id });
            const r = await reidentificarDoc(db, doc, { aplicar: true, usarApis: true, forzar: true });
            if (r.estado === 'aplicado') resumen.isbn++;

            // 3. Investigar CDU forzado (sin IA): mueve la carpeta.
            doc = await bib.findOne({ _id: d._id });
            const rc = await resolverCduDoc(db, doc, { forzar: true, aplicar: true }).catch(() => null);
            if (rc?.estado === 'cdu-aplicada') resumen.cdu++;

            // 4. La carpeta a libros/ si aún está en revistas/; sidecars e índice.
            doc = await bib.findOne({ _id: d._id });
            if (await recolocarSegunCdu(doc).catch(() => null)) resumen.recolocados++;
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
    await guardarSeleccion('Pasados de revista a libro', 'Libros que estaban catalogados como revista (ISSN de su serie, o ISBN sin señales de número) y se pasaron a libro, re-identificados por su ISBN (scripts/libros-como-revista). Para comprobar el resultado.', lista.map((x) => x.d._id));
    await guardarSeleccion('¿Libro catalogado como revista?', 'Documentos tipados como revista sin ISBN ni señales de número (fecha, nº, cabecera), con muchas páginas o dentro de una colección de libros (scripts/libros-como-revista). Si es un libro: 🔀 Cambiar tipo → Libro y 🔎 Extraer ISBN.', aRevisar.map((x) => x.d._id));
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${EJECUTAR ? `${resumen.pasados} pasados a libro · ${resumen.isbn} con ISBN cotejado · ${resumen.cdu} CDU nuevas · ${resumen.recolocados} carpetas recolocadas · ${resumen.errores} errores` : `${lista.length} pasarían a libro`} · ${aRevisar.length} a revisar ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js), en el NAS, y repite con --ejecutar (prueba primero con --limite 5).');
process.exit(0);
