/**
 * Análisis del formato del campo CDU en el volcado JSON de la BNE.
 * Uso: node "Test Battery/test-bne-json-analysis.js"
 */
import fs from 'fs';
import readline from 'readline';

const rl = readline.createInterface({ input: fs.createReadStream('docs/monomodernas-JSON.json') });

const multiCDU = [], soloSubdivision = [], pagEjemplos = [], dimEjemplos = [];
let seen = 0;

for await (const line of rl) {
    const clean = line.trim().replace(/,$/, '').replace(/^\[/, '').replace(/\]$/, '');
    if (!clean || clean === '[' || clean === ']') continue;
    let rec;
    try { rec = JSON.parse(clean); } catch { continue; }
    if (!rec.isbn || !rec.cdu) continue;
    seen++;

    // ¿Aparece /**/ en el MEDIO? → múltiples CDUs
    const partes = rec.cdu.split('/**/').map(s => s.trim()).filter(Boolean);
    if (partes.length > 1 && multiCDU.length < 6) {
        multiCDU.push({ raw: rec.cdu, partes, titulo: rec.titulo?.slice(0,40) });
    }
    // CDUs que son solo subdivisiones sin código base
    if (/^\s*[\(\-\+\.]/.test(rec.cdu) && soloSubdivision.length < 4) {
        soloSubdivision.push(rec.cdu.trim());
    }
    // Ejemplos de extension (páginas)
    if (rec.extension && /\d+\s*p[áa]g/i.test(rec.extension) && pagEjemplos.length < 5) {
        pagEjemplos.push(rec.extension.trim());
    }
    // Ejemplos de dimensiones
    if (rec.dimensiones && dimEjemplos.length < 5) {
        dimEjemplos.push(rec.dimensiones.trim());
    }

    if (seen > 400000) break;
}

console.log(`Registros ISBN+CDU analizados: ${seen.toLocaleString()}\n`);

console.log('── Multi-CDU (/**/ separa varios códigos) ───');
multiCDU.forEach(m => {
    console.log('  RAW:   ', JSON.stringify(m.raw));
    console.log('  PARTES:', m.partes);
    console.log('  TÍTULO:', m.titulo);
    console.log();
});

console.log('── Solo subdivisión (sin código base) ────────');
soloSubdivision.forEach(s => console.log(' ', JSON.stringify(s)));

console.log('\n── Formatos de extension (páginas) ───────────');
pagEjemplos.forEach(s => console.log(' ', JSON.stringify(s)));

console.log('\n── Formatos de dimensiones ───────────────────');
dimEjemplos.forEach(s => console.log(' ', JSON.stringify(s)));
