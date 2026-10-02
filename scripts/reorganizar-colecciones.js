/**
 * REORGANIZAR LAS COLECCIONES — aplica la regla del usuario (1-oct): manda la colección MANUAL, luego la EDITORIAL
 * (la serie que dice la autoridad por el ISBN: Fichero/series.db y Crossref/crossref.db) y por último la de la
 * INGESTA (nombre de carpeta). Sin red ni IA.
 *
 * Medido el 1-oct: 3.777 colecciones, 2.445 de un solo libro; 93 con nombre de artefacto («MIT.Press.Nonfiction.
 * Ebook-2021-PHC», «University Press Collection»…) con 10.448 libros; 2.569 libros con el nombre de su colección
 * desfasado; 3.808 libros sin colección cuya serie conoce la autoridad.
 *
 * Cada colección se clasifica:
 *   · INTOCABLE — revistas, transmedia, audiolibros, las de árbol fijo (ruta_fija/raiz_web) y las que tienen algún
 *     libro puesto a mano (coleccion_fuente:'manual').
 *   · EDITORIAL — tiene ISSN; o sus libros la confirman (la autoridad dice esa serie) al menos tantas veces como la
 *     contradicen; o su nombre es el de una serie conocida y sus libros no la contradicen (3+ y mayoría).
 *   · DE CARPETA — el resto (las de nombre de artefacto, siempre, salvo ISSN).
 *
 * FASES (todas en seco por defecto):
 *   1. NOMBRES — el `coleccion_nombre` de cada libro vuelve a ser el de su colección.
 *   2. UNA SERIE, UNA COLECCIÓN — las colecciones editoriales que son la misma serie según sus libros («Very short
 *      introductions», «Very Short Introductions», «Oxford.Very Short Introduction») se funden en una; si la que
 *      queda tiene nombre de artefacto, toma el de la serie. Los libros conservan su número.
 *   3. LIBRO A LIBRO, por la autoridad (solo libros con ISBN y serie fiable: con ISSN o 3+ libros en el Fichero):
 *        sin colección          → entra en su serie;
 *        en una de CARPETA      → pasa a su serie (decisión del usuario: «si nació de una carpeta y existe una
 *                                 colección editorial, pasa a esta última»);
 *        en otra EDITORIAL      → NO se toca: selección «Colección contradicha por la autoridad» para revisarla,
 *                                 con el resumen por transición en el informe.
 *   4. LAS DE CARPETA que quedan — con 2+ libros se convierten en SELECCIÓN («Colección de carpeta · <nombre>»: la
 *      agrupación no se pierde) y la colección se retira; con 1 libro, el libro queda libre y la colección se retira.
 *
 * INTERRUMPIBLE Y REANUDABLE: cada cambio se guarda en el momento (un libro, una colección), y cada pasada parte del
 * estado ACTUAL de la base: lo ya hecho sale confirmado o ya no aparece, y se sigue con lo que falta. Para cortarlo,
 * Ctrl+C con `docker exec -it` (con -t a secas no llega la señal); relanzar con las mismas opciones.
 *
 * NADA SE PIERDE: cada libro cambiado lleva su entrada en el diario `deshacer[]` (origen «reorganizar-colecciones»),
 * cada colección retirada se copia entera en `colecciones_retiradas` (con el motivo y sus miembros) antes de borrarla.
 * Las carpetas en disco no se mueven: la ruta de un libro no depende de su colección (salvo las de árbol fijo, que
 * no se tocan).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/reorganizar-colecciones.js                 (en seco: informe)
 *   sudo docker exec -it gestor-biblioteca node scripts/reorganizar-colecciones.js --ejecutar
 *   … --fases 1,2          solo esas fases
 *   … --conservar <id|nombre>,…   colecciones que no se tocan (se tratan como intocables)
 *   … --informe <ruta>     el informe completo (todas las listas) a un fichero de texto
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { resolverCabecera } from '../src/utils/colecciones.js';
import { claveSerie } from '../src/utils/series-texto.js';
import { seriesDeAutoridad, elegirSerie, mismaSerie, mismoNombreDeSerie, esSerieEditorial, esNombreGenerico, palabrasDeSerie, naturalezaISSN } from '../src/utils/serie-autoridad.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { parsearNombre } from '../src/utils/parsear-nombre.js';
import { serieCrossrefLocal, seriesCrossrefPorNombre } from '../src/utils/crossref-local.js';
import { seriesDeISSN } from '../src/utils/buscador-series.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const FASES = new Set(String(arg('--fases') || '1,2,3,4').split(',').map((s) => s.trim()));
const CONSERVAR = new Set(String(arg('--conservar') || '').split(',').map((s) => s.trim()).filter(Boolean));
const RUTA_INFORME = arg('--informe');
const EXPLICAR = new Set(String(arg('--explicar') || '').split(',').map((x) => x.trim()).filter(Boolean));   // ids: por qué se clasifica así
const ORIGEN = 'reorganizar-colecciones';

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · reorganizar colecciones (fases ${[...FASES].join(', ')})\n`);

// Informe: lo que se imprime también se guarda (con --informe, las listas completas).
const informe = [];
const anota = (linea = '') => { informe.push(linea); };
const di = (linea = '') => { console.log(linea); anota(linea); };

// Nombre con pinta de carpeta o de paquete de descarga, no de serie editorial.
const RE_ARTEFACTO = /(\.pdf\b|\.epub\b|\bpdf\b|\bepub\b|\bebooks?\b|\bpack\b|\btorrent\b|\bcollection\b.*\b(books?|pdf|ebooks?)\b|\b(books?|pdf|ebooks?)\b.*\bcollection\b|^[\w-]+(\.[\w-]+){2,}|^author:|^\d+$|_|untitled)/i;
const pareceArtefacto = (nombre) => RE_ARTEFACTO.test(String(nombre || ''));
// Un número («nº 73», «73») en el título.
const RE_NUMERO = new RegExp(String.raw`\b(n[º°o.]?\s*\d+|\d{1,4})\b`, 'i');
// Una FECHA de número (año-mes, con o sin separadores: «2009-09», «20090910»), sin confundirla con los dígitos de un ISBN.
const RE_FECHA_NUMERO = new RegExp(String.raw`(?<!\d)(19|20)\d{2}[-_.]?(0[1-9]|1[0-2])([-_.]?(0[1-9]|[12]\d|3[01]))?(?!\d)`);
const RE_ISSN = new RegExp(String.raw`^\d{4}-\d{3}[\dXx]$`);
// Nombre de EDITORIAL usado como colección («Cornell Univerity Press»): es la carpeta de una editorial, no una serie.
const RE_NOMBRE_EDITORIAL = new RegExp(String.raw`\b(press|publishing|publishers|verlag|editorial|ediciones)\s*$`, 'i');

// ─── Carga ───────────────────────────────────────────────────────────────────────────────────────────────
const colecciones = new Map();   // id → colección
for await (const c of colCol.find({})) colecciones.set(String(c._id), c);
const nombreEditorial = new Map();
for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombreEditorial.set(String(e._id), e.nombre);

const PROY = { titulo: 1, isbn: 1, issn: 1, clave_numero: 1, nombre_archivo: 1, tipo_recurso: 1, naturaleza: 1, coleccion: 1, coleccion_nombre: 1, coleccion_numero: 1, coleccion_numero_auto: 1, coleccion_fuente: 1 };
const docs = [];
const pc = progreso(await bib.countDocuments({}), 'Leyendo la biblioteca y la serie de cada libro');
for await (const d of bib.find({}, { projection: PROY })) {
    pc.paso(d.titulo);
    // La autoridad, solo para libros con ISBN (las revistas tienen su cabecera).
    d._series = d.isbn && d.tipo_recurso !== 'revista' ? seriesDeAutoridad(d.isbn, { titulo: d.titulo }) : [];
    docs.push(d);
}
pc.fin();

const miembrosDe = new Map();   // id colección → docs
for (const d of docs) {
    if (!d.coleccion) continue;
    const k = String(d.coleccion);
    if (!miembrosDe.has(k)) miembrosDe.set(k, []);
    miembrosDe.get(k).push(d);
}

// ¿Comparten alguna palabra con cuerpo que no sea de materia? (misma serie escrita distinto, o serie y subserie)
const emparentadas = (a, b) => {
    const pb = palabrasDeSerie(b);
    return [...palabrasDeSerie(a)].some((p) => p.length >= 4 && pb.has(p) && !esNombreGenerico(p));
};

// ─── Clasificación de cada colección ─────────────────────────────────────────────────────────────────────
const TIPOS_INTOCABLES = new Set(['revista', 'transmedia', 'audiolibros']);
const clase = new Map();         // id → 'intocable' | 'editorial' | 'carpeta'
const votos = new Map();         // id → Map(claveSerie → { serie, n }) de sus libros que la confirman
const pcl = progreso(colecciones.size, 'Clasificando colecciones');
for (const [id, c] of colecciones) {
    pcl.paso(c.nombre);
    const miembros = miembrosDe.get(id) || [];
    // «REVISTA» QUE ES UNA SERIE DE LIBROS: una cabecera con ISSN cuyos miembros son casi todos LIBROS es el ISSN de
    // una serie (el caso «Rosen», 2-oct: la colección de la serie Springer «The Frontiers Collection», ISSN
    // 1612-3018, acabó como revista y con el nombre «Rosen» porque un libro suyo —«Rosen - Symmetry Rules
    // (Springer, 2008).pdf»— entró como revista titulada «Rosen» y la cabecera tomó su nombre). Deja de ser
    // intocable: la fase 2 le devuelve el tipo libro y el nombre que la autoridad da a ese ISSN.
    const libros = miembros.filter((d) => d.tipo_recurso === 'libro').length;
    // Lo PRIMERO es de qué es su ISSN (Crossref/Fichero): eso decide el tipo de la colección, y los miembros que no
    // casen son los sospechosos — no al revés.
    c._naturaleza = naturalezaISSN(c.issn);
    if (c.tipo === 'revista' && c._naturaleza === 'serie') {
        const nombreSerie = serieCrossrefLocal(c.issn)?.nombre || seriesDeISSN(c.issn)[0]?.nombre || c.nombre;
        c._serieDeLibros = { nombre: mismaSerie(nombreSerie, c.nombre) ? c.nombre : nombreSerie, issn: c.issn, numero: null, registros: 0 };
    } else if (c.tipo === 'revista' && c.issn && !c._naturaleza && miembros.length >= 2 && libros / miembros.length >= 0.8) {
        const nombreAutoridad = serieCrossrefLocal(c.issn)?.nombre || seriesDeISSN(c.issn)[0]?.nombre || null;
        // Solo si el ISSN es de una SERIE DE LIBROS conocida (Crossref/Fichero): «Popular Photography» o «MSDN» son
        // revistas de verdad, aunque algún número se catalogara como libro.
        if (nombreAutoridad) c._serieDeLibros = { nombre: mismaSerie(nombreAutoridad, c.nombre) ? c.nombre : nombreAutoridad, issn: c.issn, numero: null, registros: 0 };
    }
    // Aunque la autoridad no conozca el ISSN: si los libros llevan ISBN y ninguno parece un número de revista, es una
    // serie de libros («DK Eyewitness Travel», «Focus series», «Intersections»). Con un solo libro y su mismo título
    // no: es el libro dando nombre a una colección (la fase 2b lo saca y la colección vacía se retira).
    const conIsbn = miembros.filter((d) => d.tipo_recurso === 'libro' && d.isbn).length;
    if (!c._serieDeLibros && c.tipo === 'revista' && c._naturaleza !== 'revista' && miembros.length >= 2 && conIsbn / miembros.length >= 0.8
        && miembros.filter((d) => tieneSenalDeNumero(d, c)).length / miembros.length < 0.2) {
        c._serieDeLibros = { nombre: c.nombre, issn: c.issn || null, numero: null, registros: 0 };
    }
    // COLECCIÓN «DE LIBROS» QUE ES UNA REVISTA: casi todos sus miembros son números o artículos («Science», «Cell»,
    // «Fotogramas», «Nueva Dimensión»). La fase 2 le pone tipo revista; mientras, intocable (no es una serie de libros
    // que la autoridad pueda confirmar ni una carpeta que deshacer).
    const periodicos = miembros.filter((d) => d.tipo_recurso === 'revista' || d.tipo_recurso === 'articulo').length;
    if (c.tipo !== 'revista' && !TIPOS_INTOCABLES.has(c.tipo)
        && (c._naturaleza === 'revista' || (c._naturaleza !== 'serie' && miembros.length && periodicos / miembros.length >= 0.8))) c._aRevista = true;
    if (CONSERVAR.has(id) || CONSERVAR.has(c.nombre) || (TIPOS_INTOCABLES.has(c.tipo) && !c._serieDeLibros) || c._aRevista || c.ruta_fija || c.raiz_web
        || miembros.some((d) => d.coleccion_fuente === 'manual')) {
        clase.set(id, 'intocable');
        continue;
    }
    let confirman = 0;
    let contradicen = 0;
    const seriesQueContradicen = new Set();
    const v = new Map();
    for (const d of miembros) {
        const s = elegirSerie(d._series, c.nombre);
        if (!s) continue;
        if (mismaSerie(s.nombre, c.nombre)) {
            confirman++;
            const k = claveSerie(s.nombre);
            v.set(k, { serie: s, n: (v.get(k)?.n || 0) + 1 });
        } else if (!emparentadas(s.nombre, c.nombre)) {
            contradicen++;
            seriesQueContradicen.add(claveSerie(s.nombre));
        }
        // (Emparentadas —comparten una palabra con cuerpo: «Selecciones del Séptimo Círculo» y «Colección El Séptimo
        // Círculo. Policiaca»— ni confirman ni desmienten: es la misma serie mal escrita o una subserie.)
    }
    votos.set(id, v);
    c._confirman = confirman;
    c._contradicen = contradicen;
    const editorial = c.editorial ? nombreEditorial.get(String(c.editorial)) : null;
    // DE CARPETA solo si hay motivo, no por falta de datos (una colección real sin ISBN —Solaris, Bob Morane— no es
    // una carpeta porque la autoridad no la conozca):
    //   · nombre de artefacto («MIT.Press.Nonfiction.Ebook-2021-PHC», «Untitled-9») o de pura materia («English
    //     Literature», «Quimica», «Cinema»), salvo que sus libros la confirmen;
    //   · la autoridad la DESMIENTE: es un saco grande de libros de muchas series (20+ libros de 10+ series ajenas, y
    //     más del doble de los que la confirman), sin ISSN propio («University Press Collection», «English
    //     Literature»). Unos pocos libros con otra serie NO bastan: en una colección real (Solaris, Nosferatu,
    //     «Descubrir la filosofía») hay reediciones que la autoridad cataloga en su serie de origen;
    //   · lleva por nombre el de una EDITORIAL («Cornell Univerity Press»): eso es una carpeta, no una serie;
    //   · de UN solo libro y nada dice que sea una serie editorial (regla del usuario: si no referencia una
    //     colección real de una editorial, se retira y el libro queda libre).
    const desmentida = !c.issn && contradicen >= 20 && seriesQueContradicen.size >= 10 && contradicen > 2 * confirman;
    const nombreDeEditorial = !c.issn && !confirman && RE_NOMBRE_EDITORIAL.test(String(c.nombre).trim());
    // Nombre que es un ISSN («0262-3617»): la serie existe; se le pone su nombre (fase 2) en vez de deshacerla.
    const issnDelNombre = RE_ISSN.test(String(c.nombre).trim()) ? String(c.nombre).trim().toUpperCase() : null;
    const nombreDelIssn = issnDelNombre && (serieCrossrefLocal(issnDelNombre)?.nombre || seriesDeISSN(issnDelNombre)[0]?.nombre);
    if (nombreDelIssn) c._serieIssn = { nombre: nombreDelIssn, issn: issnDelNombre, numero: null, registros: 0 };
    // Nombre de pura materia: carpeta, salvo que Crossref tenga una serie que se llame EXACTAMENTE así (las series
    // académicas a veces lo hacen: «Contemporary Mathematics», «History of mathematics»).
    const generico = esNombreGenerico(c.nombre) && !seriesCrossrefPorNombre(c.nombre).length;
    const nombreMalo = !nombreDelIssn && (pareceArtefacto(c.nombre) || generico) && confirman < Math.max(1, contradicen);
    const unitariaSinAval = miembros.length <= 1 && !c.issn && !confirman && !nombreDelIssn && !esSerieEditorial(c.nombre, { editorial });
    clase.set(id, desmentida || nombreDeEditorial || nombreMalo || unitariaSinAval ? 'carpeta' : 'editorial');
    c._motivo = desmentida ? 'la autoridad la desmiente' : nombreDeEditorial ? 'es el nombre de una editorial' : nombreMalo ? 'nombre de carpeta o de materia' : unitariaSinAval ? 'un solo libro, sin aval' : null;
    if (EXPLICAR.has(id) || EXPLICAR.has(c.nombre)) console.log(`
[explicar] «${c.nombre}» · ${miembros.length} libros · confirman ${confirman} · contradicen ${contradicen} (${seriesQueContradicen.size} series) · issn ${c.issn || '—'} → ${clase.get(id)} (${c._motivo || 'editorial'})`);
}
pcl.fin();
const cuenta = (k) => [...clase.values()].filter((x) => x === k).length;
di(`Colecciones: ${colecciones.size} · editoriales ${cuenta('editorial')} · de carpeta ${cuenta('carpeta')} · intocables ${cuenta('intocable')}\n`);

// ─── Utilidades de escritura ─────────────────────────────────────────────────────────────────────────────
let librosCambiados = 0;
/**
 * Cambia la colección de un libro (o lo libera con destino null), con su entrada en el diario. En seco no escribe,
 * pero el estado en memoria cambia igual: así las fases siguientes cuentan lo que de verdad quedaría.
 */
