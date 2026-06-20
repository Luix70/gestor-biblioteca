/**
 * Limpia/normaliza las carpetas "sueltas" que quedan en la RAÍZ de CDU/ tras la migración al
 * árbol: deberían existir solo las clases 0-9 y _sin_clasificar. Cualquier otra carpeta de
 * primer nivel es un resto.
 *
 * Causa típica: Synology deja un '@eaDir' (miniaturas) dentro de la vieja carpeta plana; tras
 * mover el contenido real al árbol, ese '@eaDir' impide que rmdir borre la carpeta vacía.
 *
 * REGLA ANTI-PÉRDIDA: solo se ELIMINA una carpeta raíz si NO contiene ningún fichero de documento
 * (.epub/.pdf/…) ni ningún registro.json en su interior (solo metadatos de Synology / vacíos).
 * Si tiene contenido real, NO se toca: se informa para revisión (probable huérfano → reingesta).
 *
 *   node scripts/nestar-sueltos.js                 (DRY-RUN: informa, no borra)
 *   node scripts/nestar-sueltos.js --ejecutar      (elimina solo los restos vacíos/metadatos)
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { conectarDB } from '../src/database.js';
import { arbolCDU } from '../src/utils/cdu-arbol.js';
import { DIR_CDU, EXT_DOC } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ignorar = (n) => n.startsWith('@') || n.startsWith('#') || n.startsWith('.');
const esRaizValida = (n) => /^[0-9]$/.test(n) || n === '_sin_clasificar';

/** ¿Hay algún documento real (epub/pdf/… o registro.json) dentro? (ignora metadatos Synology). */
async function tieneContenidoReal(dir) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entradas) {
        if (ignorar(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (await tieneContenidoReal(p)) return true; }
        else if (EXT_DOC.includes(path.extname(e.name).toLowerCase()) || e.name === 'registro.json') return true;
    }
    return false;
}

async function main() {
    console.log(`\nNormalización de sueltos en la raíz de CDU  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}\n`);

    const db = await conectarDB();
    const col = db.collection('biblioteca');

    let entradas;
    try { entradas = await fs.readdir(DIR_CDU, { withFileTypes: true }); }
    catch (e) { console.error('No se pudo leer DIR_CDU:', e.message); process.exit(1); }

    const sueltos = entradas.filter(e => e.isDirectory() && !ignorar(e.name) && !esRaizValida(e.name));
    console.log(`Carpetas sueltas en la raíz: ${sueltos.length}\n`);

    let eliminados = 0, conContenido = 0;
    for (const e of sueltos) {
        const carpeta = path.join(DIR_CDU, e.name);
        const real = await tieneContenidoReal(carpeta);
        const destino = arbolCDU(e.name).segmentos.join('/'); // dónde DEBERÍA ir su contenido

        if (!real) {
            // Resto vacío / solo metadatos Synology → eliminar (no se pierde nada).
            console.log(`  🧹 VACÍO/METADATOS  "${e.name}"  → eliminar`);
            if (EJECUTAR) { await fs.rm(carpeta, { recursive: true, force: true }).catch(err => console.warn(`     ⚠️ ${err.message}`)); }
            eliminados++;
        } else {
            // Tiene documentos: ¿hay algún doc que lo referencie?
            const docs = await col.find({ ruta_base: { $regex: '^/recursos/' + e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/' } }, { projection: { _id: 1, titulo: 1 } }).toArray();
            console.log(`  ⚠️  CON CONTENIDO   "${e.name}"  (debería estar en ${destino})`);
            console.log(`        docs que lo referencian: ${docs.length ? docs.map(d => d._id).join(', ') : 'NINGUNO → huérfano: mover su .epub/.pdf al Inbox para recatalogar'}`);
            conContenido++;
        }
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Eliminados (vacíos/metadatos)' : 'A eliminar (vacíos/metadatos)'}: ${eliminados}`);
    console.log(`  Con contenido real (revisar):  ${conContenido}`);
    if (conContenido) console.log(`\n  Los "CON CONTENIDO" no se tocan. Si son huérfanos, mueve su documento al Inbox para recatalogarlo limpio.`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
