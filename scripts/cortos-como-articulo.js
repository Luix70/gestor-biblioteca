/**
 * DOCUMENTOS CORTOS CATALOGADOS COMO LIBRO O REVISTA — los pasa a artículo (o capítulo).
 *
 * Por qué (23-nov, al ingerir «_ARTE»): aparecían como LIBROS o REVISTAS PDFs de 1 a 11 páginas. Dos causas,
 * ya corregidas en la ingesta (este script repara lo de antes):
 *   1. La política por nº de páginas (discriminador·clasificarPorPaginas) SÍ los pasaba a artículo/capítulo, y lo
 *      dejaba dicho en la ficha («Escaneo de 4 páginas (< 12) sin ISBN propio → ARTÍCULO digital escaneado»),
 *      pero motor-enriquecimiento prefería el tipo que había dicho la VISIÓN («libro»), así que el tipo no
 *      cambiaba. Candidatos: los que llevan ese aviso y siguen siendo libro.
 *   2. Una REVISTA corta nunca se miraba: un año en el nombre («Aspden - A Theory of Pion Creation (1989).pdf»)
 *      la hacía número de revista, con una cabecera inventada con su propio título. Candidatos: revistas PDF de
 *      menos de 12 páginas SIN ISSN, sin cabecera o con una cabecera SOLO suya y sin ISSN (si la comparte con otros
 *      números, o tiene ISSN, es una revista de verdad con un número fino: se lista y se deja).
 *
 * Se SALTAN (y se listan) los que ya tienen ISBN: lo ganaron después (Fichero/APIs) y lo decide una persona.
 *
 * QUÉ SE HACE con cada uno (con --ejecutar; dry-run por defecto):
 *   1. tipo articulo / capitulo; fuera clave/mes/nº de número; sale del inventario de números de su cabecera.
 *      Si la cabecera era SOLO suya (inventada con su título): el título pierde el «nº 4 (1989)» que se le añadió,
 *      el documento deja la colección y la cabecera vacía se borra. Si la comparte, sigue en ella (artículo de esa
 *      revista, como hace la ingesta con los artículos por DOI).
 *   2. Carpeta a articulos/ o capitulos/ (recolocarSegunCdu), sidecars e índice al día.
 * Todo con diario `deshacer[]` (origen «cortos-como-articulo»). Mueve carpetas: correr en el NAS, con copia antes.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/cortos-como-articulo.js               (en seco: la lista)
 *   sudo docker exec -it gestor-biblioteca node scripts/cortos-como-articulo.js --ejecutar
 *   … --limite N        solo los N primeros (para probar)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { recolocarSegunCdu, carpetaDeDoc, aplicarCambio } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { eliminarColeccionVacia } from '../src/utils/gestion-grupos.js';
import { crearSeleccion } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = Number(arg('--limite')) || 0;
const ORIGEN = 'cortos-como-articulo';

// Los mismos umbrales que la ingesta (config.js · discriminador.js).
const PAG_PAPEL_MAX = Number(process.env.CLASIF_PAPEL_MAX_PAGINAS) || 12;
const PAG_CAPITULO_MAX = Number(process.env.CLASIF_CAPITULO_MAX_PAGINAS) || 20;

const db = await conectarDB();
const bib = db.collection('biblioteca');
const colCol = db.collection('colecciones');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · documentos cortos catalogados como libro o revista\n`);

// ─── Señales ─────────────────────────────────────────────────────────────────────────────────────────────
// El aviso que la política por páginas dejó en la ficha dice a qué tipo lo pasaba.
const RE_AVISO_ARTICULO = /→ ARTÍCULO digital escaneado/;
const RE_AVISO_CLASIFICADO = /→ clasificado como (articulo|capitulo)\b/;
const alertas = (d) => (d.alertas_agente || []).map(String);

/** 'articulo' | 'capitulo' según el aviso de la política, o null si no lo lleva. */
function tipoDelAviso(d) {
    for (const a of alertas(d)) {
        if (RE_AVISO_ARTICULO.test(a)) return 'articulo';
        const m = a.match(RE_AVISO_CLASIFICADO);
        if (m) return m[1];
    }
    return null;
}

