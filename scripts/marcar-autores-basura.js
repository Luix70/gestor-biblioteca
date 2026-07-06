// ── MARCAR AUTORES BASURA (para filtrarlos y reingerir a mano) ───────────────────────────────────────
// Antepone el prefijo «[?]_» al nombre de los autores que son ARTEFACTOS (metadatos de producción del PDF:
// «Creator: Adobe Acrobat…», URLs/marcas de agua «http://avxhome…», ISBNs sueltos, números, etc. — los que
// detecta esAutorArtefacto). Así se pueden FILTRAR en el panel de Autores (buscar «[?]_») para revisar sus
// libros y reingerirlos/corregirlos a mano. NO borra: solo renombra (los que tienen obras se conservan). El
// parser ya arreglado NO crea nuevos; esto marca los VIEJOS. Dry-run por defecto; --ejecutar marca; --quitar
// retira el prefijo.
//   node scripts/marcar-autores-basura.js            (lista)
//   node scripts/marcar-autores-basura.js --ejecutar (marca con «[?]_»)
//   node scripts/marcar-autores-basura.js --quitar --ejecutar  (retira el prefijo)
import 'dotenv/config';
import { conectarDB } from '../src/database.js';
import { esAutorArtefacto } from '../src/utils/parsear-nombre.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const QUITAR = process.argv.includes('--quitar');
const PREFIJO = '[?]_';

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const col = db.collection('autores');
    const autores = await col.find({}).project({ nombre: 1 }).toArray();

    const objetivos = QUITAR
        ? autores.filter(a => String(a.nombre).startsWith(PREFIJO))
        : autores.filter(a => esAutorArtefacto(a.nombre) && !String(a.nombre).startsWith(PREFIJO));

    console.log(`${QUITAR ? 'Quitar prefijo' : 'Marcar con «' + PREFIJO + '»'}: ${objetivos.length} autor(es).`);
    let n = 0;
    for (const a of objetivos) {
        const nDocs = await bib.countDocuments({ $or: [{ autores: a._id }, { 'contribuciones.persona': a._id }] });
        const nuevo = QUITAR ? String(a.nombre).slice(PREFIJO.length) : PREFIJO + a.nombre;
        if (n < 80) console.log(`  ${EJECUTAR ? '✓' : '·'} «${String(nuevo).slice(0, 52)}» · ${nDocs} doc(s)`);
        if (EJECUTAR) await col.updateOne({ _id: a._id }, { $set: { nombre: nuevo } });
        n++;
    }
    console.log(`\n${EJECUTAR ? (QUITAR ? 'Desmarcados' : 'Marcados') : '(dry-run)'}: ${n}. ${QUITAR ? '' : 'Busca «' + PREFIJO + '» en el panel de Autores para revisarlos.'}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
