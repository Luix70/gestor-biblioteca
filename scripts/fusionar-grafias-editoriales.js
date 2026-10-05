/**
 * FUSIONAR LAS GRAFÍAS DE UNA MISMA EDITORIAL — «Emecé», «EMECÉ», «Emece Editores», «Emecé editores, s. a.» son la misma
 * editorial escrita de diez formas, y cada forma era una editorial distinta (medido el 5-oct: 983 grupos, 2.719
 * editoriales, 6.133 libros; John Wiley & Sons escrita de 13 maneras, Tusquets de 7…). Cada grupo se funde en UNA.
 *
 * MISMA EDITORIAL = mismo nombre sin mayúsculas, acentos, puntuación, la forma societaria («S.A.», «Inc.», «Ltd»,
 * «GmbH», «& Co.»), las palabras genéricas («Editorial», «Ediciones», «Editores», «Publishing», «Publishers»,
 * «Verlag», «Grupo», «Group») ni un año suelto al final («Emecé Editores S.A., 1997»). CONSERVADOR a propósito:
 *   · «Press» y «Books» SÍ cuentan: «Penguin Press» y «Penguin Books» son sellos distintos, y «Princeton University»
 *     no es «Princeton University Press»;
 *   · una palabra de más separa: «Emecé Editores España», «Alianza Emecé», «Oxford University Press, USA» quedan
 *     aparte (si son la misma, se funden a mano en la página Editoriales → 🔗 Combinar).
 *
 * Se queda la que tiene trabajo hecho a mano (logo, descripción, web); si no, entre las que tienen al menos la cuarta
 * parte de los libros de la más usada, la que no lleva nombre de empresa («Planeta» antes que «Grupo Planeta», «Random
 * House» antes que «Random House, Inc.»), escrita con mayúsculas y minúsculas, con más libros y con acentos («Emecé»
 * antes que «EMECE»). Los placeholders («Unknown», «Publisher Unknown») no se funden: no son editoriales. Las demás grafías pasan a sus
 * nombres alternativos (la ingesta las reconoce después) y sus libros a ella (utils/gestion-editoriales ·
 * fusionarEditoriales, lo mismo que «🔗 Combinar» en el panel). Antes de borrarlas, cada editorial absorbida se copia
 * entera en `editoriales_retiradas` (con la lista de sus libros), para poder deshacerlo.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/fusionar-grafias-editoriales.js             (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/fusionar-grafias-editoriales.js --ejecutar
 *   … --solo "<texto>"     solo los grupos cuyo nombre contenga ese texto (p. ej. «emece»)
 *   … --excluir <id>,…     editoriales que no se tocan
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { fusionarEditoriales } from '../src/utils/gestion-editoriales.js';
import { esEditorialFalsa } from '../src/utils/editoriales-falsas.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SOLO = arg('--solo');
const EXCLUIR = new Set(String(arg('--excluir') || '').split(',').map((s) => s.trim()).filter(Boolean));

const db = await conectarDB();
const colEd = db.collection('editoriales');
const bib = db.collection('biblioteca');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · grafías de una misma editorial\n`);

// Forma societaria y palabras genéricas que no distinguen una editorial de otra.
const RE_SOCIETARIA = /\b(s\.?\s?a\.?\s?u?|s\.?\s?l\.?\s?u?|s\.?\s?a\.?\s?de\s?c\.?\s?v\.?|s\.?\s?r\.?\s?l\.?|s\.?\s?p\.?\s?a\.?|inc|incorporated|ltd|ltda|limited|llc|l\.?\s?l\.?\s?c|gmbh|ag|kg|bv|nv|plc|pty|sarl|co|corp|corporation|company|& co|y cia|cia)\b\.?/gi;
const RE_GENERICAS = /\b(editorial|editoriales|ediciones|edicions|edicion|editores|editora|editrice|edizioni|editions|edition|publishing|publishers|publisher|pub|verlag|grupo|group)\b/gi;

/** Clave de agrupación: el nombre sin lo que no distingue una editorial de otra. */
function clave(nombre) {
    return String(nombre || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/&amp;/g, '&')
        .replace(/[,\s]+(1[5-9]|20)\d{2}\s*$/, '')            // «…, 1997»
        .replace(/&/g, ' and ')
        .replace(RE_SOCIETARIA, ' ')
        .replace(RE_GENERICAS, ' ')
        .replace(/\band\b/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

// ─── Grupos ──────────────────────────────────────────────────────────────────────────────────────────────
const editoriales = await colEd.find({}, { projection: { nombre: 1, logo: 1, descripcion: 1, web: 1, nombres_alternativos: 1 } }).toArray();
const libros = new Map((await bib.aggregate([{ $match: { editorial: { $ne: null } } }, { $group: { _id: '$editorial', n: { $sum: 1 } } }]).toArray())
    .map((x) => [String(x._id), x.n]));
const porClave = new Map();
for (const e of editoriales) {
    if (EXCLUIR.has(String(e._id))) continue;
    const k = clave(e.nombre);
    if (k.replace(/\s/g, '').length < 3) continue;          // «B», «SM»: demasiado corto para agrupar con seguridad
    if (!porClave.has(k)) porClave.set(k, []);
    porClave.get(k).push({ ...e, n: libros.get(String(e._id)) || 0 });
}

const mezcla = (t) => /\p{Ll}/u.test(t) && /\p{Lu}/u.test(t);                 // mayúsculas y minúsculas
const acentos = (t) => /[À-ſ]/.test(t);
const trabajoManual = (e) => !!(e.logo || e.descripcion || e.web);
// Nombre «de empresa» (grupo o forma societaria): «Grupo Planeta», «Random House Publishing Group», «Bloomsbury
// Publishing Plc». Se prefiere el nombre del sello («Planeta», «Random House») si tiene un número de libros comparable.
const RE_NOMBRE_DE_EMPRESA = new RegExp('\\b(grupo|group|inc|incorporated|ltd|limited|plc|llc|gmbh|corp|corporation|s\\.\\s?a|s\\.\\s?l)\\b', 'i');
function elegirDestino(grupo) {
    const conTrabajo = grupo.filter(trabajoManual);
    if (conTrabajo.length) return [...conTrabajo].sort((a, b) => b.n - a.n)[0];
    const maximo = Math.max(...grupo.map((e) => e.n));
    // Candidatas: las que tienen al menos la cuarta parte de los libros de la más usada.
    const candidatas = grupo.filter((e) => e.n >= maximo / 4);
    return [...candidatas].sort((a, b) => (RE_NOMBRE_DE_EMPRESA.test(a.nombre) - RE_NOMBRE_DE_EMPRESA.test(b.nombre))
        || (mezcla(b.nombre) - mezcla(a.nombre)) || (b.n - a.n) || (acentos(b.nombre) - acentos(a.nombre)) || (a.nombre.length - b.nombre.length))[0];
}

const grupos = [...porClave.values()]
    .filter((g) => g.length > 1)
    // «Unknown», «Publisher Unknown»: no son editoriales; no se funden (se quitan con reclasificar-editoriales).
    .filter((g) => !g.some((e) => esEditorialFalsa(e.nombre)))
    .filter((g) => !SOLO || g.some((e) => clave(e.nombre).includes(clave(SOLO)) || e.nombre.toLowerCase().includes(SOLO.toLowerCase())))
    .map((g) => ({ destino: elegirDestino(g), grupo: g }))
    .sort((a, b) => b.grupo.reduce((s, e) => s + e.n, 0) - a.grupo.reduce((s, e) => s + e.n, 0));

const aMover = grupos.reduce((s, x) => s + x.grupo.filter((e) => e !== x.destino).reduce((t, e) => t + e.n, 0), 0);
console.log(`Grupos de grafías: ${grupos.length} · editoriales que se funden: ${grupos.reduce((s, x) => s + x.grupo.length - 1, 0)} · libros que cambian de editorial: ${aMover}\n`);
for (const { destino, grupo } of grupos.slice(0, 60)) {
    console.log(`  «${destino.nombre}» (${destino.n}) ← ${grupo.filter((e) => e !== destino).map((e) => `«${e.nombre}» (${e.n})`).join(', ')}`);
}
if (grupos.length > 60) console.log(`  … y ${grupos.length - 60} grupos más`);

// ─── Ejecución ───────────────────────────────────────────────────────────────────────────────────────────
let fusionadas = 0;
let reasignados = 0;
if (EJECUTAR && grupos.length) {
    const p = progreso(grupos.length, 'Fundiendo');
    for (const { destino, grupo } of grupos) {
        p.paso(destino.nombre);
        const absorbidas = grupo.filter((e) => e !== destino);
        // Copia de cada editorial absorbida (con sus libros) antes de borrarla: así se puede deshacer.
        for (const e of absorbidas) {
            const suyos = await bib.find({ editorial: e._id }, { projection: { _id: 1 } }).toArray();
            const original = await colEd.findOne({ _id: e._id });
            if (!original) continue;
            const { _id, ...copia } = original;
            await db.collection('editoriales_retiradas').updateOne({ _id_original: e._id }, {
                $setOnInsert: { ...copia, _id_original: e._id, retirada: { fecha: new Date(), origen: 'fusionar-grafias-editoriales', fundida_en: destino._id, libros: suyos.map((d) => d._id) } },
            }, { upsert: true });
        }
        const r = await fusionarEditoriales(db, String(destino._id), absorbidas.map((e) => String(e._id)));
        if (r.ok) { fusionadas += r.fusionadas; reasignados += r.reasignados; } else p.nota(`  ⚠ «${destino.nombre}»: ${r.motivo}`);
    }
    p.fin();
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${fusionadas} editoriales fundidas · ${reasignados} libros reasignados` : `DRY-RUN · ${grupos.length} grupos · ${aMover} libros cambiarían`} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
else console.log('▶ Los sidecars de esos libros los rehace la campaña «sidecars»; el índice de búsqueda, «Reindexar».');
process.exit(0);