/** La cabecera de una revista corta: ¿la sostiene algo (ISSN, otros números largos)? */
async function cabeceraDe(d) {
    if (!d.coleccion) return { col: null, otros: 0, sostenida: false };
    const col = await colCol.findOne({ _id: d.coleccion }, { projection: { nombre: 1, issn: 1, tipo: 1 } });
    const otros = await bib.countDocuments({ coleccion: d.coleccion, _id: { $ne: d._id } });
    const largos = await bib.countDocuments({ coleccion: d.coleccion, _id: { $ne: d._id }, paginas: { $gte: PAG_CAPITULO_MAX } });
    return { col, otros, sostenida: !!(col?.issn || largos) };
}

/** Quita el «nº 4 (1989)» / «(diciembre 2004)» que la ingesta de revistas añadió al nombre de la cabecera. */
function tituloSinNumero(titulo, nombreCabecera) {
    const t = String(titulo || '');
    const cab = String(nombreCabecera || '');
    if (!cab || !t.startsWith(cab)) return null;
    const resto = t.slice(cab.length);
    return /^\s*(nº\s*\d+)?\s*(\([^)]*\))?\s*$/.test(resto) && resto.trim() ? cab : null;
}

// ─── Candidatos ──────────────────────────────────────────────────────────────────────────────────────────
const PROY = { titulo: 1, tipo_recurso: 1, paginas: 1, isbn: 1, issn: 1, naturaleza: 1, formatos: 1, nombre_archivo: 1, alertas_agente: 1,
    coleccion: 1, coleccion_nombre: 1, clave_numero: 1, mes_publicacion: 1, numero_issue: 1, cdu: 1, ruta_base: 1 };
const filtro = {
    formatos: 'pdf',
    paginas: { $gte: 1, $lt: PAG_CAPITULO_MAX },
    naturaleza: { $ne: 'comic' },
    $or: [
        { tipo_recurso: 'libro', alertas_agente: { $in: [RE_AVISO_ARTICULO, RE_AVISO_CLASIFICADO] } },
        { tipo_recurso: 'revista', issn: { $exists: false } },
    ],
};
const total = await bib.countDocuments(filtro);
const aCambiar = [];
const saltados = [];
const pc = progreso(total, 'Mirando los documentos cortos');
for await (const d of bib.find(filtro, { projection: PROY })) {
    pc.paso(d.titulo);
    if (d.tipo_recurso === 'libro') {
        const tipo = tipoDelAviso(d);
        if (!tipo) continue;
        if (d.isbn) { saltados.push({ d, motivo: `tiene ISBN ${d.isbn} (ganado después)` }); continue; }
        aCambiar.push({ d, tipo, motivo: 'la política por páginas ya lo pasaba a ' + tipo, cab: null });
        continue;
    }
    // Revista corta sin ISSN. Umbral el de los escaneos (12) aunque sea legible, como la ingesta: los fanzines de
    // 13-18 páginas («Pinecone», «Journal of Vampirism») son números de verdad.
    if (d.paginas >= PAG_PAPEL_MAX) continue;
    if (d.isbn) { saltados.push({ d, motivo: `tiene ISBN ${d.isbn}` }); continue; }
    const cab = await cabeceraDe(d);
    if (cab.sostenida) { saltados.push({ d, motivo: `su cabecera «${cab.col?.nombre}» tiene ISSN o números largos` }); continue; }
    // Comparte cabecera con otros números: es una serie, lo decide una persona.
    if (cab.otros) { saltados.push({ d, motivo: `comparte la cabecera «${cab.col?.nombre}» con ${cab.otros} número(s) más` }); continue; }
    aCambiar.push({ d, tipo: 'articulo', motivo: `revista de ${d.paginas} páginas sin ISSN`, cab });
}
pc.fin();