async function moverLibro(d, destino, { numero = undefined, fuente = null, motivo }) {
    librosCambiados++;
    if (EJECUTAR) await escribirMovimiento(d, destino, { numero, fuente, motivo });
    const viejo = d.coleccion ? String(d.coleccion) : null;
    if (viejo) miembrosDe.set(viejo, (miembrosDe.get(viejo) || []).filter((x) => x !== d));
    Object.assign(d, destino ? { coleccion: destino._id, coleccion_nombre: destino.nombre } : { coleccion: null, coleccion_nombre: null });
    if (destino) {
        const k = String(destino._id);
        if (!miembrosDe.has(k)) miembrosDe.set(k, []);
        miembrosDe.get(k).push(d);
    }
}

async function escribirMovimiento(d, destino, { numero, fuente, motivo }) {
    const antes = {
        coleccion: d.coleccion ?? null, coleccion_nombre: d.coleccion_nombre ?? null,
        coleccion_numero: d.coleccion_numero ?? null, coleccion_fuente: d.coleccion_fuente ?? null,
    };
    const set = { fecha_actualizacion: new Date() };
    const unset = {};
    if (destino) {
        set.coleccion = destino._id;
        set.coleccion_nombre = destino.nombre;
        if (fuente) set.coleccion_fuente = fuente;
        if (numero !== undefined) {
            if (numero) { set.coleccion_numero = String(numero); unset.coleccion_numero_auto = ''; } else { unset.coleccion_numero = ''; unset.coleccion_numero_auto = ''; }
        }
    } else {
        Object.assign(unset, { coleccion: '', coleccion_nombre: '', coleccion_numero: '', coleccion_numero_auto: '', coleccion_fuente: '' });
    }
    const upd = { $set: set, $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes }, alertas_agente: `Colección: ${motivo} (scripts/reorganizar-colecciones).` } };
    if (Object.keys(unset).length) upd.$unset = unset;
    await bib.updateOne({ _id: d._id }, upd);
    await indexarDoc(db, d._id).catch(() => {});
}

