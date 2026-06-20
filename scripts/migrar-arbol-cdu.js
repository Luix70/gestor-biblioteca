/**
 * Migración del árbol CDU: reorganiza las ~1000 carpetas planas bajo CDU/ en la jerarquía
 *   <clase>/<division>/<cdu limpio>/<libros|revistas>/<leaf...>
 * conservando EXACTAMENTE la hoja actual (isbn/discriminador/año-mes) — solo cambia el prefijo
 * CDU. El código original permanece intacto en MongoDB; esto solo mueve carpetas y actualiza
 * ruta_base / portada / imagenes.
 *
 * Movimiento por DOCUMENTO (su carpeta-hoja), transaccional y NO destructivo
 * (moverCarpetaConVerificacion). Si el destino ya existe → se omite (no se sobreescribe).
 *
 * ⚠️  Ejecutar con la app/contenedor DETENIDO (para que el Conformador no toque carpetas a la vez).
 *
 *   node scripts/migrar-arbol-cdu.js                 (DRY-RUN: informa, no mueve)
 *   node scripts/migrar-arbol-cdu.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { conectarDB } from '../src/database.js';
import { arbolCDU } from '../src/utils/cdu-arbol.js';
import { DIR_CDU, moverCarpetaConVerificacion, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');

/** Nueva ruta (segmentos) preservando tipo + hoja de la ruta vieja, re-arbolando el CDU. */
function nuevaRuta(rutaBase, cdu) {
    const segs = rutaBase.replace(/^\/recursos\//, '').split('/');
    const iTipo = segs.findIndex(s => s === 'libros' || s === 'revistas');
    if (iTipo < 0) return null;
    const resto = segs.slice(iTipo);
    return { viejos: segs, nuevos: [...arbolCDU(cdu || '').segmentos, ...resto] };
}

/** Borra de abajo a arriba las carpetas que hayan quedado vacías (no toca las que tienen algo). */
async function limpiarVacios(raiz) {
    let entradas;
    try { entradas = await fs.readdir(raiz, { withFileTypes: true }); } catch { return; }
    for (const e of entradas) if (e.isDirectory()) await limpiarVacios(path.join(raiz, e.name));
    await fs.rmdir(raiz).catch(() => {}); // falla si no está vacía → se conserva
}

async function main() {
    console.log(`\nMigración de árbol CDU  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se mueve nada.\n'); else console.log('  ⚠️  Moviendo carpetas. App detenida, ¿verdad?\n');

    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const docs = await col.find({ ruta_base: { $exists: true, $ne: null } }).toArray();

    let mover = 0, yaOk = 0, sinCarpeta = 0, colisiones = 0, sinParsear = 0, fallback = 0;
    const clases = new Map();
    const muestraColisiones = [];

    for (const doc of docs) {
        const r = nuevaRuta(doc.ruta_base, doc.cdu);
        if (!r) { sinParsear++; continue; }
        const { viejos, nuevos } = r;
        if (arbolCDU(doc.cdu || '').clase === '_sin_clasificar') fallback++;
        clases.set(nuevos[0], (clases.get(nuevos[0]) || 0) + 1);

        const rel = (a) => a.join('/');
        if (rel(viejos) === rel(nuevos)) { yaOk++; continue; } // ya en árbol

        const carpetaVieja = path.join(DIR_CDU, ...viejos);
        const carpetaNueva = path.join(DIR_CDU, ...nuevos);

        if (!await carpetaExiste(carpetaVieja)) { sinCarpeta++; continue; }
        if (await carpetaExiste(carpetaNueva)) {
            colisiones++;
            if (muestraColisiones.length < 15) muestraColisiones.push(`${rel(viejos)}  →  ${rel(nuevos)} (destino ya existe)`);
            continue;
        }

        mover++;
        if (!EJECUTAR) continue;

        // Mover la carpeta-hoja (transaccional) y remapear las rutas en BD.
        const archivosEnBD = [
            doc.portada ? path.basename(doc.portada) : null,
            ...(doc.imagenes || []).map(im => path.basename(im.ruta)),
        ].filter(Boolean);
        try {
            await moverCarpetaConVerificacion(carpetaVieja, carpetaNueva, archivosEnBD);
        } catch (e) {
            console.error(`  ⛔ [${doc._id}] no se pudo mover: ${e.message}`);
            mover--; continue;
        }
        const webViejo = '/recursos/' + rel(viejos);
        const webNuevo = '/recursos/' + rel(nuevos);
        const remap = (p) => (p && p.startsWith(webViejo)) ? webNuevo + p.slice(webViejo.length) : p;
        const set = { ruta_base: webNuevo };
        if (doc.portada) set.portada = remap(doc.portada);
        if (doc.imagenes?.length) set.imagenes = doc.imagenes.map(im => ({ ...im, ruta: remap(im.ruta) }));
        await col.updateOne({ _id: doc._id }, { $set: set });
    }

    if (EJECUTAR) { console.log('Limpiando carpetas vacías…'); await limpiarVacios(DIR_CDU); }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  Documentos:               ${docs.length}`);
    console.log(`  ${EJECUTAR ? 'Movidos' : 'A mover'}:                ${mover}`);
    console.log(`  Ya en árbol:              ${yaOk}`);
    console.log(`  Sin carpeta en disco:     ${sinCarpeta}`);
    console.log(`  Colisiones (omitidas):    ${colisiones}`);
    console.log(`  ruta_base sin tipo:       ${sinParsear}`);
    console.log(`  Caen en _sin_clasificar:  ${fallback}`);
    console.log(`\n  Distribución por clase (1er nivel):`);
    for (const [c, n] of [...clases.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
        console.log(`     ${String(c).padEnd(18)} ${n}`);
    if (muestraColisiones.length) {
        console.log(`\n  Colisiones (muestra):`);
        for (const m of muestraColisiones) console.log(`     ${m}`);
    }
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
