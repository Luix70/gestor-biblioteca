#!/usr/bin/env node
/**
 * cotejar-por-isbn.js — COTEJO por ISBN con AUTORIDAD del Fichero local (OL+BNE). Para libros con ISBN,
 * corrige el TÍTULO y/o la CDU tomando como autoridad el Fichero (no todo el mundo escanea con cuidado):
 *
 *   · TÍTULO — si el del Fichero DIFIERE del actual, prima el del Fichero (casos: título = nombre de la SERIE/
 *     editorial, truncado, artefacto).
 *   · CDU    — la CDU DIRECTA del Fichero (BNE, específica) prima aunque la catalogada sea otra; la derivada del
 *     Dewey/LC por el crosswalk determinista (más gruesa) SOLO rellena una CDU ausente/«000» (no degrada una fina).
 *     Al cambiar la CDU se MUEVE la carpeta (editarDocumento).
 *
 * SALVAGUARDA (imprescindible): solo se aplica si el ISBN se CORROBORA por el NOMBRE DE ARCHIVO contra el título
 * del Fichero (corroborarISBNporTitulo) → evita el desastre del ISBN equivocado o COMPARTIDO (guía de Venecia con
 * ISBN de «Philosophy of Plato»; el ISBN de Osprey compartido por cientos). Sin corroborar → NO se toca; se cuenta
 * como «sospechoso» (posible ISBN erróneo). SIN IA, offline (solo Fichero).
 *
 * DRY-RUN por defecto (no toca nada). --ejecutar aplica. Alcance: --titulos y/o --cdu (si no pones ninguno, AMBOS).
 * --clasificacion = informe (solo lectura) de coincidencia de CDU catalogada vs Fichero. --limite N para probar.
 * Ejecutable desde el PANEL (Mantenimiento → «Ejecutar script»), con la MISMA autoridad del Fichero.
 *
 *   node scripts/cotejar-por-isbn.js [--titulos] [--cdu] [--limite N]     (vista previa)
 *   node scripts/cotejar-por-isbn.js --ejecutar [--titulos] [--cdu]       (aplica; COPIA DE SEGURIDAD antes)
 *   node scripts/cotejar-por-isbn.js --clasificacion [--limite N]         (informe CDU, solo lectura)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEnFicheroLocal, corroborarISBNporTitulo } from '../src/utils/buscador-local.js';
import { cduDelFichero } from '../src/mantenimiento/campanas.js';
import { editarDocumento } from '../src/utils/editar-doc.js';
import { resolverCDU } from '../src/clasificador-cdu.js';
import { variantesISBN } from '../src/utils/identificadores.js';

const arg = (n) => process.argv.includes(n);
const EJECUTAR = arg('--ejecutar');
const CLASIFICACION = arg('--clasificacion');
let TITULOS = arg('--titulos'), CDU = arg('--cdu');
if (!TITULOS && !CDU) { TITULOS = true; CDU = true; }   // sin alcance explícito → ambos
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();
const MUESTRA = 15;

// Normalizaciones para comparar.
const RE_DIACR = new RegExp('[\\u0300-\\u036f]', 'g');
const normTitulo = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACR, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const normCdu = (c) => String(c || '').trim().replace(/[^0-9.].*$/, '').replace(/\.+$/, '').trim();
const sinExtension = (n) => String(n || '').replace(/\.[^.]+$/, '');

const db = await conectarDB();
const bib = db.collection('biblioteca');
const FILTRO = { isbn: { $exists: true, $nin: [null, ''] } };

// ── Modo INFORME de clasificación (--clasificacion): compara la CDU catalogada con la del Fichero. Solo lectura.
if (CLASIFICACION) {
    const cduFich = async (f) => {
        if (!f) return null;
        if (f.cdu) return String(f.cdu).trim();
        if (f.dewey || f.lcc) { try { const r = await resolverCDU({ dewey: f.dewey, lcc: f.lcc, permitirIA: false }); const c = typeof r === 'string' ? r : (r && r.cdu); if (c && c !== '000') return String(c).trim(); } catch { /**/ } }
        return null;
    };
    const total = await bib.countDocuments(FILTRO);
    console.log(`\nClasificación por ISBN — INFORME (solo lectura) · libros con ISBN: ${total}${LIMITE ? ` (ojeando ${LIMITE})` : ''}\n`);
    const cur = bib.find(FILTRO, { projection: { cdu: 1, isbn: 1 } });
    let n = 0, sinFich = 0, aporta = 0, exacto = 0, area = 0, difiere = 0; const ejDif = [];
    for await (const d of cur) {
        if (LIMITE && n >= LIMITE) break;
        n++; if (n % 500 === 0) process.stdout.write(`  … ${n}/${LIMITE || total}\r`);
        const fic = await cduFich(await buscarEnFicheroLocal({ isbns: variantesISBN(d.isbn) }).catch(() => null));
        if (!fic) { sinFich++; continue; }
        const cat = normCdu(d.cdu);
        if (!cat || d.cdu === '000') { aporta++; continue; }
        if (cat === normCdu(fic)) exacto++;
        else if (cat[0] === normCdu(fic)[0]) area++;
        else { difiere++; if (ejDif.length < MUESTRA) ejDif.push(`  cat ${cat.padEnd(12)} vs fichero ${normCdu(fic).padEnd(12)} (ISBN ${d.isbn})`); }
    }
    console.log(`\nrevisados ${n} · sin dato en Fichero ${sinFich} · Fichero APORTA (CDU 000/vacía) ${aporta}`);
    console.log(`con CDU en ambos → EXACTA ${exacto} · misma ÁREA ${area} · DIFIERE ${difiere}`);
    if (ejDif.length) { console.log(`\nMuestra de DIVERGENCIAS (área distinta — revisión manual):`); ejDif.forEach((l) => console.log(l)); }
    console.log(`\nℹ Aplica los cambios con «--cdu» (la CDU directa de BNE prima; el crosswalk solo rellena 000).`);
    process.exit(0);
}

