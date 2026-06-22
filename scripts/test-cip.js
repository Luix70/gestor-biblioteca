import { parsearBloqueCatalogacion } from '../src/utils/cip.js';

/**
 * Pruebas del parser de BLOQUE DE CATALOGACIÓN EN PUBLICACIÓN (CIP).
 * Ejecuta:  node scripts/test-cip.js
 */

let ok = 0, fallos = 0;
function comprobar(nombre, real, esperado) {
    const a = JSON.stringify(real), b = JSON.stringify(esperado);
    if (a === b) { ok++; console.log(`  ✓ ${nombre}`); }
    else { fallos++; console.log(`  ✗ ${nombre}\n      esperado: ${b}\n      real:     ${a}`); }
}

// ── Caso real Library of Congress (Loy, "A Buddhist history of the West") ──
const loy = `Library of Congress Cataloging-in-Publication Data
Loy, David R., 1947–
A Buddhist history of the West : studies in lack / David R. Loy.
p. cm. — (SUNY series in religious studies)
Includes bibliographical references and index.
ISBN 0-7914-5259-X (alk. paper) — (ISBN 0-7914-5260-3 (pbk. : alk. paper)
1. Civilization, Western—Psychological aspects. 2. Civilization, Western—Philosophy.
3. Civilization, Western—Classical influences. 4. Philosophy, Buddhist. 5.
Buddhism—Doctrines. 6. Self (Philosophy) 7. Identity (Psychology) 8.
Self-consciousness. I. Title. II. Series.
CB245.R68 2002
909'.09821—dc21 2001049415`;

console.log('parsearBloqueCatalogacion (Loy, LC):');
const r = parsearBloqueCatalogacion(loy);
comprobar('fuente', r.fuente, 'cip-lc');
comprobar('autor', r.autor, 'Loy, David R.');
comprobar('autor_fechas', r.autor_fechas, '1947–');
comprobar('titulo', r.titulo, 'A Buddhist history of the West');
comprobar('subtitulo', r.subtitulo, 'studies in lack');
comprobar('serie', r.serie, 'SUNY series in religious studies');
comprobar('isbns', r.isbns, [
    { isbn: '079145259X', etiqueta: 'alk. paper' },
    { isbn: '0791452603', etiqueta: 'pbk. : alk. paper' },
]);
comprobar('lc', r.lc, 'CB245.R68');
comprobar('dewey', r.dewey, '909.09821');
comprobar('lccn', r.lccn, '2001049415');
comprobar('año', r.año, 2002);
comprobar('materias (8)', r.materias.length, 8);
comprobar('materia[0]', r.materias[0], 'Civilization, Western—Psychological aspects');

// ── Texto sin bloque CIP → null ──
console.log('\nsin bloque CIP:');
comprobar('null', parsearBloqueCatalogacion('Un libro cualquiera sin créditos.'), null);
comprobar('vacío', parsearBloqueCatalogacion(''), null);

// ── Dewey con punto simple y sin apóstrofo ──
console.log('\nDewey variantes:');
comprobar('dc simple', parsearBloqueCatalogacion(
    'Library of Congress Cataloging-in-Publication Data\nQA76.73 2010\n005.133 dc22 2009123456').dewey, '005.133');
comprobar('ddc', parsearBloqueCatalogacion(
    'Library of Congress Cataloging-in-Publication Data\n822.33 ddc23').dewey, '822.33');

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
