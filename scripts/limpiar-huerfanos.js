// ── PODA DE HUÉRFANOS ────────────────────────────────────────────────────────────────────────────────
// Ninguna otra tarea (ni Integridad) limpia estos registros, así que se acumulan:
//   · AUTORES referenciados por 0 documentos (ni en `autores[]` ni en `contribuciones[].autor`).
//   · EDITORIALES referenciadas por 0 documentos NI por colecciones/obras.
//   · OBRAS y COLECCIONES sin ningún miembro (vacías).
// Son invisibles en el catálogo (o vacías) y se RECREAN solas (check-then-create en motor-catalogo) si un
// documento futuro las necesita, así que borrarlas es seguro. DRY-RUN por defecto; `--ejecutar` borra.
//   node scripts/limpiar-huerfanos.js            (cuenta, no escribe)
//   node scripts/limpiar-huerfanos.js --ejecutar (borra)
import 'dotenv/config';
import { conectarDB } from '../src/database.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const S = (x) => String(x);

async function refsEditorial(db) {
    // Una editorial puede estar referenciada por un documento, una colección (cabecera) o una obra.
    const set = new Set();
    for (const col of ['biblioteca', 'colecciones', 'obras']) {
        for (const id of await db.collection(col).distinct('editorial')) if (id) set.add(S(id));
    }
    return set;
}

async function refsAutor(db) {
    const set = new Set();
    // autores[] de cada documento (+ por si acaso, de obras/colecciones)
    for (const col of ['biblioteca', 'obras', 'colecciones']) {
        for (const id of await db.collection(col).distinct('autores')) if (id) set.add(S(id));
    }
    // contribuciones[].autor (traductor/ilustrador/…)
    for (const d of await db.collection('biblioteca').find({ contribuciones: { $exists: true, $ne: [] } }).project({ contribuciones: 1 }).toArray())
        for (const c of (d.contribuciones || [])) if (c && c.autor) set.add(S(c.autor));
    return set;
}

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    const refAut = await refsAutor(db);
    const autHuerf = (await db.collection('autores').find({}).project({ _id: 1 }).toArray())
        .filter(a => !refAut.has(S(a._id))).map(a => a._id);

    const refEd = await refsEditorial(db);
    const edHuerf = (await db.collection('editoriales').find({}).project({ _id: 1 }).toArray())
        .filter(e => !refEd.has(S(e._id))).map(e => e._id);

    const obVac = [];
    for (const o of await db.collection('obras').find({}).project({ _id: 1 }).toArray())
        if (await bib.countDocuments({ obra: o._id }) === 0) obVac.push(o._id);
    const colVac = [];
    for (const c of await db.collection('colecciones').find({}).project({ _id: 1 }).toArray())
        if (await bib.countDocuments({ coleccion: c._id }) === 0) colVac.push(c._id);

    console.log(`Huérfanos → autores: ${autHuerf.length} · editoriales: ${edHuerf.length} · obras vacías: ${obVac.length} · colecciones vacías: ${colVac.length}`);
    if (!EJECUTAR) { console.log('\n(dry-run) Relanza con --ejecutar para borrarlos.'); return; }

    const del = async (col, ids) => (ids.length ? (await db.collection(col).deleteMany({ _id: { $in: ids } })).deletedCount : 0);
    const a = await del('autores', autHuerf);
    const e = await del('editoriales', edHuerf);
    const o = await del('obras', obVac);
    const c = await del('colecciones', colVac);
    console.log(`Borrados → autores: ${a} · editoriales: ${e} · obras: ${o} · colecciones: ${c}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
