#!/usr/bin/env node
/**
 * reidentificar-sin-isbn.js — Recupera el ISBN que la ingesta NO capturó abriendo el PROPIO fichero del
 * documento, y con él pivota al Fichero local + APIs gratuitas para rellenar título/autores/editorial/sinopsis/
 * idioma/año. SIN IA (visión). Pensado sobre todo para los MIEMBROS DE COLECCIÓN (p. ej. TXtras), que se
 * catalogaron por el nombre de archivo sin abrir el fichero → 0 ISBN (ver docs/contexto y `transmedia.js`).
 *
 * Motor común `src/utils/reidentificar-doc.js` (el mismo de la ingesta y de la acción del panel), así que el
 * resultado es idéntico al de la Búsqueda. REANUDABLE por naturaleza: solo mira los documentos SIN ISBN, así
 * que re-ejecutar retoma donde lo dejó (los ya arreglados se saltan).
 *
 * ⚠ Corre en el NAS (docker exec -t) donde están los ficheros y el Fichero.db. Antes de `--ejecutar`: BACKUP
 * de la BD (escribe documentos: isbn/título/autores/editorial…).
 *
 * Alcance (por defecto: MIEMBROS DE COLECCIÓN sin ISBN, en formato pdf/epub/mobi):
 *   --coleccion <id|nombre>   solo esa colección
 *   --seleccion <id|nombre>   los documentos de una selección guardada
 *   --id <ObjectId>           uno solo
 *   --patron "<regex>"        por nombre_archivo
 *   --todos                   TODOS los documentos sin ISBN (no solo miembros de colección)
 *   --limite N                tope de candidatos (para probar)
 *   --sin-apis                solo el Fichero local (aún más barato; sin OpenLibrary/Google)
 *   --forzar                  re-cotejar AUNQUE ya tenga ISBN (arregla títulos-artefacto «DjVu Document»,
 *                             nombres de serie, truncados…). Exige acotar (id/colección/selección/patrón/limite).
 *   --con-ia                  si el TEXTO no da el ISBN, reextrae páginas y lee el código de barras/CIP por
 *                             visión (zxing local primero, sin coste); y permite enriquecer con IA.
 *   --cdu                     investiga/fuerza también la CDU del Dewey/LCC (crosswalk determinista → IA si
 *                             --con-ia). Por defecto apunta a los de CDU vacía/000; MUEVE la carpeta al aplicar.
 *   --id <ObjectId> --isbn <ISBN>   fija a mano el ISBN de UN documento y coteja desde él.
 *   --reintentar              repasa también los YA REVISADOS (los que no se encontraron en una pasada anterior).
 *   --edicion-por-elegir      los que esperan que elijas edición (Dashboard «Edición por elegir»): se re-investigan
 *                             con las pruebas nuevas (traductor, indicios de colección). Resultado: ISBN definitivo, PROVISIONAL
 *                             (varias ediciones de la misma editorial) o DUDOSO (una sola posible); si sigue ambiguo, se queda.
 *
 * YA REVISADOS: cada libro que se mira con --ejecutar queda marcado (la MISMA marca que la campaña «Recuperar ISBN
 * que faltan»), se encontrara o no. Las pasadas siguientes —y la campaña— lo saltan: la cola baja por todos los
 * mirados, no solo por los encontrados. Para una última vuelta sobre los que quedaron: --reintentar.
 *
 * Uso:
 *   node scripts/reidentificar-sin-isbn.js                          (dry-run, miembros de colección sin ISBN)
 *   node scripts/reidentificar-sin-isbn.js --coleccion "TXtras" --limite 10   (prueba)
 *   node scripts/reidentificar-sin-isbn.js --coleccion "TXtras" --ejecutar
 *   node scripts/reidentificar-sin-isbn.js --todos --ejecutar       (todo el catálogo sin ISBN)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { reidentificarDoc, resolverCduDoc, VERSION_RECUPERAR_ISBN, CAMPO_MARCA_RECUPERAR_ISBN, anotarRevisionIsbn } from '../src/utils/reidentificar-doc.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const TODOS = process.argv.includes('--todos');
const SIN_APIS = process.argv.includes('--sin-apis');
const FORZAR = process.argv.includes('--forzar');   // re-cotejar AUNQUE ya tenga ISBN (arregla títulos-artefacto)
const CON_IA = process.argv.includes('--con-ia');   // permite leer el ISBN por barras/visión y enriquecer con IA
const CON_CDU = process.argv.includes('--cdu');     // investigar/forzar también la CDU (crosswalk Dewey/LCC→CDU)
const REINTENTAR = process.argv.includes('--reintentar'); // repasar también los ya revisados que no se encontraron
const EDICION = process.argv.includes('--edicion-por-elegir'); // los que esperan que elijas edición: re-investigarlos
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const idArg = arg('--id');
const isbnArg = arg('--isbn');   // ISBN manual (solo con --id)
const patronArg = arg('--patron');
const colArg = arg('--coleccion');
const selArg = arg('--seleccion');
const limite = (() => { const n = parseInt(arg('--limite'), 10); return Number.isFinite(n) && n > 0 ? n : Infinity; })();
const PAUSA_MS = SIN_APIS ? 0 : 800; // ritmo entre documentos para no saturar las APIs gratuitas

const SIN_ISBN = { $or: [{ isbn: { $exists: false } }, { isbn: null }, { isbn: '' }] };

async function resolverColeccionArg(db, valor) {
    let c = ObjectId.isValid(valor) ? await db.collection('colecciones').findOne({ _id: new ObjectId(valor) }) : null;
    if (!c) c = await db.collection('colecciones').findOne({ nombre: valor });
    if (!c) { console.error(`⛔ colección no encontrada: «${valor}»`); process.exit(1); }
    return c._id;
}
async function idsDeSeleccion(db, valor) {
    let s = ObjectId.isValid(valor) ? await db.collection('selecciones').findOne({ _id: new ObjectId(valor) }) : null;
    if (!s) s = await db.collection('selecciones').findOne({ nombre: valor });
    if (!s) { console.error(`⛔ selección no encontrada: «${valor}»`); process.exit(1); }
    if (!(s.docs || []).length) { console.error(`⛔ la selección «${s.nombre}» está vacía.`); process.exit(1); }
    return s.docs;
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // --forzar re-coteja AUNQUE ya tenga ISBN → NO se filtra por «sin ISBN». Como eso podría abarcar TODO el
    // catálogo, exige acotar (id/colección/selección/patrón/limite), igual que reparar-portadas.
    const acotado = idArg || colArg || selArg || patronArg || Number.isFinite(limite);
    if (FORZAR && !TODOS && !acotado) {
        console.error('⛔ --forzar necesita acotar: --id / --coleccion / --seleccion / --patron / --limite (o --todos, con cuidado).');
        process.exit(1);
    }
    // Base del conjunto por defecto: --forzar → todos (acotado); --cdu → los de CDU vacía/000 (que suelen TENER
    // ISBN: reidentificarDoc no los tocará y resolverCduDoc les pone la CDU); si no → los SIN ISBN (recuperación).
    const CDU_VACIA = { $or: [{ cdu: { $in: ['000', '0', ''] } }, { cdu: null }, { cdu: { $exists: false } }] };
    const base = FORZAR ? {} : (CON_CDU ? { ...CDU_VACIA } : { ...SIN_ISBN });
    let filtro = { ...base };
    if (idArg) filtro = { _id: new ObjectId(idArg) };
    else if (selArg) filtro = { _id: { $in: await idsDeSeleccion(db, selArg) }, ...base };
    else if (colArg) filtro = { coleccion: await resolverColeccionArg(db, colArg), ...base };
    else if (patronArg) filtro = { nombre_archivo: { $regex: patronArg, $options: 'i' }, ...base };
    else if (EDICION) filtro = { 'ediciones_candidatas.0': { $exists: true }, isbn_provisional: { $ne: true }, ...base };
    else if (!TODOS) filtro = { coleccion: { $exists: true, $ne: null }, ...base }; // por defecto: miembros de colección
    // Solo formatos con ISBN de texto barato (pdf/epub/mobi); descarta audio/material/vídeo/software/djvu.
    if (!idArg && !EDICION) filtro.formatos = { $in: ['pdf', 'epub', 'mobi'] };   // (la edición por autoridad no necesita el fichero)
    // Solo LIBROS, como la campaña: sin revistas, cómics, audiolibros ni software (con --todos entraban las revistas
    // y recibían el ISBN de libros homónimos — 29-sep).
    if (!idArg) Object.assign(filtro, { tipo_recurso: 'libro', naturaleza: { $nin: ['comic', 'audiolibro', 'software'] } });

    // Modo RECUPERACIÓN (el normal: libros sin ISBN): salta los ya revisados, salvo --reintentar o un --id concreto.
    const RECUPERACION = !FORZAR && !CON_CDU;
    const NO_REVISADO = { $or: [{ [CAMPO_MARCA_RECUPERAR_ISBN]: { $exists: false } }, { [CAMPO_MARCA_RECUPERAR_ISBN]: { $ne: VERSION_RECUPERAR_ISBN } }] };
    let yaRevisados = 0;
    if (RECUPERACION && !idArg && !REINTENTAR && !EDICION) {
        yaRevisados = await col.countDocuments({ $and: [filtro, { [CAMPO_MARCA_RECUPERAR_ISBN]: VERSION_RECUPERAR_ISBN }] });
        filtro = { $and: [filtro, NO_REVISADO] };
    }

    const ids = (await col.find(filtro, { projection: { _id: 1 } }).limit(Number.isFinite(limite) ? limite : 0).toArray()).map((d) => d._id);
    console.log(`${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${ids.length} candidato(s)${FORZAR ? ' (forzando, incl. con ISBN)' : ' sin ISBN'}${CON_IA ? ' · con IA' : ''}${SIN_APIS ? ' · solo Fichero (sin APIs)' : ''}${REINTENTAR ? ' · reintentando los ya revisados' : ''}`);
    if (yaRevisados) console.log(`   (${yaRevisados} ya revisados antes sin éxito se saltan; --reintentar para repasarlos)`);
    console.log('');

    const st = { identificados: 0, sinFichero: 0, noHallado: 0, formato: 0, yaTiene: 0, ambiguos: 0, cdu: 0, fallos: 0, reintentar: 0, provisionales: 0, dudosos: 0 };
    const t0 = Date.now();
    let i = 0;
    for (const _id of ids) {
        let doc = await col.findOne({ _id });
        if (!doc) continue;
        i++;
        // Línea de progreso ANTES de trabajar el libro (se sobrescribe con \r): si uno se atasca, se ve cuál es.
        const seg = (Date.now() - t0) / 1000;
        const eta = i > 1 ? formatoDuracion(seg / (i - 1) * (ids.length - i + 1)) : '…';
        process.stdout.write(`\r\x1b[K   ⏳ ${i}/${ids.length} · ${(doc.titulo || '').slice(0, 40)} · identificados ${st.identificados} · ETA ${eta}`);
        let r;
        try {
            // Tope por libro: una espera de red eterna (API colgada) no puede parar la tanda — se salta y se apunta.
            r = await conTope(reidentificarDoc(db, doc, { aplicar: EJECUTAR, usarApis: !SIN_APIS, forzar: FORZAR, conIA: CON_IA, isbnManual: idArg ? isbnArg : null }), TOPE_LIBRO_MS);
        } catch (e) {
            st.fallos++;
            process.stdout.write(`\r\x1b[K[${i}/${ids.length}] ⛔ ${_id} · ${(doc.titulo || '').slice(0, 45)}: ${e.message}\n`);
            if (EJECUTAR && RECUPERACION) await anotarRevisionIsbn(db, _id, null).catch(() => {});   // intento, no marca
            continue;
        }
        // Marca «ya revisado» SOLO si no queda esperanza; si alguna fuente no respondió, se anota el intento.
        if (EJECUTAR && RECUPERACION) {
            if (await anotarRevisionIsbn(db, _id, r).catch(() => null) === 'reintentar') st.reintentar++;
        }

        if (r.estado === 'identificado' || r.estado === 'aplicado') {
            st.identificados++;
            if (r.provisional) st.provisionales++;
            if (r.dudoso) st.dudosos++;
            process.stdout.write(`\r\x1b[K[${i}/${ids.length}] ${EJECUTAR ? '✅' : '↪️'} ${_id} · ${(doc.titulo || '').slice(0, 45)} → ${r.resumen}\n`);
        } else if (r.estado === 'ambiguo') {
            // Varias ediciones posibles (o ninguna que confirme cuál es): NO se elige — se listan para ti.
            st.ambiguos++;
            process.stdout.write(`\r\x1b[K[${i}/${ids.length}] ❓ ${_id} · ${(doc.titulo || '').slice(0, 45)} → ${r.motivo}
`);
        } else if (r.estado === 'sin-fichero') st.sinFichero++;
        else if (r.estado === 'no-hallado') st.noHallado++;
        else if (r.estado === 'formato-no-soportado') st.formato++;
        else if (r.estado === 'ya-tiene-isbn') st.yaTiene++;

        // Paso CDU (opción --cdu): investiga/fuerza la CDU del Dewey/LCC (crosswalk → IA si --con-ia). Re-lee el
        // doc por si el ISBN cambió arriba. En dry-run informa el cambio propuesto; con --ejecutar mueve la carpeta.
        if (CON_CDU) {
            try {
                if (EJECUTAR) doc = await col.findOne({ _id }).catch(() => doc);
                const rc = await resolverCduDoc(db, doc, { conIA: CON_IA, forzar: FORZAR, aplicar: EJECUTAR });
                if (rc.estado === 'cdu-aplicada' || rc.estado === 'cdu-identificada') {
                    st.cdu++;
                    process.stdout.write(`\r\x1b[K[${i}/${ids.length}] ${EJECUTAR ? '🏷️' : '↪️'} ${_id} · CDU ${rc.de} → ${rc.cdu}\n`);
                }
            } catch { /* best-effort */ }
        }

        if (PAUSA_MS && (r.estado === 'identificado' || r.estado === 'aplicado')) await new Promise((res) => setTimeout(res, PAUSA_MS));
    }

    process.stdout.write('\r\x1b[K');
    console.log(`\n=== RESUMEN (${EJECUTAR ? 'APLICADO' : 'dry-run'}) ===`);
    console.log(`  ${EJECUTAR ? 'ISBN recuperados' : 'ISBN recuperables'} : ${st.identificados}`);
    if (st.provisionales) console.log(`    de ellos PROVISIONALES : ${st.provisionales}  (varias ediciones de la misma editorial; confirmables en la ficha)`);
    if (st.dudosos) console.log(`    de ellos DUDOSOS       : ${st.dudosos}  (única edición posible, sin confirmar)`);
    console.log(`  sin fichero en disco    : ${st.sinFichero}`);
    console.log(`  ISBN no hallado         : ${st.noHallado}  (el fichero no lo declara ni corrobora)`);
    console.log(`  formato no soportado    : ${st.formato}  (djvu/otros: sin ISBN de texto barato)`);
    if (CON_CDU) console.log(`  ${EJECUTAR ? 'CDU resueltas' : 'CDU resolubles'}      : ${st.cdu}  (del Dewey/LCC por crosswalk${CON_IA ? '+IA' : ''})`);
    if (st.ambiguos) console.log(`  edición ambigua         : ${st.ambiguos}  (título y autor casan, pero hay varias ediciones o ninguna confirmada → míralas tú)`);
    if (st.yaTiene) console.log(`  ya tenían ISBN          : ${st.yaTiene}`);
    if (st.reintentar) console.log(`  con esperanza           : ${st.reintentar}  (alguna fuente no respondió: NO se marcan, se reintentarán)`);
    if (st.fallos) console.log(`  fallos / saltados       : ${st.fallos}  (error o más de ${TOPE_LIBRO_MS / 60000} min con un libro; se reintentan en la próxima pasada)`);
    if (!EJECUTAR) console.log('\n▶ Ejecuta con --ejecutar para aplicar (haz COPIA DE SEGURIDAD de la BD antes).');
    process.exit(0);
}

// Tope de tiempo por libro (min): `--tope-min N` (por defecto 5).
const iTope = process.argv.indexOf('--tope-min');
const TOPE_LIBRO_MS = (iTope >= 0 ? Math.max(1, Number(process.argv[iTope + 1]) || 5) : 5) * 60 * 1000;

/** Resuelve la promesa o falla al cumplirse el tope (la tarea colgada sigue en segundo plano, pero la tanda avanza). */
function conTope(promesa, ms) {
    let temporizador;
    const tope = new Promise((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(new Error(`saltado: más de ${Math.round(ms / 60000)} min`)), ms);
    });
    return Promise.race([promesa, tope]).finally(() => clearTimeout(temporizador));
}

/** 3725 s → «1h 02m»; 95 s → «1m 35s». */
function formatoDuracion(seg) {
    seg = Math.round(seg);
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), sg = seg % 60;
    return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sg).padStart(2, '0')}s`;
}

main().catch((e) => { console.error(e); process.exit(1); });