let retiradas = 0;
/** Retira una colección (ya sin libros): copia entera en colecciones_retiradas y la borra. */
async function retirarColeccion(c, motivo, miembros = []) {
    retiradas++;
    clase.set(String(c._id), 'retirada');
    if (!EJECUTAR) return;
    // Copia sin el _id (la retirada lleva el suyo) ni los campos de trabajo de este script (los que empiezan por «_»).
    const copia = Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('_')));
    // Por _id_original: si una pasada se cortó entre la copia y el borrado, la siguiente no duplica la copia.
    await db.collection('colecciones_retiradas').updateOne({ _id_original: c._id }, {
        $setOnInsert: { ...copia, _id_original: c._id, retirada: { fecha: new Date(), origen: ORIGEN, motivo, miembros: miembros.map((d) => d._id) } },
    }, { upsert: true });
    await colCol.deleteOne({ _id: c._id });
}

// Colección EDITORIAL de una serie: la que ya exista con ese nombre (o ISSN), si no, se crea. Las que reciben libros
// quedan como editoriales (la fase 4 no las toca aunque hubieran nacido de una carpeta).
const destinos = new Map();   // claveSerie → colección
async function coleccionDeSerie(serie) {
    const k = claveSerie(serie.nombre);
    if (destinos.has(k)) return destinos.get(k);
    // La que ya exista: por ISSN, por el mismo nombre, o por el mismo nombre más la editorial («Osprey Men at
    // Arms» para «Men-at-arms series»). También una de las ya elegidas como destino en esta pasada con un nombre
    // equivalente («Collected studies series» y «Variorum collected studies series» van a la misma).
    for (const cd of new Set(destinos.values())) {
        if ((serie.issn && cd.issn === serie.issn) || mismoNombreDeSerie(cd.nombre, serie.nombre) || mismaSerie(cd.nombre, serie.nombre)) {
            destinos.set(k, cd);
            return cd;
        }
    }
    const editorialesDe = (x) => (x.editorial ? [nombreEditorial.get(String(x.editorial))].filter(Boolean) : []);
    let c = [...colecciones.values()].find((x) => clase.get(String(x._id)) === 'editorial'
        && ((serie.issn && x.issn === serie.issn) || claveSerie(x.nombre) === k
            || mismoNombreDeSerie(x.nombre, serie.nombre, { editoriales: editorialesDe(x) })));
    if (!c && EJECUTAR) {
        const { _id } = await resolverCabecera(db, { nombre: serie.nombre, issn: serie.issn || null, tipo: 'libro' });
        c = await colCol.findOne({ _id });
        colecciones.set(String(_id), c);
    }
    if (!c) c = { _id: `nueva:${k}`, nombre: serie.nombre, issn: serie.issn || null, _nueva: true };   // en seco
    clase.set(String(c._id), 'editorial');
    destinos.set(k, c);
    return c;
}

