/**
 * Test Battery / test-cdu-100.js
 *
 * Toma hasta 100 libros aleatorios de la base de datos y re-clasifica su CDU
 * con el pipeline actual (BNE → cache → IA). NO guarda nada: solo informa qué
 * CDU tendría cada libro hoy y si difiere del valor almacenado.
 *
 * Uso:
 *   node "Test Battery/test-cdu-100.js"
 *   node "Test Battery/test-cdu-100.js" --limit=20   (solo 20 libros)
 *   node "Test Battery/test-cdu-100.js" --isbn=9788491041795  (uno concreto)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarCDUsEnBNE } from '../src/utils/buscador-bne.js';
import { buscarEnLOC } from '../src/utils/buscador-loc.js';
import { resolverCDU } from '../src/clasificador-cdu.js';

const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const LIMITE = parseInt(args.limit) || 100;
const ISBN_FIJO = args.isbn || null;

async function reclasificarLibro(doc) {
    const isbn = doc.isbn || null;
    const result = {
        _id: String(doc._id),
        titulo: doc.titulo,
        isbn,
        cdu_actual: doc.cdu,
        cdu_adicionales_actual: doc.cdu_adicionales || [],
        cdu_nueva: null,
        cdu_adicionales_nueva: [],
        fuente: null,
        cambia: false,
        alertas: [],
    };

    // 1. BNE (autoridad directa)
    if (isbn) {
        const cdusBNE = await buscarCDUsEnBNE(isbn);
        if (cdusBNE && cdusBNE.length > 0) {
            result.cdu_nueva = cdusBNE[0];
            result.cdu_adicionales_nueva = cdusBNE.slice(1);
            result.fuente = 'BNE';
            result.cambia = result.cdu_nueva !== result.cdu_actual;
            return result;
        }
    }

    // 2. LOC para Dewey/LCC (si el doc no tiene ya)
    let dewey = doc.dewey || null;
    let lcc = doc.lcc || null;
    if (!dewey && !lcc && isbn) {
        const infoLOC = await buscarEnLOC({ isbn });
        if (infoLOC) { dewey = infoLOC.dewey; lcc = infoLOC.lcc; }
        if (dewey || lcc) result.alertas.push('Dewey/LCC de LOC.');
    }

    // 3. Clasificador (caché + IA)
    const categorias = doc.palabras_clave || [];
    const autor = Array.isArray(doc.autores_nombres)
        ? doc.autores_nombres[0]
        : (typeof doc.autores === 'string' ? doc.autores : null);

    const { cdu, fuente } = await resolverCDU({
        dewey, lcc,
        categorias,
        titulo: doc.titulo,
        autor,
        sinopsis: doc.sinopsis,
    });
    result.cdu_nueva = cdu;
    result.fuente = `clasificador:${fuente}`;
    result.cambia = cdu !== result.cdu_actual;
    return result;
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    let docs;
    if (ISBN_FIJO) {
        docs = await col.find({ isbn: ISBN_FIJO }).toArray();
    } else {
        // $sample es aleatorio; projection trae solo lo necesario (evita los campos grandes)
        docs = await col.aggregate([
            { $match: { tipo_recurso: 'libro' } },
            { $sample: { size: LIMITE } },
            { $project: { titulo: 1, isbn: 1, cdu: 1, cdu_adicionales: 1,
                          palabras_clave: 1, sinopsis: 1, dewey: 1, lcc: 1,
                          autores_nombres: 1, autores: 1 } },
        ]).toArray();
    }

    console.log(`\n🔍 Re-clasificando ${docs.length} libro(s)...\n`);
    const resultados = [];
    let cambian = 0, iguales = 0, errores = 0;

    for (const doc of docs) {
        try {
            const r = await reclasificarLibro(doc);
            resultados.push(r);
            if (r.cambia) cambian++;
            else iguales++;
            const icono = r.cambia ? '↪' : '✔';
            const cambio = r.cambia ? `${r.cdu_actual} → ${r.cdu_nueva}` : r.cdu_actual;
            console.log(`${icono} [${r.fuente}] "${r.titulo?.slice(0, 50)}" — ${cambio}`);
        } catch (e) {
            errores++;
            console.error(`❌ "${doc.titulo?.slice(0, 50)}": ${e.message}`);
        }
    }

    console.log(`\n── Resumen ────────────────────────────────`);
    console.log(`  Total:    ${docs.length}`);
    console.log(`  Sin cambio: ${iguales} (${Math.round(iguales / docs.length * 100)}%)`);
    console.log(`  Cambian:    ${cambian} (${Math.round(cambian / docs.length * 100)}%)`);
    if (errores) console.log(`  Errores:    ${errores}`);

    if (cambian > 0) {
        console.log(`\n── Libros que cambiarían de CDU ────────────`);
        for (const r of resultados.filter(r => r.cambia)) {
            const extras = r.cdu_adicionales_nueva.length
                ? ` + [${r.cdu_adicionales_nueva.join(', ')}]`
                : '';
            console.log(`  "${r.titulo?.slice(0, 60)}"`);
            console.log(`     ISBN: ${r.isbn || 'n/a'}`);
            console.log(`     ${r.cdu_actual} → ${r.cdu_nueva}${extras}  [${r.fuente}]`);
        }
    }

    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
