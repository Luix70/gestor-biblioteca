/**
 * Diagnóstico por ISBN — enseña, por cada ISBN y por CADA fuente, qué datos hay realmente (título,
 * sinopsis, colección, CDU/Dewey, portada) y las portadas candidatas con su URL. Sirve para distinguir
 * un BUG (la fuente tiene el dato pero no lo capturamos) de una LIMITACIÓN de datos (la fuente no lo tiene).
 *
 * Correr en el NAS (tiene red + fichero.db + Mongo):
 *   docker exec gestor-biblioteca node scripts/test-isbn.js
 *   docker exec gestor-biblioteca node scripts/test-isbn.js 9788420646152 8420646709
 * Sin argumentos usa la lista de Alianza de la prueba.
 */
import 'dotenv/config';
import '../src/config.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { buscarMetadatosExternos } from '../src/utils/proveedor-metadatos.js';
import { buscarPorCriterios } from '../src/utils/buscador-bibliografico.js';
import { buscarEnGoogleBooks } from '../src/utils/buscador-google-books.js';
import { portadasPorISBN } from '../src/api-panel.js';
import { validarISBN, isbn10a13, isbn13a10 } from '../src/utils/identificadores.js';
import { separarNumeroColeccion } from '../src/utils/colecciones.js';

const DEFECTO = [
    '8420646709', '8420646261', '9788420646152', '8420646067',
    '978-84-206-4659-6', '978-84-206-4635-0', '978-84-206-4644-2',
    '978-84-206-4670-1', '978-84-206-4675-6', '978-84-206-4616-9', '978-84-206-4647-3',
];
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ISBNS = args.length ? args : DEFECTO;

const sinop = (s) => (s ? `SÍ (${String(s).length} car.)` : 'no');
const tit = (o) => (o && o.titulo ? `«${o.titulo}»` : '—');

for (const raw of ISBNS) {
    const limpio = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
    const ok = validarISBN(limpio);
    const isbn13 = limpio.length === 13 ? limpio : isbn10a13(limpio);
    const isbn10 = limpio.length === 10 ? limpio : isbn13a10(limpio);
    const isbns = [isbn13, isbn10, limpio].filter(Boolean);
    console.log(`\n════════ ${raw} ${ok ? '' : '‼ ISBN INVÁLIDO (checksum)'} · 13=${isbn13 || '—'} 10=${isbn10 || '—'} ════════`);

    let f = null;
    try { f = await buscarEnFicheroLocal({ isbns }); } catch (e) { console.log('  · Fichero  ERROR:', e.message); }
    console.log(`  · Fichero:  ${tit(f)} | sinopsis ${sinop(f?.sinopsis)} | col «${f?.coleccion_nombre || '—'}» | cdu ${f?.cdu || '—'} | portada ${f?.portada_url ? 'sí' : 'no'}`);

    let ol = null;
    try { ol = await buscarPorCriterios({ isbns }); } catch (e) { ol = { error: e.message }; }
    console.log(`  · OpenLib:  ${tit(ol)}${ol?.error ? ` (ERROR ${ol.error})` : ''} | sinopsis ${sinop(ol?.sinopsis)} | dewey ${ol?.dewey || '—'}`);

    let gb = null;
    try { gb = await buscarEnGoogleBooks({ isbns }); } catch (e) { gb = { error: e.message }; }
    console.log(`  · GoogleBk: ${tit(gb)}${gb?.error ? ` (ERROR ${gb.error})` : ''} | sinopsis ${sinop(gb?.sinopsis)} | categorías ${(gb?.categorias || []).join(', ') || '—'} | portada ${gb?.portada_url ? 'sí' : 'no'}`);

    let ext = null;
    try { ext = await buscarMetadatosExternos(null, null, null, { isbnsArchivo: isbns, incluirSinopsis: true, incluirCdu: false }); } catch (e) { ext = { error: e.message }; }
    const col = separarNumeroColeccion(ext?.coleccion_nombre || f?.coleccion_nombre || '');
    const tituloFinal = f?.titulo || ext?.titulo;
    console.log(`  · RESULTADO alta: título ${tituloFinal ? 'OK' : '‼ SIN TÍTULO → el alta rápida FALLA'} | sinopsis ${sinop(f?.sinopsis || ext?.sinopsis)} | colección «${col.nombre || '—'}»${col.numero ? ` nº${col.numero}` : ''}`);

    let port = [];
    try { port = await portadasPorISBN(isbn13, isbn10, f?.portada_url || null); } catch (e) { console.log('  · portadas ERROR:', e.message); }
    console.log(`  · PORTADAS (${port.length}): ${port.map((p) => `${p.fuente} ${p.ancho}×${p.alto}`).join('  |  ') || '‼ NINGUNA'}`);
    for (const p of port) console.log(`       ${p.fuente}: ${p.url}`);
}
process.exit(0);
