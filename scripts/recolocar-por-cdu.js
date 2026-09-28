/**
 * RECOLOCAR POR CDU — que la carpeta de cada documento refleje la CDU (y el tipo) de su ficha.
 *
 * Por qué: hasta sep. 2026, cuando re-clasificar-cdu cambiaba la CDU y la carpeta destino ya existía (el mismo
 * libro en otro formato, con el mismo ISBN), cambiaba la CDU en la BD pero dejaba los ficheros en el árbol viejo
 * («colisión en …; CDU actualizada en BD pero ficheros NO movidos»). Esos libros quedaron donde nadie los busca.
 * Ahora cada uno se mueve a su árbol; si el destino es la carpeta de OTRO documento, a una propia con sufijo
 * (`<isbn>-<id>`). La tarea `ubicar-segun-cdu` del Conformador hace lo mismo sola; este script lo hace YA.
 *
 * No toca los miembros de colección de árbol fijo (transmedia, audiolibros, software) ni los tomos de obra:
 * viven a propósito en la carpeta de su colección u obra. No borra nada: mueve con verificación de la copia.
 * Solo en el NAS (necesita los ficheros): si la carpeta vieja no está en disco, no se toca el documento.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/recolocar-por-cdu.js              (DRY-RUN: lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/recolocar-por-cdu.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { carpetaReflejaFicha, recolocarSegunCdu, aplicarCambio, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const db = await conectarDB();
const col = db.collection('biblioteca');

// Primero los candidatos (la comprobación es solo de rutas: rápida), luego el trabajo.
const candidatos = [];
for await (const d of col.find({ ruta_base: { $exists: true } }, {
    projection: { cdu: 1, ruta_base: 1, tipo_recurso: 1, obra: 1, ruta_fija: 1, coleccion: 1, naturaleza: 1, titulo: 1 },
})) {
    if (!carpetaReflejaFicha(d)) candidatos.push(d._id);
}
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${candidatos.length} documento(s) con la carpeta fuera del árbol de su ficha\n`);

let movidos = 0, sinCarpeta = 0, fallos = 0, i = 0;
const t0 = Date.now();
for (const _id of candidatos) {
    i++;
    const doc = await col.findOne({ _id });
    if (!doc) continue;
    const eta = i > 1 ? Math.round(((Date.now() - t0) / (i - 1)) * (candidatos.length - i + 1) / 1000) : 0;
    if (!EJECUTAR) {
        process.stdout.write(`[${i}/${candidatos.length}] ↪️  cdu ${String(doc.cdu).padEnd(16)} ${doc.ruta_base}  «${String(doc.titulo || '').slice(0, 40)}»\n`);
        continue;
    }
    try {
        const reub = await recolocarSegunCdu(doc);
        if (!reub?.set?.ruta_base) { sinCarpeta++; process.stdout.write(`[${i}/${candidatos.length}] ·  ${doc._id}: sin carpeta en disco — no se toca\n`); continue; }
        const cambio = { set: reub.set, alertas: ['Carpeta recolocada según la ficha (scripts/recolocar-por-cdu).', ...(reub.alertas || [])] };
        await aplicarCambio(col, doc, reub.carpetaNueva || carpetaDeDoc({ ...doc, ...reub.set }), cambio);
        await indexarDoc(db, doc._id).catch(() => {});
        movidos++;
        process.stdout.write(`[${i}/${candidatos.length}] ✅ ${reub.set.ruta_base}  «${String(doc.titulo || '').slice(0, 40)}» · ETA ${eta} s\n`);
    } catch (e) {
        fallos++;
        process.stdout.write(`[${i}/${candidatos.length}] ⛔ ${doc._id}: ${e.message}\n`);
    }
}
console.log(`\n${EJECUTAR ? `Recolocados: ${movidos} · sin carpeta en disco: ${sinCarpeta} · fallos: ${fallos}` : 'DRY-RUN: no se ha movido nada. Repite con --ejecutar.'}\n`);
process.exit(fallos ? 1 : 0);