// ─── FASE 1: nombres desfasados ──────────────────────────────────────────────────────────────────────────
if (FASES.has('1')) {
    const desfasados = docs.filter((d) => d.coleccion && colecciones.has(String(d.coleccion))
        && d.coleccion_nombre !== colecciones.get(String(d.coleccion)).nombre);
    const huerfanos = docs.filter((d) => d.coleccion && !colecciones.has(String(d.coleccion)));
    di(`FASE 1 · nombre de colección desfasado: ${desfasados.length} libros · apuntando a una colección que no existe: ${huerfanos.length}`);
    if (EJECUTAR) {
        const p1 = progreso(desfasados.length + huerfanos.length, 'Fase 1');
        for (const d of desfasados) {
            p1.paso(d.titulo);
            const nombre = colecciones.get(String(d.coleccion)).nombre;
            await bib.updateOne({ _id: d._id }, { $set: { coleccion_nombre: nombre, fecha_actualizacion: new Date() } });
            d.coleccion_nombre = nombre;
        }
        // Huérfano: su colección ya no existe → libre (con diario: el nombre que tenía queda en `antes`).
        for (const d of huerfanos) {
            p1.paso(d.titulo);
            await moverLibro(d, null, { motivo: `su colección «${d.coleccion_nombre || '?'}» ya no existía` });
        }
        p1.fin();
    }
    di('');
}