// ── Cotejo TÍTULO + CDU con autoridad del Fichero (corroborado por el nombre) ────────────────────────────────
// Devuelve { corroborado, titulo?, subtitulo?, cdu?, cduVia? } con las correcciones propuestas, o null.
async function evaluar(doc) {
    const isbns = variantesISBN(doc.isbn);
    if (!isbns.length) return null;
    const f = await buscarEnFicheroLocal({ isbns }).catch(() => null);
    if (!f) return null;
    const ref = sinExtension(doc.nombre_archivo);
    const corr = ref ? await corroborarISBNporTitulo({ candidatos: isbns, titulo: ref }).catch(() => null) : null;
    const out = { corroborado: !!corr, titulo: null, subtitulo: null, cdu: null, cduVia: null };
    // TÍTULO: prima el del Fichero si difiere (y el ISBN se corrobora).
    const tAut = f.titulo ? String(f.titulo).trim() : '';
    if (tAut && normTitulo(doc.titulo) !== normTitulo(tAut)) {
        out.difiereTitulo = true;
        if (corr) { out.titulo = tAut; if (f.subtitulo && !doc.subtitulo) out.subtitulo = String(f.subtitulo).trim(); }
    }
    // CDU: la directa de BNE prima aunque difiera; la del crosswalk solo rellena 000. Requiere corroboración.
    if (corr) {
        const cf = await cduDelFichero(f);
        if (cf) {
            const catVacia = !doc.cdu || doc.cdu === '000';
            if (cf.via === 'cdu-BNE' && normCdu(cf.cdu) !== normCdu(doc.cdu)) { out.cdu = cf.cdu; out.cduVia = cf.via; }
            else if (cf.via === 'crosswalk' && catVacia) { out.cdu = cf.cdu; out.cduVia = cf.via; }
        }
    }
    return out;
}

const total = await bib.countDocuments(FILTRO);
console.log(`\nCotejo por ISBN (autoridad Fichero) — ${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'} · alcance: ${[TITULOS && 'títulos', CDU && 'CDU'].filter(Boolean).join(' + ')} · libros con ISBN: ${total}${LIMITE ? ` (ojeando ${LIMITE})` : ''}\n`);

const cur = bib.find(FILTRO, { projection: { titulo: 1, subtitulo: 1, cdu: 1, isbn: 1, nombre_archivo: 1 } });
let n = 0, cambT = 0, cambC = 0, sospechosos = 0, aplicados = 0;
const ejT = [], ejC = [], ejS = [];
for await (const doc of cur) {
    if (LIMITE && n >= LIMITE) break;
    n++; if (n % 500 === 0) process.stdout.write(`  … ${n}/${LIMITE || total}\r`);
    let e; try { e = await evaluar(doc); } catch { continue; }
    if (!e) continue;
    if (e.difiereTitulo && !e.corroborado) { sospechosos++; if (ejS.length < MUESTRA) ejS.push(`  «${String(doc.titulo).slice(0, 30)}» (ISBN ${doc.isbn}) — difiere y NO corrobora`); }
    const cambios = {};
    if (TITULOS && e.titulo) { cambios.titulo = e.titulo; if (e.subtitulo) cambios.subtitulo = e.subtitulo; cambT++; if (ejT.length < MUESTRA) ejT.push(`  «${String(doc.titulo).slice(0, 30)}» → «${e.titulo.slice(0, 50)}»`); }
    if (CDU && e.cdu) { cambios.cdu = e.cdu; cambC++; if (ejC.length < MUESTRA) ejC.push(`  cdu «${String(doc.cdu || '—')}» → «${e.cdu}» (${e.cduVia}) · «${String(doc.titulo).slice(0, 30)}»`); }
    if (!Object.keys(cambios).length) continue;
    if (EJECUTAR) { try { const r = await editarDocumento(db, String(doc._id), cambios); if (r && r.ok) aplicados++; } catch { /* omitir este doc */ } }
}

console.log(`\n${'─'.repeat(64)}`);
console.log(`Revisados: ${n} · títulos a corregir: ${cambT} · CDU a corregir: ${cambC} · sospechosos (no corroboran): ${sospechosos}`);
if (ejT.length) { console.log(`\nMuestra TÍTULOS (serie/artefacto → título real del Fichero):`); ejT.forEach((l) => console.log(l)); }
if (ejC.length) { console.log(`\nMuestra CDU (autoridad Fichero; BNE prima, crosswalk rellena 000):`); ejC.forEach((l) => console.log(l)); }
if (ejS.length) { console.log(`\nMuestra SOSPECHOSOS (posible ISBN equivocado/compartido — NO se tocan):`); ejS.forEach((l) => console.log(l)); }
if (EJECUTAR) console.log(`\nAPLICADOS: ${aplicados} documento(s) (título y/o CDU; la CDU mueve la carpeta).`);
else console.log(`\n▶ Repite con --ejecutar para aplicar (COPIA DE SEGURIDAD antes). Los sospechosos nunca se tocan.`);
process.exit(0);
