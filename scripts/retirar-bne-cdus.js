/**
 * Retira la colección `bne_cdus` de MongoDB Atlas.
 *
 * `bne_cdus` fue el PRIMER intento de CDUs de la BNE offline (volcado parcial de monografías
 * modernas, importado por el antiguo scripts/importar-bne.js). Quedó REDUNDANTE: el Fichero local
 * (fichero.db) contiene el volcado COMPLETO de la BNE (2,37 M registros con CDU) y lo sirve
 * buscador-local. Mantenerla solo gastaba el free tier de Atlas (512 MB).
 *
 * Dry-run por defecto (muestra tamaño y no borra). Para ELIMINARLA de verdad:
 *   node scripts/retirar-bne-cdus.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const db = await conectarDB();
const existe = (await db.listCollections({ name: 'bne_cdus' }).toArray()).length > 0;
if (!existe) {
    console.log('✓ La colección `bne_cdus` no existe (ya retirada). Nada que hacer.');
    process.exit(0);
}

const stats = await db.command({ collStats: 'bne_cdus' });
console.log(`bne_cdus: ${stats.count.toLocaleString()} docs · datos ${(stats.size / 1e6).toFixed(1)} MB · almacenamiento ${(stats.storageSize / 1e6).toFixed(1)} MB · índices ${(stats.totalIndexSize / 1e6).toFixed(1)} MB`);

if (!EJECUTAR) {
    console.log('\n(simulación) Re-ejecuta con --ejecutar para ELIMINAR la colección.');
    process.exit(0);
}

await db.collection('bne_cdus').drop();
console.log('🗑️  Colección `bne_cdus` eliminada. Espacio liberado en Atlas.');
process.exit(0);
