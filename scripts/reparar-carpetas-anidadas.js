/**
 * REPARAR DOCUMENTOS QUE APUNTAN A UNA CARPETA QUE YA NO ESTÁ… porque se movió DENTRO de la de otro documento.
 *
 * Qué pasó (1-oct, «Historia de Iberia Vieja» feb. 2015, 6a69a8b9985570200af03dac): un número de revista vivía en
 * una SUBCARPETA de la carpeta de otro número («…/revistas/1699-7913/2015-02», dentro de «…/revistas/1699-7913», que
 * era la carpeta del número de julio). Al recolocar el de julio por su CDU (946 → 94(460)), `reubicarPorCdu` movió
 * su carpeta ENTERA —con la subcarpeta del de febrero dentro— y solo actualizó a los documentos con la MISMA carpeta,
 * no a los que vivían DENTRO. El de febrero siguió apuntando a la ruta vieja. Los ficheros están, en otro sitio.
 * (`reubicarPorCdu` ya lleva consigo a los anidados; esto arregla lo que pasó antes.)
 *
 * Cómo se encuentran: el DIARIO DE MOVIMIENTOS del árbol CDU (`.movimientos-copia.log`, el que usa la copia USB)
 * dice qué carpeta se movió a dónde. Si la ruta del documento colgaba de una carpeta movida, su sitio nuevo es el
 * mismo camino bajo el destino. Se comprueba en disco antes de tocar nada; si no aparece, queda en la lista.
 *
 * Además avisa de las carpetas ANIDADAS que quedan (un documento dentro de la carpeta de otro): son las que se
 * romperían en el próximo movimiento si alguien lo hiciera con código viejo.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-carpetas-anidadas.js              (en seco)
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-carpetas-anidadas.js --ejecutar
 *   node scripts/reparar-carpetas-anidadas.js --raiz "U:/CDU"      (desde el PC, mirando el árbol del NAS)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { rutaDiario } from '../src/utils/diario-movimientos.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const RAIZ = arg('--raiz') || DIR_CDU;

const db = await conectarDB();
const col = db.collection('biblioteca');
const relDe = (rutaBase) => String(rutaBase || '').replace(/^\/recursos\//, '');
const existe = (rel) => fs.existsSync(path.join(RAIZ, ...rel.split('/')));

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · documentos con la carpeta movida dentro de la de otro · árbol: ${RAIZ}\n`);

// ─── El diario de movimientos, en orden ─────────────────────────────────────────────────────────────────────
let movimientos = [];
try {
    movimientos = fs.readFileSync(rutaDiario(RAIZ), 'utf8').split('\n')
        .map((l) => l.split('\t')).filter((p) => p.length === 3 && p[1] && p[2])
        .map(([fecha, viejo, nuevo]) => ({ fecha, viejo, nuevo }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
} catch (e) {
    console.warn(`⚠️  No se pudo leer el diario de movimientos (${e.message}): solo se diagnostica.`);
}
console.log(`Diario de movimientos: ${movimientos.length} movimiento(s) desde ${movimientos[0]?.fecha?.slice(0, 10) || '—'}.\n`);

/** Dónde está ahora una ruta, siguiendo los movimientos de las carpetas de las que colgaba. */
function rutaActual(rel) {
    let actual = rel;
    for (const m of movimientos) {
        if (actual === m.viejo || actual.startsWith(`${m.viejo}/`)) actual = m.nuevo + actual.slice(m.viejo.length);
    }
    return actual;
}

// ─── Recorrido ──────────────────────────────────────────────────────────────────────────────────────────────
const proyeccion = { ruta_base: 1, portada: 1, imagenes: 1, titulo: 1, nombre_archivo: 1, ruta_fija: 1, coleccion: 1 };
const docs = await col.find({ ruta_base: { $regex: '^/recursos/' } }, { projection: proyeccion }).toArray();
const rutas = new Set(docs.map((d) => relDe(d.ruta_base)));

