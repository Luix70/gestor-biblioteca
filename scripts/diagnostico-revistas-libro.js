// ── DIAGNÓSTICO (solo lectura): revistas que en realidad son LIBROS ──────────────────────────────────
// No escribe NADA. Estudia dos poblaciones y las clasifica por SEÑAL, para decidir qué reclasificar:
//   (A) COLECCIONES tipo:'revista' con 1 solo miembro  → sospechosas de ser una serie/monografía de libros.
//   (B) documentos tipo:'revista'                        → clasificados por señal de libro.
// Señales (de más a menos fiable):
//   · CIP        — bloque de catalogación en las alertas (solo lo llevan los libros).
//   · ISBN propio— doc.isbn presente (una revista no lleva ISBN propio; el ISSN es lo suyo).
//   · editorial  — nombre de archivo/colección con prefijo de EDITORIAL DE LIBROS (Apress, Wrox, O'Reilly…).
//   · serie-libros — el título delata una serie/monografía académica (pareceSerieLibros).
//   · (ninguna)  — probable revista REAL (fechada, ISSN-only, sin señal de libro): NO tocar.
// Correr en el NAS (o local con NODE_TLS_REJECT_UNAUTHORIZED=0 si tu red intercepta TLS):
//   docker exec gestor-biblioteca node scripts/diagnostico-revistas-libro.js
//   docker exec gestor-biblioteca node scripts/diagnostico-revistas-libro.js --lista   (detalle por documento)
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { pareceSerieLibros } from '../src/utils/revistas.js';

const LISTA = process.argv.includes('--lista');
const EDIT_RX = /\b(Apress|Wrox|Oxford|Packt|O'?Reilly|Cambridge|Springer|Wiley|McGraw|Microsoft\.?Press|Manning|Peachpit|Course\.?Technology|Sams|Addison|Pearson|Elsevier|Academic|CRC|Routledge|No\.?Starch|Prentice)\b/i;

// Señal de LIBRO de un documento-revista (de más a menos fiable), o null si no hay ninguna.
function senalLibro(d, colNombre = '') {
    if ((d.alertas_agente || []).some((a) => /bloque CIP/i.test(a))) return 'CIP';
    if (d.isbn) return 'ISBN propio';
    if (EDIT_RX.test(d.nombre_archivo || '') || EDIT_RX.test(colNombre || '') || EDIT_RX.test(d.coleccion_nombre || '')) return 'editorial';
    if (pareceSerieLibros(d.titulo || '') || pareceSerieLibros(colNombre)) return 'serie-libros';
    return null;
}

const corto = (s, n = 42) => String(s || '').slice(0, n);

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    // ── (A) Colecciones tipo:'revista' con exactamente 1 miembro ──────────────────────────────────────
    const colsRev = await db.collection('colecciones').find({ tipo: 'revista' }).toArray();
    const unMiembro = [];
    for (const c of colsRev) {
        const n = await bib.countDocuments({ coleccion: c._id });
        if (n === 1) {
            const doc = await bib.findOne({ coleccion: c._id });
            unMiembro.push({ c, doc, senal: doc ? senalLibro(doc, c.nombre) : null });
        }
    }
    console.log(`\n═══ (A) COLECCIONES tipo:'revista' con UN SOLO miembro: ${unMiembro.length} de ${colsRev.length} ═══`);
    const porSenalA = {};
    for (const x of unMiembro) { const k = x.senal || '(sin señal → ¿revista real?)'; (porSenalA[k] ||= []).push(x); }
    for (const [k, arr] of Object.entries(porSenalA).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`   · ${k}: ${arr.length}`);
        if (LISTA) for (const x of arr) console.log(`        «${corto(x.c.nombre, 34)}» ← ${corto(x.doc?.titulo)} [${corto(x.doc?.nombre_archivo, 34)}]`);
    }

    // ── (B) Documentos tipo:'revista' con señal de libro ──────────────────────────────────────────────
    const revistas = await bib.find({ tipo_recurso: 'revista' }).toArray();
    const conSenal = revistas.map((d) => ({ d, senal: senalLibro(d) })).filter((x) => x.senal);
    console.log(`\n═══ (B) DOCUMENTOS tipo:'revista' con SEÑAL de libro: ${conSenal.length} de ${revistas.length} ═══`);
    const porSenalB = {};
    for (const x of conSenal) { (porSenalB[x.senal] ||= []).push(x); }
    for (const [k, arr] of Object.entries(porSenalB).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`   · ${k}: ${arr.length}`);
        if (LISTA) for (const x of arr) console.log(`        ${x.d.isbn || ''} «${corto(x.d.titulo)}» [${corto(x.d.nombre_archivo, 34)}]`);
    }

    console.log(`\nResumen: ${revistas.length} revistas en total. Las de señal CIP/ISBN propio/editorial son casi seguro`);
    console.log(`LIBROS mal clasificados. Reclasifícalos con el botón 🔀 «Cambiar tipo» (selección) o con`);
    console.log(`scripts/reclasificar-revistas-por-senal.js --ejecutar (nuevo desde cero, re-lee el CIP). Solo lectura: nada modificado.`);
    process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
