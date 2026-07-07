// ── RECLASIFICAR revistas que son LIBROS por SEÑAL FUERTE (no por colección) ─────────────────────────────
// Complementa a reclasificar-revistas-a-libros.js (que iba por colección-de-1). Aquí se cogen las revistas
// con SEÑAL FUERTE de libro: bloque CIP en las alertas, o ISBN PROPIO (no del cuerpo), o nombre con prefijo de
// EDITORIAL. NO se usan Dewey/LC ni ISBN-de-cuerpo (a las revistas también se les asigna Dewey, y un ISBN del
// cuerpo suele ser de un anuncio → falsos positivos tipo «Direction Italie»). Cada una se reprocesa «NUEVO
// DESDE CERO» (sin sidecar): re-lee el CIP y la re-cataloga como el libro que es (ISBN correcto, sin quedar
// como revista); su carpeta va a la Papelera (recuperable).
//
// SEGURO: dry-run por defecto. --ejecutar aplica. --limite N. Correr en el NAS (ficheros en el árbol CDU),
// Vigilante ACTIVO. ⚠ BACKUP antes de --ejecutar.
//   docker exec gestor-biblioteca node scripts/reclasificar-revistas-por-senal.js            (lista)
//   docker exec gestor-biblioteca node scripts/reclasificar-revistas-por-senal.js --ejecutar
import 'dotenv/config';
import { conectarDB } from '../src/database.js';
import { reprocesarDocumento } from '../src/utils/reproceso.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity; })();

const EDIT_RX = /^(Apress|Wrox|Oxford|Packt|OReilly|Oreilly|Cambridge|Springer|Wiley|McGraw|Microsoft\.?Press|Manning|Peachpit|Course\.Technology|Sams|Addison|Pearson|Elsevier|Academic|CRC|Routledge|No\.?Starch|Prentice)/i;

// SEÑAL FUERTE de libro (fiable, sin falsos positivos de revista): CIP, ISBN PROPIO, o prefijo de editorial.
function senalLibro(d) {
    const cip = (d.alertas_agente || []).some((a) => /bloque CIP/i.test(a));
    if (cip) return 'CIP';
    if (d.isbn) return 'ISBN propio';
    if (EDIT_RX.test(d.nombre_archivo || '') || EDIT_RX.test(d.coleccion_nombre || '')) return 'editorial';
    return null;
}

async function main() {
    const db = await conectarDB();
    const objetivos = [];
    for (const d of await db.collection('biblioteca').find({ tipo_recurso: 'revista' }).toArray()) {
        const s = senalLibro(d);
        if (s) objetivos.push([d, s]);
    }
    console.log(`Revistas con SEÑAL FUERTE de libro (CIP/ISBN propio/editorial): ${objetivos.length}${EJECUTAR ? '' : ' (dry-run)'}\n`);

    let hechos = 0, saltados = 0;
    for (const [d, s] of objetivos) {
        if (hechos >= LIMITE) break;
        console.log(`  ${EJECUTAR ? '→' : '·'} [${s}] ${d.isbn || ''} «${String(d.titulo || '').slice(0, 30)}» [${String(d.nombre_archivo || '').slice(0, 44)}]`);
        if (!EJECUTAR) { hechos++; continue; }
        try {
            const colId = d.coleccion;
            const r = await reprocesarDocumento(db, d, { conservar: false }); // nuevo desde cero → re-lee el CIP → libro
            if (!r.ok) { console.error(`      ✗ ${r.motivo}`); saltados++; continue; }
            let col = '';
            if (colId && await db.collection('biblioteca').countDocuments({ coleccion: colId }) === 0) {
                await db.collection('colecciones').deleteOne({ _id: colId }); col = ' · colección vacía eliminada';
            }
            console.log(`      ✔ al Inbox «${r.inbox}» (nuevo desde cero)${col}`);
            hechos++;
        } catch (e) { console.error(`      ✗ error: ${e.message}`); saltados++; }
    }

    console.log(`\n${EJECUTAR ? `Reprocesados: ${hechos}` : `A reclasificar: ${hechos}`}${saltados ? ` · saltados: ${saltados}` : ''}.`);
    if (!EJECUTAR) console.log('Dry-run. --ejecutar aplica (⚠ BACKUP; Vigilante ACTIVO). El Vigilante las re-cataloga como libros.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