// ─── FASE 2: una serie, una colección ────────────────────────────────────────────────────────────────────
if (FASES.has('2')) {
    // Serie mayoritaria de cada colección editorial (según los libros que la confirman).
    const grupos = new Map();   // claveSerie → [{ c, serie }]
    for (const [id, c] of colecciones) {
        if (clase.get(id) !== 'editorial') continue;
        const v = votos.get(id);
        const top = v && [...v.values()].sort((a, b) => b.n - a.n)[0];
        // Solo se juntan colecciones con el MISMO nombre de serie (admitiendo la editorial delante: «Valdemar:
        // Gótica» con «Colección Gótica»), no una subserie con su serie («Breve historia: Conflictos» se queda), ni
        // nombres de pura materia («Historia» de una editorial no es la «Historia» de otra).
        const editoriales = c.editorial ? [nombreEditorial.get(String(c.editorial))].filter(Boolean) : [];
        const serieComun = c._serieIssn || (top && mismoNombreDeSerie(c.nombre, top.serie.nombre, { editoriales }) ? top.serie : null);
        if (esNombreGenerico(serieComun?.nombre || c.nombre)) continue;
        const k = serieComun ? claveSerie(serieComun.nombre) : claveSerie(c.nombre);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push({ c, serie: serieComun });
    }
    const fusiones = [...grupos.entries()].filter(([, g]) => g.length > 1);
    const seriesDeLibros = [...colecciones.values()].filter((c) => c._serieDeLibros && clase.get(String(c._id)) === 'editorial');
    di(`FASE 2 · «revistas» que son series de libros (pasan a tipo libro, con el nombre de su ISSN): ${seriesDeLibros.length}`);
    for (const c of seriesDeLibros) di(`   «${c.nombre}» (ISSN ${c.issn}, ${(miembrosDe.get(String(c._id)) || []).length} libros) → «${c._serieDeLibros.nombre}»`);
    const renombres = [...grupos.values()].filter((g) => g.length === 1 && g[0].serie && (pareceArtefacto(g[0].c.nombre) || g[0].c._serieIssn)
        && !pareceArtefacto(g[0].serie.nombre) && g[0].serie.nombre !== g[0].c.nombre);
    di(`FASE 2 · series repartidas en varias colecciones: ${fusiones.length} (${fusiones.reduce((s, [, g]) => s + g.length, 0)} colecciones) · nombres de artefacto que pasan al de la serie: ${renombres.length}`);
    for (const [, g] of fusiones.slice(0, 30)) di(`   ${g.map(({ c }) => `«${c.nombre}» (${(miembrosDe.get(String(c._id)) || []).length})`).join(' + ')}`);
    for (const [, g] of fusiones.slice(30)) anota(`   ${g.map(({ c }) => `«${c.nombre}» (${(miembrosDe.get(String(c._id)) || []).length})`).join(' + ')}`);
    for (const [unico] of renombres) anota(`   renombrar «${unico.c.nombre}» → «${unico.serie.nombre}»`);

    {
        const p2 = progreso(seriesDeLibros.length + fusiones.length + renombres.length, 'Fase 2');
        for (const c of seriesDeLibros) {
            p2.paso(c.nombre);
            if (EJECUTAR) {
                // El inventario de números (numeros[]) era de revista: queda en el diario, no en la colección.
                await colCol.updateOne({ _id: c._id }, {
                    $set: { tipo: 'libro', fecha_actualizacion: new Date() },
                    $unset: { numeros: '', numeros_sin_fecha: '', numeros_presentes: '' },
                    $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { tipo: c.tipo, numeros: c.numeros ?? null, numeros_sin_fecha: c.numeros_sin_fecha ?? null } } },
                });
            }
            c.tipo = 'libro';
            await renombrar(c, c._serieDeLibros);
        }
        for (const [k, g] of fusiones) {
            // Se queda la que ya se llama como la serie; si no, la más grande.
            const tam = (c) => (miembrosDe.get(String(c._id)) || []).length;
            const canonica = (g.find(({ c }) => claveSerie(c.nombre) === k) || [...g].sort((a, b) => tam(b.c) - tam(a.c))[0]).c;
            p2.paso(canonica.nombre);
            const serie = g.find((x) => x.serie)?.serie;
            if (serie && pareceArtefacto(canonica.nombre)) await renombrar(canonica, serie);
            if (EJECUTAR && serie?.issn && !canonica.issn) await colCol.updateOne({ _id: canonica._id }, { $set: { issn: serie.issn } });
            for (const { c } of g) {
                if (c === canonica) continue;
                const miembros = [...(miembrosDe.get(String(c._id)) || [])];
                for (const d of miembros) await moverLibro(d, canonica, { motivo: `«${c.nombre}» y «${canonica.nombre}» son la misma serie` });
                await retirarColeccion(c, `fundida en «${canonica.nombre}» (misma serie)`, miembros);
            }
            destinos.set(k, canonica);
        }
        for (const [unico] of renombres) {
            p2.paso(unico.c.nombre);
            await renombrar(unico.c, unico.serie);
        }
        p2.fin();
    }
    di('');
}

/** Renombra una colección al nombre de su serie (diario en la colección y nombre al día en sus libros). */
async function renombrar(c, serie) {
    if (c.nombre === serie.nombre) return;
    if (!EJECUTAR) { c.nombre = serie.nombre; return; }
    const antes = { nombre: c.nombre, issn: c.issn ?? null };
    await colCol.updateOne({ _id: c._id }, {
        $set: { nombre: serie.nombre, ...(serie.issn && !c.issn ? { issn: serie.issn } : {}), fecha_actualizacion: new Date() },
        $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes } },
    });
    await bib.updateMany({ coleccion: c._id }, { $set: { coleccion_nombre: serie.nombre } });
    for (const d of miembrosDe.get(String(c._id)) || []) d.coleccion_nombre = serie.nombre;
    c.nombre = serie.nombre;
}

// ─── FASE 2b: cada colección con documentos de su tipo ───────────────────────────────────────────────────
// Una colección de REVISTA admite números y artículos; una de LIBROS, libros, capítulos y apuntes. Un cómic vale en
// las dos (hay tebeos periódicos y en tomo). Medido el 2-oct: 88 colecciones de revista y 73 de libros mezcladas.
//   · la colección «de libros» que es una revista (_aRevista) → tipo revista;
//   · un LIBRO CON ISBN en la cabecera de una revista sale de ella (llegó por el nombre de una carpeta: los 37 libros
//     de astronomía en la revista «Astronomy»), salvo que sea una serie de libros con ISSN (eso lo arregla la fase 2);
//   · el resto de desajustes (un número suelto en una serie de libros, un libro sin ISBN en una revista…) no se
//     decide solo: selección «Tipo distinto del de su colección».
const desajustados = [];
const malTipados = [];


// Señales de que el documento es un NÚMERO de la revista `c`: su ISSN, una clave de número, una fecha en el nombre
// del fichero, o el nombre de la cabecera en su título acompañado de un número.
function pareceNumeroDe(d, c, { soloFuertes = false } = {}) {
    if (tieneSenalDeNumero(d, c)) return true;
    // El título solo es una señal débil («Marketing - 11. ed.» no es el nº 11 de la revista «Marketing»).
    if (soloFuertes || /d+s*(.|ª|a)?s*(ed|edici[oó]n|edition)/i.test(String(d.titulo || ''))) return false;
    const titulo = String(d.titulo || '');
    const palabrasCabecera = [...palabrasDeSerie(c.nombre)];
    const palabrasTitulo = palabrasDeSerie(titulo);
    return palabrasCabecera.length > 0 && palabrasCabecera.every((p) => palabrasTitulo.has(p)) && RE_NUMERO.test(titulo);
}


/**
 * Señales FUERTES de que el documento es un número de la revista `c`: su mismo ISSN, una clave de número, una fecha
 * en el nombre o el título, o un título que es solo la cabecera y un número («Nueva Dimensión 20»).
 */