const reparables = [], perdidos = [], anidados = [];
const p = progreso(docs.length, 'Comprobando carpetas');
for (const d of docs) {
    p.paso(d.titulo);
    const rel = relDe(d.ruta_base);
    // ¿Vive dentro de la carpeta de OTRO documento? (los miembros de una colección de árbol fijo, a propósito sí)
    const segmentos = rel.split('/');
    for (let i = segmentos.length - 1; i > 0; i--) {
        const padre = segmentos.slice(0, i).join('/');
        if (rutas.has(padre) && !(d.ruta_fija && d.coleccion)) { anidados.push({ d, padre }); break; }
    }
    if (existe(rel)) continue;
    const nueva = rutaActual(rel);
    if (nueva !== rel && existe(nueva)) reparables.push({ d, rel, nueva });
    else perdidos.push({ d, rel });
}
p.fin();

for (const r of reparables.slice(0, 40)) console.log(`↪️  ${r.d._id} «${String(r.d.titulo || '').slice(0, 40)}»\n      ${r.rel}\n   →  ${r.nueva}`);
for (const r of perdidos.slice(0, 40)) console.log(`❌ ${r.d._id} «${String(r.d.titulo || '').slice(0, 40)}» · ${r.rel} (no está, ni siguiendo el diario)`);

if (EJECUTAR && reparables.length) {
    const pe = progreso(reparables.length, 'Corrigiendo rutas');
    for (const { d, rel, nueva } of reparables) {
        pe.paso(d.titulo);
        const viejaWeb = `/recursos/${rel}`, nuevaWeb = `/recursos/${nueva}`;
        const remap = (ruta) => (ruta && ruta.startsWith(viejaWeb) ? nuevaWeb + ruta.slice(viejaWeb.length) : ruta);
        const set = { ruta_base: nuevaWeb, fecha_actualizacion: new Date() };
        if (d.portada) set.portada = remap(d.portada);
        if (d.imagenes?.length) set.imagenes = d.imagenes.map((im) => ({ ...im, ruta: remap(im.ruta) }));
        await col.updateOne({ _id: d._id }, {
            $set: set,
            $push: {
                deshacer: { fecha: new Date(), origen: 'reparar-carpetas-anidadas', antes: { ruta_base: d.ruta_base, portada: d.portada ?? null, imagenes: d.imagenes ?? null } },
                alertas_agente: `Carpeta reencontrada: se había movido dentro de la de otro documento («${rel}» → «${nueva}»); ruta corregida.`,
            },
        });
        const actualizado = await col.findOne({ _id: d._id });
        await regenerarSidecarsDoc(db, actualizado, path.join(RAIZ, ...nueva.split('/'))).catch(() => {});
        await indexarDoc(db, d._id).catch(() => {});
    }
    pe.fin();
}
if (EJECUTAR && anidados.length) {
    await crearSeleccion(db, {
        nombre: `Carpeta dentro de la de otro documento ${new Date().toISOString().slice(0, 10)}`,
        descripcion: 'Documentos cuya carpeta cuelga de la carpeta de otro documento. Funcionan, pero cada uno debería tener la suya (1 documento ↔ 1 carpeta).',
        docs: anidados.map((a) => a.d._id),
    });
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
console.log(`  documentos revisados                         : ${docs.length}`);
console.log(`  carpeta movida dentro de otra (se reencuentra): ${reparables.length}${EJECUTAR ? ' (corregidos)' : ''}`);
console.log(`  carpeta que no está en ningún sitio conocido  : ${perdidos.length}`);
console.log(`  carpetas ANIDADAS que quedan (riesgo)         : ${anidados.length}${EJECUTAR && anidados.length ? ' → selección «Carpeta dentro de la de otro documento»' : ''}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para corregir las rutas (solo cambia la base: los ficheros ya están en su sitio nuevo).');
process.exit(0);
