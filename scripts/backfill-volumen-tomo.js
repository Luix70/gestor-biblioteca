// ── BACKFILL DE volumen_numero EN TOMOS DE OBRA ─────────────────────────────────────────────────────────
// Muchos tomos de obra tienen `volumen_numero: null` porque el número iba PEGADO en el nombre ("…Vol1.pdf",
// "…Vol2.pdf") y el parser lo pasaba por alto (arreglado en multivolumen.js·VOL_RE). Al quedarse sin número,
// TODOS los tomos de una obra piden la misma carpeta 'vol-x' y se pisan (caso real: «Endangered Species»).
//
// Este script RE-PARSEA el número desde `nombre_archivo` (con el parser ya corregido) y rellena
// `volumen_numero` donde falta. NO mueve carpetas: para re-alojar cada tomo a su vol-N canónico y deshacer las
// colisiones se ejecuta DESPUÉS `scripts/consolidar-obras.js`, que ya sabe hacerlo (y con verificación).
//
// Solo escribe si el número es INEQUÍVOCO (uno por nombre) y NO crea duplicados dentro de la obra (si dos
// tomos parsearan el mismo número, se deja el conflicto para revisión manual: nunca se inventa nada).
//
// DRY-RUN por defecto (no toca la BD). Antes de --ejecutar: BACKUP de la colección `biblioteca`.
//   node scripts/backfill-volumen-tomo.js            (informe)
//   node scripts/backfill-volumen-tomo.js --ejecutar (aplica; BACKUP recomendado)
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { parsearVolumen } from '../src/utils/multivolumen.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const db = await conectarDB();
const col = db.collection('biblioteca');

// Tomos de obra SIN número. (Un doc es tomo de obra si tiene `obra`.)
const sinNumero = await col
    .find({ obra: { $exists: true, $ne: null }, volumen_numero: { $in: [null, undefined] } })
    .project({ titulo: 1, nombre_archivo: 1, obra: 1, volumen_numero: 1 })
    .toArray();

console.log(`\nTomos de obra sin volumen_numero: ${sinNumero.length}\n`);

// Números YA usados por otros tomos de cada obra: no se debe backfillar un número que ya existe (crearía dos
// «vol-3» en la misma obra). Se consulta una vez por obra implicada.
const obrasImplicadas = [...new Set(sinNumero.map(d => String(d.obra)))];
const usados = new Map(); // obra(str) → Set(numeros ya asignados)
for (const ob of obrasImplicadas) {
    const hn = await col.find({ obra: sinNumero.find(d => String(d.obra) === ob).obra, volumen_numero: { $ne: null } })
        .project({ volumen_numero: 1 }).toArray();
    usados.set(ob, new Set(hn.map(h => h.volumen_numero)));
}

let aplicables = 0, sinParsear = 0, enConflicto = 0;
const conflictos = [];
// Se agrupa por obra para detectar dos tomos que parseen el MISMO número (nombres ambiguos → no tocar).
const porObra = new Map();
for (const d of sinNumero) {
    const v = d.nombre_archivo ? parsearVolumen(d.nombre_archivo) : null;
    const num = v && v.numero != null ? v.numero : null;
    if (!num) { sinParsear++; continue; }
    const ob = String(d.obra);
    if (!porObra.has(ob)) porObra.set(ob, []);
    porObra.get(ob).push({ d, num });
}

const aEscribir = [];
for (const [ob, items] of porObra) {
    const ocupados = usados.get(ob) || new Set();
    // Cuenta de cada número parseado dentro de la obra (para detectar choques entre los propios candidatos).
    const cuenta = new Map();
    for (const it of items) cuenta.set(it.num, (cuenta.get(it.num) || 0) + 1);
    for (const it of items) {
        const choca = ocupados.has(it.num) || cuenta.get(it.num) > 1;
        if (choca) { enConflicto++; conflictos.push({ ...it, ob }); continue; }
        aplicables++;
        aEscribir.push(it);
        console.log(`  vol ${String(it.num).padStart(3)} ← "${it.d.nombre_archivo}"  [${it.d._id}]`);
    }
}

console.log(`\nResumen: ${aplicables} aplicables · ${sinParsear} sin número en el nombre · ${enConflicto} en conflicto (no se tocan)`);
if (conflictos.length) {
    console.log('\nConflictos (dos tomos con el mismo número, o número ya usado en la obra) — revisar a mano:');
    for (const c of conflictos) console.log(`  vol ${c.num}  "${c.d.nombre_archivo}"  [${c.d._id}]  obra ${c.ob}`);
}

if (!EJECUTAR) {
    console.log('\n(DRY-RUN) Nada escrito. Con --ejecutar se aplica (haz BACKUP de `biblioteca` antes).');
    console.log('Después: `node scripts/consolidar-obras.js` re-aloja cada tomo a su carpeta vol-N.\n');
    process.exit(0);
}

let escritos = 0;
for (const it of aEscribir) {
    await col.updateOne({ _id: it.d._id }, { $set: { volumen_numero: it.num } });
    escritos++;
}
console.log(`\n✅ ${escritos} tomos actualizados con su volumen_numero.`);
console.log('Ahora ejecuta `node scripts/consolidar-obras.js --ejecutar` para re-alojar cada uno a vol-N.\n');
process.exit(0);
