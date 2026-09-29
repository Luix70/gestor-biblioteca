#!/usr/bin/env node
/**
 * FUSIONAR VERSIONES — libros catalogados varias veces (mismo ISBN, mismo formato, mismo título, ficheros algo
 * distintos). Motor y reglas: src/utils/fusionar-versiones.js.
 *
 * Por defecto NO toca ningún documento: clasifica los grupos y crea SELECCIONES para revisar:
 *   · «Versiones por revisar <ISBN> (N)»   — mismo libro, pero algo impide fusionarlo solo (páginas o tamaño muy
 *                                             distintos, formatos distintos, posibles tomos, ISBN provisional…)
 *   · «ISBN compartido <ISBN> (N)»         — títulos DISTINTOS con el mismo ISBN: no son versiones, el ISBN está mal
 * Con --ejecutar, fusiona los SEGUROS (mismo ISBN, formatos, título, páginas ±2 y tamaño ±25 %): un solo documento,
 * con los ficheros de todas las versiones conservados en su carpeta.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/fusionar-versiones.js                 (diagnóstico + selecciones)
 *   sudo docker exec -t gestor-biblioteca node scripts/fusionar-versiones.js --ejecutar      (fusiona los seguros)
 *   … --isbn <ISBN>      un solo grupo
 *   … --limite N         como mucho N fusiones (para probar)
 *   … --sin-selecciones  no crea selecciones
 *
 * ⚠ Antes de --ejecutar: COPIA DE SEGURIDAD de la base de datos. Reanudable: lo fusionado ya no forma grupo.
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { gruposDeVersiones, clasificarGrupo, tamanosDe, fusionarDocumentos } from '../src/utils/fusionar-versiones.js';
import { crearSeleccion, reemplazarDocs } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SELECCIONES = !args.includes('--sin-selecciones');
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ISBN = arg('--isbn');
const LIMITE = parseInt(arg('--limite'), 10) || Infinity;

const db = await conectarDB();
const grupos = await gruposDeVersiones(db, { isbn: ISBN });
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DIAGNÓSTICO'} · ${grupos.length} grupo(s) con el mismo ISBN y formato\n`);

// ── 1. Clasificar (mide el tamaño de cada fichero: stat, no lo lee) ─────────────────────────────────────────
const t0 = Date.now();
const clases = { seguro: [], revisar: [], 'isbn-compartido': [] };
const motivos = {};
let i = 0;
for (const g of grupos) {
    i++;
    if (i % 20 === 0) process.stdout.write(`\r\x1b[K   ⏳ clasificando ${i}/${grupos.length}`);
    const tamanos = await tamanosDe(g.docs);
    const c = clasificarGrupo(g.docs, { tamanos });
    clases[c.clase].push({ ...g, motivo: c.motivo });
    const clave = c.motivo.replace(/\(.*\)/, '').trim();
    motivos[clave] = (motivos[clave] || 0) + 1;
}
process.stdout.write('\r\x1b[K');
const docsDe = (l) => l.reduce((s, g) => s + g.docs.length, 0);
console.log(`   SEGUROS (se fusionan con --ejecutar) : ${clases.seguro.length} grupos · ${docsDe(clases.seguro)} documentos → quedarían ${clases.seguro.length}`);
console.log(`   por revisar                          : ${clases.revisar.length} grupos · ${docsDe(clases.revisar)} documentos`);
console.log(`   ISBN compartido (títulos distintos)  : ${clases['isbn-compartido'].length} grupos · ${docsDe(clases['isbn-compartido'])} documentos`);
console.log('   motivos:');
for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(`     · ${m}: ${n}`);

// ── 2. Selecciones para revisar ─────────────────────────────────────────────────────────────────────────
async function seleccion(prefijo, g, descripcion) {
    const nombre = `${prefijo} ${g._id.isbn} (${g.docs.length})`;
    const ya = await db.collection('selecciones').findOne({ nombre: { $regex: `^${prefijo} ${g._id.isbn} ` } }, { projection: { _id: 1 } });
    const ids = g.docs.map((d) => d._id);
    if (ya) { await reemplazarDocs(db, ya._id, ids); await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { nombre, descripcion } }); }
    else await crearSeleccion(db, { nombre, descripcion, docs: ids });
}
if (SELECCIONES && !ISBN) {
    let n = 0;
    for (const g of clases.revisar) {
        await seleccion('Versiones por revisar', g, `Mismo ISBN (${g._id.isbn}) y título, pero no se fusiona solo: ${g.motivo}. Si son el mismo libro, «🔗 Fusionar versiones» (conserva todos los ficheros).`);
        if (++n % 50 === 0) process.stdout.write(`\r\x1b[K   ⏳ selecciones ${n}/${clases.revisar.length + clases['isbn-compartido'].length}`);
    }
    for (const g of clases['isbn-compartido']) {
        await seleccion('ISBN compartido', g, `Títulos DISTINTOS con el mismo ISBN ${g._id.isbn}: no son versiones; el ISBN está mal en alguno (o es de relleno). Corrige el ISBN de los que no sean.`);
        if (++n % 50 === 0) process.stdout.write(`\r\x1b[K   ⏳ selecciones ${n}/${clases.revisar.length + clases['isbn-compartido'].length}`);
    }
    process.stdout.write('\r\x1b[K');
    console.log(`\n📋 Selecciones creadas/actualizadas: ${clases.revisar.length} «Versiones por revisar …» y ${clases['isbn-compartido'].length} «ISBN compartido …».`);
}

// ── 3. Fusionar los seguros ─────────────────────────────────────────────────────────────────────────────
if (!EJECUTAR) {
    console.log(`\nNo se ha fusionado nada. Con --ejecutar se fusionarían ${clases.seguro.length} grupos (haz COPIA DE SEGURIDAD antes).\n`);
    process.exit(0);
}
const lista = clases.seguro.slice(0, LIMITE);
const st = { fusionados: 0, retirados: 0, versiones: 0, fallos: 0 };
const t1 = Date.now();
let j = 0;
for (const g of lista) {
    j++;
    const eta = j > 1 ? Math.round((Date.now() - t1) / (j - 1) * (lista.length - j + 1) / 1000) : null;
    process.stdout.write(`\r\x1b[K   ⏳ ${j}/${lista.length} · ${String(g.docs[0].titulo || '').slice(0, 40)}${eta != null ? ` · ETA ${Math.floor(eta / 60)}m ${eta % 60}s` : ''}`);
    try {
        const r = await fusionarDocumentos(db, g.docs.map((d) => d._id));
        if (!r.ok) { st.fallos++; process.stdout.write(`\r\x1b[K   ⛔ ${g._id.isbn}: ${r.motivo}\n`); continue; }
        st.fusionados++; st.retirados += r.retirados.length; st.versiones += r.versiones.length;
    } catch (e) { st.fallos++; process.stdout.write(`\r\x1b[K   ⛔ ${g._id.isbn}: ${e.message}\n`); }
}
process.stdout.write('\r\x1b[K');
console.log(`\n=== RESUMEN ===`);
console.log(`  grupos fusionados             : ${st.fusionados}`);
console.log(`  documentos retirados          : ${st.retirados}  (su id redirige al principal)`);
console.log(`  ficheros conservados como versión: ${st.versiones}`);
if (st.fallos) console.log(`  fallos                        : ${st.fallos}`);
console.log(`  tiempo: ${Math.round((Date.now() - t0) / 1000)} s\n`);
process.exit(0);
