/**
 * SANEA las colecciones (de libros/series) cuyo nombre es un PLACEHOLDER/ARTEFACTO —su propio ISSN, un DOI
 * de Springer «10.1007%40978-…», un ISSN suelto— pero que SÍ tienen un ISSN de serie. Resuelve el nombre
 * REAL por ISSN (Wikidata, keyless, sin IA) y:
 *   · si YA existe otra colección con ese nombre real → FUNDE (reasigna los miembros a la real, le pasa el
 *     ISSN si le falta, y borra la placeholder), y borra de paso las HUÉRFANAS (0 miembros) duplicadas;
 *   · si no → RENOMBRA la placeholder al nombre real (y corrige tipo:'revista' de relleno SIN números →
 *     'libro'), y actualiza el coleccion_nombre denormalizado de sus miembros.
 * Restos típicos de una ingesta fallida (nombre-DOI). NO toca cabeceras de revista reales (con numeros[]).
 * DRY-RUN por defecto; --ejecutar aplica. Idempotente.
 *
 *   node scripts/sanear-colecciones-issn.js               (DRY-RUN)
 *   node scripts/sanear-colecciones-issn.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { nombreEsPlaceholder, claveCanonica } from '../src/utils/colecciones.js';
import { buscarNombrePorISSN } from '../src/utils/buscador-issn-titulo.js';

const EJECUTAR = process.argv.includes('--ejecutar');

async function main() {
    const db = await conectarDB();
    const cols = db.collection('colecciones');
    const bib = db.collection('biblioteca');

    // Candidatas: con ISSN y nombre placeholder/artefacto, SIN inventario cronológico de revista (numeros[]).
    const todas = await cols.find({ issn: { $exists: true, $ne: null } }).toArray();
    const cand = todas.filter((c) => nombreEsPlaceholder(c.nombre, c.issn) && !((c.numeros || []).length));
    console.log(`\n🗂️  Colecciones con ISSN: ${todas.length} · con nombre placeholder (sin numeros[]): ${cand.length}`);

    const nMiembros = async (id) => bib.countDocuments({ coleccion: id });
    const plan = [];
    for (const c of cand) {
        const r = await buscarNombrePorISSN(c.issn);
        if (!r?.nombre) { console.log(`  · ISSN ${c.issn} «${c.nombre}» → sin nombre en Wikidata (se deja)`); continue; }
        const gemela = await cols.findOne({ nombre: r.nombre, _id: { $ne: c._id } }, { collation: { locale: 'es', strength: 1 } });
        plan.push({ col: c, nombre: r.nombre, fuente: r.fuente, gemela, miembros: await nMiembros(c._id) });
    }

    console.log(`\n── Plan ${EJECUTAR ? '(EJECUTAR)' : '(DRY-RUN)'} ──`);
    for (const p of plan) {
        console.log(`  «${p.col.nombre}» (ISSN ${p.col.issn}, ${p.miembros} miembro/s) → «${p.nombre}»` +
            (p.gemela ? `  [FUNDE en la existente ${p.gemela._id}]` : '  [RENOMBRA]'));
    }
    if (!plan.length) { console.log('  (nada que sanear)'); }

    if (!EJECUTAR) { console.log('\n(DRY-RUN: no se ha escrito nada. Repite con --ejecutar.)\n'); process.exit(0); }

    let nRen = 0, nFus = 0, nDocs = 0, nDel = 0;
    for (const p of plan) {
        if (p.gemela) {
            // FUNDIR: los miembros de la placeholder → la gemela real; borra la placeholder; y SOLO ENTONCES
            // pásale su ISSN a la gemela (el índice único de issn no admite dos colecciones con el mismo →
            // hay que borrar la placeholder ANTES de escribir su issn en la gemela).
            const res = await bib.updateMany({ coleccion: p.col._id }, { $set: { coleccion: p.gemela._id, coleccion_nombre: p.nombre } });
            nDocs += res.modifiedCount || 0;
            const issnHuerfano = p.col.issn;
            await cols.deleteOne({ _id: p.col._id }).catch((e) => console.warn(`  ⚠️ borrar ${p.col._id}: ${e.message}`));
            nFus++; nDel++;
            const set = {};
            if (!p.gemela.issn && issnHuerfano) set.issn = issnHuerfano;
            if (!p.gemela.clave_canonica && claveCanonica(p.nombre)) set.clave_canonica = claveCanonica(p.nombre);
            if (Object.keys(set).length) await cols.updateOne({ _id: p.gemela._id }, { $set: set }).catch((e) => console.warn(`  ⚠️ issn gemela ${p.gemela._id}: ${e.message}`));
        } else {
            // RENOMBRAR la placeholder al nombre real (+ tipo libro si era revista de relleno) y sus miembros.
            const set = { nombre: p.nombre, fecha_actualizacion: new Date() };
            const k = claveCanonica(p.nombre); if (k) set.clave_canonica = k;
            if (p.col.tipo === 'revista') set.tipo = 'libro';
            await cols.updateOne({ _id: p.col._id }, { $set: set }).catch((e) => console.warn(`  ⚠️ renombrar ${p.col._id}: ${e.message}`));
            const res = await bib.updateMany({ coleccion: p.col._id }, { $set: { coleccion_nombre: p.nombre } });
            nDocs += res.modifiedCount || 0;
            nRen++;
        }
    }

    console.log(`\n✅ Hecho: ${nRen} renombrada(s), ${nFus} fundida(s) (${nDel} borrada(s)), ${nDocs} documento(s) actualizado(s).\n`);
    process.exit(0);
}

main().catch((e) => { console.error('❌ Error:', e); process.exit(1); });
