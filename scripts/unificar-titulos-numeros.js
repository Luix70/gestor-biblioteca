/**
 * UNIFICAR LOS TÍTULOS DE LOS NÚMEROS DE REVISTA — todos los números de una cabecera con el mismo patrón:
 * «Easy Cook nº 219 (septiembre 2020)», «Popular Photography (marzo 2010)».
 *
 * Por qué (5-oct, a petición del usuario): muchos números se titulaban con lo que traía su PDF — la marca de agua de la
 * web de descargas («downmagaz.com», «Storemags - Free Magazines for all»), «Untitled», un resto del nombre del
 * fichero, la cabecera escrita de mil formas («Easy cook. Septiembre 2020», «Easy Cook #219») o el título de un libro
 * homónimo que les puso un catálogo de libros. La ingesta ya los compone así al resolver la cabecera
 * (motor-catalogo 2d, utils/revistas · tituloUnificadoDeNumero); esto arregla los que ya estaban.
 *
 * Con cada número de una cabecera de revista que tenga nº o año:
 *   · título = cabecera + nº + (mes año);
 *   · el título anterior, si era uno DE VERDAD (el tema de portada: «Especial Navidad»), pasa a SUBTÍTULO (si no tenía);
 *     si era basura o de un libro homónimo (lo marcan las alertas de catálogos de libros), solo queda en el diario.
 * Y las cabeceras escritas todo en minúsculas o todo en mayúsculas («easy cook», «DON MIKI») pasan a su grafía de
 * título («Easy Cook», «Don Miki»), y con ellas el nombre que llevan sus números.
 *
 * Solo toca la base (y el índice de búsqueda); no mueve carpetas (la de un número no depende de su título). Los
 * sidecars los rehace la campaña «sidecars». Diario `deshacer[]` (origen «unificar-titulos-numeros»).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/unificar-titulos-numeros.js                (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/unificar-titulos-numeros.js --ejecutar
 *   … --cabecera "<nombre>"   solo esa cabecera
 *   … --sin-grafia            no tocar la grafía de las cabeceras
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { tituloUnificadoDeNumero, capitalizarCabecera, claveNumero, tituloCabecera, normTituloPublicacion, RE_DATOS_DE_CATALOGO_DE_LIBROS } from '../src/utils/revistas.js';
import { registrarNumeroEnColeccion } from '../src/utils/colecciones.js';
import { parsearNombre, esTituloArtefacto } from '../src/utils/parsear-nombre.js';
import { cabeceraDeNombreDeFichero } from '../src/utils/cabecera-de-fichero.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SOLO_CABECERA = arg('--cabecera');
const SIN_GRAFIA = args.includes('--sin-grafia');
const ORIGEN = 'unificar-titulos-numeros';

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · títulos de los números de revista\n`);

const filtroCab = { tipo: 'revista', ...(SOLO_CABECERA ? { nombre: SOLO_CABECERA } : {}) };
const cabeceras = await colCol.find(filtroCab, { projection: { nombre: 1 } }, { collation: { locale: 'es', strength: 1 } }).toArray();

// Cabecera con nombre BASURA (de un fichero: «LeFigaro29», «Kiplinger's Personal Finance 2010-11», «cuadernosdecomic_5»,
// «downmagaz.net», «Le film franu00e7ais - 6»): componer títulos con él los estropearía. Se listan y se saltan.
const RE_CABECERA_BASURA = /\d[\d\s-]*$|_|\.(com|net|org|info)\b|u00[0-9a-f]{2}/i;
const esCabeceraBasura = (n) => RE_CABECERA_BASURA.test(String(n || '')) || String(n || '').length > 70 || esTituloArtefacto(String(n || ''));

// ─── 0. Cabeceras con nombre BASURA → el nombre que dicen los ficheros de sus números ─────────────────────
// «downmagaz.net» (era la marca de agua del título del primer número) tiene dentro «BBC Easy cook 2018 109.pdf»…:
// toma el nombre que dicen sus ficheros (el mayoritario, si lo dice la mitad o más). Si ya existe una cabecera con
// ese nombre (escrito junto, con otra grafía…), se FUNDE en ella; si no, se RENOMBRA. Sin nombre claro, se queda.
const compacto = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
// Para reconocer la misma revista: sin «BBC», «The», «Revista» delante ni «Magazine» detrás («BBC Easy Cook» = «Easy Cook»).
const compactoCabecera = (t) => compacto(String(t || '').replace(/^\s*((bbc|the|la revista de|revista|magazine)\s+)+/i, '').replace(/\s+(magazine|revista)\s*$/i, ''));
const todasLasCabeceras = await colCol.find({ tipo: 'revista' }, { projection: { nombre: 1, issn: 1 } }).toArray();
const cabeceraPorCompacto = new Map(todasLasCabeceras.filter((c) => !esCabeceraBasura(c.nombre)).map((c) => [compactoCabecera(c.nombre), c]));
const arreglos = [];
for (const c of cabeceras.filter((x) => esCabeceraBasura(x.nombre))) {
    const miembros = await bib.find({ coleccion: c._id }, { projection: { nombre_archivo: 1, coleccion_nombre: 1, clave_numero: 1, año_edicion: 1, mes_publicacion: 1, numero_issue: 1, issn: 1 } }).toArray();
    if (!miembros.length) continue;
    const votos = new Map();
    for (const m of miembros) {
        const n = cabeceraDeNombreDeFichero(m.nombre_archivo || '');
        if (!n || esCabeceraBasura(n)) continue;
        const k = compacto(n);
        votos.set(k, { nombre: votos.get(k)?.nombre || n, n: (votos.get(k)?.n || 0) + 1 });
    }
    const mejor = [...votos.values()].sort((a, b) => b.n - a.n)[0];
    if (!mejor || mejor.n / miembros.length < 0.5) continue;
    const destino = cabeceraPorCompacto.get(compactoCabecera(mejor.nombre));
    // Una «cabecera» de UN solo documento sin otra a la que unirse no se renombra: suele ser un libro o un artículo
    // tipado como revista (un preprint de arXiv, un VSI), no una revista. Se queda en la lista de revisar.
    if (!destino && miembros.length < 2) continue;
    arreglos.push({ c, miembros, nombre: mejor.nombre, destino: destino && String(destino._id) !== String(c._id) ? destino : null });
}
console.log(`Cabeceras con nombre de marca de agua o de fichero que toman el de sus números: ${arreglos.length}`);
for (const a of arreglos) console.log(`   «${a.c.nombre}» (${a.miembros.length}) → ${a.destino ? `se funde en «${a.destino.nombre}»` : `«${a.nombre}»`}`);
for (const a of arreglos) {
    if (EJECUTAR) {
        if (a.destino) {
            for (const m of a.miembros) {
                const set = { coleccion: a.destino._id, coleccion_nombre: a.destino.nombre, fecha_actualizacion: new Date() };
                if (a.destino.issn && !m.issn) set.issn = a.destino.issn;
                await bib.updateOne({ _id: m._id }, { $set: set, $push: {
                    deshacer: { fecha: new Date(), origen: ORIGEN, antes: { coleccion: m.coleccion ?? a.c._id, coleccion_nombre: m.coleccion_nombre ?? null, issn: m.issn ?? null } },
                    alertas_agente: `Cabecera «${a.c.nombre}» (nombre de una marca de agua) fundida en «${a.destino.nombre}» (scripts/unificar-titulos-numeros).`,
                } });
                await registrarNumeroEnColeccion(db, a.destino._id, { clave: m.clave_numero || null, 'año': m.año_edicion ?? null, mes: m.mes_publicacion ?? null, numero_issue: m.numero_issue ?? null }, m._id);
            }
            const { _id, ...copia } = a.c;
            await db.collection('colecciones_retiradas').updateOne({ _id_original: a.c._id }, { $setOnInsert: { ...copia, _id_original: a.c._id,
                retirada: { fecha: new Date(), origen: ORIGEN, motivo: `fundida en «${a.destino.nombre}»`, miembros: a.miembros.map((m) => m._id) } } }, { upsert: true });
            await colCol.deleteOne({ _id: a.c._id });
        } else {
            const choca = await colCol.findOne({ nombre: a.nombre, _id: { $ne: a.c._id } });
            if (choca) { console.log(`   · «${a.c.nombre}»: ya hay una «${a.nombre}» — sin cambiar`); continue; }
            await colCol.updateOne({ _id: a.c._id }, { $set: { nombre: a.nombre, fecha_actualizacion: new Date() }, $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { nombre: a.c.nombre } } } });
            await bib.updateMany({ coleccion: a.c._id }, { $set: { coleccion_nombre: a.nombre } });
        }
    }
    // En memoria, para las fases siguientes: la cabecera ya tiene nombre bueno (o ya no existe).
    if (a.destino) { a.c._fundida = true; } else { a.c.nombre = a.nombre; }
}
// Las fundidas desaparecen; sus números se unifican con su cabecera nueva en la fase 2.
for (const a of arreglos.filter((x) => x.destino)) {
    const i = cabeceras.indexOf(a.c);
    if (i >= 0) cabeceras.splice(i, 1);
    if (!cabeceras.some((x) => String(x._id) === String(a.destino._id))) cabeceras.push(a.destino);
}
const reasignados = new Map(arreglos.filter((x) => x.destino).flatMap((x) => x.miembros.map((m) => [String(m._id), x.destino._id])));
console.log('');

const cabecerasBasura = cabeceras.filter((c) => esCabeceraBasura(c.nombre));
const basuraIds = new Set(cabecerasBasura.map((c) => String(c._id)));
console.log(`Cabeceras con nombre de fichero (se saltan; limpiarlas aparte): ${cabecerasBasura.length}`);
for (const c of cabecerasBasura.slice(0, 20)) console.log(`   «${c.nombre}»`);

// ─── 1. Grafía de las cabeceras («easy cook» → «Easy Cook») ─────────────────────────────────────────────
const sinLetrasMixtas = (t) => /\p{L}/u.test(t) && (t === t.toLowerCase() || t === t.toUpperCase());
const renombres = SIN_GRAFIA ? [] : cabeceras
    .filter((c) => !basuraIds.has(String(c._id)) && sinLetrasMixtas(String(c.nombre || '')))
    .map((c) => ({ c, nuevo: capitalizarCabecera(c.nombre) }))
    .filter((x) => x.nuevo && x.nuevo !== x.c.nombre);
console.log(`Cabeceras con la grafía a corregir: ${renombres.length}`);
for (const { c, nuevo } of renombres.slice(0, 30)) console.log(`   «${c.nombre}» → «${nuevo}»`);
if (renombres.length > 30) console.log(`   … y ${renombres.length - 30} más`);
const nombreDe = new Map(cabeceras.map((c) => [String(c._id), c.nombre]));
for (const { c, nuevo } of renombres) {
    nombreDe.set(String(c._id), nuevo);
    if (!EJECUTAR) continue;
    // Si otra cabecera ya se llama así (índice único de nombre), no se toca: se fusionaría a mano.
    const choca = await colCol.findOne({ nombre: nuevo, _id: { $ne: c._id } });
    if (choca) { console.log(`   · «${c.nombre}»: ya hay una «${nuevo}» — sin cambiar (fusiónalas a mano)`); nombreDe.set(String(c._id), c.nombre); continue; }
    await colCol.updateOne({ _id: c._id }, {
        $set: { nombre: nuevo, fecha_actualizacion: new Date() },
        $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { nombre: c.nombre } } },
    });
    await bib.updateMany({ coleccion: c._id }, { $set: { coleccion_nombre: nuevo } });
}

// ─── 2. Títulos de los números ──────────────────────────────────────────────────────────────────────────
const idsCab = [...cabeceras.map((c) => c._id), ...arreglos.filter((x) => x.destino).map((x) => x.c._id)];
const filtro = { coleccion: { $in: idsCab }, tipo_recurso: 'revista' };
const PROY = { titulo: 1, subtitulo: 1, nombre_archivo: 1, numero_issue: 1, año_edicion: 1, mes_publicacion: 1, mes_fin_publicacion: 1, coleccion: 1, alertas_agente: 1, clave_numero: 1 };

/**
 * El Nº del número cuando no lo tiene en su ficha pero sí en el título o en el nombre del fichero: «Nueva Dimensión 2»,
 * «[Nueva Dimension 020] AA. VV. - …». Sin él, el título compuesto lo perdería («Nueva Dimensión (1968)»). Solo si lo
 * que queda al quitar la cabecera es un número (que no sea un año).
 */
