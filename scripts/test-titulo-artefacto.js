import { esTituloArtefacto, esAutorArtefacto } from '../src/utils/parsear-nombre.js';

/**
 * Pruebas del detector de títulos/autores ARTEFACTO del productor (TeX/DVI, InDesign, Word…).
 * Ejecuta:  node scripts/test-titulo-artefacto.js
 */

let ok = 0, fallos = 0;
const eq = (cond, msg) => { if (cond) ok++; else { fallos++; console.log('  ✗', msg); } };

// ── Deben marcarse como ARTEFACTO (casos reales del catálogo) ──
console.log('títulos-artefacto (deben ser true):');
for (const t of [
    'C:TARANTOLABOOK.DVI', 'C:\\HSW\\MYBOOKS\\AlgComp\\abook.DVI', 'A:\\QICC.PDF',
    'master.dvi', 'ode.dvi', 'PB3231_Great_Tours_Text_10_14.indd', '473223_1_En_Print.indd',
    "Rhys, Jean ''Wide Sargasso Sea''-Xx-En-Sp.p65", 'Microsoft Word - recipes.doc',
    'Microsoft PowerPoint - Aves.pptx', 'Untitled', 'untitled', 'Documento 1', 'Document1',
    'C:/Documents and Settings/x/Desktop/driver.dvi',
]) eq(esTituloArtefacto(t), `debería marcar: ${JSON.stringify(t)}`);

// ── NO deben marcarse (títulos legítimos: sin falsos positivos) ──
console.log('títulos legítimos (deben ser false):');
for (const t of [
    'Inverse Problem Theory and Methods for Model Parameter Estimation',
    'Don Quijote de la Mancha', 'Algorithms in C++', 'Python 3: The Complete Reference',
    'Web Design 2.0', 'R.U.R.', 'Documents in Contemporary Art', 'The C Programming Language',
    'Cien años de soledad', 'Sapiens: A Brief History of Humankind',
]) eq(!esTituloArtefacto(t), `NO debería marcar: ${JSON.stringify(t)}`);

// ── Autores-artefacto ──
console.log('autores-artefacto:');
eq(esAutorArtefacto('Pat Hufnagle (Sherman Typography) 893 1998 May 29 10:37:50'), 'crédito de composición con hora');
eq(esAutorArtefacto('Acrobat Distiller 4.05'), 'herramienta de build');
eq(!esAutorArtefacto('Tarantola, Albert'), 'autor real (Tarantola)');
eq(!esAutorArtefacto('García Márquez, Gabriel'), 'autor real (García Márquez)');

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
