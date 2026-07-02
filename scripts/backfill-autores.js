/**
 * Backfill de la colección `autores` — pone los nombres importados (volcado BNE/OL) en la MISMA forma
 * canónica que produce hoy la ingesta (motor-catalogo · normalizarAutor + latinizarNombre):
 *   · marcador «/**​/» (autor · traductor · …) → se queda con el PRIMER contribuyente,
 *   · FECHAS de vida «(1857-1924)» → campos biográficos nacimiento/fallecimiento (fuera del nombre),
 *   · nombre en otro alfabeto (cirílico/griego) → principal LATINIZADO + grafías originales en nombres_alternativos.
 *
 * Tras limpiar, DEDUPLICA los autores que colapsan al mismo nombre canónico (p. ej. «Chéjov (1860-1904)»,
 * «Chéjov» y «Чехов» → un solo autor): elige como canónico el MÁS referenciado, fusiona en él las grafías
 * (nombres_alternativos) y la bio, REASIGNA las referencias en `biblioteca.autores` y borra los duplicados.
 *
 * DRY-RUN por defecto (solo informa). Aplica con --ejecutar. No borra nada más; las reasignaciones son
 * idempotentes (se puede volver a ejecutar sin daño).
 *
 *   node scripts/backfill-autores.js                 (DRY-RUN)
 *   node scripts/backfill-autores.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { normalizarAutor } from '../src/utils/autor-normalizar.js';
import { latinizarNombre } from '../src/utils/transliterar.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// Forma canónica de un nombre, igual que la ingesta: primer contribuyente + fechas fuera + latinizado.
// Devuelve { nombre (latinizado), limpio (pre-latinizado), alternativos, nacimiento, fallecimiento }.
function canonizar(raw) {
    const bio = normalizarAutor(raw);
    const limpio = bio.nombre || String(raw || '').trim();
    const { nombre, alternativos } = latinizarNombre(limpio);
    return { nombre, limpio, alternativos: alternativos || [], nacimiento: bio.nacimiento, fallecimiento: bio.fallecimiento };
}

async function main() {
    const db = await conectarDB();
    const colAutores = db.collection('autores');
    const colBiblio = db.collection('biblioteca');

    const autores = await colAutores.find({}).toArray();
    console.log(`\n📚 Autores en la base: ${autores.length}`);

    // Nº de documentos que referencian cada autor (para elegir el canónico con menos reasignaciones).
    const refs = new Map();
    for (const r of await colBiblio.aggregate([{ $unwind: '$autores' }, { $group: { _id: '$autores', n: { $sum: 1 } } }]).toArray()) {
        refs.set(String(r._id), r.n);
    }
    const nrefs = (id) => refs.get(String(id)) || 0;

    // Agrupar por nombre canónico (case-insensitive). Cada grupo de >1 se fusiona; los de 1, se limpian in situ.
    const grupos = new Map();
    let sinNombre = 0;
    for (const a of autores) {
        const canon = canonizar(a.nombre);
        if (!canon.nombre) { sinNombre++; continue; } // nombre que quedaría vacío tras limpiar → no tocar
        const clave = canon.nombre.toLowerCase();
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push({ doc: a, canon });
    }

    const limpiezas = []; // { _id, antes, set }               un autor, sin colisión, con cambios
    const fusiones = [];  // { canonical, nombre, set, absorbidos:[{_id,nombre}] }
    const remap = new Map(); // absorbedIdStr → canonicalId (global, para reasignar referencias en una pasada)

    for (const miembros of grupos.values()) {
        // Nombre canónico definitivo: la grafía latinizada del miembro más referenciado (determinista).
        miembros.sort((x, y) => nrefs(y.doc._id) - nrefs(x.doc._id) || String(x.doc._id).localeCompare(String(y.doc._id)));
        const nombreCanon = miembros[0].canon.nombre;

        // Unión de grafías alternativas de TODO el grupo (limpias, nunca el string con /**​/): las pre-latinizadas
        // y las originales que aporte latinizarNombre, más las que ya tuvieran los docs. Se excluye el canónico.
        const alt = new Set();
        let nacimiento = null, fallecimiento = null;
        for (const { doc, canon } of miembros) {
            (doc.nombres_alternativos || []).forEach((x) => alt.add(x));
            if (canon.limpio && canon.limpio !== nombreCanon) alt.add(canon.limpio);
            (canon.alternativos || []).forEach((x) => alt.add(x));
            if (!nacimiento && canon.nacimiento) nacimiento = canon.nacimiento;
            if (!fallecimiento && canon.fallecimiento) fallecimiento = canon.fallecimiento;
            if (!nacimiento && doc.nacimiento) nacimiento = doc.nacimiento;
            if (!fallecimiento && doc.fallecimiento) fallecimiento = doc.fallecimiento;
        }
        alt.delete(nombreCanon);
        alt.delete('');
        const alternativos = [...alt].sort();

        if (miembros.length === 1) {
            const { doc } = miembros[0];
            const set = {};
            if (nombreCanon !== doc.nombre) set.nombre = nombreCanon;
            const altActual = (doc.nombres_alternativos || []).slice().sort();
            if (JSON.stringify(alternativos) !== JSON.stringify(altActual) && alternativos.length) set.nombres_alternativos = alternativos;
            if (nacimiento && !doc.nacimiento) set.nacimiento = nacimiento;
            if (fallecimiento && !doc.fallecimiento) set.fallecimiento = fallecimiento;
            if (Object.keys(set).length) limpiezas.push({ _id: doc._id, antes: doc.nombre, set });
            continue;
        }

        // Fusión: el primero (más referenciado) es el canónico; el resto se absorben.
        const canonical = miembros[0].doc;
        const absorbidos = miembros.slice(1).map((m) => m.doc);
        const set = {};
        if (nombreCanon !== canonical.nombre) set.nombre = nombreCanon;
        if (alternativos.length) set.nombres_alternativos = alternativos;
        if (nacimiento && !canonical.nacimiento) set.nacimiento = nacimiento;
        if (fallecimiento && !canonical.fallecimiento) set.fallecimiento = fallecimiento;
        for (const a of absorbidos) remap.set(String(a._id), canonical._id);
        fusiones.push({ canonical: canonical._id, nombre: nombreCanon, set, absorbidos: absorbidos.map((a) => ({ _id: a._id, nombre: a.nombre })) });
    }

    // Documentos de biblioteca que habrá que reasignar (referencian a algún autor absorbido).
    const oidAbsorbed = fusiones.flatMap((f) => f.absorbidos.map((a) => a._id));
    const docsReasignar = oidAbsorbed.length
        ? await colBiblio.find({ autores: { $in: oidAbsorbed } }, { projection: { autores: 1 } }).toArray()
        : [];

    // ── Informe ──────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n── Plan ${EJECUTAR ? '(EJECUTAR)' : '(DRY-RUN)'} ──`);
    console.log(`  Nombres que quedarían vacíos al limpiar (se dejan intactos): ${sinNombre}`);
    console.log(`  Limpiezas in situ (nombre/bio/alternativos): ${limpiezas.length}`);
    console.log(`  Fusiones (grupos duplicados): ${fusiones.length}  →  autores a borrar: ${oidAbsorbed.length}`);
    console.log(`  Documentos de biblioteca a reasignar: ${docsReasignar.length}`);

    const muestra = (arr, n = 12) => arr.slice(0, n);
    if (limpiezas.length) {
        console.log('\n  Ejemplos de limpieza:');
        for (const l of muestra(limpiezas)) {
            const bits = Object.entries(l.set).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ');
            console.log(`    · «${l.antes}»  →  ${bits}`);
        }
    }
    if (fusiones.length) {
        console.log('\n  Ejemplos de fusión:');
        for (const f of muestra(fusiones)) {
            console.log(`    · «${f.nombre}»  ⇐  ${f.absorbidos.map((a) => `«${a.nombre}»`).join(', ')}`);
        }
    }

    if (!EJECUTAR) {
        console.log('\n(DRY-RUN: no se ha escrito nada. Repite con --ejecutar para aplicar.)\n');
        process.exit(0);
    }

    // ── Aplicar ──────────────────────────────────────────────────────────────────────────────────────
    let nLimp = 0, nCanon = 0, nBorr = 0, nReasig = 0;

    for (const l of limpiezas) {
        await colAutores.updateOne({ _id: l._id }, { $set: l.set }).catch((e) => console.warn(`  ⚠️ limpieza ${l._id}: ${e.message}`));
        nLimp++;
    }
    for (const f of fusiones) {
        if (Object.keys(f.set).length) {
            await colAutores.updateOne({ _id: f.canonical }, { $set: f.set }).catch((e) => console.warn(`  ⚠️ canónico ${f.canonical}: ${e.message}`));
            nCanon++;
        }
    }
    // Reasignar referencias en biblioteca (map absorbed→canonical + dedup del array). Una pasada por doc.
    for (const b of docsReasignar) {
        const nuevos = [];
        const visto = new Set();
        for (const aid of b.autores || []) {
            const rep = remap.get(String(aid)) || aid;
            const k = String(rep);
            if (!visto.has(k)) { visto.add(k); nuevos.push(rep); }
        }
        await colBiblio.updateOne({ _id: b._id }, { $set: { autores: nuevos, fecha_actualizacion: new Date() } }).catch((e) => console.warn(`  ⚠️ reasignar ${b._id}: ${e.message}`));
        nReasig++;
    }
    // Borrar los autores absorbidos (ya sin referencias).
    for (const id of oidAbsorbed) {
        await colAutores.deleteOne({ _id: id }).catch((e) => console.warn(`  ⚠️ borrar ${id}: ${e.message}`));
        nBorr++;
    }

    console.log(`\n✅ Hecho: ${nLimp} limpieza(s), ${nCanon} canónico(s) actualizado(s), ${nReasig} documento(s) reasignado(s), ${nBorr} autor(es) duplicado(s) borrado(s).\n`);
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
});
