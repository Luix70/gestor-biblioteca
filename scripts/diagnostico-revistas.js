#!/usr/bin/env node
/**
 * DIAGNÓSTICO (SOLO LECTURA) de revistas conflacionadas / carpetas colisionadas.
 *
 * Recorre el árbol CDU buscando carpetas de revista con MÁS de un fichero-documento y, CRUZANDO con
 * la BD (biblioteca.nombre_archivo), distingue las dos situaciones —muy distintas— que producen eso:
 *
 *   (A) REGISTRO PERDIDO  — el fichero está en disco pero NINGÚN documento lo referencia: el bug de
 *       dedup fusionó ese número en el registro de otro (pérdida real de catálogo; recuperable
 *       re-catalogando el fichero, que sigue en disco).
 *   (B) COLISIÓN DE CARPETA — varios documentos DISTINTOS (cada uno con su registro en BD) acabaron
 *       en la MISMA carpeta (la ruta de revista no lleva discriminador), pisándose el registro.json /
 *       las portadas. No hay pérdida de catálogo: solo el layout en disco colisiona.
 *
 * Además CLASIFICA cada carpeta: «revista» real, «serie de LIBROS mal clasificada» (ficheros con
 * nombre de ISBN) o «título BASURA» (marca de agua del productor del PDF como título → libro mal
 * clasificado). Así se ve cuánto es problema de revistas y cuánto de clasificación/extracción.
 *
 * NO modifica nada. Uso en el contenedor del NAS:
 *   docker exec gestor-biblioteca node scripts/diagnostico-revistas.js
 *   docker exec gestor-biblioteca node scripts/diagnostico-revistas.js --listar
 *   docker exec gestor-biblioteca node scripts/diagnostico-revistas.js --sin-bd   # solo disco
 */
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');

const DETALLE = process.argv.includes('--listar');
const SIN_BD = process.argv.includes('--sin-bd');

const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.zip', '.rar']);
const esDoc = (n) => EXT_DOC.has(path.extname(n).toLowerCase());
const soloAño = (seg) => /^\d{4}$/.test(seg);

// Heurísticas de mala clasificación.
const ISBNRX = /^(97[89])?\d{9,12}[\dX]$/i;
const esISBNnombre = (n) => ISBNRX.test(path.basename(n, path.extname(n)).replace(/\(\d+\)$/, '').replace(/[ _\-.]/g, ''));
const TITULO_BASURA = /creator_|pscript|pdf ?repair|datanumen|acrobat ?distiller|ghostscript|quartz ?pdf|untitled/i;

async function* carpetasDeRevista(dir, dentro = false) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const archivos = entradas.filter(e => e.isFile()).map(e => e.name);
    if (dentro && archivos.some(esDoc)) yield { dir, archivos };
    for (const e of entradas) {
        if (e.isDirectory()) yield* carpetasDeRevista(path.join(dir, e.name), dentro || e.name === 'revistas');
    }
}

async function cargarMapaBD() {
    if (SIN_BD) return null;
    try {
        const { conectarDB } = await import('../src/database.js');
        const db = await conectarDB();
        const docs = await db.collection('biblioteca')
            .find({}, { projection: { nombre_archivo: 1, archivos_originales: 1, tipo_recurso: 1 } }).toArray();
        const mapa = new Map();
        for (const d of docs) {
            if (d.nombre_archivo) mapa.set(d.nombre_archivo, d);
            for (const a of (d.archivos_originales || [])) mapa.set(a, d);
        }
        console.log(`✔ Cruce con BD: ${docs.length} documentos indexados por nombre de fichero.\n`);
        return mapa;
    } catch (e) {
        console.warn(`⚠ Sin cruce con BD (${e.message}). Informe SOLO por disco (cuentas = cota superior).\n`);
        return null;
    }
}

function clasificar(seg, segPadre, docFiles) {
    if (TITULO_BASURA.test(seg) || TITULO_BASURA.test(segPadre) || docFiles.some(f => TITULO_BASURA.test(f))) return 'basura';
    if (docFiles.filter(esISBNnombre).length >= Math.ceil(docFiles.length / 2)) return 'libros';
    return 'revista';
}