function tieneSenalDeNumero(d, c) {
    if (c && c.issn && d.issn && String(d.issn).toUpperCase() === String(c.issn).toUpperCase()) return true;
    if (d.clave_numero && d.tipo_recurso === 'revista') return true;
    if (d.nombre_archivo && parsearNombre(d.nombre_archivo).esFechada) return true;
    if (RE_FECHA_NUMERO.test(String(d.titulo || '')) || RE_FECHA_NUMERO.test(String(d.nombre_archivo || '').replace(/\d{10,13}/g, ''))) return true;
    if (c) {
        const sobra = [...palabrasDeSerie(d.titulo)].filter((w) => !palabrasDeSerie(c.nombre).has(w));
        if (!sobra.length && palabrasDeSerie(c.nombre).size && RE_NUMERO.test(String(d.titulo || ''))) return true;
    }
    return false;
}

// Un número de revista SUELTO (de alguna cabecera): tiene clave, ISSN o fecha en el nombre.
const esNumeroDeRevista = (d) => !!(d.clave_numero || d.issn || (d.nombre_archivo && parsearNombre(d.nombre_archivo).esFechada));

/** 'mal-tipo' (el documento está mal catalogado) · 'fuera' (está mal metido en la colección) · null (no se sabe). */
function diagnosticar(d, c, tipoColeccion) {
    // La colección es el propio documento («Essays on the Theory of Numbers», «El extraño caso del doctor Jekyll…»):
    // nació de su título. Sale, y la colección vacía se retira.
    if ((miembrosDe.get(String(c._id)) || []).length === 1 && d.tipo_recurso === 'libro' && mismaSerie(c.nombre, d.titulo)) return 'fuera';
    if (tipoColeccion === 'revista') {
        if (d.tipo_recurso === 'libro') {
            // Señales fuertes de número (ISSN, clave, fecha en el nombre): es un número suyo tipado como libro.
            if (pareceNumeroDe(d, c, { soloFuertes: true })) return 'mal-tipo';
            if (d.isbn) return 'fuera';                    // un libro de verdad, metido por el nombre de una carpeta
            if (pareceNumeroDe(d, c)) return 'mal-tipo';   // solo el título lo sugiere, y no tiene ISBN
        }
        return null;
    }
    // Serie de libros.
    if (d.tipo_recurso === 'revista') {
        // Un libro con ISBN tipado como revista (como «Rosen»)… salvo que tenga señales de número: entonces el ISBN
        // es el que le atribuyó por error un catálogo de libros («Más Allá 1» con el de un manual de español).
        if (d.isbn && !esNumeroDeRevista(d) && !pareceNumeroDe(d, c)) return 'mal-tipo';
        if (d.isbn) return null;
        if (esNumeroDeRevista(d) && !(c.issn && d.issn === c.issn)) return 'fuera';   // un número de otra revista
        return null;
    }
    if (d.tipo_recurso === 'articulo') return 'fuera';      // un artículo no es un libro de la serie
    return null;
}

const motivoFuera = (d, tipo) => (tipo === 'revista'
    ? 'es un libro con ISBN en la cabecera de una revista (llegó por el nombre de una carpeta)'
    : d.tipo_recurso === 'articulo' ? 'es un artículo, no un libro de la serie' : 'es un número de otra revista, no un libro de la serie');

if (FASES.has('2')) {
    const COMPATIBLES = { revista: new Set(['revista', 'articulo']), libro: new Set(['libro', 'capitulo', 'apuntes']) };
    const esComic = (d) => ['comic', 'novela-grafica', 'tebeo', 'historieta', 'manga'].includes(String(d.naturaleza || '').toLowerCase());
    const aRevista = [...colecciones.values()].filter((c) => c._aRevista);
    let fuera = 0;
    for (const c of aRevista) {
        if (EJECUTAR) {
            await colCol.updateOne({ _id: c._id }, {
                $set: { tipo: 'revista', fecha_actualizacion: new Date() },
                $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { tipo: c.tipo ?? null } } },
            });
        }
        c.tipo = 'revista';
    }
    for (const [id, c] of colecciones) {
        const tipo = c.tipo === 'revista' ? 'revista' : (!c.tipo || c.tipo === 'libro') ? 'libro' : null;
        // (Las de carpeta las deshace la fase 4: sus desajustes no importan.)
        if (!tipo || clase.get(id) === 'retirada' || clase.get(id) === 'carpeta') continue;
        for (const d of [...(miembrosDe.get(id) || [])]) {
            if (COMPATIBLES[tipo].has(d.tipo_recurso) || esComic(d)) continue;
            if (c._serieDeLibros && d.tipo_recurso === 'libro') continue;
            // DOS DIAGNÓSTICOS POSIBLES (regla del usuario, 2-oct): o el DOCUMENTO está mal catalogado (un número de
            // esa revista tipado como libro, un libro con ISBN tipado como revista), o está MAL METIDO en la colección
            // (un libro en la cabecera de una revista por el nombre de una carpeta, un número de otra revista o un
            // artículo en una serie de libros). Se decide por sus señales; sin señales claras, a revisar.
            const diag = diagnosticar(d, c, tipo);
            if (diag === 'fuera' && d.coleccion_fuente !== 'manual') {
                fuera++;
                c._tocada = true;
                (fuera <= 25 ? di : anota)(`      fuera: «${String(d.titulo).slice(0, 60)}» (${d.tipo_recurso}${d.isbn ? ', ISBN' : ''}) de «${c.nombre}»`);
                await moverLibro(d, null, { motivo: `no pertenece a «${c.nombre}»: ${motivoFuera(d, tipo)}` });
                continue;
            }
            if (diag === 'mal-tipo') malTipados.push({ d, c, debe: tipo === 'revista' ? 'revista' : 'libro' });
            else desajustados.push({ d, c });
        }
    }
    // Las que se han quedado vacías (el libro que les daba nombre ha salido): se retiran.
    let vaciadas = 0;
    for (const [id, c] of colecciones) {
        if (clase.get(id) === 'retirada' || clase.get(id) === 'carpeta' || TIPOS_INTOCABLES.has(c.tipo) && c.tipo !== 'revista') continue;
        if ((miembrosDe.get(id) || []).length || !(c._tocada)) continue;
        vaciadas++;
        await retirarColeccion(c, 'vacía tras sacar los documentos que no eran de ella');
    }
    di(`FASE 2b · colecciones de libros que son revistas (pasan a tipo revista): ${aRevista.length}`);
    for (const c of aRevista) di(`   «${c.nombre}» (${(miembrosDe.get(String(c._id)) || []).length})`);
    const alarmas = [...malTipados, ...desajustados].length + fuera;
    di(`          ⚠ documentos de un tipo distinto del de su ISSN/colección (libro bajo una revista o al revés): ${alarmas}`);
    di(`          colecciones que se quedan vacías y se retiran: ${vaciadas}`);
    di(`          mal metidos en la colección (salen de ella): ${fuera} · mal catalogados (el tipo del documento está mal): ${malTipados.length} · sin señales claras, a revisar: ${desajustados.length}`);
    const porDebe = { revista: malTipados.filter((x) => x.debe === 'revista'), libro: malTipados.filter((x) => x.debe === 'libro') };
    di(`          · deberían ser REVISTA (números tipados como libro): ${porDebe.revista.length} · deberían ser LIBRO (con ISBN, tipados como revista): ${porDebe.libro.length}`);
    for (const { d, c, debe } of malTipados.slice(0, 15)) di(`      «${String(d.titulo).slice(0, 60)}» en «${c.nombre}» → ${debe}`);
    for (const { d, c, debe } of malTipados.slice(15)) anota(`      «${String(d.titulo).slice(0, 60)}» en «${c.nombre}» → ${debe}`);
    const porColeccion = new Map();
    for (const { d, c } of desajustados) {
        const k = `«${c.nombre}» (${c.tipo === 'revista' ? 'revista' : 'libros'}) ← ${d.tipo_recurso}`;
        porColeccion.set(k, (porColeccion.get(k) || 0) + 1);
    }
    const orden = [...porColeccion].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of orden.slice(0, 20)) di(`   ${String(n).padStart(5)} · ${k}`);
    for (const [k, n] of orden.slice(20)) anota(`   ${String(n).padStart(5)} · ${k}`);
    // El tipo NO se cambia aquí: cambiarlo mueve la carpeta (libros/ ↔ revistas/) y conviene mirarlo antes. Una
    // selección por tipo correcto, para aplicarlo en bloque con «🔀 Cambiar tipo».
    if (EJECUTAR && porDebe.revista.length) {
        await guardarSeleccion('Debería ser revista (según su colección)',
            'Documentos tipados como libro dentro de la cabecera de una revista, con señales de ser un número suyo (mismo ISSN, fecha o número en el nombre, título de la cabecera). Revísalos y usa 🔀 Cambiar tipo → Revista (scripts/reorganizar-colecciones, fase 2b).',
            porDebe.revista.map((x) => x.d._id));
    }
    if (EJECUTAR && porDebe.libro.length) {
        await guardarSeleccion('Debería ser libro (según su colección)',
            'Documentos tipados como revista dentro de una serie de libros y con ISBN propio: son libros catalogados como revista. Revísalos y usa 🔀 Cambiar tipo → Libro y después 🔎 Extraer ISBN (scripts/reorganizar-colecciones, fase 2b).',
            porDebe.libro.map((x) => x.d._id));
    }
    if (EJECUTAR && desajustados.length) {
        await guardarSeleccion('Tipo distinto del de su colección',
            'Documentos cuyo tipo no casa con el de su colección: un número de revista en una serie de libros, un libro sin ISBN en la cabecera de una revista… (scripts/reorganizar-colecciones, fase 2b). Corrige el tipo del documento (🔀 Cambiar tipo) o sácalo de la colección.',
            desajustados.map((x) => x.d._id));
    }
    di('');
}

