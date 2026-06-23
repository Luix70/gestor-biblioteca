import { norm13, isbn10a13, anioDe, paginasDe, idiomaOL, idiomaBNE, limpiarCDU, mapBNE, mapOL } from './etl-map.js';

/** Pruebas de la lógica pura del ETL del Fichero. node scripts/test-etl-map.js */
let ok = 0, fallos = 0;
const eq = (a, b, m) => { if (JSON.stringify(a) === JSON.stringify(b)) ok++; else { fallos++; console.log(`  ✗ ${m}\n      esperado ${JSON.stringify(b)} · real ${JSON.stringify(a)}`); } };

console.log('ISBN:');
eq(norm13('978-84-19399-06-9'), '9788419399069', 'BNE con guiones → 13');
eq(norm13('0306406152'), isbn10a13('0306406152'), 'ISBN-10 → 13');
eq(norm13('0306406152').length, 13, 'longitud 13');
eq(norm13(''), null, 'vacío → null');
eq(norm13('abc'), null, 'no-ISBN → null');

console.log('año / páginas:');
eq(anioDe('2015'), 2015, 'año simple');
eq(anioDe('c2016.'), 2016, 'año con ruido');
eq(anioDe('[2024]'), 2024, 'año entre corchetes');
eq(anioDe(null), null, 'sin año');
eq(paginasDe(' 118 páginas'), 118, 'páginas BNE');
eq(paginasDe(210), 210, 'páginas OL (entero)');

console.log('idioma:');
eq(idiomaOL('/languages/eng'), 'en', 'OL eng→en');
eq(idiomaOL('/languages/spa'), 'es', 'OL spa→es');
eq(idiomaBNE('español'), 'es', 'BNE español→es');
eq(idiomaBNE('Inglés'), 'en', 'BNE Inglés→en');
eq(idiomaBNE(null), null, 'BNE sin lengua');

console.log('CDU:');
eq(limpiarCDU(' 821.134.2-91"20" /**/ '), '821.134.2-91"20"', 'limpia marcador /**/');
eq(limpiarCDU(null), null, 'sin cdu');

console.log('mapBNE:');
const b = mapBNE({ isbn: '978-84-18585-02-9', titulo: 'Viñetas 4', autores: 'Salmarina', editorial: 'Letrame', fecha_de_publicacion: '2020', lengua_principal: 'español', cdu: ' 821.134.2-91"20" /**/ ', extension: ' 118 páginas', dimensiones: ' 14 x 25 cm', tipo_de_documento: 'Monografía', pais_de_publicacion: 'España', id: ' 99106' });
eq(b.isbn, '9788418585029', 'BNE isbn');
eq(b.idioma, 'es', 'BNE idioma');
eq(b.cdu, '821.134.2-91"20"', 'BNE cdu limpio');
eq(b.paginas, 118, 'BNE páginas');
eq(b.fuente, 'bne', 'BNE fuente');

console.log('mapOL:');
const o = mapOL({ title: 'Activity Theory', subtitle: 'Research', isbn_13: ['9789463003865'], authors: [{ key: '/authors/OL1A' }], publishers: ['BRILL'], publish_date: '2016', languages: [{ key: '/languages/eng' }], number_of_pages: 210, subjects: ['Education', 'Theory'], covers: [12345], key: '/books/OL1M' }, k => k === '/authors/OL1A' ? 'Doe, J.' : null);
eq(o.isbn, '9789463003865', 'OL isbn');
eq(o.autores, 'Doe, J.', 'OL autor resuelto');
eq(o.idioma, 'en', 'OL idioma');
eq(o.palabras_clave, 'Education; Theory', 'OL materias unidas');
eq(o.portada_url, 'https://covers.openlibrary.org/b/id/12345-L.jpg', 'OL portada');
eq(o.fuente, 'openlibrary', 'OL fuente');

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
