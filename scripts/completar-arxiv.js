#!/usr/bin/env node
/**
 * COMPLETAR CON ARXIV — los preprints de arxiv.org ya catalogados, con su ficha de arXiv (API gratuita, sin clave).
 *
 * Por qué (10-nov): 49 documentos se titularon con la MARCA LATERAL que arXiv imprime en el margen del PDF
 * («arXiv:hep-th/9912205 v3   23 Aug 2005»); la fecha de la marca los hizo pasar por números de REVISTA, cada uno con
 * su cabecera falsa, sin autores, con idioma «es» por defecto y casi todos en CDU 000. La ingesta ya los reconoce
 * (lector-pdf → orquestador → motor-enriquecimiento); esto arregla los de antes. Motor: src/utils/completar-arxiv.js.
 *
 * CANDIDATOS: documentos cuyo título es la marca de arXiv o un identificador suelto («math.CO/9902004»), cuyo nombre de
 * fichero lleva el identificador («0806.1234v1.pdf», «hep-th_9912205.pdf»), o que ya tienen `arxiv.id` pero no su ficha
 * (entraron con arXiv caído). Con --buscar-en-ficheros, además, los PDF sin ISBN cuya PRIMERA PÁGINA lleva la marca
 * (por defecto los de las clases 5 y 0 y los artículos/capítulos, ~2.100; con --todos, todos los PDF sin ISBN).
 *
 * QUÉ SE HACE (con --ejecutar; en seco solo se lista): título y autores de arXiv, tipo artículo/libro (fuera de la
 * cabecera falsa, que se borra si queda vacía), resumen, año, idioma (del texto del PDF), DOI y revista de origen,
 * materias, CDU por sus categorías (con la prioridad de siempre) y carpeta a la de su tipo. Diario `deshacer[]`.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/completar-arxiv.js                       (en seco: la lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/completar-arxiv.js --ejecutar
 *   … --buscar-en-ficheros [--todos]   busca también la marca dentro de los PDF (largo: guarda guion del seco)
 *   … --id <id>,<id>                   solo esos documentos
 *   … --limite N                       como mucho N documentos (para probar)
 *
 * ⚠ Mueve carpetas: correr en el NAS, con copia de la base antes (scripts/copia-base.js).
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { abrirGuion } from '../src/utils/guion-seco.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { textoPagina } from '../src/utils/lector-pdf.js';
import { buscarEnArxiv } from '../src/utils/buscador-arxiv.js';
import { arxivDeTexto } from '../src/utils/arxiv-id.js';
import { arxivDeDoc, arxivDeFichero, completarDesdeArxiv } from '../src/utils/completar-arxiv.js';
import { carpetaDeDoc, archivoOriginal } from '../src/mantenimiento/util-mantenimiento.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const EN_FICHEROS = args.includes('--buscar-en-ficheros');
const TODOS = args.includes('--todos');
const LIMITE = Number(arg('--limite')) || 0;
const IDS = String(arg('--id') || '').split(',').map((s) => s.trim()).filter((s) => ObjectId.isValid(s));

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · completar con arXiv\n`);

// ─── 1. Candidatos por título / nombre / ficha ───────────────────────────────────────────────────────────
// Prefiltro amplio en Mongo (cualquier mención de arXiv o de un archivo antiguo con 7 cifras, o un nombre que empieza
// por AAMM.nnnn); el filtro de verdad es arxivDeDoc (estricto: valida archivo, mes y longitud).
const ARCHIVOS = '(hep-th|hep-ph|hep-ex|hep-lat|gr-qc|quant-ph|astro-ph|cond-mat|nucl-th|nucl-ex|math-ph|math|physics|nlin|cs|q-bio|q-alg|alg-geom|dg-ga|funct-an|chao-dyn|solv-int|patt-sol|adap-org|supr-con|mtrl-th|atom-ph|chem-ph|plasm-ph|acc-phys|ao-sci|bayes-an|cmp-lg|comp-gas)';
const rePrevio = { $regex: `arxiv|${ARCHIVOS}(\\.[A-Za-z]{2})?[/_ -]?[0-9]{7}|^[0-9]{4}\\.[0-9]{4,5}`, $options: 'i' };
const filtro = IDS.length
    ? { _id: { $in: IDS.map((x) => new ObjectId(x)) } }
    : { $or: [{ titulo: rePrevio }, { nombre_archivo: rePrevio }, { 'arxiv.id': { $exists: true }, 'arxiv.categorias': { $exists: false } }] };
const candidatos = new Map();   // _id → { doc, ref }
for await (const doc of bib.find(filtro)) {
    const ref = arxivDeDoc(doc);
    if (ref) candidatos.set(String(doc._id), { doc, ref });
}
console.log(`   ${candidatos.size} documento(s) con identificador arXiv en el título, el nombre o la ficha.`);

// ─── 2. (Opcional) La marca dentro de los PDF ────────────────────────────────────────────────────────────
// Solo la primera página (pdftotext), que es donde arXiv estampa la marca. Largo → guion del seco: el --ejecutar
// siguiente con los mismos parámetros no vuelve a abrir los ficheros.
if (EN_FICHEROS && !IDS.length) {
    const guion = abrirGuion('completar-arxiv-ficheros', { parametros: { todos: TODOS } });
    let hallados = EJECUTAR ? (await guion.leer())?.acciones : null;
    if (!hallados) {
        const base = { formatos: 'pdf', isbn: { $exists: false }, 'arxiv.id': { $exists: false } };
        const fFich = TODOS ? base : { ...base, $or: [{ cdu: { $regex: '^(5|00|0$|000)' } }, { tipo_recurso: { $in: ['articulo', 'capitulo'] } }] };
        const total = await bib.countDocuments(fFich);
        const pf = progreso(total, 'Leyendo la 1.ª página de los PDF');
        hallados = [];
        for await (const doc of bib.find(fFich, { projection: { titulo: 1, nombre_archivo: 1, ruta_base: 1, cdu: 1, tipo_recurso: 1, isbn: 1, issn: 1, año_edicion: 1, mes_publicacion: 1 } })) {
            pf.paso(doc.titulo);
            if (candidatos.has(String(doc._id))) continue;
            const ruta = await archivoOriginal(carpetaDeDoc(doc), doc.nombre_archivo).catch(() => null);
            if (!ruta || !/\.pdf$/i.test(ruta)) continue;
            const ref = arxivDeTexto(await textoPagina(ruta, 1).catch(() => ''));
            if (ref) {
                hallados.push({ id: String(doc._id), arxiv: ref.id, version: ref.version });
                pf.nota(`   📄 ${ref.id} en «${String(doc.titulo).slice(0, 60)}»`);
            }
        }
        pf.fin();
        if (!EJECUTAR) await guion.guardar(hallados, { hallados: hallados.length });
    }
    for (const h of hallados) {
        const doc = await bib.findOne({ _id: new ObjectId(h.id) });
        if (doc && !candidatos.has(h.id)) candidatos.set(h.id, { doc, ref: { id: h.arxiv, version: h.version, origen: 'marca del PDF' } });
    }
    if (EJECUTAR) await guion.archivar();
    console.log(`   ${hallados.length} más con la marca de arXiv en su primera página.`);
}

let lista = [...candidatos.values()];
if (LIMITE) lista = lista.slice(0, LIMITE);
if (!lista.length) {
    console.log('\n   Nada que completar.\n');
    process.exit(0);
}

// ─── 3. Las fichas de arXiv (de 50 en 50, una consulta cada 3 s) ────────────────────────────────────────
const fichas = await buscarEnArxiv(lista.map((c) => c.ref.id));
if (fichas === null) {
    console.log('\n   ❌ arXiv no responde: inténtalo más tarde.\n');
    process.exit(1);
}

// ─── 4. Plan (y ejecución) documento a documento ─────────────────────────────────────────────────────────
const resumen = { completados: 0, sinCambios: 0, noHallados: 0, errores: 0 };
const tocados = [];
const noHallados = [];
const p = progreso(lista.length, EJECUTAR ? 'Completando' : 'Planificando');
for (const { doc, ref } of lista) {
    p.paso(doc.titulo);
    const ficha = fichas.get(ref.id);
    if (!ficha) {
        resumen.noHallados++;
        noHallados.push(doc);
        p.nota(`   ? ${doc._id} «${String(doc.titulo).slice(0, 60)}»: ${ref.id} no está en arXiv`);
        continue;
    }
    try {
        // El propio PDF (en el NAS): idioma del texto y versión de la marca.
        const fich = await arxivDeFichero(doc).catch(() => ({ arxiv: null, idioma: null }));
        const version = fich.arxiv?.id === ref.id ? (fich.arxiv.version ?? ref.version) : ref.version;
        const r = await completarDesdeArxiv(db, doc, ficha, { aplicar: EJECUTAR, idiomaFichero: fich.idioma, version });
        if (r.estado === 'sin-cambios') { resumen.sinCambios++; continue; }
        resumen.completados++;
        tocados.push(doc._id);
        p.nota(`   ${EJECUTAR ? '✅' : '·'} ${doc._id} ${ref.id} (${ref.origen}) «${String(doc.titulo).slice(0, 50)}» → «${String(ficha.titulo).slice(0, 60)}»`);
        for (const c of r.cambios) p.nota(`        ${c.campo}: ${c.de == null ? '∅' : String(c.de).slice(0, 50)} → ${String(c.a).slice(0, 90)}`);
        for (const a of r.avisos) p.nota(`        ⚠ ${a}`);
    } catch (e) {
        resumen.errores++;
        p.nota(`   ❌ ${doc._id} «${doc.titulo}»: ${e.message}`);
    }
}
p.fin();

if (EJECUTAR && tocados.length) {
    const nombre = 'Completados con arXiv';
    const ya = await db.collection('selecciones').findOne({ nombre }, { projection: { _id: 1 } });
    if (ya) await db.collection('selecciones').updateOne({ _id: ya._id }, { $addToSet: { docs: { $each: tocados } }, $set: { fecha_actualizacion: new Date() } });
    else await crearSeleccion(db, { nombre, descripcion: 'Preprints completados con su ficha de arXiv (scripts/completar-arxiv.js): título, autores, tipo, resumen, CDU y carpeta. Para comprobar el resultado.', docs: tocados });
    console.log(`\n   📋 Selección «${nombre}»: ${tocados.length} documento(s).`);
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${resumen.completados} ${EJECUTAR ? 'completados' : 'se completarían'} · ${resumen.sinCambios} ya al día · ${resumen.noHallados} no hallados en arXiv · ${resumen.errores} errores ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js), en el NAS, y repite con --ejecutar (prueba primero con --limite 3).');
process.exit(0);
