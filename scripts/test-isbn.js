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
import { buscarPorCriterios } from '../src/utils/buscador-bibliografico.js';
import { buscarEnGoogleBooks } from '../src/utils/buscador-google-books.js';
import { buscarUnISBN } from '../src/utils/lote-isbn.js';
import { validarISBN, isbn10a13, isbn13a10 } from '../src/utils/identificadores.js';
import { separarNumeroColeccion } from '../src/utils/colecciones.js';

const DEFECTO = [
    '8420646709', '8420646261', '9788420646152', '8420646067',
    '978-84-206-4659-6', '978-84-206-4635-0', '978-84-206-4644-2',
    '978-84-206-4670-1', '978-84-206-4675-6', '978-84-206-4616-9', '978-84-206-4647-3',
];
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const ISBNS = args.length ? args : DEFECTO;

// OJO: NO usar console.log aquí. `consola-timestamp.js` (cargado transitivamente vía api-panel.js)
// intercepta console.log/info y, en modo no-verboso (el normal en producción), DESCARTA en silencio
// cualquier línea sin un emoji "titular" — con lo que este informe línea a línea desaparecía por
// completo (sin error, sin rastro). Escribir directo a stdout evita el interceptor y no ensucia el
// log de Actividad del panel con el ruido de un diagnóstico puntual.
const imprimir = (s) => process.stdout.write(s + '\n');

const sinop = (s) => (s ? `SÍ (${String(s).length} car.)` : 'no');
const tit = (o) => (o && o.titulo ? `«${o.titulo}»` : '—');

for (const raw of ISBNS) {
    const limpio = String(raw).replace(/[^0-9Xx]/g, '').toUpperCase();
    const ok = validarISBN(limpio);
    const isbn13 = limpio.length === 13 ? limpio : isbn10a13(limpio);
    const isbn10 = limpio.length === 10 ? limpio : isbn13a10(limpio);
    const isbns = [isbn13, isbn10, limpio].filter(Boolean);
    imprimir(`\n════════ ${raw} ${ok ? '' : '‼ ISBN INVÁLIDO (checksum)'} · 13=${isbn13 || '—'} 10=${isbn10 || '—'} ════════`);

    let f = null;
    try { f = await buscarEnFicheroLocal({ isbns }); } catch (e) { imprimir('  · Fichero  ERROR: ' + e.message); }
    imprimir(`  · Fichero:  ${tit(f)} | sinopsis ${sinop(f?.sinopsis)} | col «${f?.coleccion_nombre || '—'}» | cdu ${f?.cdu || '—'} | portada ${f?.portada_url ? 'sí' : 'no'}`);

    let ol = null;
    try { ol = await buscarPorCriterios({ isbns }); } catch (e) { ol = { error: e.message }; }
    imprimir(`  · OpenLib:  ${tit(ol)}${ol?.error ? ` (ERROR ${ol.error})` : ''} | sinopsis ${sinop(ol?.sinopsis)} | dewey ${ol?.dewey || '—'}`);

    let gb = null;
    try { gb = await buscarEnGoogleBooks({ isbns }); } catch (e) { gb = { error: e.message }; }
    imprimir(`  · GoogleBk: ${tit(gb)}${gb?.error ? ` (ERROR ${gb.error})` : ''} | sinopsis ${sinop(gb?.sinopsis)} | categorías ${(gb?.categorias || []).join(', ') || '—'} | portada ${gb?.portada_url ? 'sí' : 'no'}`);

    // RESULTADO REAL de producción: la MISMA función que usan GET /isbn/:isbn y el LOTE (Fichero + huecos
    // rellenados online, sin pisar nada). Así el test verifica el camino real, no una reimplementación aparte.
    let real = null;
    try { real = await buscarUnISBN(raw); } catch (e) { real = { ok: false, motivo: e.message }; }
    const col = separarNumeroColeccion(real?.meta?.coleccion_nombre || '');
    imprimir(`  · RESULTADO alta: fuente «${real?.fuente || '—'}» | título ${real?.meta?.titulo ? 'OK' : '‼ SIN TÍTULO → el alta rápida FALLA'} | sinopsis ${sinop(real?.meta?.sinopsis)} | colección «${col.nombre || '—'}»${col.numero ? ` nº${col.numero}` : ''} | cdu ${real?.meta?.cdu || '—'}`);

    const port = real?.portadas || [];
    imprimir(`  · PORTADAS (${port.length}): ${port.map((p) => `${p.fuente} ${p.ancho}×${p.alto}`).join('  |  ') || '‼ NINGUNA'}`);
    for (const p of port) imprimir(`       ${p.fuente}: ${p.url}`);
}
process.exit(0);
