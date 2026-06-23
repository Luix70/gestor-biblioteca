/**
 * Prueba manual de los nuevos proveedores Tier-2:
 *   - buscador-local.js  (fichero.db: OL+BNE offline)
 *   - buscador-bnf.js    (BnF SRU online)
 *
 * Uso (PC con el .db y red):
 *   PATH_FICHERO=H:/DUMPS/fichero.db NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/test-buscadores.js
 */
import Database from 'better-sqlite3';
import { buscarEnFicheroLocal, cerrarFicheroLocal } from '../src/utils/buscador-local.js';
import { buscarEnBNF } from '../src/utils/buscador-bnf.js';

const RUTA = (process.env.PATH_FICHERO && /\.db$/i.test(process.env.PATH_FICHERO)) ? process.env.PATH_FICHERO : 'H:/DUMPS/fichero.db';

console.log('═══ FICHERO LOCAL ═══');
const dbg = new Database(RUTA, { readonly: true });
// Un ISBN español que esté tanto en BNE (con CDU) como en OL → caso de fusión.
const conAmbas = dbg.prepare(`
  SELECT b.isbn FROM fichero b
  JOIN fichero o ON o.isbn = b.isbn AND o.fuente = 'openlibrary'
  WHERE b.fuente = 'bne' AND b.cdu IS NOT NULL AND b.isbn IS NOT NULL
  LIMIT 1`).get();
const soloBNE = dbg.prepare(`SELECT isbn FROM fichero WHERE fuente='bne' AND cdu IS NOT NULL AND isbn IS NOT NULL LIMIT 1`).get();
const soloOL = dbg.prepare(`SELECT isbn FROM fichero WHERE fuente='openlibrary' AND dewey IS NOT NULL AND isbn IS NOT NULL LIMIT 1`).get();
dbg.close();

for (const [etiqueta, fila] of [['BNE+OL (fusión)', conAmbas], ['solo BNE', soloBNE], ['solo OL', soloOL]]) {
    if (!fila) { console.log(`  (${etiqueta}: sin muestra)`); continue; }
    const r = await buscarEnFicheroLocal({ isbns: [fila.isbn] });
    console.log(`\n• ${etiqueta} · ${fila.isbn}`);
    console.log('  ', JSON.stringify(r && {
        titulo: r.titulo, autores: r.autores, editorial: r.editorial, año: r.año_edicion,
        idioma: r.idioma, cdu: r.cdu, dewey: r.dewey, lcc: r.lcc, paginas: r.paginas,
        categorias: r.categorias?.slice(0, 3), portada: !!r.portada_url, fuentes: r.fuentes,
    }));
}
// Miss controlado (ISBN inexistente → {}).
console.log('\n• miss · 9789999999999 →', JSON.stringify(await buscarEnFicheroLocal({ isbns: ['9789999999999'] })));
cerrarFicheroLocal();

console.log('\n═══ BnF (SRU online) ═══');
for (const isbn of ['2070408507', '9782070360024', '9782707178183']) {
    try {
        const r = await buscarEnBNF({ isbns: [isbn] });
        console.log(`\n• ${isbn} →`, JSON.stringify(r));
    } catch (e) { console.log(`\n• ${isbn} → ERROR ${e.message}`); }
}
