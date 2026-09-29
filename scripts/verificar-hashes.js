#!/usr/bin/env node
/**
 * VERIFICAR HASHES — detecta los documentos cuyo hash ha quedado DESACTUALIZADO (el fichero se modificó después de
 * calcularlo: se le quitó una página, se anotó…) y, con --ejecutar, lo regenera. Motor: src/utils/hash-doc.js.
 *
 * Detección BARATA (no lee los ficheros): compara el tamaño y la fecha de modificación del fichero con la huella
 * guardada junto al hash; en los documentos antiguos sin huella, la fecha del fichero con la de su ingesta. Un
 * sospechoso se CONFIRMA al regenerar: si el hash sale igual, solo se anota la huella (mover o restaurar carpetas
 * también cambia la fecha del fichero).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/verificar-hashes.js                (diagnóstico + selección)
 *   sudo docker exec -t gestor-biblioteca node scripts/verificar-hashes.js --ejecutar     (regenera sospechosos y sin hash)
 *   … --todos        recalcula TODOS (no solo los sospechosos): lee cada fichero, lento
 *   … --id <id>      uno solo
 *   … --sin-seleccion  no crea la selección «Hash por revisar»
 *
 * Reanudable: lo ya regenerado tiene huella al día y no vuelve a salir.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { estadoHash, regenerarHashDoc, PROYECCION_HASH } from '../src/utils/hash-doc.js';
import { crearSeleccion, reemplazarDocs } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const TODOS = args.includes('--todos');
const SELECCION = !args.includes('--sin-seleccion');
const iId = args.indexOf('--id');
const ID = iId >= 0 ? args[iId + 1] : null;

const db = await conectarDB();
const col = db.collection('biblioteca');
const filtro = ID ? { _id: new ObjectId(ID) } : { nombre_archivo: { $exists: true, $ne: '' }, formatos: { $ne: 'papel' } };
const docs = await col.find(filtro, { projection: PROYECCION_HASH }).toArray();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DIAGNÓSTICO'} · ${docs.length} documento(s) con fichero${TODOS ? ' · recalculando TODOS' : ''}\n`);

// ── 1. Diagnóstico por huella (stat) ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const cuenta = { 'al-dia': 0, 'sin-huella': 0, sospechoso: 0, 'sin-hash': 0, 'sin-fichero': 0 };
const sospechosos = [], sinHash = [], aRecalcular = [];
let i = 0;
for (const d of docs) {
    i++;
    if (i % 200 === 0) process.stdout.write(`\r\x1b[K   ⏳ comprobando ${i}/${docs.length}`);
    const e = await estadoHash(d);
    if (e.estado === 'al-dia' && e.sinHuella) cuenta['sin-huella']++;
    else cuenta[e.estado]++;
    if (e.estado === 'sospechoso') sospechosos.push({ d, motivo: e.motivo });
    if (e.estado === 'sin-hash') sinHash.push(d);
    if (TODOS && e.estado !== 'sin-fichero') aRecalcular.push(d);
}
process.stdout.write('\r\x1b[K');
console.log(`   al día                : ${cuenta['al-dia']}`);
console.log(`   al día (sin huella)   : ${cuenta['sin-huella']}  (anteriores a la huella; se anota al regenerar)`);
console.log(`   SOSPECHOSOS           : ${cuenta.sospechoso}  (el fichero cambió después de calcular su hash)`);
console.log(`   sin hash              : ${cuenta['sin-hash']}`);
console.log(`   sin fichero           : ${cuenta['sin-fichero']}`);
for (const { d, motivo } of sospechosos.slice(0, 30)) console.log(`   ⚠️  ${d._id} · ${String(d.titulo || '').slice(0, 50)} — ${motivo}`);
if (sospechosos.length > 30) console.log(`   … y ${sospechosos.length - 30} más`);

// Selección para revisarlos (o regenerarlos) desde el panel.
if (SELECCION && sospechosos.length && !ID) {
    const nombre = `Hash por revisar (${sospechosos.length})`;
    const ya = await db.collection('selecciones').findOne({ nombre: { $regex: '^Hash por revisar' } }, { projection: { _id: 1 } });
    const ids = sospechosos.map((x) => x.d._id);
    if (ya) {
        await reemplazarDocs(db, ya._id, ids);
        await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { nombre } });
    } else {
        await crearSeleccion(db, { nombre, descripcion: 'Documentos cuyo fichero parece modificado DESPUÉS de calcular su hash (verificar-hashes.js). En el panel: «#️⃣ Regenerar hash».', docs: ids });
    }
    console.log(`\n📋 Selección «${nombre}» creada/actualizada: en el panel, «#️⃣ Regenerar hash» sobre ella.`);
}

// ── 2. Regenerar ─────────────────────────────────────────────────────────────────────────────────────────
const lista = TODOS ? aRecalcular : [...sospechosos.map((x) => x.d), ...sinHash];
if (!EJECUTAR) {
    console.log(`\nNo se ha cambiado nada. Con --ejecutar se regenerarían ${lista.length} hash(es).\n`);
    process.exit(0);
}
const st = { cambiados: 0, iguales: 0, nuevos: 0, duplicados: 0, fallos: 0, paginas: 0 };
const t1 = Date.now();
let j = 0;
for (const d of lista) {
    j++;
    const eta = j > 1 ? Math.round((Date.now() - t1) / (j - 1) * (lista.length - j + 1) / 1000) : null;
    process.stdout.write(`\r\x1b[K   ⏳ ${j}/${lista.length} · ${String(d.titulo || '').slice(0, 40)}${eta != null ? ` · ETA ${Math.floor(eta / 60)}m ${eta % 60}s` : ''}`);
    try {
        const r = await regenerarHashDoc(db, d);
        if (!r.ok) { st.fallos++; continue; }
        if (r.nuevo) st.nuevos++;
        else if (r.cambiado) {
            st.cambiados++;
            process.stdout.write(`\r\x1b[K   #️⃣  ${d._id} · ${String(d.titulo || '').slice(0, 45)} — hash nuevo${r.paginas ? ` · páginas ${r.paginas}` : ''}\n`);
        } else st.iguales++;
        if (r.paginas) st.paginas++;
        if (r.duplicadoDe) {
            st.duplicados++;
            process.stdout.write(`\r\x1b[K   ⚠️  ${d._id} · idéntico a ${r.duplicadoDe.id} («${String(r.duplicadoDe.titulo || '').slice(0, 40)}»)\n`);
        }
    } catch (e) { st.fallos++; process.stdout.write(`\r\x1b[K   ⛔ ${d._id}: ${e.message}\n`); }
}
process.stdout.write('\r\x1b[K');
console.log(`\n=== RESUMEN ===`);
console.log(`  hash CAMBIADO (fichero modificado) : ${st.cambiados}${st.paginas ? `  (${st.paginas} con nº de páginas corregido)` : ''}`);
console.log(`  igual (solo se anotó la huella)    : ${st.iguales}`);
console.log(`  hash nuevo (no tenía)              : ${st.nuevos}`);
if (st.duplicados) console.log(`  idénticos a otro documento         : ${st.duplicados}  (revisar: copia exacta)`);
if (st.fallos) console.log(`  sin fichero / error                : ${st.fallos}`);
console.log(`  tiempo: ${Math.round((Date.now() - t0) / 1000)} s\n`);
process.exit(0);
