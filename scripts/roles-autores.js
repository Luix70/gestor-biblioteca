/**
 * Backfill de CONTRIBUCIONES con rol (traductor/ilustrador/prologuista/anotador/editor/compilador) e
 * IDIOMA ORIGINAL de los libros ya catalogados que tienen ISBN. Reutiliza la MISMA captura que la ingesta:
 * consulta OpenLibrary por ISBN (mención de responsabilidad `by_statement`) + el Fichero (lengua original),
 * SIN IA (incluirCdu/incluirSinopsis desactivados), parsea los roles y resuelve cada nombre a su persona
 * (crea el autor si no existe, con la misma lógica que la ingesta). Conservador: no pisa lo que ya haya.
 * Procesa por TANDAS DE 25 con una pausa (respeta a OpenLibrary). Reanudable (coge los que aún no tienen
 * contribuciones). DRY-RUN por defecto.
 *
 *   node scripts/roles-autores.js                 (DRY-RUN: cuenta candidatos)
 *   node scripts/roles-autores.js --ejecutar
 *   node scripts/roles-autores.js --ejecutar --limite 50
 *
 * En el NAS: docker exec gestor-biblioteca node scripts/roles-autores.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarMetadatosExternos } from '../src/utils/proveedor-metadatos.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { ROLES_VALIDOS } from '../src/utils/contribuciones.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const idx = process.argv.indexOf('--limite');
const LIMITE = idx >= 0 ? Number(process.argv[idx + 1]) : Infinity;

const TANDA = 25;
const PAUSA_MS = Number(process.env.ROLES_PAUSA_MS || 700);
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const db = await conectarDB();
const bib = db.collection('biblioteca');
// Candidatos: libros con ISBN que AÚN no tienen contribuciones registradas.
const filtro = { isbn: { $exists: true, $nin: [null, ''] }, contribuciones: { $exists: false } };
const total = await bib.countDocuments(filtro);
console.log(`\n═══ ROLES DE CONTRIBUYENTES · ${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'} ═══`);
console.log(`  Libros con ISBN y sin contribuciones: ${total}`);
if (!EJECUTAR) {
    console.log('\n  DRY-RUN: no se ha escrito nada. Repite con --ejecutar (o --limite N para probar).\n');
    process.exit(0);
}

const cursor = bib.find(filtro, { projection: { isbn: 1, idioma_original: 1 } });
let procesados = 0, conRoles = 0, sinDatos = 0, fallos = 0;
const tope = Number.isFinite(LIMITE) ? LIMITE : Infinity;

for await (const doc of cursor) {
    if (procesados >= tope) break;
    procesados++;
    try {
        const isbns = variantesISBN(doc.isbn);
        const ext = await buscarMetadatosExternos(null, null, null, {
            isbnsArchivo: isbns, incluirCdu: false, incluirSinopsis: false,
        }).catch(() => null);
        const nombres = (ext && ext.contribuciones_nombres) || [];
        const set = {};
        // Resolver [{nombre,rol}] → [{persona,rol}] (dedup).
        const contribs = [];
        const vistos = new Set();
        for (const c of nombres) {
            if (!c || !c.nombre || !ROLES_VALIDOS.includes(c.rol) || c.rol === 'autor') continue;
            const r = await resolverPersona(db, c.nombre);
            if (!r) continue;
            const clave = `${String(r._id)}|${c.rol}`;
            if (vistos.has(clave)) continue;
            vistos.add(clave);
            contribs.push({ persona: r._id, rol: c.rol });
        }
        if (contribs.length) set.contribuciones = contribs;
        if (!doc.idioma_original && ext && ext.idioma_original) set.idioma_original = ext.idioma_original;
        if (Object.keys(set).length) {
            set.fecha_actualizacion = new Date();
            await bib.updateOne({ _id: doc._id }, { $set: set });
            conRoles++;
            const resumen = contribs.map((c) => c.rol).join(',') || '—';
            console.log(`  ✅ ${doc.isbn} → ${contribs.length} contrib. (${resumen})${set.idioma_original ? ` · orig ${set.idioma_original}` : ''}`);
        } else {
            sinDatos++;
        }
    } catch (e) {
        fallos++;
        console.warn(`  ⚠️ ${doc.isbn}: ${e.message}`);
    }
    if (procesados % TANDA === 0) console.log(`  … ${procesados} procesados`);
    await espera(PAUSA_MS);
}

console.log(`\n✅ Hecho: ${procesados} procesados · ${conRoles} con contribuciones/idioma · ${sinDatos} sin datos · ${fallos} fallo(s).\n`);
process.exit(0);