// ─── FASE 3: libro a libro, por la autoridad ─────────────────────────────────────────────────────────────
const contradichos = [];
if (FASES.has('3')) {
    const transiciones = new Map();
    const entran = [];
    const pasan = [];
    let confirmadosSinFuente = 0;
    let claros = 0;
    const p3 = progreso(docs.length, 'Fase 3 · libros');
    for (const d of docs) {
        p3.paso(d.titulo);
        if (!d._series.length || d.coleccion_fuente === 'manual') continue;
        const c = d.coleccion ? colecciones.get(String(d.coleccion)) : null;
        const claseC = c ? clase.get(String(c._id)) : null;
        if (claseC === 'intocable') continue;
        const serie = elegirSerie(d._series, c?.nombre);
        if (!serie) continue;

        if (c && mismaSerie(serie.nombre, c.nombre) && claseC === 'carpeta') {
            // Su colección es su serie pero escrita como una carpeta que la autoridad desmiente en general (la
            // fase 4 la deshará): el libro va a la colección editorial de su serie, no a una selección.
            const destino = await coleccionDeSerie(serie);
            pasan.push(d);
            const k = `«${c.nombre}» → «${destino.nombre}»`;
            transiciones.set(k, (transiciones.get(k) || 0) + 1);
            await moverLibro(d, destino, { numero: serie.numero || d.coleccion_numero || null, fuente: 'autoridad', motivo: `de «${c.nombre}» a su serie editorial «${destino.nombre}»` });
            continue;
        }
        if (c && mismaSerie(serie.nombre, c.nombre)) {
            // Confirmado: se apunta de dónde viene y, si no tenía número, el de la autoridad.
            if (d.coleccion_fuente !== 'autoridad') {
                confirmadosSinFuente++;
                if (EJECUTAR) {
                    const set = { coleccion_fuente: 'autoridad' };
                    if (serie.numero && (!d.coleccion_numero || d.coleccion_numero_auto)) set.coleccion_numero = String(serie.numero);
                    await bib.updateOne({ _id: d._id }, { $set: set, ...(set.coleccion_numero ? { $unset: { coleccion_numero_auto: '' } } : {}) });
                }
            }
            continue;
        }
        if (!c || claseC === 'carpeta') {
            const destino = await coleccionDeSerie(serie);
            (c ? pasan : entran).push(d);
            const k = `${c ? `«${c.nombre}»` : '(sin colección)'} → «${destino.nombre}»`;
            transiciones.set(k, (transiciones.get(k) || 0) + 1);
            await moverLibro(d, destino, {
                numero: serie.numero || null, fuente: 'autoridad',
                motivo: c ? `de la carpeta «${c.nombre}» a su serie editorial «${destino.nombre}»` : `entra en su serie editorial «${destino.nombre}»`,
            });
            continue;
        }
        // Emparentadas (la misma serie escrita de otra forma, o una subserie): se deja como está.
        if (emparentadas(serie.nombre, c.nombre)) continue;
        // Dos colecciones editoriales distintas. Se decide solo si la autoridad lo dice CLARO (regla del usuario):
        // el Fichero y Crossref coinciden en la serie, o el Fichero le da además su NÚMERO en ella. Si no, a revisar.
        const coinciden = new Set(d._series.filter((x) => mismaSerie(x.nombre, serie.nombre)).map((x) => x.fuente)).size >= 2;
        if (coinciden || serie.numero) {
            const destino = await coleccionDeSerie(serie);
            claros++;
            const k = `«${c.nombre}» → «${destino.nombre}» (claro)`;
            transiciones.set(k, (transiciones.get(k) || 0) + 1);
            await moverLibro(d, destino, { numero: serie.numero || null, fuente: 'autoridad', motivo: `de «${c.nombre}» a «${destino.nombre}»: el Fichero${serie.numero ? ` (nº ${serie.numero})` : ''}${coinciden ? ' y Crossref' : ''} lo ponen en esa serie` });
            continue;
        }
        contradichos.push({ d, c, serie });
    }
    p3.fin();
    di(`FASE 3 · confirmados por la autoridad (se anota la procedencia): ${confirmadosSinFuente}`);
    di(`         sin colección → su serie: ${entran.length} · de una colección de carpeta → su serie: ${pasan.length}`);
    di(`         en otra colección editorial: ${claros} claros (pasan a su serie) · ${contradichos.length} a revisar`);
    di('   Transiciones más frecuentes:');
    const ordenT = [...transiciones].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of ordenT.slice(0, 30)) di(`   ${String(n).padStart(5)} · ${k}`);
    for (const [k, n] of ordenT.slice(30)) anota(`   ${String(n).padStart(5)} · ${k}`);
    const porRevisar = new Map();
    for (const { c, serie } of contradichos) {
        const k = `«${c.nombre}» ≠ «${serie.nombre}»`;
        porRevisar.set(k, (porRevisar.get(k) || 0) + 1);
    }
    di('   A revisar (colección editorial ≠ la serie que dice la autoridad):');
    const ordenR = [...porRevisar].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of ordenR.slice(0, 25)) di(`   ${String(n).padStart(5)} · ${k}`);
    for (const [k, n] of ordenR.slice(25)) anota(`   ${String(n).padStart(5)} · ${k}`);
    if (EJECUTAR && contradichos.length) {
        await guardarSeleccion('Colección contradicha por la autoridad',
            'Libros en una colección editorial distinta de la serie que dicen el Fichero/Crossref por su ISBN (scripts/reorganizar-colecciones, fase 3). Revísalos: tu libro puede ser otra edición, o la colección estar mal.',
            contradichos.map((x) => x.d._id));
    }
    di('');
}

