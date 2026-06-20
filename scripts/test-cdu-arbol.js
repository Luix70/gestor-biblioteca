/**
 * Test offline (sin BD) del mapeo arbolCDU sobre los códigos reales más problemáticos.
 *   node scripts/test-cdu-arbol.js
 */
import { arbolCDU } from '../src/utils/cdu-arbol.js';

const CASOS = [
    ['821.161.1-31_18_', '8', '821'],
    ['93-055.2', '9', '93'],
    ['004.738.55', '0', '004'],
    ['82.09 _ 821.14', '8', '82'],            // espacio alrededor de '_' (relación), NO nombre
    ['929 Velázquez, Diego', '9', '929'],     // nombre recortado
    ['929 VelÃ¡zquez, Diego', '9', '929'],     // mojibake recortado
    ['821.111(73) King, Stephen 1.07_791.43', '8', '821'],
    ['025.45 CDU (083.74)', '0', '025'],
    ['913(410.111 L.)', '9', '913'],          // paréntesis colgante equilibrado
    ['(460.23)', '_sin_clasificar', '_sin_clasificar'], // sin clase → cajón
    ['9(569.4-18)', '9', '9'],
    ['00', '0', '00'], ['000', '0', '000'], ['0', '0', '0'],
    ['460.8', '4', '460'], ['82', '8', '82'], ['1 Sócrates', '1', '1'],
    ['', '_sin_clasificar', '_sin_clasificar'],
];

let ok = 0, fail = 0;
for (const [cdu, clase, division] of CASOS) {
    const a = arbolCDU(cdu);
    const pass = a.clase === clase && a.division === division;
    if (pass) ok++; else fail++;
    console.log(`${pass ? '✅' : '❌'} "${cdu}" → ${a.segmentos.join('/')}` + (pass ? '' : `  (esperaba ${clase}/${division})`));
}
console.log(`\n${ok} OK · ${fail} fallos`);
process.exit(fail ? 1 : 0);
