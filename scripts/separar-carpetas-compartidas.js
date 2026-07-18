// ── SEPARAR CARPETAS COMPARTIDAS (varios docs en la misma carpeta) ──────────────────────────────────────
// Por una colisión de ruta_base, varios documentos comparten UNA carpeta y se pisan los sidecars
// (registro.json, portada). No están perdidos —el catálogo los tiene bien— solo mal alojados. Este script les
// da a cada uno SU carpeta adyacente y lo actualiza en la BD. NO reingesta y NO usa IA: los datos ya están
// bien; solo se mueve el fichero y se corrige la ruta. Es lo que la red anti-colisión habría hecho al ingerir
// (misma mecánica: carpeta + sufijo del _id).
//
// Por cada grupo que comparte carpeta R:
//   · el PRIMER doc se queda en R (con sus sidecars regenerados a su nombre).
//   · cada OTRO doc → carpeta adyacente «R-<id6>»: se COPIA+verifica su fichero (y las imágenes que referencia)
//     allí, se actualiza ruta_base/portada/imagenes en Mongo, se regeneran sus sidecars, y solo ENTONCES se
//     retira su fichero de R. Copia→verifica→retira: nunca se pierde un byte.
//
// Se excluyen los árboles preservados (ruta_fija): ahí compartir carpeta es a propósito (transmedia).
// Tras ejecutar, conviene `node scripts/reparar-portadas.js --ejecutar` (las portadas compartidas eran de UN
// solo doc; se re-extrae la de cada uno) y una pasada de Integridad.
//
// DRY-RUN por defecto. Antes de --ejecutar: BACKUP de `biblioteca` (ya hecho).
//   node scripts/separar-carpetas-compartidas.js            (informe)
//   node scripts/separar-carpetas-compartidas.js --ejecutar (aplica)
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { aRegistroLegible, escribirSidecars } from '../src/utils/registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const dir = (env, def) => { const v = process.env[env] || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = dir('PATH_CDU', 'CDU');
const EJECUTAR = process.argv.includes('--ejecutar');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const absDe = (web) => path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/').filter(Boolean));

// Copia NO destructiva y verificada (a un temporal oculto → rename): el destino queda con el mismo tamaño (>0)
// o se aborta sin haber tocado nada. Devuelve true si la copia es íntegra.
async function copiaVerificada(origen, destino) {
    const st = await fs.stat(origen).catch(() => null);
    if (!st || !st.isFile() || st.size === 0) return false;
    await fs.mkdir(path.dirname(destino), { recursive: true });
    const tmp = path.join(path.dirname(destino), `.tmp-${Date.now()}-${path.basename(destino)}`);
    try {
        await fs.copyFile(origen, tmp);
        const d = await fs.stat(tmp);
        if (d.size !== st.size) { await fs.rm(tmp, { force: true }).catch(() => {}); return false; }
        await fs.rename(tmp, destino);
        return true;
    } catch { await fs.rm(tmp, { force: true }).catch(() => {}); return false; }
}

// Este script trabaja sobre los FICHEROS del árbol CDU: hay que ejecutarlo DONDE ESTÁN (en el NAS, dentro del
// contenedor). Si la raíz CDU no existe (p. ej. corriéndolo en un portátil de desarrollo), todo saldría como
// «no está en la carpeta» — un falso negativo que despista. Se avisa alto y claro.
if (!(await existe(DIR_CDU))) {
    console.error(`\n⛔ No existe la raíz CDU: ${DIR_CDU}`);
    console.error('   Este script mueve ficheros del árbol CDU: ejecútalo EN EL NAS, dentro del contenedor:');
    console.error('   docker exec gestor-biblioteca node scripts/separar-carpetas-compartidas.js\n');
    process.exit(1);
}

const db = await conectarDB();
const col = db.collection('biblioteca');

// Mapas id→nombre para resolver autores/editorial al regenerar los sidecars (sin una consulta por doc).
const autorMap = new Map();
for (const a of await db.collection('autores').find({}, { projection: { nombre: 1 } }).toArray()) autorMap.set(String(a._id), a.nombre);
const editorialMap = new Map();
for (const e of await db.collection('editoriales').find({}, { projection: { nombre: 1 } }).toArray()) editorialMap.set(String(e._id), e.nombre);
const sidecarsDe = (doc) => aRegistroLegible(doc, {
    autores: (doc.autores || []).map(id => autorMap.get(String(id)) || String(id)),
    editorial: doc.editorial ? (editorialMap.get(String(doc.editorial)) || null) : null,
});

