// ── LIMPIAR COLECCIONES FALSAS (libro colgando de una colección de 1 miembro que NO es una serie real) ──
// Repara los libros que quedaron ligados a una colección-BASURA: una colección de UN SOLO miembro que es en
// realidad el nombre del propio fichero (p. ej. «Oxford.Faith.And.Its.Critics.») o una colección `tipo:revista`
// con un LIBRO dentro. Estas colecciones nacieron del bug «nombre fechado → revista» y se re-imponen al
// reprocesar en modo CONSERVADOR (el sidecar preserva `coleccion_nombre`). La cura es reprocesar «NUEVO DESDE
// CERO» (sin sidecar): se re-lee el CIP → ISBN/título/autor correctos, SIN la colección; luego se borra la
// colección vacía.
//
// Criterio (conservador, para NO tocar series de libros legítimas):
//   · colección de EXACTAMENTE 1 miembro, y ese miembro es un LIBRO, y ADEMÁS
//   · la colección es `tipo:revista` (un libro NO debe estar en una colección-revista), O
//   · su nombre es un NOMBRE-DE-FICHERO (palabras.unidas.por.puntos, sin espacios).
// (Una serie de libros real —nombre con espacios, tipo:libro— NO se toca aunque tenga 1 miembro.)
//
// SEGURO: dry-run por defecto. --ejecutar aplica. --limite N por tandas. Correr en el NAS (los ficheros
// están en el árbol CDU) y con el VIGILANTE ACTIVO (re-cataloga los ficheros devueltos al Inbox).
// ⚠ Haz COPIA DE SEGURIDAD antes de --ejecutar.
//   docker exec gestor-biblioteca node scripts/limpiar-colecciones-falsas.js            (lista, dry-run)
//   docker exec gestor-biblioteca node scripts/limpiar-colecciones-falsas.js --ejecutar --limite 10
import 'dotenv/config';
import { conectarDB } from '../src/database.js';
import { reprocesarDocumento } from '../src/utils/reproceso.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity; })();

// ¿El nombre de la colección es un NOMBRE-DE-FICHERO (palabras unidas por puntos, sin espacios)?
const esNombreFichero = (s) => { const t = String(s || '').trim(); return !!t && !/\s/.test(t) && /\.[^\s.]/.test(t); };

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    // Colecciones de EXACTAMENTE 1 miembro, con el miembro adjunto.
    const cols = await db.collection('colecciones').aggregate([
        { $lookup: { from: 'biblioteca', localField: '_id', foreignField: 'coleccion', as: 'm' } },
        { $match: { $expr: { $eq: [{ $size: '$m' }, 1] } } },
        { $project: { nombre: 1, tipo: 1, issn: 1, miembro: { $arrayElemAt: ['$m', 0] } } },
    ]).toArray();

    // Nombre inequívocamente BASURA: artefacto de producción ("Creator: Adobe…") o nombre-de-fichero
    // (palabras.unidas.por.puntos). Una SERIE de libros real nunca tiene un nombre así.
    const esArtefactoNombre = (s) => esTituloArtefacto(s) || esNombreFichero(s);
    const libros = cols.filter((c) => c.miembro?.tipo_recurso === 'libro');
    // AUTO (SEGURO): solo las de nombre-basura → reprocesar «nuevo desde cero».
    const objetivos = libros.filter((c) => esArtefactoNombre(c.nombre));
    // REVISAR (AMBIGUO, NO se toca): libro en colección-revista de nombre con ESPACIOS — puede ser una SERIE
    // real mal tipada (p. ej. «Progress in Mathematics», «UNITEXT for physics») que NO hay que destruir, o el
    // título del propio libro. Se reporta para decidir a mano (arreglar el tipo revista→libro, o limpiar).
    const revisar = libros.filter((c) => c.tipo === 'revista' && !esArtefactoNombre(c.nombre));

    console.log(`Colecciones de 1 miembro: ${cols.length} · con miembro LIBRO: ${libros.length}`);
    console.log(`  → AUTO-limpiar (nombre basura): ${objetivos.length}${EJECUTAR ? '' : ' (dry-run)'} · a REVISAR a mano (posible serie real): ${revisar.length}\n`);

    let hechos = 0, saltados = 0;
    for (const c of objetivos) {
        if (hechos >= LIMITE) break;
        const d = c.miembro;
        const motivo = c.tipo === 'revista' ? 'libro en colección-revista' : 'nombre-de-fichero';
        console.log(`  ${EJECUTAR ? '→' : '·'} «${String(c.nombre).slice(0, 46)}» (${c.tipo}) · ${motivo} · [${String(d.nombre_archivo || '').slice(0, 42)}] isbn=${d.isbn || '—'}`);
        if (!EJECUTAR) { hechos++; continue; }
        try {
            const colId = d.coleccion; // guardar antes de borrar el doc
            const r = await reprocesarDocumento(db, d, { conservar: false }); // NUEVO DESDE CERO (sin sidecar)
            if (!r.ok) { console.error(`      ✗ ${r.motivo}`); saltados++; continue; }
            // Borrar la colección si quedó vacía (el miembro ya se desvinculó/borró).
            let borradaCol = false;
            if (colId && await bib.countDocuments({ coleccion: colId }) === 0) {
                await db.collection('colecciones').deleteOne({ _id: colId }); borradaCol = true;
            }
            console.log(`      ✔ al Inbox «${r.inbox}» (nuevo desde cero) · colección ${borradaCol ? 'eliminada' : 'conserva miembros'}`);
            hechos++;
        } catch (e) { console.error(`      ✗ error: ${e.message}`); saltados++; }
    }

    console.log(`\n${EJECUTAR ? `Reprocesados: ${hechos}` : `A limpiar: ${hechos}`}${saltados ? ` · saltados (sin fichero/error): ${saltados}` : ''}.`);

    // Reporte de las AMBIGUAS (no se tocan): el usuario decide si son series reales (arreglar tipo→libro) o basura.
    if (revisar.length) {
        console.log(`\n── A REVISAR A MANO (${revisar.length}) — libro en colección-revista de nombre con espacios (¿serie real?) ──`);
        for (const c of revisar) console.log(`  ? «${String(c.nombre).slice(0, 52)}» · [${String(c.miembro.nombre_archivo || '').slice(0, 40)}]`);
        console.log('  (No se tocan. Si es una SERIE real, corrige su tipo revista→libro; si es el título del propio libro, límpiala a mano.)');
    }

    if (!EJECUTAR) console.log('\nDry-run. Con --ejecutar se aplica SOLO a las AUTO (⚠ BACKUP antes; Vigilante ACTIVO). --limite N por tandas.');
    else console.log('\nLos ficheros están en el Inbox: el Vigilante los re-cataloga limpios (ISBN del CIP, sin colección falsa).');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