const lista = LIMITE ? aCambiar.slice(0, LIMITE) : aCambiar;
console.log(`\nPASAN A ARTÍCULO / CAPÍTULO: ${aCambiar.length}${LIMITE ? ` (con --limite, ${lista.length})` : ''}`);
for (const { d, tipo, motivo, cab } of aCambiar) {
    const propia = cab?.col && !cab.otros ? ` · cabecera propia «${cab.col.nombre}» (se borra)` : (cab?.col ? ` · sigue en «${cab.col.nombre}»` : '');
    console.log(`  ${d._id} · ${d.tipo_recurso}→${tipo} · ${d.paginas} p · «${String(d.titulo).slice(0, 50)}» · ${String(d.nombre_archivo || '').slice(0, 50)} — ${motivo}${propia}`);
}
console.log(`\nSE QUEDAN COMO ESTÁN: ${saltados.length}`);
for (const { d, motivo } of saltados) console.log(`  ${d._id} · ${d.tipo_recurso} · ${d.paginas} p · «${String(d.titulo).slice(0, 50)}» — ${motivo}`);

// ─── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────
const resumen = { cambiados: 0, cabecerasBorradas: 0, recolocados: 0, errores: 0 };
if (EJECUTAR && lista.length) {
    const pe = progreso(lista.length, 'Pasando a artículo');
    for (const { d, tipo, motivo, cab } of lista) {
        pe.paso(d.titulo);
        try {
            const antes = {
                tipo_recurso: d.tipo_recurso, titulo: d.titulo, clave_numero: d.clave_numero ?? null, mes_publicacion: d.mes_publicacion ?? null,
                numero_issue: d.numero_issue ?? null, coleccion: d.coleccion ?? null, coleccion_nombre: d.coleccion_nombre ?? null,
            };
            const set = { tipo_recurso: tipo, fecha_actualizacion: new Date() };
            const unset = { clave_numero: '', mes_publicacion: '', numero_issue: '' };
            // Cabecera solo suya: era la de un «número» inventado → el doc sale de ella y recupera su título.
            const cabeceraPropia = cab?.col && !cab.otros;
            if (cabeceraPropia) {
                Object.assign(unset, { coleccion: '', coleccion_nombre: '', coleccion_fuente: '' });
                const limpio = tituloSinNumero(d.titulo, cab.col.nombre);
                if (limpio) set.titulo = limpio;
            }
            await bib.updateOne({ _id: d._id }, {
                $set: set, $unset: unset,
                $push: {
                    deshacer: { fecha: new Date(), origen: ORIGEN, antes },
                    alertas_agente: `Pasado de ${d.tipo_recurso} a ${tipo}: ${motivo} (scripts/cortos-como-articulo).`,
                },
            });
            if (d.coleccion) {
                await colCol.updateOne({ _id: d.coleccion }, { $pull: { numeros: { _id: d._id }, numeros_sin_fecha: d._id } });
                if (cabeceraPropia) {
                    const enObras = await db.collection('obras').countDocuments({ coleccion: d.coleccion }, { limit: 1 });
                    if (!enObras && (await eliminarColeccionVacia(db, d.coleccion)).ok) resumen.cabecerasBorradas++;
                }
            }
            resumen.cambiados++;

            // Carpeta a articulos/ o capitulos/ (recolocarSegunCdu MUEVE; el cambio en la base lo escribe aplicarCambio).
            let doc = await bib.findOne({ _id: d._id });
            const reub = await recolocarSegunCdu(doc).catch(() => null);
            if (reub?.set?.ruta_base) {
                await aplicarCambio(bib, doc, reub.carpetaNueva || carpetaDeDoc({ ...doc, ...reub.set }),
                    { set: reub.set, alertas: [`Carpeta recolocada según su tipo (scripts/${ORIGEN}).`, ...(reub.alertas || [])] });
                resumen.recolocados++;
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

    if (lista.length) {
        await crearSeleccion(db, {
            nombre: `Pasados a artículo por páginas (${lista.length})`,
            descripcion: 'PDFs cortos (menos de 12 páginas escaneadas o 20 legibles) que estaban como libro o revista sin ISBN/ISSN y se pasaron a artículo o capítulo (scripts/cortos-como-articulo). Para comprobar el resultado.',
            docs: lista.map((x) => x.d._id),
        });
    }
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${resumen.cambiados} cambiados · ${resumen.cabecerasBorradas} cabeceras inventadas borradas · ${resumen.recolocados} carpetas recolocadas · ${resumen.errores} errores` : `DRY-RUN · ${lista.length} pasarían a artículo/capítulo`} · ${saltados.length} se quedan ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js), en el NAS, y repite con --ejecutar (prueba primero con --limite 5).');
process.exit(0);
