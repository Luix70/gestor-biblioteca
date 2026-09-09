/**
 * BACKFILL DE PERMISOS DEL ÁRBOL CDU.
 *
 * Recorre el árbol y deja directorios en 0o755 y ficheros en 0o644, de modo que CUALQUIER usuario pueda
 * leerlo y recorrerlo entero. La ingesta ya normaliza lo nuevo (`utils/permisos.js`, cableado en
 * `servicio-ingesta`, `transmedia` y `util-mantenimiento`); esto arregla lo que se catalogó ANTES.
 *
 * POR QUÉ IMPORTA: `fs.copyFile`/`fs.cp` preservan el modo del origen y `fs.rename` conserva el del directorio
 * original, así que el material descargado metió en el árbol carpetas sin bit de travesía. La aplicación no lo
 * nota (el contenedor corre con privilegios), pero un `du` o un `rsync` de copia de seguridad ejecutado con
 * otro usuario se topa con «Permission denied» y LAS SALTA SIN AVISAR: la copia queda con huecos silenciosos.
 *
 * ⚠️  EJECUTAR EN EL NAS, donde están los ficheros — por SMB desde el PC un `chmod` no hace lo que esperas:
 *        sudo docker exec gestor-biblioteca node scripts/normalizar-permisos.js            (DRY-RUN)
 *        sudo docker exec gestor-biblioteca node scripts/normalizar-permisos.js --ejecutar
 *
 * Opciones:
 *   --ejecutar        aplica los cambios (sin él solo informa: no toca nada)
 *   --ruta <subruta>  limita a una rama del árbol (p. ej. "8/82/82/audiolibros") para probar antes de ir a todo
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { MODO_DIR, MODO_FICHERO } from '../src/utils/permisos.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const iRuta = process.argv.indexOf('--ruta');
const SUBRUTA = iRuta > -1 ? process.argv[iRuta + 1] : null;

const stats = {
    dirs: 0, ficheros: 0,          // recorridos
    dirsMal: 0, ficherosMal: 0,    // con el modo incorrecto
    corregidos: 0, ilegibles: 0, errores: 0,
};
const ejemplos = [];   // primeras rutas problemáticas, para el informe

let ultimoAviso = 0;

/** Progreso en una sola línea (regla del proyecto: toda operación masiva informa de su avance). */
function progreso(forzar = false) {
    const ahora = Date.now();
    if (!forzar && ahora - ultimoAviso < 2000) return;
    ultimoAviso = ahora;
    const total = stats.dirs + stats.ficheros;
    process.stdout.write(
        `\r   ${total.toLocaleString('es')} entradas · ${stats.dirsMal} carpetas y ${stats.ficherosMal} ficheros con permisos raros` +
        `${EJECUTAR ? ` · ${stats.corregidos} corregidos` : ''}   `
    );
}

/**
 * Recorre y (si procede) corrige. Iterativo con pila explícita: una recursión sobre ~485.000 entradas en el
 * Atom del NAS puede agotar la pila, y aquí no hay nada que ganar siendo recursivo.
 */
async function recorrer(raiz) {
    const pila = [raiz];
    while (pila.length) {
        const actual = pila.pop();
        let st;
        try { st = await fs.lstat(actual); } catch { stats.errores++; continue; }
        if (st.isSymbolicLink()) continue;   // chmod seguiría el enlace: fuera del árbol, no es asunto nuestro

        const esDir = st.isDirectory();
        const deseado = esDir ? MODO_DIR : MODO_FICHERO;
        const actualModo = st.mode & 0o777;

        if (esDir) stats.dirs++; else stats.ficheros++;

        if (actualModo !== deseado) {
            if (esDir) stats.dirsMal++; else stats.ficherosMal++;
            if (ejemplos.length < 15) {
                ejemplos.push(`${esDir ? 'D' : 'f'} ${actualModo.toString(8).padStart(3, '0')} → ${deseado.toString(8)}  ${path.relative(DIR_CDU, actual)}`);
            }
            if (EJECUTAR) {
                try { await fs.chmod(actual, deseado); stats.corregidos++; }
                catch { stats.errores++; }
            }
        }

        if (!esDir) { progreso(); continue; }

        // Importante: si la carpeta estaba sin bit de travesía y la acabamos de corregir, AHORA sí se puede
        // listar. En dry-run no la hemos tocado, así que puede seguir siendo ilegible — se cuenta y se avisa,
        // porque es justo el síntoma que estamos persiguiendo.
        let entradas;
        try { entradas = await fs.readdir(actual); }
        catch { stats.ilegibles++; progreso(); continue; }
        for (const nombre of entradas) pila.push(path.join(actual, nombre));
        progreso();
    }
}

async function main() {
    const raiz = SUBRUTA ? path.join(DIR_CDU, SUBRUTA) : DIR_CDU;
    try { await fs.access(raiz); }
    catch { console.error(`❌ No existe la ruta: ${raiz}`); process.exit(1); }

    console.log(`\n🔐 Normalización de permisos del árbol CDU`);
    console.log(`   Raíz:   ${raiz}`);
    console.log(`   Modo:   ${EJECUTAR ? '⚠️  EJECUTAR (se aplican los cambios)' : 'DRY-RUN (no se toca nada)'}`);
    console.log(`   Diana:  carpetas ${MODO_DIR.toString(8)} · ficheros ${MODO_FICHERO.toString(8)}\n`);

    const t0 = Date.now();
    await recorrer(raiz);
    progreso(true);
    const segs = Math.round((Date.now() - t0) / 1000);

    console.log(`\n\n── Resumen ──────────────────────────────────────────`);
    console.log(`   Recorrido:   ${stats.dirs.toLocaleString('es')} carpetas · ${stats.ficheros.toLocaleString('es')} ficheros  (${segs}s)`);
    console.log(`   Con permisos incorrectos: ${stats.dirsMal} carpetas · ${stats.ficherosMal} ficheros`);
    if (EJECUTAR) console.log(`   Corregidos:  ${stats.corregidos}`);
    if (stats.ilegibles) console.log(`   ⚠️  Carpetas que NO se pudieron ni listar: ${stats.ilegibles}${EJECUTAR ? '' : ' (normal en dry-run: aún no se han corregido)'}`);
    if (stats.errores) console.log(`   ⚠️  Errores: ${stats.errores}`);

    if (ejemplos.length) {
        console.log(`\n   Ejemplos:`);
        for (const e of ejemplos) console.log(`     ${e}`);
    }

    if (!EJECUTAR && (stats.dirsMal || stats.ficherosMal)) {
        console.log(`\n   → Para aplicarlo: añade --ejecutar`);
    }
    if (EJECUTAR && stats.ilegibles) {
        console.log(`\n   → Quedan carpetas ilegibles: vuelve a lanzarlo (al corregir el bit de travesía en`);
        console.log(`     esta pasada, la siguiente ya puede entrar en ellas).`);
    }
    console.log('');
    process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
