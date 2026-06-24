/**
 * Migra los ficheros sueltos del _ER Room a depósitos en Cuarentena/ilegibles (cada uno en su
 * carpeta + estado.json), para unificar TODO el flujo de "ficheros problemáticos" en Cuarentena
 * (el panel ya lista Cuarentena; el _ER Room queda obsoleto). Cada fichero se MUEVE (sale del _ER
 * Room) a `Cuarentena/ilegibles/<título>/` con su sidecar, listo para buscar copia y reemplazar.
 *
 *   node scripts/migrar-erroom-a-ilegibles.js              → SIMULACIÓN (no toca nada)
 *   node scripts/migrar-erroom-a-ilegibles.js --ejecutar   → mueve los ficheros
 *
 * En el NAS, dentro del contenedor:
 *   docker exec gestor-biblioteca node scripts/migrar-erroom-a-ilegibles.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { enviarAIlegibles } from '../src/gestor-fallos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_ER = resolver(process.env.PATH_ER_ROOM, '_ER Room');

const EJECUTAR = process.argv.includes('--ejecutar');
const tituloDeNombre = (n) => n.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();

let ents; try { ents = await fs.readdir(DIR_ER, { withFileTypes: true }); } catch { ents = []; }
const ficheros = ents.filter(e => e.isFile() && !e.name.startsWith('.'));

console.log(`\n═══ MIGRAR _ER Room → Cuarentena/ilegibles · ${EJECUTAR ? 'EJECUTAR' : 'SIMULACIÓN'} ═══`);
console.log(`Origen: ${DIR_ER}`);
console.log(`Ficheros a migrar: ${ficheros.length}\n`);

let ok = 0;
for (const e of ficheros) {
    const ruta = path.join(DIR_ER, e.name);
    const titulo = tituloDeNombre(e.name);
    if (!EJECUTAR) { console.log(`  • ${e.name}  →  ilegibles/"${titulo}"`); continue; }
    try {
        const dest = await enviarAIlegibles([ruta], { titulo, mensaje: 'migrado desde _ER Room' });
        console.log(`  ✅ ${e.name}  →  ${dest}`);
        ok++;
    } catch (err) {
        console.error(`  ❌ ${e.name}: ${err.message}`);
    }
}

if (!EJECUTAR) console.log(`\n(simulación) Re-ejecuta con --ejecutar para mover ${ficheros.length} fichero(s).`);
else console.log(`\nMigrados ${ok}/${ficheros.length} a Cuarentena/ilegibles.`);
process.exit(0);
