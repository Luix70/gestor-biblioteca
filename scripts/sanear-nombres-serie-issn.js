// ── SANEAR NOMBRES DE SERIE DESDE EL ISSN ────────────────────────────────────────────────────────────
// Corrige colecciones de SERIE cuyo nombre NO es el de la serie sino un TÍTULO DE LIBRO (o un placeholder):
// típicamente la primera monografía de una serie Springer se llevó su propio título a la cabecera (p. ej.
// «Continuum Mechanics using Mathematica…» en vez de «Modeling and Simulation in Science, Engineering and
// Technology», ISSN 2164-3679). Resuelve el nombre AUTORITATIVO desde el ISSN (Wikidata → ISSN Portal) y
// RENOMBRA. Solo renombra (no funde ni borra → cero pérdida de datos); si el nombre destino ya lo tiene otra
// colección, LO OMITE y lo lista (fusión manual). DRY-RUN por defecto; --ejecutar escribe.
//   node scripts/sanear-nombres-serie-issn.js            (diagnostica)
//   node scripts/sanear-nombres-serie-issn.js --ejecutar (renombra)
import 'dotenv/config';
import { conectarDB } from '../src/database.js';
import { nombreEsPlaceholder, nombreEsTituloDeMiembro } from '../src/utils/colecciones.js';
import { buscarNombrePorISSN } from '../src/utils/buscador-issn-titulo.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const _norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
    const db = await conectarDB();
    const col = db.collection('colecciones');
    // Series de LIBROS con ISSN (las revistas con inventario cronológico numeros[] se dejan aparte).
    const todas = await col.find({ issn: { $exists: true, $ne: null } }).toArray();
    let renombradas = 0, omitidas = 0, revisados = 0;
    for (const c of todas) {
        if ((c.numeros || []).length) continue; // revista con inventario → no aplica
        const sospechoso = nombreEsPlaceholder(c.nombre, c.issn) || await nombreEsTituloDeMiembro(db, c._id, c.nombre);
        if (!sospechoso) continue;
        revisados++;
        let real = null;
        try { real = await buscarNombrePorISSN(c.issn); } catch { /* red */ }
        if (!real || !real.nombre) { console.log(`  ·· ${c.issn}: sin nombre autoritativo (se deja «${String(c.nombre).slice(0, 40)}»).`); continue; }
        if (_norm(real.nombre) === _norm(c.nombre)) continue; // ya está bien
        const choca = await col.findOne({ nombre: real.nombre, _id: { $ne: c._id } }, { collation: { locale: 'es', strength: 1 } });
        if (choca) {
            omitidas++;
            console.log(`  ⚠ «${String(c.nombre).slice(0, 34)}» → «${real.nombre}» OMITIDA (ya existe otra con ese nombre: ${choca._id}; fusión manual).`);
            continue;
        }
        renombradas++;
        console.log(`  ✓ «${String(c.nombre).slice(0, 34)}» → «${real.nombre}» (ISSN ${c.issn}, ${real.fuente}).`);
        if (EJECUTAR) await col.updateOne({ _id: c._id }, { $set: { nombre: real.nombre, fecha_actualizacion: new Date() } });
    }
    console.log(`\nCon ISSN: ${todas.length} · sospechosas revisadas: ${revisados} · renombradas: ${renombradas} · omitidas (colisión): ${omitidas}`);
    if (!EJECUTAR) console.log('(dry-run) Relanza con --ejecutar para renombrar.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
