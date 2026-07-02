/**
 * Consolida las colecciones de LIBROS que quedaron DUPLICADAS por volumen antes del fix de ingesta
 * (una colección por tomo: «Alianza cien 15», «Alianza 100 10», …). Reutiliza `separarNumeroColeccion`
 * (mismo criterio que la ingesta):
 *   · calcula el nombre CANÓNICO de cada colección (separa el nº de volumen del nombre + aplica alias),
 *   · funde las que colapsan al mismo nombre (canónica = la que ya tiene el nombre limpio; si no, la de
 *     MÁS miembros), REASIGNA `biblioteca.coleccion` a la canónica y `coleccion_nombre` al nombre limpio,
 *   · RELLENA `coleccion_numero` de cada documento con el número que estaba embebido en el nombre de SU
 *     colección (si el documento no lo tenía ya),
 *   · borra las colecciones absorbidas (ya vacías).
 * NO toca cabeceras de revista (tipo:'revista'). DRY-RUN por defecto; --ejecutar aplica. Idempotente.
 *
 *   node scripts/consolidar-colecciones.js               (DRY-RUN)
 *   node scripts/consolidar-colecciones.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { separarNumeroColeccion, claveCanonica, limpiarNombreColeccion } from '../src/utils/colecciones.js';

const EJECUTAR = process.argv.includes('--ejecutar');

async function main() {
    const db = await conectarDB();
    const colColecciones = db.collection('colecciones');
    const colBiblio = db.collection('biblioteca');

    const todas = await colColecciones.find({}).toArray();
    const libros = todas.filter((c) => c.tipo !== 'revista'); // las cabeceras de revista NO se tocan
    console.log(`\n📚 Colecciones: ${todas.length} (de libros: ${libros.length})`);

    // Nº de documentos miembro por colección (para elegir la canónica con menos reasignaciones).
    const miembros = new Map();
    for (const r of await colBiblio.aggregate([
        { $match: { coleccion: { $ne: null } } },
        { $group: { _id: '$coleccion', n: { $sum: 1 } } },
    ]).toArray()) {
        miembros.set(String(r._id), r.n);
    }
    const nMiembros = (id) => miembros.get(String(id)) || 0;

    // Agrupar por CLAVE CANÓNICA: las VARIANTES DE GRAFÍA del mismo grupo caen juntas («Cátedra, Letras
    // Universales» ≡ «Letras Universales Cátedra» ≡ «Cátedra-Letras Universales»). Si el nombre no da ≥2
    // tokens significativos (clave null), se agrupa por el nombre limpio EXACTO (evita fundir de más).
    // Cada item guarda su nombre limpio y el número embebido en el nombre de ESA colección (o null).
    // La clave y el nombre limpio deben ser CONSISTENTES: si se agrupa por el nombre solo con el número
    // separado (deja tokens como «ISSN»/«0075»), «Springer … series, ISSN 1615» NO caería con «Springer …
    // series» y luego al renombrar chocaría con ella (E11000). Por eso se LIMPIA el nombre (quita « ; v»,
    // «, ISSN …») ANTES de calcular la clave y de agrupar. `limpio` = nombre final de esa colección.
    const grupos = new Map();
    for (const c of libros) {
        const { nombre, numero } = separarNumeroColeccion(c.nombre);
        const limpio = limpiarNombreColeccion(nombre || c.nombre);
        const clave = claveCanonica(limpio) || limpio.toLowerCase();
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push({ col: c, numero, limpio });
    }

    // Plan: grupos con >1 colección, o con una sola pero cuyo nombre hay que limpiar.
    const plan = [];
    for (const items of grupos.values()) {
        // Canónica: la que YA tiene el nombre limpio; si no, la de más miembros; desempate por _id.
        items.sort((a, b) => {
            const aEx = a.col.nombre === a.limpio ? 1 : 0, bEx = b.col.nombre === b.limpio ? 1 : 0;
            return bEx - aEx || nMiembros(b.col._id) - nMiembros(a.col._id) || String(a.col._id).localeCompare(String(b.col._id));
        });
        const canonical = items[0].col;
        const canon = items[0].limpio;   // nombre del grupo = el nombre YA LIMPIO de la canónica
        const hayQueRenombrar = items.some((it) => it.col.nombre !== canon);
        if (items.length === 1 && !hayQueRenombrar) continue; // grupo de 1 ya correcto (la clave la pone el backfill final)
        const absorbidos = items.slice(1).map((it) => it.col);
        const numeroPorCol = new Map(); // colecciónId → número embebido en su nombre (para rellenar los docs)
        for (const it of items) if (it.numero) numeroPorCol.set(String(it.col._id), it.numero);
        const ids = items.map((it) => it.col._id);
        const nDocs = ids.reduce((s, id) => s + nMiembros(id), 0);
        plan.push({ canon, canonical, absorbidos, numeroPorCol, ids, nDocs, rename: canonical.nombre !== canon });
    }

    // Colecciones (de libros) a las que les FALTA la clave canónica → se rellenará (habilita el
    // emparejamiento por grafía en futuras ingestas). Se cuenta para el informe.
    const sinClave = libros.filter((c) => !c.clave_canonica && claveCanonica(separarNumeroColeccion(c.nombre).nombre || c.nombre));

    // ── Informe ──────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n── Plan ${EJECUTAR ? '(EJECUTAR)' : '(DRY-RUN)'} ──`);
    console.log(`  Grupos a consolidar (incl. variantes de grafía): ${plan.length}`);
    console.log(`  Colecciones a borrar (absorbidas): ${plan.reduce((s, p) => s + p.absorbidos.length, 0)}`);
    console.log(`  Documentos a reasignar/actualizar: ${plan.reduce((s, p) => s + p.nDocs, 0)}`);
    console.log(`  Clave canónica a rellenar (para emparejar en el futuro): ${sinClave.length}`);
    for (const p of plan.slice(0, 25)) {
        console.log(`\n  «${p.canon}»  (canónica: «${p.canonical.nombre}» · ${p.nDocs} doc)`);
        for (const a of p.absorbidos) console.log(`     ⇐ «${a.nombre}»`);
    }

    if (!EJECUTAR) {
        console.log('\n(DRY-RUN: no se ha escrito nada. Repite con --ejecutar para aplicar.)\n');
        process.exit(0);
    }

    // ── Aplicar ──────────────────────────────────────────────────────────────────────────────────────
    let nRen = 0, nDocU = 0, nDel = 0, nOmit = 0;
    for (const p of plan) {
        if (p.rename) {
            // Salvaguarda: el nombre limpio ya puede pertenecer a OTRA colección FUERA de este grupo (p. ej.
            // una cabecera de revista, excluida del ámbito «libros»). Renombrar chocaría con el índice único
            // (E11000). En ese caso se OMITE el grupo (revisión manual) — no se funde libro↔revista a ciegas.
            const ocupa = await colColecciones.findOne(
                { nombre: p.canon, _id: { $nin: p.ids } },
                { collation: { locale: 'es', strength: 1 } },
            );
            if (ocupa) {
                console.warn(`  ⚠️ «${p.canon}» ya existe (${ocupa.tipo === 'revista' ? 'revista' : 'otra colección'}); grupo OMITIDO (revisar a mano).`);
                nOmit++;
                continue;
            }
            await colColecciones.updateOne({ _id: p.canonical._id }, { $set: { nombre: p.canon, fecha_actualizacion: new Date() } })
                .catch((e) => { console.warn(`  ⚠️ renombrar ${p.canonical._id}: ${e.message}`); });
            nRen++;
        }
        // Rellenar issn/editorial/cdu/clave_canonica de la canónica desde las absorbidas / el nombre si faltan.
        const relleno = {};
        for (const a of p.absorbidos) {
            if (!p.canonical.issn && a.issn) relleno.issn = a.issn;
            if (!p.canonical.editorial && a.editorial) relleno.editorial = a.editorial;
            if (!p.canonical.cdu && a.cdu) relleno.cdu = a.cdu;
        }
        if (!p.canonical.clave_canonica) {
            const k = claveCanonica(p.canon);
            if (k) relleno.clave_canonica = k;
        }
        if (Object.keys(relleno).length) {
            await colColecciones.updateOne({ _id: p.canonical._id }, { $set: relleno }).catch(() => {});
        }

        // Reasignar TODOS los documentos del grupo → canónica; nombre canónico + nº embebido si faltaba.
        const docs = await colBiblio.find({ coleccion: { $in: p.ids } }, { projection: { coleccion: 1, coleccion_numero: 1 } }).toArray();
        for (const d of docs) {
            const set = { coleccion: p.canonical._id, coleccion_nombre: p.canon, fecha_actualizacion: new Date() };
            if (!d.coleccion_numero) {
                const num = p.numeroPorCol.get(String(d.coleccion));
                if (num) set.coleccion_numero = String(num);
            }
            await colBiblio.updateOne({ _id: d._id }, { $set: set }).catch((e) => console.warn(`  ⚠️ doc ${d._id}: ${e.message}`));
            nDocU++;
        }

        // Borrar las colecciones absorbidas (ya sin miembros).
        for (const a of p.absorbidos) {
            await colColecciones.deleteOne({ _id: a._id }).catch((e) => console.warn(`  ⚠️ borrar ${a._id}: ${e.message}`));
            nDel++;
        }
    }

    // Backfill de clave_canonica en TODAS las colecciones de libros que aún no la tengan (habilita el
    // emparejamiento por grafía en la ingesta futura). Idempotente; no toca cabeceras de revista.
    let nClave = 0;
    for (const c of await colColecciones.find({ tipo: { $ne: 'revista' }, clave_canonica: { $exists: false } }).toArray()) {
        const k = claveCanonica(separarNumeroColeccion(c.nombre).nombre || c.nombre);
        if (k) { await colColecciones.updateOne({ _id: c._id }, { $set: { clave_canonica: k } }).catch(() => {}); nClave++; }
    }

    console.log(`\n✅ Hecho: ${nRen} renombrada(s), ${nDocU} documento(s) actualizado(s), ${nDel} colección(es) borrada(s), ${nClave} clave(s) canónica(s) rellenada(s)${nOmit ? `, ${nOmit} grupo(s) OMITIDO(s) (nombre ya en uso)` : ''}.\n`);
    process.exit(0);
}

main().catch((e) => {
    console.error('❌ Error:', e);
    process.exit(1);
});