/** Crea la selección o, si ya existe con ese nombre, la rehace (no duplica). */
// `sumar`: AÑADE a los que ya tenga en vez de sustituirlos. Lo usa la fase 4 para poder REANUDAR: si una pasada se
// corta después de liberar parte de los libros de una colección de carpeta, la siguiente solo ve los que quedan, y
// sustituir dejaría fuera de la selección a los ya liberados.
async function guardarSeleccion(nombre, descripcion, ids, { sumar = false } = {}) {
    const existe = await db.collection('selecciones').findOne({ nombre });
    if (existe) {
        const docs = sumar ? { $addToSet: { docs: { $each: ids } } } : {};
        await db.collection('selecciones').updateOne({ _id: existe._id }, {
            $set: { ...(sumar ? {} : { docs: ids }), descripcion, fecha_actualizacion: new Date() }, ...docs,
        });
        return existe._id;
    }
    return (await crearSeleccion(db, { nombre, descripcion, docs: ids }))._id;
}

// ─── FASE 4: las colecciones de carpeta que quedan ───────────────────────────────────────────────────────
if (FASES.has('4')) {
    const aSeleccion = [];
    const unitarias = [];
    const vacias = [];
    for (const [id, c] of colecciones) {
        if (clase.get(id) !== 'carpeta') continue;
        const miembros = miembrosDe.get(id) || [];
        if (!miembros.length) vacias.push(c);
        else if (miembros.length === 1) unitarias.push(c);
        else aSeleccion.push(c);
    }
    const n = (c) => (miembrosDe.get(String(c._id)) || []).length;
    di(`FASE 4 · colecciones de carpeta: ${aSeleccion.length} pasan a SELECCIÓN (${aSeleccion.reduce((s, c) => s + n(c), 0)} libros) · `
        + `${unitarias.length} de un libro se retiran (el libro queda libre) · ${vacias.length} vacías se retiran`);
    const orden = [...aSeleccion].sort((a, b) => n(b) - n(a));
    for (const c of orden.slice(0, 40)) di(`   ${String(n(c)).padStart(5)} · «${c.nombre}»${c._contradicen ? ` (la autoridad la contradice en ${c._contradicen})` : ''}`);
    for (const c of orden.slice(40)) anota(`   ${String(n(c)).padStart(5)} · «${c.nombre}»`);
    anota('   De un libro:');
    for (const c of unitarias) anota(`         «${c.nombre}» · ${(miembrosDe.get(String(c._id)) || [])[0]?.titulo || ''}`);

    {
        const p4 = progreso(aSeleccion.length + unitarias.length + vacias.length, 'Fase 4');
        for (const c of aSeleccion) {
            p4.paso(c.nombre);
            const miembros = [...(miembrosDe.get(String(c._id)) || [])];
            if (EJECUTAR) await guardarSeleccion(`Colección de carpeta · ${c.nombre}`.slice(0, 120),
                `Era la colección «${c.nombre}», que no es una serie editorial (nació de una carpeta o de un paquete de descarga). Se conserva la agrupación como selección (scripts/reorganizar-colecciones, fase 4).`,
                miembros.map((d) => d._id), { sumar: true });
            for (const d of miembros) await moverLibro(d, null, { motivo: `«${c.nombre}» no es una serie editorial; queda la selección «Colección de carpeta · ${c.nombre}»` });
            await retirarColeccion(c, 'de carpeta: convertida en selección', miembros);
        }
        for (const c of unitarias) {
            p4.paso(c.nombre);
            const miembros = [...(miembrosDe.get(String(c._id)) || [])];
            for (const d of miembros) await moverLibro(d, null, { motivo: `«${c.nombre}» no es una serie editorial (colección de un solo libro)` });
            await retirarColeccion(c, 'de carpeta, de un solo libro', miembros);
        }
        for (const c of vacias) {
            p4.paso(c.nombre);
            await retirarColeccion(c, 'vacía');
        }
        p4.fin();
    }
    di('');
}

di(`=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${librosCambiados} libros ${EJECUTAR ? 'cambiados' : 'cambiarían'} de colección · `
    + `${retiradas} colecciones ${EJECUTAR ? 'retiradas' : 'se retirarían'} (copiadas en colecciones_retiradas) ===`);
if (!EJECUTAR) di('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
if (RUTA_INFORME) {
    fs.writeFileSync(RUTA_INFORME, informe.join('\n') + '\n');
    console.log(`Informe completo: ${RUTA_INFORME}`);
}
process.exit(0);