// Grupos que comparten ruta_base (2+ docs). Se excluyen los árboles preservados (ruta_fija).
const grupos = await col.aggregate([
    { $match: { ruta_base: { $ne: null }, ruta_fija: { $ne: true } } },
    { $group: { _id: '$ruta_base', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
]).toArray();

console.log(`\nCarpetas compartidas por 2+ documentos: ${grupos.length}  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]\n`);

let movidos = 0, fallos = 0, gruposOk = 0;
for (const g of grupos) {
    const base = g._id;
    const baseDir = absDe(base);
    // Orden estable por _id: el keeper (primero) es determinista entre pasadas.
    const docs = (await col.find({ ruta_base: base }).toArray()).sort((a, b) => String(a._id).localeCompare(String(b._id)));
    const [keeper, ...movers] = docs;
    console.log(`📁 ${base}   (${docs.length} docs)`);
    console.log(`   ⏸ se queda: [${keeper._id}] ${keeper.nombre_archivo || keeper.titulo}`);

    for (const doc of movers) {
        const id6 = String(doc._id).slice(-6);
        const nuevaWeb = `${base}-${id6}`;
        const nuevaDir = absDe(nuevaWeb);
        const nombre = doc.nombre_archivo || '';
        const src = nombre ? path.join(baseDir, nombre) : null;

        if (!src || !(await existe(src))) {
            // Su fichero no está en la carpeta (quizá ya es el de otro doc): no se puede mover con seguridad.
            console.log(`   ⚠ [${doc._id}] «${nombre || '(sin nombre_archivo)'}» no está en la carpeta → SE OMITE (revisar a mano)`);
            fallos++;
            continue;
        }
        // Imágenes que referencia el doc y que EXISTEN en la carpeta base (se COPIAN, no se mueven: pueden ser
        // compartidas por nombre con el keeper; rebase de sus rutas web a la carpeta nueva).
        const imgs = [];
        for (const im of (doc.imagenes || [])) {
            const b = im?.ruta ? path.basename(im.ruta) : null;
            if (b && await existe(path.join(baseDir, b))) imgs.push(b);
        }
        const portadaB = doc.portada ? path.basename(doc.portada) : null;
        if (portadaB && !imgs.includes(portadaB) && await existe(path.join(baseDir, portadaB))) imgs.push(portadaB);

        console.log(`   → [${doc._id}] «${nombre}»  →  ${nuevaWeb}${imgs.length ? `  (+${imgs.length} img)` : ''}`);
        if (!EJECUTAR) { movidos++; continue; }

        // 1) Copiar+verificar el fichero y las imágenes en la carpeta nueva.
        if (!(await copiaVerificada(src, path.join(nuevaDir, nombre)))) { console.error(`     ⛔ copia fallida → SE OMITE`); fallos++; continue; }
        let imgsOk = true;
        for (const b of imgs) if (!(await copiaVerificada(path.join(baseDir, b), path.join(nuevaDir, b)))) { imgsOk = false; break; }
        if (!imgsOk) { console.error(`     ⛔ copia de imágenes fallida → SE OMITE (fichero ya copiado, se limpia)`); await fs.rm(path.join(nuevaDir, nombre), { force: true }).catch(() => {}); fallos++; continue; }

        // 2) Actualizar la BD: ruta_base + rebase de portada/imagenes al prefijo nuevo.
        const rebase = (w) => (typeof w === 'string' && w.startsWith(base) ? nuevaWeb + w.slice(base.length) : w);
        const set = { ruta_base: nuevaWeb };
        if (doc.portada) set.portada = rebase(doc.portada);
        if (Array.isArray(doc.imagenes)) set.imagenes = doc.imagenes.map(im => ({ ...im, ruta: rebase(im.ruta) }));
        await col.updateOne({ _id: doc._id }, { $set: set });

        // 3) Regenerar los sidecars del doc en su carpeta nueva.
        try { await escribirSidecars(nuevaDir, sidecarsDe({ ...doc, ...set })); } catch (e) { console.warn(`     ⚠ sidecars: ${e.message}`); }

        // 4) Ahora que todo está copiado y verificado, retirar el fichero del doc de la carpeta base (NO las
        //    imágenes: pueden ser del keeper por nombre compartido). Si por lo que sea coincide con el nombre
        //    del keeper, no se toca.
        if (nombre !== (keeper.nombre_archivo || '')) await fs.rm(src, { force: true }).catch(() => {});
        movidos++;
    }

    // El keeper se queda, pero sus sidecars en la carpeta base pueden ser de OTRO doc (el último que escribió).
    // Se regeneran a su nombre para que registro.json/marc reflejen al keeper.
    if (EJECUTAR) { try { await escribirSidecars(baseDir, sidecarsDe(keeper)); } catch (e) { console.warn(`   ⚠ sidecars keeper: ${e.message}`); } }
    gruposOk++;
    console.log('');
}

console.log('═'.repeat(64));
console.log(`  ${EJECUTAR ? 'Movidos' : 'A mover'}: ${movidos} docs · Grupos: ${gruposOk} · Omitidos/fallos: ${fallos}`);
if (!EJECUTAR) console.log('\n  (DRY-RUN) Nada tocado. Con --ejecutar se aplica (BACKUP hecho).');
else console.log('\n  Sugerido después: `node scripts/reparar-portadas.js --ejecutar` (re-extrae la portada de cada uno)\n              y `node scripts/integridad.js` para confirmar que ya no hay carpetas compartidas.');
process.exit(0);
