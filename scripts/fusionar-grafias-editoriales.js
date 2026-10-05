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
 * SEGUNDO NIVEL (5-oct, «Montena/Mondiberica», «Montena División Infantil de Mondadori» → «Montena»): un nombre que
 * EMPIEZA por el de otra editorial se junta con ella si la mitad o más de sus libros con ISBN llevan un prefijo de
 * registrante que ya usa la otra. Junta sellos de una misma casa (Wiley-VCH → Wiley, Planeta México → Planeta);
 * `--sin-prefijo` lo desactiva. La ingesta aplica la misma regla (utils/resolver-editorial · buscarEditorial).
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
 *   … --sin-prefijo        solo grafías; sin el segundo nivel (nombre que empieza por el de otra + mismo ISBN)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { fusionarEditoriales } from '../src/utils/gestion-editoriales.js';
import { esEditorialFalsa } from '../src/utils/editoriales-falsas.js';
import { claveEditorial, asegurarClaves, prefijoIsbn, clavesPrefijo } from '../src/utils/resolver-editorial.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const SIN_PREFIJO = args.includes('--sin-prefijo');   // solo grafías: no junta sellos de una misma casa
const SOLO = arg('--solo');
const EXCLUIR = new Set(String(arg('--excluir') || '').split(',').map((s) => s.trim()).filter(Boolean));

const db = await conectarDB();
const colEd = db.collection('editoriales');
const bib = db.collection('biblioteca');

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · grafías de una misma editorial\n`);

// La clave es la de la ingesta (utils/resolver-editorial.js): lo que aquí se funde, allí se reconoce después.
const clave = claveEditorial;

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

// ─── Segundo nivel: el nombre EMPIEZA por el de otra editorial y comparten editor por el ISBN ─────────────────
// «Montena/Mondiberica», «Montena División Infantil de Mondadori España» → «Montena»: palabras de más, misma casa.
// El nombre solo no basta («Alianza Emecé» no es «Alianza» por llamarse así): hace falta que la MITAD O MÁS de sus
// libros con ISBN tengan un PREFIJO DE ISBN (registrante) que ya usa la madre. Con un solo libro en común se colaban
// sellos distintos por un libro mal asignado («Wiley-VCH» → «Wiley», «Random House Mondadori» → «Random House»).
// En la ingesta (buscarEditorial) la regla es la misma aplicada al único libro que entra.
const prefijosDe = new Map();   // id de editorial → prefijo de ISBN → nº de libros
for await (const d of bib.find({ editorial: { $ne: null }, isbn: { $exists: true } }, { projection: { editorial: 1, isbn: 1 } })) {
    const pref = prefijoIsbn(d.isbn);
    if (!pref) continue;
    const k = String(d.editorial);
    if (!prefijosDe.has(k)) prefijosDe.set(k, new Map());
    const m = prefijosDe.get(k);
    m.set(pref, (m.get(pref) || 0) + 1);
}
// Prefijo → nº de libros, sumado sobre las editoriales del grupo.
const prefijosDeGrupo = (g) => {
    const total = new Map();
    for (const e of g) for (const [pref, n] of prefijosDe.get(String(e._id)) || []) total.set(pref, (total.get(pref) || 0) + n);
    return total;
};
// ¿La mitad o más de los libros del hijo llevan un prefijo que ya usa la madre?
const comparten = (hijo, madreP) => {
    let dentro = 0, todos = 0;
    for (const [pref, n] of hijo) { todos += n; if (madreP.has(pref)) dentro += n; }
    return todos > 0 && dentro / todos >= 0.5;
};

// Unión de grupos: cada clave apunta a la de su editorial «madre» (la más corta que la contiene y la avala el ISBN).
const madre = new Map();
const raiz = (k) => { while (madre.has(k)) k = madre.get(k); return k; };
const porPrefijo = [];      // para el informe
for (const [k, g] of SIN_PREFIJO ? [] : porClave) {
    if (g.some((e) => esEditorialFalsa(e.nombre))) continue;
    const suyos = prefijosDeGrupo(g);
    if (!suyos.size) continue;
    for (const pref of clavesPrefijo(k)) {             // de la más corta a la más larga
        const otro = porClave.get(pref);
        if (!otro || otro.some((e) => esEditorialFalsa(e.nombre))) continue;
        if (!comparten(suyos, prefijosDeGrupo(otro))) continue;
        const r1 = raiz(k), r2 = raiz(pref);
        if (r1 !== r2) madre.set(r1, r2);
        porPrefijo.push(`«${g[0].nombre}» → «${otro[0].nombre}»`);
        break;
    }
}
const unidos = new Map();
for (const [k, g] of porClave) {
    const r = raiz(k);
    if (!unidos.has(r)) unidos.set(r, []);
    unidos.get(r).push(...g);
}
console.log(`Por principio de nombre + prefijo de ISBN: ${porPrefijo.length}`);
for (const x of porPrefijo.slice(0, 40)) console.log(`   ${x}`);
if (porPrefijo.length > 40) console.log(`   … y ${porPrefijo.length - 40} más`);
console.log('');

const grupos = [...unidos.values()]
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
    await asegurarClaves(db);   // las que no se fundieron también quedan con su clave para la ingesta
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${fusionadas} editoriales fundidas · ${reasignados} libros reasignados` : `DRY-RUN · ${grupos.length} grupos · ${aMover} libros cambiarían`} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
else console.log('▶ Los sidecars de esos libros los rehace la campaña «sidecars»; el índice de búsqueda, «Reindexar».');
process.exit(0);
