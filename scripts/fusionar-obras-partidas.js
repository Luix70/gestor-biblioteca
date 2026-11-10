#!/usr/bin/env node
/**
 * FUSIONAR OBRAS PARTIDAS — una obra multivolumen catalogada como dos o más obras («Gale - Schlager - Science and
 * Its Times» con los tomos 4-7 y «Science and Its Times» con los 1-3). Detector y reglas: src/utils/obras-partidas.js.
 *
 * Por defecto NO toca nada: lista los grupos SEGUROS (tomos que no se solapan + misma editorial o mismo registrante
 * de ISBN + títulos iguales o uno el final del otro) y deja en la selección «Obras partidas por revisar» los tomos
 * de los pares que solo se parecen por el título (tomos repetidos, sin editorial que lo confirme, título corto…).
 * Con --ejecutar fusiona los seguros con la misma función que «⛙ Fusionar obras» del panel: los tomos pasan a la
 * obra que se conserva (la que tiene isbn_obra; si no, la de más tomos) y sus CARPETAS se mudan a la de esa obra,
 * con su CDU. Los títulos de las obras absorbidas quedan en titulos_alt (un tomo futuro con ese nombre cae bien).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/fusionar-obras-partidas.js               (diagnóstico + selección)
 *   sudo docker exec -t gestor-biblioteca node scripts/fusionar-obras-partidas.js --ejecutar    (fusiona los seguros)
 *   … --limite N          como mucho N grupos (para probar)
 *   … --sin-seleccion     no crea la selección de revisión
 *
 * ⚠ Antes de --ejecutar: COPIA DE SEGURIDAD de la base de datos. Debe correr en el NAS (mueve carpetas).
 * Reanudable: lo fusionado ya no forma grupo.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { gruposObrasPartidas } from '../src/utils/obras-partidas.js';
import { fusionarObras } from '../src/utils/gestion-grupos.js';
import { crearSeleccion, reemplazarDocs } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SELECCION = !args.includes('--sin-seleccion');
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const LIMITE = parseInt(arg('--limite'), 10) || Infinity;
const NOMBRE_SELECCION = 'Obras partidas por revisar';

const db = await conectarDB();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DIAGNÓSTICO'} · obras multivolumen partidas\n`);

// ── 1. Detectar ──────────────────────────────────────────────────────────────────────────────────────────
const total = await db.collection('obras').countDocuments({ tipo: { $ne: 'revista' } });
const pd = progreso(total, 'Comparando obras');
const { seguros, revisar } = await gruposObrasPartidas(db, { alPaso: (t) => pd.paso(t) });
pd.fin();

const tomosTxt = (o) => `${o.tomos} tomo(s)${o.numeros.size ? ` [${[...o.numeros].sort((a, b) => a - b).join(',')}]` : ''}`;
console.log(`   SEGUROS (se fusionan con --ejecutar): ${seguros.length} grupo(s)`);
for (const g of seguros) {
    console.log(`   ⛙ «${g.destino.titulo}»${g.destino.isbn_obra ? ` (${g.destino.isbn_obra})` : ''} · ${tomosTxt(g.destino)} — ${g.motivo}`);
    for (const o of g.obras) if (o !== g.destino) console.log(`        ← «${o.titulo}» · ${tomosTxt(o)}`);
}
const motivos = {};
for (const r of revisar) motivos[r.motivo.replace(/\(.*\)/, '').trim()] = (motivos[r.motivo.replace(/\(.*\)/, '').trim()] || 0) + 1;
console.log(`\n   por revisar (solo se parecen por el título): ${revisar.length} par(es)`);
for (const [m, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) console.log(`     · ${m}: ${n}`);
for (const r of revisar) console.log(`     ? «${r.a.titulo}» · ${tomosTxt(r.a)}  ~  «${r.b.titulo}» · ${tomosTxt(r.b)} — ${r.motivo}`);

// ── 2. Selección de revisión (una sola; ordenar por obra junta cada par) ─────────────────────────────────
if (SELECCION) {
    const ids = [...new Set(revisar.flatMap((r) => [...r.a.idsTomos, ...r.b.idsTomos]).map(String))];
    const col = db.collection('selecciones');
    const ya = await col.findOne({ nombre: NOMBRE_SELECCION }, { projection: { _id: 1 } });
    const descripcion = 'Tomos de obras que podrían ser la misma (título parecido) pero que no se fusionan solas. '
        + 'Revísalas en Obras y usa «⛙ Fusionar» si lo son. Generada por scripts/fusionar-obras-partidas.js.';
    if (ids.length) {
        if (ya) await reemplazarDocs(db, ya._id, ids);
        else await crearSeleccion(db, { nombre: NOMBRE_SELECCION, descripcion, docs: ids });
        console.log(`\n   📋 Selección «${NOMBRE_SELECCION}»: ${ids.length} tomo(s).`);
    }
}

// ── 3. Fusionar los seguros ──────────────────────────────────────────────────────────────────────────────
if (!EJECUTAR) {
    console.log('\n   (diagnóstico: no se ha fusionado nada; --ejecutar fusiona los grupos SEGUROS)\n');
    process.exit(0);
}
const lista = seguros.slice(0, LIMITE);
const pf = progreso(lista.length, 'Fusionando obras');
let hechas = 0, tomos = 0, fallos = 0;
for (const g of lista) {
    pf.paso(g.destino.titulo);
    try {
        const r = await fusionarObras(db, g.obras.map((o) => o._id), g.destino._id);
        if (!r.ok) { fallos++; pf.nota(`   ❌ «${g.destino.titulo}»: ${r.motivo}`); continue; }
        hechas++;
        tomos += r.movidos;
        pf.nota(`   ✅ «${g.destino.titulo}»: ${r.movidos} tomo(s) unidos de ${r.fusionadas} obra(s)`);
        for (const a of r.avisos || []) pf.nota(`        · ${a}`);
    } catch (e) {
        fallos++;
        pf.nota(`   ❌ «${g.destino.titulo}»: ${e.message}`);
    }
}
pf.fin();
console.log(`\n   Fusionadas ${hechas} obra(s) · ${tomos} tomo(s) movidos${fallos ? ` · ${fallos} con error` : ''}.\n`);
process.exit(0);
