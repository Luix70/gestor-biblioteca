/**
 * Reconstruye el ÍNDICE DE BÚSQUEDA local (busqueda.db, SQLite FTS5) desde MongoDB. Úsalo para la
 * PRIMERA carga (tras un despliegue) o para una recuperación. En la app el índice se mantiene SOLO al
 * ingerir/editar/borrar; esto lo regenera entero (vacía y re-inserta) — la búsqueda nunca se rompe:
 * mientras no exista el índice, /catalogo cae a la búsqueda Mongo $regex.
 *
 *   node scripts/reindexar-busqueda.js
 *
 * En el NAS:  docker exec gestor-biblioteca node scripts/reindexar-busqueda.js
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { reconstruir, estadoIndice, cerrarIndice } from '../src/utils/indice-busqueda.js';

const t0 = Date.now();
try {
    const db = await conectarDB();
    const { ruta } = await estadoIndice();
    console.log(`\n═══ REINDEXAR BÚSQUEDA → ${ruta} ═══`);
    const { total } = await reconstruir(db, (p) => {
        if (p.fase === 'reconstruyendo' && p.hechos) process.stdout.write(`\r  ${p.hechos}/${p.total} documentos…`);
    });
    console.log(`\n✅ Índice reconstruido: ${total} documento(s) en ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
    process.exitCode = 0;
} catch (e) {
    console.error(`\n❌ Error reindexando: ${e.message}`);
    process.exitCode = 1;
} finally {
    try { cerrarIndice(); } catch { /* ignore */ }
    process.exit(process.exitCode || 0);
}
