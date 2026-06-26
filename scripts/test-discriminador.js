/**
 * Test unitario del DISCRIMINADOR de tipo de recurso (sin red ni Mongo) — fija la tabla de casos
 * REALES que motivaron la identificación por confianza (ver src/utils/discriminador.js):
 *   · revista fechada cuyo ISBN venía del CUERPO (pista) → revista (no libro con ISBN falso)
 *   · seriado con ISSN compartido → revista
 *   · libro con ISBN propio / CIP / serie editorial → libro (aun fechado o con ISSN de serie)
 *   · cómic .cbz numerado → revista-serie; .cbr álbum/novela gráfica → libro (ambos naturaleza:comic)
 * Ejecutar: `node scripts/test-discriminador.js`  (sale 0 si todo pasa, 1 si algo falla).
 */
import { clasificarTipo } from '../src/utils/discriminador.js';

const casos = [
    ['EPE revista fechada + ISBN del cuerpo', { esFechada: true, isbnHint: true }, 'revista'],
    ['AMS seriado ISSN compartido',           { issnFuerte: true },                'revista'],
    ['Springer libro ISBN propio + ISSN serie',{ isbnPropio: true, issnHint: true }, 'libro'],
    ['Paranormal 977 (barras)',               { issnFuerte: true },                'revista'],
    ['Libro con bloque CIP',                  { cip: true },                       'libro'],
    ['Anuario con CIP + nombre fechado',      { cip: true, esFechada: true },      'libro'],
    ['Multivolumen (Vol N / ISBN con rol)',   { multiparte: true },                'libro'],
    ['Cómic .cbz numerado (serie)',           { esComic: true, comicSerie: true }, 'revista'],
    ['Cómic .cbr álbum (novela gráfica)',     { esComic: true },                   'libro'],
    ['Revista por título (pista)',            { pareceRevista: true },             'revista'],
    ['Libro normal (sin señales)',            {},                                  'libro'],
];

let ok = 0;
for (const [nombre, señales, esperado] of casos) {
    const r = clasificarTipo(señales);
    const pasa = r.tipo_recurso === esperado;
    if (pasa) ok++;
    const etiq = `${r.tipo_recurso}${r.naturaleza ? '/' + r.naturaleza : ''}${r.multiparte ? ' [multiparte]' : ''}`;
    console.log(`${pasa ? '✓' : '✗'} ${nombre.padEnd(40)} → ${etiq.padEnd(18)} (esperado ${esperado})`);
}
console.log(`\n${ok}/${casos.length} OK`);
process.exit(ok === casos.length ? 0 : 1);