function numeroDeTituloONombre(d, cabecera) {
    const cab = normTituloPublicacion(cabecera);
    for (const texto of [d.titulo, String(d.nombre_archivo || '').replace(/\.[^.]+$/, '')]) {
        const t = String(texto || '');
        if (normTituloPublicacion(tituloCabecera(t)) !== cab && !normTituloPublicacion(t).startsWith(cab + ' ')) continue;
        const resto = normTituloPublicacion(t).slice(cab.length).trim();
        const m = resto.match(/^(?:n[ºo]?\s*)?0*(\d{1,4})$/);
        if (m && !(+m[1] >= 1800 && +m[1] <= 2100)) return +m[1];
    }
    const pn = parsearNombre(d.nombre_archivo || '');
    if (pn.coleccion_numero && normTituloPublicacion(pn.coleccion_nombre || '') === cab) return +pn.coleccion_numero || null;
    return null;
}
const cambios = [];
let sinDatos = 0;
const p = progreso(await bib.countDocuments(filtro), 'Mirando los números');
for await (const d of bib.find(filtro, { projection: PROY })) {
    p.paso(d.titulo);
    if (reasignados.has(String(d._id))) d.coleccion = reasignados.get(String(d._id));
    if (basuraIds.has(String(d.coleccion))) continue;
    const cabecera = nombreDe.get(String(d.coleccion));
    // Sin Nº en la ficha: el del título o el del nombre del fichero (y con él, su clave de número).
    let numeroNuevo = null;
    if (d.numero_issue == null || String(d.numero_issue).trim() === '') {
        numeroNuevo = numeroDeTituloONombre(d, cabecera);
        if (numeroNuevo) d.numero_issue = numeroNuevo;
    }
    const contaminado = (d.alertas_agente || []).some((a) => RE_DATOS_DE_CATALOGO_DE_LIBROS.test(String(a)));
    const u = tituloUnificadoDeNumero(d, cabecera, { contaminado });
    if (!u) {
        if (!(d.numero_issue != null && String(d.numero_issue).trim()) && !parseInt(d.año_edicion, 10)) sinDatos++;
        continue;
    }
    cambios.push({ d, u, numeroNuevo });
}
p.fin();

