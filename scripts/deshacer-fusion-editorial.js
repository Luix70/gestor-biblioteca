/**
 * DESHACER una fusión de editoriales que absorbió de más.
 *
 * Contexto (2026-07-10): un bug del panel (el diálogo listaba solo las editoriales VISIBLES pero fusionaba
 * TODA la selección, que sobrevive a las búsquedas) hizo que al combinar «Geoplaneta»+«GeoPlaneta» se absorbiera
 * además «Seix Barral», con ~292 libros. El bug ya está corregido; esto repara los datos.
 *
 * CÓMO SE IDENTIFICAN los libros a devolver: `fusionarEditoriales` hace UN updateMany que pone la misma
 * `fecha_actualizacion` a TODOS los reasignados. Esa marca temporal (al segundo) los distingue con precisión de
 * los libros que ya eran del destino (que no se tocaron).
 *
 * SEGURIDAD:
 *   · DRY-RUN por defecto; `--ejecutar` aplica.
 *   · Antes de escribir vuelca un MANIFIESTO JSON con los _id exactos → la operación es reversible.
 *   · Guarda de cordura: aborta si el nº de libros encontrados se aleja de `--esperados` (salvo `--forzar`).
 *   · No borra NADA: solo reasigna `editorial` y quita un alias.
 *
 *   node scripts/deshacer-fusion-editorial.js --destino GeoPlaneta --restaurar "Seix Barral" \
 *        --ts 2026-07-10T09:10:23Z --esperados 293                (DRY-RUN)
 *   node scripts/deshacer-fusion-editorial.js ... --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';

const arg = (nombre, pordefecto = null) => {
    const i = process.argv.indexOf(nombre);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : pordefecto;
};
const EJECUTAR = process.argv.includes('--ejecutar');
const FORZAR = process.argv.includes('--forzar');
const DESTINO = arg('--destino');            // editorial que absorbió (nombre exacto o _id)
const RESTAURAR = arg('--restaurar');        // nombre de la editorial a recrear
const TS = arg('--ts');                      // instante ISO de la fusión (se toma el SEGUNDO)
const ESPERADOS = parseInt(arg('--esperados', '0'), 10) || 0;

if (!DESTINO || !RESTAURAR || !TS) {
    console.error('Faltan argumentos: --destino <nombre|id> --restaurar <nombre> --ts <ISO> [--esperados N] [--ejecutar] [--forzar]');
    process.exit(1);
}

async function main() {
    const db = await conectarDB();
    const eds = db.collection('editoriales');
    const bib = db.collection('biblioteca');

    // 1) Editorial destino (la que absorbió).
    const destino = ObjectId.isValid(DESTINO)
        ? await eds.findOne({ _id: new ObjectId(DESTINO) })
        : await eds.findOne({ nombre: DESTINO });
    if (!destino) { console.error(`❌ No existe la editorial destino «${DESTINO}».`); process.exit(1); }

    // 2) Ventana temporal de la fusión: [ts, ts+1s). Un solo updateMany ⇒ todos comparten el mismo segundo.
    const t0 = new Date(TS);
    if (isNaN(t0)) { console.error(`❌ --ts no es una fecha ISO válida: ${TS}`); process.exit(1); }
    t0.setUTCMilliseconds(0);
    const t1 = new Date(t0.getTime() + 1000);

    const filtro = { editorial: destino._id, fecha_actualizacion: { $gte: t0, $lt: t1 } };
    const afectados = await bib.find(filtro, { projection: { titulo: 1, nombre_archivo: 1 } }).toArray();
    const intactos = await bib.countDocuments({ editorial: destino._id, $nor: [{ fecha_actualizacion: { $gte: t0, $lt: t1 } }] });

    console.log(`\n📚 Destino: «${destino.nombre}» (${destino._id})`);
    console.log(`   alias actuales: ${JSON.stringify(destino.nombres_alternativos || [])}`);
    console.log(`   ventana de la fusión: ${t0.toISOString()} → ${t1.toISOString()}`);
    console.log(`\n   libros a DEVOLVER a «${RESTAURAR}»: ${afectados.length}`);
    console.log(`   libros que se QUEDAN en «${destino.nombre}»: ${intactos}`);

    if (ESPERADOS && afectados.length !== ESPERADOS && !FORZAR) {
        console.error(`\n❌ Guarda de cordura: esperaba ${ESPERADOS} y he encontrado ${afectados.length}. Aborto (usa --forzar si estás seguro).`);
        process.exit(1);
    }
    if (!afectados.length) { console.log('\n(nada que hacer)\n'); process.exit(0); }

    console.log('\n   muestra:');
    for (const d of afectados.slice(0, 8)) console.log('     ·', String(d.titulo || d.nombre_archivo).slice(0, 64));
    if (afectados.length > 8) console.log(`     … y ${afectados.length - 8} más.`);

    const quitaAlias = (destino.nombres_alternativos || []).includes(RESTAURAR);
    console.log(`\n   alias «${RESTAURAR}» ${quitaAlias ? 'SE QUITARÁ' : 'no está (nada que quitar)'} de «${destino.nombre}».`);

    if (!EJECUTAR) {
        console.log('\n(DRY-RUN: no se ha escrito nada. Repite con --ejecutar para aplicar.)\n');
        process.exit(0);
    }

    // 3) MANIFIESTO antes de tocar nada → permite deshacer esto mismo.
    const manifiesto = {
        fecha: new Date().toISOString(),
        operacion: 'deshacer-fusion-editorial',
        destino: { _id: String(destino._id), nombre: destino.nombre, alias_previos: destino.nombres_alternativos || [] },
        restaurada: RESTAURAR,
        ventana: { desde: t0.toISOString(), hasta: t1.toISOString() },
        ids: afectados.map((d) => String(d._id)),
    };
    const ruta = path.resolve(`manifiesto-deshacer-fusion-${Date.now()}.json`);
    await fs.writeFile(ruta, JSON.stringify(manifiesto, null, 2), 'utf8');
    console.log(`\n📝 Manifiesto escrito: ${ruta}`);

    // 4) Recrear (o reutilizar) la editorial restaurada. Si ya existiera con ese nombre exacto, se reutiliza.
    let rest = await eds.findOne({ nombre: RESTAURAR });
    if (!rest) {
        const ins = await eds.insertOne({ nombre: RESTAURAR, fecha_creacion: new Date() });
        rest = { _id: ins.insertedId, nombre: RESTAURAR };
        console.log(`   ✅ Editorial «${RESTAURAR}» recreada (${rest._id}).`);
    } else {
        console.log(`   ℹ️  «${RESTAURAR}» ya existía (${rest._id}); se reutiliza.`);
    }

    // 5) Devolver los libros (por _id EXACTOS del manifiesto, no por la ventana: ya no dependemos del timestamp).
    const oids = afectados.map((d) => d._id);
    const r = await bib.updateMany({ _id: { $in: oids } }, { $set: { editorial: rest._id, fecha_actualizacion: new Date() } });
    console.log(`   ✅ ${r.modifiedCount} libro(s) devueltos a «${RESTAURAR}».`);

    // 6) Quitar el alias absorbido del destino (los demás alias se conservan).
    if (quitaAlias) {
        await eds.updateOne({ _id: destino._id }, { $pull: { nombres_alternativos: RESTAURAR }, $set: { fecha_actualizacion: new Date() } });
        console.log(`   ✅ Alias «${RESTAURAR}» retirado de «${destino.nombre}».`);
    }

    const finalDestino = await bib.countDocuments({ editorial: destino._id });
    const finalRest = await bib.countDocuments({ editorial: rest._id });
    console.log(`\n✅ Hecho. «${destino.nombre}» → ${finalDestino} libro(s) · «${RESTAURAR}» → ${finalRest} libro(s).\n`);
    process.exit(0);
}

main().catch((e) => { console.error('❌ Error:', e); process.exit(1); });
