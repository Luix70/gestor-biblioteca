// ── SEPARAR AUTORES/COLABORADORES FUSIONADOS ────────────────────────────────────────────────────────────
// Backfill para lo YA catalogado del mismo bug que arreglamos en la ingesta: una mención con VARIAS personas
// unidas por « & »/« ; »/« / » (p. ej. «Rochegrosse, Georges & Rackham, Arthur & Clarke, Harry (Ilustrador)»)
// se guardó como UN ÚNICO registro de `autores` (una «persona» con cinco nombres pegados), referenciado por
// los libros. Este script:
//   1) localiza los registros de `autores` cuyo nombre es una fusión (separarAutores → ≥2 partes),
//   2) resuelve cada parte a su persona REAL (resolverPersona: check-then-create, dedup por acentos/mayúsc.),
//   3) RE-APUNTA cada libro que lo referenciaba: en `autores[]` y en `contribuciones[].persona` (mismo rol),
//   4) si el registro fusionado queda sin ninguna referencia, lo BORRA (es un artefacto, no una persona real).
//
// Usa EXACTAMENTE el mismo separarAutores que la ingesta → respeta «Ortega y Gasset», «Ramón y Cajal» (no
// parte por « y ») y no toca el marcador BNE «/**​/». ANTI-PÉRDIDA: solo borra un registro fusionado tras
// comprobar que ya no lo referencia NINGÚN documento; nunca borra una persona real.
//
// DRY-RUN por defecto (no escribe nada): lista qué se separaría y cuántos libros afecta.
//   node scripts/separar-autores-fusionados.js               (informe)
//   node scripts/separar-autores-fusionados.js --limite 20   (informe, solo los N primeros grupos)
//   node scripts/separar-autores-fusionados.js --ejecutar     (aplica → BORRA los fusionados; BACKUP antes)
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { separarAutores } from '../src/utils/autor-normalizar.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = parseInt((args[args.indexOf('--limite') + 1] || '0'), 10) || 0;

const sid = (x) => String(x);

// ¿El nombre de este registro de `autores` es una FUSIÓN de varias personas? (mismo criterio que la ingesta)
function partesFusion(nombre) {
    const partes = separarAutores(nombre);
    return partes.length >= 2 ? partes : null;
}

// Re-apunta un documento: sustituye `viejoId` por `nuevosIds[]` en autores[] y en contribuciones[].persona
// (conservando el rol de cada contribución), deduplicando. Devuelve el $set a aplicar (o null si no cambia nada).
function reapuntarDoc(doc, viejoId, nuevosIds) {
    const set = {};
    const vid = sid(viejoId);

    if (Array.isArray(doc.autores) && doc.autores.some((a) => sid(a) === vid)) {
        const out = [];
        const vistos = new Set();
        for (const a of doc.autores) {
            const reemplazos = sid(a) === vid ? nuevosIds : [a];
            for (const r of reemplazos) if (!vistos.has(sid(r))) { vistos.add(sid(r)); out.push(r); }
        }
        set.autores = out;
    }

    if (Array.isArray(doc.contribuciones) && doc.contribuciones.some((c) => c && sid(c.persona) === vid)) {
        const out = [];
        const vistos = new Set();
        for (const c of doc.contribuciones) {
            if (!c || !c.persona) continue;
            const reemplazos = sid(c.persona) === vid ? nuevosIds : [c.persona];
            for (const r of reemplazos) {
                const clave = `${sid(r)}|${c.rol || ''}`;
                if (vistos.has(clave)) continue;
                vistos.add(clave);
                out.push({ ...c, persona: r });
            }
        }
        set.contribuciones = out;
    }

    return Object.keys(set).length ? set : null;
}

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const colAutores = db.collection('autores');

    // Candidatos: registros de `autores` cuyo nombre contiene un separador de fusión (& · ; · « / »). El
    // filtro fino (≥2 partes, respetando « y ») lo hace separarAutores; el regex solo acota el escaneo.
    const candidatos = await colAutores
        .find({ nombre: { $regex: '[&;]|\\s/\\s' } }, { projection: { nombre: 1 } })
        .toArray();

    let nGrupos = 0, nDocsAfectados = 0, nBorrados = 0, nCreadosAprox = 0;
    const referenciaFiltro = (id) => ({ $or: [{ autores: id }, { 'contribuciones.persona': id }] });

    for (const m of candidatos) {
        const partes = partesFusion(m.nombre);
        if (!partes) continue;
        // Solo interesa si REALMENTE lo referencia algún documento (los del volcado sin libros son ruido).
        const docs = await bib.find(referenciaFiltro(m._id)).toArray();
        if (!docs.length) continue;

        nGrupos++;
        if (LIMITE && nGrupos > LIMITE) { nGrupos--; break; }

        if (!EJECUTAR) {
            // Dry-run: no resuelve/crea nada; solo informa la separación y el alcance.
            console.log(`  «${m.nombre}»  →  [${partes.map((p) => `«${p}»`).join(', ')}]  ·  ${docs.length} libro(s)`);
            nDocsAfectados += docs.length;
            nCreadosAprox += partes.length;
            continue;
        }

        // Ejecutar: resuelve cada parte a su persona real (crea si no existe), evitando reapuntar al propio
        // registro fusionado.
        const nuevosIds = [];
        const vistos = new Set();
        for (const p of partes) {
            const r = await resolverPersona(db, p);
            if (!r || sid(r._id) === sid(m._id)) continue;
            if (r.creada) nCreadosAprox++;
            if (!vistos.has(sid(r._id))) { vistos.add(sid(r._id)); nuevosIds.push(r._id); }
        }
        if (!nuevosIds.length) { console.log(`  ⚠️  «${m.nombre}»: no se pudo resolver ninguna parte; se deja intacto`); continue; }

        let afectados = 0;
        for (const doc of docs) {
            const set = reapuntarDoc(doc, m._id, nuevosIds);
            if (!set) continue;
            set.fecha_actualizacion = new Date();
            await bib.updateOne({ _id: doc._id }, { $set: set });
            afectados++;
        }
        nDocsAfectados += afectados;

        // ANTI-PÉRDIDA: solo borra el fusionado si YA no lo referencia nadie.
        const restantes = await bib.countDocuments(referenciaFiltro(m._id), { limit: 1 });
        if (restantes === 0) {
            await colAutores.deleteOne({ _id: m._id });
            nBorrados++;
            console.log(`  «${m.nombre}» → [${nuevosIds.length} personas] · ${afectados} libro(s) · registro fusionado borrado`);
        } else {
            console.log(`  «${m.nombre}» → [${nuevosIds.length} personas] · ${afectados} libro(s) · NO se borra (aún referenciado)`);
        }
    }

    console.log(`\nGrupos fusionados con libros: ${nGrupos}`);
    console.log(`Libros ${EJECUTAR ? 'actualizados' : 'que se actualizarían'}: ${nDocsAfectados}`);
    console.log(`Personas ${EJECUTAR ? 'creadas' : 'que se crearían (aprox.)'}: ${nCreadosAprox}`);
    if (EJECUTAR) console.log(`Registros fusionados borrados: ${nBorrados}`);
    else console.log('\n(dry-run) No se ha escrito nada. Relanza con --ejecutar para aplicar. ⚠ Haz BACKUP antes.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
