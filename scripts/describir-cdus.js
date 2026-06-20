/**
 * Rellena la tabla 'cdu_descripciones' (ES/EN, extensa) para todos los códigos CDU presentes
 * en la biblioteca. Cacheado: salta los ya descritos. Reutiliza describirCDU (IA + caché).
 *
 *   node scripts/describir-cdus.js                 (DRY-RUN: cuenta distintos y los que faltan)
 *   node scripts/describir-cdus.js --limite 5      (genera solo 5, para probar)
 *   node scripts/describir-cdus.js --ejecutar      (genera todos los que falten)
 */

import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { describirCDU } from '../src/utils/descripcion-cdu.js';
import { sanitizarCDU } from '../src/utils/cdu-arbol.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const idxLim = process.argv.indexOf('--limite');
const LIMITE = idxLim >= 0 ? Number(process.argv[idxLim + 1]) : Infinity;
const PAUSA_MS = 900; // ritmo entre llamadas a la IA

async function main() {
    console.log(`\nDescripciones CDU  [${EJECUTAR || Number.isFinite(LIMITE) ? 'GENERAR' : 'DRY-RUN'}]\n`);
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // Índice único (idempotente) para que la caché no duplique ante carreras.
    await db.collection('cdu_descripciones').createIndex({ codigo: 1 }, { unique: true, name: 'idx_codigo_unico' }).catch(() => {});

    // Códigos distintos (limpios) que usan los libros.
    const crudos = await col.distinct('cdu', { cdu: { $exists: true, $ne: null } });
    const codigos = new Set();
    for (const c of crudos) {
        const k = sanitizarCDU(c);
        if (k && /[0-9]/.test(k)) codigos.add(k);
    }
    const yaDesc = new Set(await db.collection('cdu_descripciones').distinct('codigo'));
    const faltan = [...codigos].filter(k => !yaDesc.has(k));

    console.log(`  Códigos CDU distintos:  ${codigos.size}`);
    console.log(`  Ya descritos:           ${codigos.size - faltan.length}`);
    console.log(`  Faltan por describir:   ${faltan.length}`);

    if (!EJECUTAR && !Number.isFinite(LIMITE)) {
        console.log(`\n  DRY-RUN: ejecuta con --ejecutar (o --limite N para probar).`);
        process.exit(0);
    }

    const objetivo = faltan.slice(0, LIMITE);
    console.log(`\n  Generando ${objetivo.length}…\n`);
    let ok = 0, fallo = 0;
    for (const codigo of objetivo) {
        const r = await describirCDU(db, codigo);
        if (r) { console.log(`  ✅ ${codigo} → ${r.titulo_es || '(sin título)'}`); ok++; }
        else { console.log(`  ⛔ ${codigo} (IA falló; se reintenta en otra pasada)`); fallo++; }
        await new Promise(res => setTimeout(res, PAUSA_MS));
    }

    console.log(`\n  Generados: ${ok} · Fallos: ${fallo} · Pendientes: ${faltan.length - ok}`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
