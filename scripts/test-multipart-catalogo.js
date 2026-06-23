import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { procesarCatalogo } from '../src/motor-catalogo.js';

/**
 * Prueba de INTEGRACIÓN (escribe en Atlas y limpia tras de sí) de los dos bugs que mandaban los
 * tomos 2..N a Cuarentena:
 *   A) registrarTomo fuera de alcance en el manejador de E11000 ("registrarTomo is not defined").
 *   B) los tomos compartían el ISBN de la OBRA (set) → colisión en el índice único `isbn`.
 *
 * Requiere credenciales de Atlas:  NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/test-multipart-catalogo.js
 */

let ok = 0, fallos = 0;
const eq = (cond, msg) => { if (cond) { ok++; console.log('  ✓', msg); } else { fallos++; console.log('  ✗', msg); } };

const ISBN_SET = '0000000000';            // ISBN-10 válido (checksum 0), test
const MARCA = 'ZZZTEST_MULTIPART';

const db = await conectarDB();
const bib = db.collection('biblioteca');
const obras = db.collection('obras');

async function limpiar() {
    const tomos = await bib.find({ titulo: new RegExp(MARCA) }).toArray();
    await bib.deleteMany({ titulo: new RegExp(MARCA) });
    await obras.deleteMany({ titulo: new RegExp(MARCA) });
    await obras.deleteMany({ isbn_obra: ISBN_SET });
    return tomos.length;
}

const base = (extra) => ({
    cdu: '030', idioma: 'es', tipo_recurso: 'libro', formatos: ['digital'],
    ubicacion: { ambito: 'test', estanteria: 'test' }, alertas_agente: [], ...extra,
});

try {
    await limpiar(); // por si quedó algo de una ejecución previa

    // ── A) Dos libros NO-obra con el MISMO isbn → el 2º cae en E11000 → debe FUSIONAR sin romper ──
    console.log('A) E11000 en libro normal (registrarTomo definido en el catch):');
    const a1 = await procesarCatalogo(base({ titulo: `${MARCA} A1`, isbn: '0306406152', nombre_archivo: 'a1.pdf' }));
    let a2;
    try {
        a2 = await procesarCatalogo(base({ titulo: `${MARCA} A2`, isbn: '0306406152', nombre_archivo: 'a2.pdf' }));
        eq(a2.operacion === 'actualizacion', `2º con mismo isbn → fusiona (no "registrarTomo is not defined"), op=${a2.operacion}`);
    } catch (e) {
        eq(false, `lanzó: ${e.message}`);
    }
    await bib.deleteMany({ isbn: '0306406152', titulo: new RegExp(MARCA) });

    // ── B) Dos TOMOS de una obra que comparten el ISBN del set → deben insertarse por separado ──
    console.log('B) tomos con ISBN de set compartido (no colisionan, inventario completo):');
    const vol = (n) => base({
        titulo: `${MARCA} Obra — Vol. ${n}`, obra_titulo: `${MARCA} Obra`,
        isbn: ISBN_SET, isbn_obra: ISBN_SET, volumen_numero: n, obra_total: 2,
        nombre_archivo: `obra-vol-${n}.pdf`,
    });
    const r1 = await procesarCatalogo(vol(1));
    const r2 = await procesarCatalogo(vol(2));
    eq(r1.operacion === 'insercion', `tomo 1 insertado (op=${r1.operacion})`);
    eq(r2.operacion === 'insercion', `tomo 2 insertado SIN colisión (op=${r2.operacion})`);
    eq(String(r1._id) !== String(r2._id), 'tomo 1 y tomo 2 son documentos DISTINTOS');
    eq(r1.isbn === undefined && r2.isbn === undefined, 'los tomos NO heredan el isbn del set');

    const obra = await obras.findOne({ titulo: `${MARCA} Obra` });
    eq(!!obra, 'obra creada');
    eq(obra && obra.volumenes_presentes === 2, `inventario: 2 tomos presentes (${obra?.volumenes_presentes})`);
    eq(obra && obra.volumenes?.every(v => v._id), 'todos los tomos del inventario tienen _id (ninguno null)');
    eq(obra && obra.completa === true, 'obra marcada completa');

    // ── C) SEGURIDAD: un tomo cuyo ISBN ya es de OTRO documento NO se fusiona: se guarda sin isbn ──
    console.log('C) ISBN de tomo que choca con otro doc → se guarda SIN isbn (no fusiona) + anomalía:');
    const ajeno = await procesarCatalogo(base({ titulo: `${MARCA} Ajeno`, isbn: '0131103628', nombre_archivo: 'ajeno.pdf' }));
    const volC = await procesarCatalogo(base({
        titulo: `${MARCA} Obra C — Vol. 1`, obra_titulo: `${MARCA} Obra C`, isbn_obra: '0000000002',
        isbn: '0131103628', volumen_numero: 1, nombre_archivo: 'obraC-vol-1.pdf', // mismo isbn que 'ajeno'
    }));
    eq(volC.operacion === 'insercion', `tomo insertado aparte (op=${volC.operacion})`);
    eq(String(volC._id) !== String(ajeno._id), 'el tomo NO se fusionó con el documento ajeno');
    eq(volC.isbn === undefined, 'el tomo se guardó SIN isbn (descartado el que chocaba)');

    // ── D) Tomo SIN número ("?") → se guarda igual, en volumenes_sin_numero, obra a revisión ──
    console.log('D) tomo sin número ("?") → guardado y marcado, nunca descartado:');
    const volD = await procesarCatalogo(base({   // sin volumen_numero (tomo "?")
        titulo: `${MARCA} Obra D — ?`, obra_titulo: `${MARCA} Obra D`, isbn_obra: '0000000001',
        nombre_archivo: 'obraD-vol-x.pdf',
    }));
    eq(volD.operacion === 'insercion', `tomo "?" insertado (op=${volD.operacion})`);
    const obraD = await obras.findOne({ titulo: `${MARCA} Obra D` });
    eq(obraD && (obraD.volumenes_sin_numero || []).length === 1, 'tomo "?" registrado en volumenes_sin_numero');
    eq(obraD && obraD.revision_requerida === true, 'obra marcada revision_requerida');
} finally {
    const n = await limpiar();
    console.log(`(limpieza: ${n} documento(s) de prueba eliminados)`);
}

console.log(`\n${fallos === 0 ? '✅' : '❌'}  ${ok} ok, ${fallos} fallos`);
process.exit(fallos === 0 ? 0 : 1);
