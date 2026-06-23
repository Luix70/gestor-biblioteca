import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { purgarObra } from '../src/utils/purga.js';

/**
 * Purga una OBRA multivolumen mal catalogada para re-ingerirla limpia: elimina la obra y TODOS sus
 * tomos de `biblioteca`, y MUEVE sus carpetas CDU a la Papelera (nunca borra). Simulación por defecto;
 * --ejecutar aplica. La lógica vive en src/utils/purga.js (reutilizada por el panel).
 *
 *   node scripts/purgar-multipart.js <isbn_obra|título> [...más] [--ejecutar]
 */
const args = process.argv.slice(2);
const ejecutar = args.includes('--ejecutar');
const claves = args.filter(a => a !== '--ejecutar');
if (!claves.length) {
    console.error('Uso: node scripts/purgar-multipart.js <isbn_obra|título> [...] [--ejecutar]');
    process.exit(1);
}

const db = await conectarDB();
for (const clave of claves) {
    const r = await purgarObra(db, clave, { ejecutar });
    if (!r.ok) { console.log(`\n⚠️  ${r.motivo}`); continue; }
    console.log(`\n📚 Obra "${r.obra.titulo}" (isbn_obra ${r.obra.isbn_obra || '—'})`);
    if (r.simulacion) {
        for (const t of r.tomos) console.log(`   - vol ${t.vol ?? '?'}  ${t._id}  isbn=${t.isbn || '—'}  «${t.titulo}»`);
        console.log(`   (simulación: ${r.tomos.length} tomo(s) + la obra se eliminarían; carpetas CDU → Papelera)`);
    } else {
        console.log(`   ✅ Eliminados ${r.eliminados} tomo(s) + la obra. Carpetas CDU → Papelera. Ya puedes re-soltar la obra.`);
    }
}
process.exit(0);