const basura = cambios.filter((x) => x.u.basura).length;
const aSubtitulo = cambios.filter((x) => x.u.subtitulo).length;
console.log(`\nNúmeros con el título a unificar: ${cambios.length} (${basura} con un título basura · ${aSubtitulo} con un título de verdad que pasa a subtítulo · `
    + `${cambios.length - basura - aSubtitulo} con el de un libro homónimo, solo al diario)`);
console.log(`Números sin nº ni año (no se puede componer su título): ${sinDatos}`);
    console.log(`Números a los que se les pone el Nº que traía el título o el nombre del fichero: ${cambios.filter((x) => x.numeroNuevo).length}`);
for (const { u } of cambios.slice(0, 40)) console.log(`   «${String(u.anterior).slice(0, 45)}» → «${u.titulo}»${u.subtitulo ? ' (el anterior, a subtítulo)' : ''}`);

if (EJECUTAR && cambios.length) {
    const pe = progreso(cambios.length, 'Unificando títulos');
    for (const { d, u, numeroNuevo } of cambios) {
        pe.paso(u.titulo);
        const set = { titulo: u.titulo, fecha_actualizacion: new Date() };
        if (u.subtitulo) set.subtitulo = u.subtitulo;
        if (numeroNuevo) {
            set.numero_issue = numeroNuevo;
            const clave = claveNumero(d);
            if (clave) set.clave_numero = clave;
        }
        await bib.updateOne({ _id: d._id }, {
            $set: set,
            $push: {
                deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo: d.titulo ?? null, subtitulo: d.subtitulo ?? null, ...(numeroNuevo ? { numero_issue: null, clave_numero: d.clave_numero ?? null } : {}) } },
                alertas_agente: `Título «${u.anterior}» → «${u.titulo}» (el de los números de su cabecera)${u.subtitulo ? '; el anterior, a subtítulo' : ''} (scripts/unificar-titulos-numeros).`,
            },
        });
        // Con el Nº nuevo, su entrada en el inventario de la cabecera.
        if (numeroNuevo) {
            await registrarNumeroEnColeccion(db, d.coleccion, { clave: set.clave_numero || null, 'año': d.año_edicion ?? null, mes: d.mes_publicacion ?? null, numero_issue: numeroNuevo }, d._id);
        }
        await indexarDoc(db, d._id).catch(() => {});
    }
    pe.fin();
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${renombres.length} cabeceras con grafía corregida · ${cambios.length} títulos ${EJECUTAR ? 'unificados' : 'a unificar'} ===`);
if (!EJECUTAR) console.log('▶ Repite con --ejecutar (copia de la base antes).');
process.exit(0);
