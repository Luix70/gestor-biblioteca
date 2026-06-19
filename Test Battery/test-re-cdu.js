/**
 * Test Battery / test-re-cdu.js
 *
 * Simula la tarea 're-clasificar-cdu' del Conformador sobre N libros
 * elegidos al azar. NO mueve ficheros ni escribe en la BD: solo muestra
 * qué CDU tendría cada libro tras pasar por el pipeline BNE→DNB→caché→IA
 * y si eso implicaría un cambio de carpeta.
 *
 * Uso:
 *   node "Test Battery/test-re-cdu.js"                  (20 libros)
 *   node "Test Battery/test-re-cdu.js" --limit=50
 *   node "Test Battery/test-re-cdu.js" --isbn=8408015885
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEnBNE } from '../src/utils/buscador-bne.js';
import { buscarEnDNB } from '../src/utils/buscador-dnb.js';
import { resolverCDU } from '../src/clasificador-cdu.js';
import { rutaCatalogo } from '../src/utils/rutas.js';

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const LIMITE = parseInt(args.limit) || 20;
const ISBN_FIJO = args.isbn || null;

async function clasificarDoc(doc, db) {
    const isbn = doc.isbn || null;
    let cduNueva = null, cduAdicionales = [], fuente = null;

    if (isbn) {
        const recBNE = await buscarEnBNE(isbn);
        if (recBNE?.cdus?.length > 0) {
            [cduNueva] = recBNE.cdus;
            cduAdicionales = recBNE.cdus.slice(1);
            fuente = 'BNE';
        }
    }

    if (!cduNueva) {
        let dewey = doc.dewey || null, lcc = doc.lcc || null;
        if (!dewey && !lcc && isbn) {
            const infoDNB = await buscarEnDNB({ isbn });
            if (infoDNB) { dewey = infoDNB.dewey; lcc = infoDNB.lcc; }
        }
        if (dewey || lcc) {
            let autorNombre = null;
            if (doc.autores?.length > 0) {
                const autorDoc = await db.collection('autores')
                    .findOne({ _id: doc.autores[0] }, { projection: { nombre: 1 } });
                if (autorDoc) autorNombre = autorDoc.nombre;
            }
            const { cdu, fuente: f } = await resolverCDU({
                dewey, lcc,
                categorias: doc.palabras_clave || [],
                titulo: doc.titulo,
                autor: autorNombre,
                sinopsis: doc.sinopsis,
            });
            if (cdu && cdu !== '000') { cduNueva = cdu; fuente = `clasificador:${f}`; }
        }
    }

    return { cduNueva, cduAdicionales, fuente };
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    let docs;
    if (ISBN_FIJO) {
        docs = await col.find({ isbn: ISBN_FIJO }).toArray();
    } else {
        docs = await col.aggregate([
            { $match: { tipo_recurso: 'libro' } },
            { $sample: { size: LIMITE } },
            { $project: { titulo: 1, isbn: 1, cdu: 1, cdu_adicionales: 1,
                          ruta_base: 1, dewey: 1, lcc: 1,
                          palabras_clave: 1, sinopsis: 1, autores: 1 } },
        ]).toArray();
    }

    console.log(`\n🔍 Simulando re-clasificar-cdu en ${docs.length} libro(s)...\n`);

    let cambian = 0, iguales = 0, sinResolucion = 0;
    const cambios = [];

    for (const doc of docs) {
        const { cduNueva, cduAdicionales, fuente } = await clasificarDoc(doc, db);

        if (!cduNueva) {
            sinResolucion++;
            console.log(`  ○ [sin resolución] "${doc.titulo?.slice(0, 55)}" — mantiene ${doc.cdu}`);
            continue;
        }

        if (cduNueva === doc.cdu) {
            iguales++;
            const adicCambia = JSON.stringify(cduAdicionales) !== JSON.stringify(doc.cdu_adicionales || []);
            const extra = adicCambia ? ` (adicionales cambian → [${cduAdicionales.join(' / ')}])` : '';
            console.log(`  ✔ [${fuente}] "${doc.titulo?.slice(0, 55)}"${extra}`);
            continue;
        }

        cambian++;
        const rcVieja = doc.ruta_base || '?';
        const rcNueva = rutaCatalogo({ cdu: cduNueva, tipo_recurso: doc.tipo_recurso,
                                       isbn: doc.isbn, issn: doc.issn, id: doc._id }).web;
        cambios.push({ titulo: doc.titulo, isbn: doc.isbn, de: doc.cdu, a: cduNueva, fuente, rcVieja, rcNueva });
        console.log(`  ↪ [${fuente}] "${doc.titulo?.slice(0, 50)}" — ${doc.cdu} → ${cduNueva}`);
    }

    console.log(`
── Resumen ────────────────────────────────
  Total:          ${docs.length}
  Sin cambio:     ${iguales}
  Cambiarían CDU: ${cambian}
  Sin resolución: ${sinResolucion}
`);

    if (cambios.length) {
        console.log('── Detalle de cambios ─────────────────────');
        for (const c of cambios) {
            console.log(`  "${c.titulo?.slice(0, 55)}"  ISBN:${c.isbn || 'n/a'}`);
            console.log(`     CDU:    ${c.de} → ${c.a}  [${c.fuente}]`);
            console.log(`     Ruta:   ${c.rcVieja}`);
            console.log(`             → ${c.rcNueva}`);
        }
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
