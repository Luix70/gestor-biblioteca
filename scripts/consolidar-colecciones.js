/**
 * Consolida las colecciones de LIBROS que quedaron DUPLICADAS por volumen antes del fix de ingesta
 * (una colección por tomo: «Alianza cien 15», «Alianza 100 10», …). Reutiliza `separarNumeroColeccion`
 * (mismo criterio que la ingesta):
 *   · calcula el nombre CANÓNICO de cada colección (separa el nº de volumen del nombre + aplica alias),
 *   · funde las que colapsan al mismo nombre (canónica = la que ya tiene el nombre limpio; si no, la de
 *     MÁS miembros), REASIGNA `biblioteca.coleccion` a la canónica y `coleccion_nombre` al nombre limpio,
 *   · RELLENA `coleccion_numero` de cada documento con el número que estaba embebido en el nombre de SU
 *     colección (si el documento no lo tenía ya),
 *   · borra las colecciones absorbidas (ya vacías).
 * NO toca cabeceras de revista (tipo:'revista'). DRY-RUN por defecto; --ejecutar aplica. Idempotente.
 *
 *   node scripts/consolidar-colecciones.js               (DRY-RUN)
 *   node scripts/consolidar-colecciones.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { separarNumeroColeccion } from '../src/utils/colecciones.js';

const EJECUTAR = process.argv.includes('--ejecutar');

async function main() {
    const db = await conectarDB();
    const colColecciones = db.collection('colecciones');
    const colBiblio = db.collection('biblioteca');

    const todas = await colColecciones.find({}).toArray();
    const libros = todas.filter((c) => c.tipo !== 'revista'); // las cabeceras de revista NO se tocan
    console.log(`\n📚 Colecciones: ${todas.length} (de libros: ${libros.length})`);

    // Nº de documentos miembro por colección (para elegir la canónica con menos reasignaciones).
    const miembros = new Map();
    for (const r of await colBiblio.aggregate([
        { $match: { coleccion: { $ne: null } } },
        { $group: { _id: '$coleccion', n: { $sum: 1 } } },
    ]).toArray()) {
        miembros.set(String(r._id), r.n);
    }
    const nMiembros = (id) => miembros.get(String(id)) || 0;

    // Agrupar por nombre canónico. Cada item guarda el número embebido en el nombre de ESA colección (o null).
    const grupos = new Map();
    for (const c of libros) {
        const { nombre, numero } = separarNumeroColeccion(c.nombre);
        const canon = nombre || c.nombre;
        const clave = canon.toLowerCase();
        if (!grupos.has(clave)) grupos.set(clave, { canon, items: [] });
        grupos.get(clave).items.push({ col: c, numero });
    }

    // Plan: grupos con >1 colección, o con una sola pero cuyo nombre hay que limpiar.
    const plan = [];
    for (const { canon, items } of grupos.values()) {
        const hayQueRenombrar = items.some((it) => it.col.nombre !== canon);
        if (items.length === 1 && !hayQueRenombrar) continue; // ya está bien

        // Canónica: la que YA tiene el nombre limpio; si no, la de más miembros; desempate por _id.
        items.sort((a, b) => {
            const aEx = a.col.nombre === canon ? 1 : 0, bEx = b.col.nombre === canon ? 1 : 0;
            return bEx - aEx || nMiembros(b.col._id) - nMiembros(a.col._id) || String(a.col._id).localeCompare(String(b.col._id));
        });
        const canonical = items[0].col;
        const absorbidos = items.slice(1).map((it) => it.col);
        const numeroPorCol = new Map(); // colecciónId → número embebido en su nombre (para rellenar los docs)
        for (const it of items) if (it.numero) numeroPorCol.set(String(it.col._id), it.numero);
        const ids = items.map((it) => it.col._id);
        const nDocs = ids.reduce((s, id) => s + nMiembros(id), 0);
        plan.push({ canon, canonical, absorbidos, numeroPorCol, ids, nDocs, rename: canonical.nombre !== canon });
    }

    // ── Informe ──────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n── Plan ${EJECUTAR ? '(EJECUTAR)' : '(DRY-RUN)'} ──`);
    console.log(`  Grupos a consolidar: ${plan.length}`);
    console.log(`  Colecciones a borrar (absorbidas): ${plan.reduce((s, p) => s + p.absorbidos.length, 0)}`);
    console.log(`  Documentos a reasignar/actualizar: ${plan.reduce((s, p) => s + p.nDocs, 0)}`);
    for (const p of plan.slice(0, 25)) {
        console.log(`\n  «${p.canon}»  (canónica: «${p.canonical.nombre}» · ${p.nDocs} doc)`);
        for (const a of p.absorbidos) console.log(`     ⇐ «${a.nombre}»`);
    }

    if (!EJECUTAR) {
        console.log('\n(DRY-RUN: no se ha escrito nada. Repite con --ejecutar para aplicar.)\n');
        process.exit(0);
    }

    // ── Aplicar ──────────────────────────────────────────────────────────────────────────────────────
    let nRen = 0, nDocU = 0, nDel = 0;
    for (const p of plan) {
        if (p.rename) {
            await colColecciones.updateOne({ _id: p.canonical._id }, { $set: { nombre: p.canon, fecha_actualizacion: new Date() } })
                .catch((e) => console.warn(`  ⚠️ renombrar ${p.canonical._id}: ${e.message}`));
            nRen++;
        }
        // Rellenar issn/editorial/cdu de la canónica desde las absorbidas si le faltan.
        const relleno = {};
        for (const a of p.absorbidos) {
            if (!p.canonical.issn && a.issn) relleno.issn = a.issn;
            if (!p.canonical.editorial && a.editorial) relleno.editorial = a.editorial;
            if (!p.canonical.cdu && a.cdu) relleno.cdu = a.cdu;
        }
        if (Object.keys(relleno).length) {
            await colColecciones.updateOne({ _id: p.canonical._id }, { $set: relleno }).catch(() => {});
        }

        // Reasignar TODOS los documentos del grupo → canónica; nombre canónico + nº embebido si faltaba.
        const docs = await colBiblio.find({ coleccion: { $in: p.ids } }, { projection: { coleccion: 1, coleccion_numero: 1 } }).toArray();
        for (const d of docs) {
            const set = { coleccion: p.canonical._id, coleccion_nombre: p.canon, fecha_actualizacion: new Date() };
            if (!d.coleccion_numero) {
                const num = p.numeroPorCol.get(String(d.coleccion));
                if (num) set.coleccion_numero = String(num);
            }
            await colBiblio.updateOne({ _id: d._id }, { $set: set }).catch((e) => console.warn(`  ⚠️ doc ${d._id}: ${e.message}`));
            nDocU++;
        }

        // Borrar las colecciones absorbidas (ya sin miembros).
        for (const a of p.absorbidos) {
            await colColecciones.deleteOne({ _id: a._id }).catch((e) => console.warn(`  ⚠️ borrar ${a._id}: ${e.message}`));
            nDel++;
        }
    }
    console.log(`\n✅ Hecho: ${nRen} renombrada(s), ${nDocU} documento(s) actualizado(s), ${nDel} colección(es) borrada(s).\n`);
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
});
