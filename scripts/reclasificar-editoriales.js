/**
 * RECLASIFICADOR del campo `editorial` en LOTE (CLI, para el NAS). Busca la editorial correcta de cada libro
 * en cascada (Fichero local → OpenLibrary → Google Books → IA opcional) y presenta un INFORME por transición.
 * Pensado para depurar en masa lo que la UI hace por selección (p. ej. los cientos de libros con «ePubLibre»,
 * que es un grupo de maquetación, no una editorial).
 *
 * Uso:
 *   node scripts/reclasificar-editoriales.js --editorial "ePubLibre"     (dry-run: solo informa)
 *   node scripts/reclasificar-editoriales.js --editorial "ePubLibre" --ejecutar
 *   node scripts/reclasificar-editoriales.js --id <editorialId> [--ejecutar]
 *   node scripts/reclasificar-editoriales.js --todos [--limite 500] [--ejecutar]   (TODOS los libros; con tope)
 *   node scripts/reclasificar-editoriales.js --sin-editorial [--ejecutar]          (libros SIN editorial: rellenar)
 *   node scripts/reclasificar-editoriales.js … --ia                                (permite IA como último recurso)
 *
 * SEGURO: dry-run por defecto (no escribe nada). --ejecutar aplica. ⚠ Copia de seguridad recomendada antes de
 * --ejecutar en lotes grandes. Correr en el NAS (o local con acceso a Atlas + Fichero + red).
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { calcularReclasificacion, aplicarReclasificacion } from '../src/utils/reclasificar-editorial.js';

const args = process.argv.slice(2);
const tieneFlag = (f) => args.includes(f);
const valorDe = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

const EJECUTAR = tieneFlag('--ejecutar');
const USAR_IA = tieneFlag('--ia');
const LIMITE = parseInt(valorDe('--limite') || '0', 10) || 0;
const FUENTE_ETQ = { archivo: 'Nombre', fichero: 'Fichero', coleccion: 'Colección', openlibrary: 'OpenLibrary', google: 'Google', 'coleccion-ia': 'Colección·IA', ia: 'IA·visión' };

async function seleccionarIds(db) {
    const bib = db.collection('biblioteca');
    const proj = { projection: { _id: 1 } };
    const aplicarLimite = (cur) => (LIMITE ? cur.limit(LIMITE) : cur);

    if (valorDe('--id')) {
        const _id = ObjectId.isValid(valorDe('--id')) ? new ObjectId(valorDe('--id')) : null;
        if (!_id) throw new Error('id de editorial inválido');
        return (await aplicarLimite(bib.find({ editorial: _id }, proj)).toArray()).map((d) => String(d._id));
    }
    if (valorDe('--editorial')) {
        const nombre = valorDe('--editorial');
        const ed = await db.collection('editoriales').findOne(
            { $or: [{ nombre: new RegExp('^' + nombre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }] },
            { projection: { _id: 1, nombre: 1 } },
        );
        if (!ed) throw new Error(`no existe la editorial «${nombre}»`);
        console.log(`Editorial objetivo: «${ed.nombre}» (${ed._id})`);
        return (await aplicarLimite(bib.find({ editorial: ed._id }, proj)).toArray()).map((d) => String(d._id));
    }
    if (tieneFlag('--sin-editorial')) {
        return (await aplicarLimite(bib.find({ tipo_recurso: 'libro', $or: [{ editorial: null }, { editorial: { $exists: false } }] }, proj)).toArray()).map((d) => String(d._id));
    }
    if (tieneFlag('--todos')) {
        return (await aplicarLimite(bib.find({ tipo_recurso: 'libro' }, proj)).toArray()).map((d) => String(d._id));
    }
    throw new Error('indica el conjunto: --editorial "Nombre" | --id <id> | --sin-editorial | --todos');
}

async function main() {
    console.log(`\nReclasificador de editoriales  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]${USAR_IA ? ' · IA habilitada' : ''}\n`);
    const db = await conectarDB();
    const ids = await seleccionarIds(db);
    if (!ids.length) { console.log('No hay libros que reclasificar con ese criterio.'); process.exit(0); }
    console.log(`Libros a examinar: ${ids.length}${LIMITE ? ` (limitado a ${LIMITE})` : ''}\n`);

    let ultimo = 0;
    const informe = await calcularReclasificacion(db, ids, {
        usarIA: USAR_IA,
        alPaso: (h, t) => { if (h - ultimo >= 25 || h === t) { ultimo = h; process.stdout.write(`\r  buscando… ${h}/${t}`); } },
    });
    process.stdout.write('\r' + ' '.repeat(40) + '\r');

    console.log('══════════════════════════════════════════════════════════════════════');
    console.log('INFORME');
    console.log(`  Total examinados : ${informe.total}`);
    console.log(`  Reclasificados   : ${informe.cambios}`);
    console.log(`  Quitada editorial: ${informe.eliminadosTotal} (quedan sin editorial)`);
    console.log(`  Sin cambio       : ${informe.sinCambio}`);
    console.log(`  No resueltos     : ${informe.noResueltos.length} (se dejan como están)\n`);

    if (informe.transiciones.length) {
        console.log('  ── Transiciones (origen → destino) ──');
        for (const t of informe.transiciones) {
            console.log(`     ${String(t.n).padStart(4)}  «${t.de}» → «${t.a}»  [${t.fuentes.map((f) => FUENTE_ETQ[f] || f).join(', ')}]`);
        }
        console.log('');
    }
    if (informe.eliminados.length) {
        console.log('  ── Quitada la editorial (sin reemplazo hallado; la actual es falsa) ──');
        for (const e of informe.eliminados) console.log(`     ${String(e.n).padStart(4)}  de «${e.de}» → sin editorial`);
        console.log('');
    }
    if (informe.noResueltos.length) {
        console.log(`  ── No resueltos (${informe.noResueltos.length}; se conservan) ──`);
        for (const x of informe.noResueltos.slice(0, 20)) console.log(`     · «${String(x.titulo || '—').slice(0, 55)}» (${x.editorial || 'sin editorial'})`);
        if (informe.noResueltos.length > 20) console.log(`     … y ${informe.noResueltos.length - 20} más`);
        console.log('');
    }

    if (!EJECUTAR) {
        console.log('Dry-run: no se ha escrito nada. Repite con --ejecutar para aplicar (⚠ backup recomendado).');
        process.exit(0);
    }
    if (!informe.plan || !informe.plan.length) { console.log('Nada que aplicar.'); process.exit(0); }
    console.log('Aplicando…');
    const r = await aplicarReclasificacion(db, informe.plan);
    console.log(`✓ Aplicado: ${r.cambios} reclasificado(s) · ${r.eliminadosTotal} sin editorial · ${r.creadas} editorial(es) nueva(s).`);
    process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