async function main() {
    try { await fs.access(DIR_CDU); }
    catch { console.error(`❌ No existe el árbol CDU en ${DIR_CDU}.`); process.exit(2); }
    console.log(`🔎 Diagnóstico de revistas (SOLO LECTURA) sobre ${DIR_CDU}\n`);

    const mapa = await cargarMapaBD();
    const tieneReg = (f) => mapa ? mapa.has(f) : null;

    let carpetas = 0, totalDocs = 0, conflacion = 0;
    let perdidos = 0, perdidosRevista = 0;                 // ficheros sin registro en BD (A)
    let colisionCarpetas = 0, colisionRegistros = 0;       // registros distintos compartiendo carpeta (B)
    const porClase = { revista: { carpetas: 0, perdidos: 0 }, libros: { carpetas: 0, perdidos: 0 }, basura: { carpetas: 0, perdidos: 0 } };
    const detalle = [];

    for await (const { dir, archivos } of carpetasDeRevista(DIR_CDU)) {
        const docs = archivos.filter(esDoc);
        carpetas++; totalDocs += docs.length;
        if (docs.length < 2) continue;
        conflacion++;

        const seg = path.basename(dir), segPadre = path.basename(path.dirname(dir));
        const clase = clasificar(seg, segPadre, docs);
        porClase[clase].carpetas++;

        const sinReg = mapa ? docs.filter(f => !tieneReg(f)) : docs.slice(1); // sin BD: estimación K-1
        const conReg = mapa ? docs.filter(f => tieneReg(f)) : [];
        const distintos = mapa ? new Set(conReg.map(f => String(mapa.get(f)._id))).size : 0;

        perdidos += sinReg.length;
        porClase[clase].perdidos += sinReg.length;
        if (clase === 'revista') perdidosRevista += sinReg.length;
        if (distintos >= 2) { colisionCarpetas++; colisionRegistros += distintos; }

        if (DETALLE) detalle.push({ ruta: path.relative(DIR_CDU, dir), clase, n: docs.length, soloAño: soloAño(seg), sinReg, distintos });
    }

    const f = (n) => String(n).padStart(6);
    console.log('── Resumen ───────────────────────────────────────────────');
    console.log(`Carpetas de número con documento:            ${f(carpetas)}`);
    console.log(`Ficheros-documento en disco:                 ${f(totalDocs)}`);
    console.log(`Carpetas con ≥2 documentos:                  ${f(conflacion)}`);
    console.log('');
    if (mapa) {
        console.log(`(A) REGISTROS PERDIDOS  (fichero en disco SIN documento en BD): ${perdidos}`);
        console.log(`      · de carpetas tipo «revista» real:                       ${perdidosRevista}   ← lo recuperable de verdad`);
        console.log(`      · de carpetas «libros»/«basura» (mal clasificadas):      ${perdidos - perdidosRevista}`);
        console.log(`(B) COLISIÓN DE CARPETA (registros DISTINTOS compartiendo carpeta, SIN pérdida):`);
        console.log(`      · carpetas afectadas: ${colisionCarpetas}  ·  registros implicados: ${colisionRegistros}`);
    } else {
        console.log(`Números ABSORBIDOS estimados (cota superior, K-1 por carpeta): ${perdidos}`);
        console.log('  (ejecuta dentro del contenedor SIN --sin-bd para separar pérdidas reales de colisiones)');
    }
    console.log('');
    console.log('── Por clase de carpeta ──────────────────────────────────');
    console.log(`  REVISTA real:                  carpetas ${f(porClase.revista.carpetas)} · perdidos ${porClase.revista.perdidos}`);
    console.log(`  LIBROS (ISBN) mal clasificados:carpetas ${f(porClase.libros.carpetas)} · perdidos ${porClase.libros.perdidos}`);
    console.log(`  TÍTULO BASURA (productor PDF):  carpetas ${f(porClase.basura.carpetas)} · perdidos ${porClase.basura.perdidos}`);

    if (DETALLE) {
        const orden = { revista: 0, libros: 1, basura: 2 };
        console.log('\n── Detalle ───────────────────────────────────────────────');
        for (const d of detalle.sort((a, b) => orden[a.clase] - orden[b.clase] || b.n - a.n)) {
            const etiq = d.clase === 'revista' ? 'REVISTA' : d.clase === 'libros' ? 'LIBROS?' : 'BASURA';
            const col = d.distintos >= 2 ? ` · colisión(${d.distintos} registros)` : '';
            console.log(`\n• [${etiq}${d.soloAño ? ',AÑO' : ''}] ${d.ruta}   (${d.n} docs, ${d.sinReg.length} sin registro${col})`);
            for (const a of d.sinReg) console.log(`    sin registro en BD (fichero a salvo en disco): ${a}`);
        }
    }
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
