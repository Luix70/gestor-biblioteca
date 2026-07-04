/**
 * TASK 15 — Agrupa en OBRAS multivolumen los libros HERMANOS que la ingesta no detectó porque su número
 * de tomo va en el TÍTULO como un ROMANO/NÚMERO FINAL sin la palabra «Vol./Tomo» (patrón muy común en
 * enciclopedias: «Historia de las Ideas Políticas, I» · «Historia de las Ideas Políticas, II» · …).
 *
 * Ese patrón NO se detecta en la ingesta a propósito (un romano final suelto confundiría «Rocky II» o
 * «Enrique V» con tomos). Aquí es SEGURO porque exige CORROBORACIÓN entre hermanos: solo agrupa cuando
 * ≥2 documentos comparten EXACTAMENTE el mismo prefijo (de ≥2 palabras) con números DISTINTOS.
 *
 * Para cada grupo: resuelve/crea la obra (título = prefijo), fija `obra` + `volumen_numero` + `obra_titulo`
 * en cada libro y reconstruye el inventario de la obra. Conserva la colección/editorial/CDU comunes. NO
 * toca libros que ya están en una obra, ni revistas, ni cómics. DRY-RUN por defecto; --ejecutar aplica.
 *
 *   node scripts/agrupar-hermanos.js                 (DRY-RUN)
 *   node scripts/agrupar-hermanos.js --ejecutar
 *   node scripts/agrupar-hermanos.js --min 3         (exige ≥3 hermanos por grupo; por defecto 2)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { resolverObra, reconstruirInventarioObra } from '../src/utils/obras.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const MIN_HERMANOS = Math.max(2, parseInt((process.argv[process.argv.indexOf('--min') + 1]) || '2', 10) || 2);

// Romano (I..XXXIX) → entero, o null. Solo hasta ~40 (un romano mayor suele ser un año, no un tomo).
function romanoANum(s) {
    const t = String(s || '').toUpperCase();
    if (!/^[IVXL]+$/.test(t)) return null; // hasta L=50; descarta C/D/M (años/números grandes)
    const val = { I: 1, V: 5, X: 10, L: 50 };
    let n = 0;
    for (let i = 0; i < t.length; i++) { const c = val[t[i]], sig = val[t[i + 1]] || 0; n += c < sig ? -c : c; }
    return n > 0 && n <= 40 ? n : null;
}

// Etiqueta opcional de volumen (con la que el número es indiscutible). Sin ella también se acepta un
// romano/número FINAL, pero ese caso solo cuenta si tiene hermanos (corroboración en el agrupado).
const PAL = '(?:vol(?:umen|ume)?|tomo|libro|parte|part|band|t)';
const RE_KW = new RegExp('^(.*?)[\\s,;:._·\\-]*\\b' + PAL + '\\.?\\s*([IVXLCDM]{1,6}|\\d{1,3})\\.?$', 'i');
const RE_ROMANO_FINAL = new RegExp('^(.{6,}?)[\\s,]+([IVXL]{1,6})\\.?$');          // romano MAYÚSCULO final
const RE_NUM_FINAL = new RegExp('^(.{6,}?)[\\s,]+(\\d{1,2})\\.?$');                // número pequeño (1-2 díg.) final

// Extrae {prefijo, numero} del título si sigue el patrón de tomo. `numero` entero; null si no aplica.
function extraerTomo(titulo) {
    const t = String(titulo || '').trim();
    if (!t) return null;
    let m = t.match(RE_KW);
    if (m && m[1] && /[a-zà-ÿ]/i.test(m[1])) {
        const n = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : romanoANum(m[2]);
        if (n != null && n >= 1 && n <= 60) return { prefijo: limpiarPrefijo(m[1]), numero: n };
    }
    m = t.match(RE_ROMANO_FINAL);
    if (m) { const n = romanoANum(m[2]); if (n != null) return { prefijo: limpiarPrefijo(m[1]), numero: n }; }
    m = t.match(RE_NUM_FINAL);
    if (m) { const n = parseInt(m[2], 10); if (n >= 1 && n <= 40) return { prefijo: limpiarPrefijo(m[1]), numero: n }; }
    return null;
}
const limpiarPrefijo = (s) => String(s || '').replace(/[\s,;:._·\-]+$/, '').trim();
// Clave de agrupado: prefijo normalizado (minúsculas, sin acentos ni puntuación, espacios colapsados).
const normClave = (s) => String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const nPalabras = (s) => normClave(s).split(' ').filter(Boolean).length;
const modo = (arr) => { const c = new Map(); for (const x of arr) if (x != null) c.set(String(x), (c.get(String(x)) || 0) + 1); let best = null, bn = 0; for (const [k, n] of c) if (n > bn) { bn = n; best = k; } return best; };

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    // Libros aún NO agrupados en una obra, no-revista, no-cómic.
    const docs = await bib.find(
        { tipo_recurso: { $ne: 'revista' }, naturaleza: { $ne: 'comic' }, obra: { $in: [null, undefined] } },
        { projection: { titulo: 1, autores: 1, editorial: 1, coleccion: 1, coleccion_nombre: 1, cdu: 1, volumen_numero: 1 } },
    ).toArray();
    console.log(`\n📚 Libros sin obra: ${docs.length}`);

    // Agrupar por prefijo normalizado. Cada item: {doc, numero, prefijoOrig}.
    const grupos = new Map();
    for (const d of docs) {
        const t = extraerTomo(d.titulo);
        if (!t || nPalabras(t.prefijo) < 2) continue;         // prefijo de ≥2 palabras (evita «Enrique V»)
        const clave = normClave(t.prefijo);
        if (!clave) continue;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push({ doc: d, numero: t.numero, prefijoOrig: t.prefijo });
    }

    // Un grupo es OBRA si tiene ≥MIN_HERMANOS miembros y ≥2 NÚMEROS DISTINTOS (corroboración).
    const plan = [];
    for (const items of grupos.values()) {
        const nums = new Set(items.map((it) => it.numero));
        if (items.length < MIN_HERMANOS || nums.size < 2) continue;
        // Título de la obra = el prefijo original más frecuente (mejor grafía).
        const titulo = modo(items.map((it) => it.prefijoOrig)) || items[0].prefijoOrig;
        const editorialId = modo(items.map((it) => it.doc.editorial && String(it.doc.editorial)).filter(Boolean));
        const coleccionId = modo(items.map((it) => it.doc.coleccion && String(it.doc.coleccion)).filter(Boolean));
        const cdu = modo(items.map((it) => it.doc.cdu).filter(Boolean));
        items.sort((a, b) => a.numero - b.numero);
        plan.push({ titulo, items, editorialId, coleccionId, cdu });
    }
    plan.sort((a, b) => b.items.length - a.items.length);

    console.log(`\n── Plan ${EJECUTAR ? '(EJECUTAR)' : '(DRY-RUN)'} · min ${MIN_HERMANOS} hermanos ──`);
    console.log(`  Obras a formar: ${plan.length} · libros a enlazar: ${plan.reduce((s, p) => s + p.items.length, 0)}`);
    for (const p of plan.slice(0, 40)) {
        console.log(`\n  📖 «${p.titulo}»  (${p.items.length} tomos)`);
        for (const it of p.items) console.log(`     ${String(it.numero).padStart(3)} · ${it.doc.titulo}`);
    }
    if (plan.length > 40) console.log(`\n  … y ${plan.length - 40} obra(s) más.`);

    if (!EJECUTAR) {
        console.log('\n(DRY-RUN: no se ha escrito nada. Revisa y repite con --ejecutar para aplicar.)\n');
        process.exit(0);
    }

    let nObras = 0, nLibros = 0;
    for (const p of plan) {
        const { _id: obraId } = await resolverObra(db, {
            titulo: p.titulo,
            editorialId: p.editorialId ? p.editorialId : null,
            coleccionId: p.coleccionId ? p.coleccionId : null,
            cdu: p.cdu || null,
            total: Math.max(...p.items.map((it) => it.numero)),
        });
        if (!obraId) { console.warn(`  ⚠️ no se pudo resolver la obra «${p.titulo}»`); continue; }
        nObras++;
        // Enlazar cada libro: obra + volumen_numero + obra_titulo. Solo se fija volumen_numero si el doc no
        // traía uno (respeta un número ya conocido). Un choque de número queda para la reconstrucción.
        for (const it of p.items) {
            const set = { obra: obraId, obra_titulo: p.titulo, fecha_actualizacion: new Date() };
            if (!Number.isInteger(it.doc.volumen_numero)) set.volumen_numero = it.numero;
            await bib.updateOne({ _id: it.doc._id }, { $set: set }).catch((e) => console.warn(`  ⚠️ doc ${it.doc._id}: ${e.message}`));
            nLibros++;
        }
        await reconstruirInventarioObra(db, obraId);
    }
    console.log(`\n✅ Hecho: ${nObras} obra(s) formada(s), ${nLibros} libro(s) enlazado(s).\n`);
    process.exit(0);
}

main().catch((e) => { console.error('❌ Error:', e); process.exit(1); });
