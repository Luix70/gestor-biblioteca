#!/usr/bin/env node
/**
 * DIAGNÓSTICO (SOLO LECTURA) de revistas conflacionadas.
 *
 * Antiguo bug de dedup: cuando NO se extraía el mes de un número fechado por nombre ("octubre 2015"),
 * la clave caía a (issn + año), de modo que VARIOS números del mismo año se fusionaban en un único
 * registro Y en una única carpeta `…/revistas/<issn>/<año>/`. Los ficheros NO se borran (solo se borra
 * un hash idéntico), así que los números "absorbidos" siguen en disco, en la misma carpeta, sin catalogar
 * aparte. La señal es: una carpeta de número con MÁS DE UN fichero-documento (pdf/epub/…).
 *
 * Este script NO modifica nada: recorre el árbol CDU, cuenta y reporta. Mide el alcance del problema
 * antes de cualquier migración. (La recuperación —re-catalogar los ficheros absorbidos— es el Paso 2.)
 *
 * Uso (en el contenedor del NAS, donde está montado el árbol CDU):
 *   docker exec gestor-biblioteca node scripts/diagnostico-revistas.js
 *   docker exec gestor-biblioteca node scripts/diagnostico-revistas.js --listar   # detalle por carpeta
 *
 * Limitación: detecta números en formato documento (pdf/epub/…). Las revistas escaneadas como GRUPOS
 * de imágenes no se evalúan (no hay un fichero-documento que contar).
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

// Extensiones de "documento" (el fichero real del número) — NO las imágenes materializadas (portada-*.jpg).
const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.zip', '.rar']);
const esDoc = (n) => EXT_DOC.has(path.extname(n).toLowerCase());
const soloAño = (seg) => /^\d{4}$/.test(seg);   // "2015" (sin mes) vs "2015-10"

/** Recorre el árbol y emite { dir, archivos } de cada carpeta SITUADA dentro de un subárbol `revistas`. */
async function* carpetasDeRevista(dir, dentro = false) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const archivos = entradas.filter(e => e.isFile()).map(e => e.name);
    if (dentro && archivos.some(esDoc)) yield { dir, archivos };
    for (const e of entradas) {
        if (e.isDirectory()) yield* carpetasDeRevista(path.join(dir, e.name), dentro || e.name === 'revistas');
    }
}

async function leerRegistro(dir) {
    try { return JSON.parse(await fs.readFile(path.join(dir, 'registro.json'), 'utf8')); }
    catch { return null; }
}

async function main() {
    try { await fs.access(DIR_CDU); }
    catch { console.error(`❌ No existe el árbol CDU en ${DIR_CDU}. ¿Ruta PATH_CDU correcta / montada?`); process.exit(2); }

    console.log(`🔎 Diagnóstico de revistas (SOLO LECTURA) sobre ${DIR_CDU}\n`);

    let carpetas = 0, totalDocs = 0;
    let conflacion = 0, absorbidos = 0, conflacionSoloAño = 0, absorbidosSoloAño = 0;
    let sinRegistro = 0;
    const detalle = [];

    for await (const { dir, archivos } of carpetasDeRevista(DIR_CDU)) {
        const docs = archivos.filter(esDoc);
        carpetas++;
        totalDocs += docs.length;

        const reg = await leerRegistro(dir);
        if (!reg) sinRegistro++;
        const catalogados = new Set([reg?.nombre_archivo, ...(reg?.archivos_originales || [])].filter(Boolean));
        // "Absorbidos" = ficheros-documento de la carpeta que NO son el catalogado. Sin registro, todos
        // menos uno se cuentan como absorbidos (la carpeta cataloga, como mucho, un número).
        const extra = catalogados.size
            ? docs.filter(d => !catalogados.has(d))
            : docs.slice(1);

        const seg = path.basename(dir);
        const esSoloAño = soloAño(seg);

        if (docs.length >= 2) {
            conflacion++;
            absorbidos += extra.length;
            if (esSoloAño) { conflacionSoloAño++; absorbidosSoloAño += extra.length; }
            if (DETALLE) detalle.push({
                ruta: path.relative(DIR_CDU, dir), seg, esSoloAño, n: docs.length,
                catalogado: reg?.nombre_archivo || '(sin registro)',
                absorbidos: extra,
            });
        }
    }

    const ok = carpetas - conflacion;
    const fmt = (n) => String(n).padStart(6);

    console.log('── Resumen ───────────────────────────────────────────────');
    console.log(`Carpetas de número con documento:        ${fmt(carpetas)}`);
    console.log(`Ficheros-documento en disco:             ${fmt(totalDocs)}`);
    console.log(`  · carpetas con 1 documento (OK):       ${fmt(ok)}`);
    console.log(`  · carpetas con ≥2 documentos (CONFLACIÓN): ${fmt(conflacion)}`);
    console.log(`      de ellas en carpetas «solo año»:   ${fmt(conflacionSoloAño)}  (la firma del bug del mes)`);
    if (sinRegistro) console.log(`  · carpetas sin registro.json (huérfanas):  ${fmt(sinRegistro)}`);
    console.log('──────────────────────────────────────────────────────────');
    console.log(`NÚMEROS ABSORBIDOS (en disco, sin catalogar aparte): ${absorbidos}`);
    console.log(`   de ellos en carpetas «solo año»:                  ${absorbidosSoloAño}`);
    console.log('');
    if (absorbidos === 0) {
        console.log('✅ No se detectan números absorbidos: no hay conflaciones recuperables en disco.');
    } else {
        console.log(`➡  Estimación: tienes ~${absorbidos} número(s) de revista en disco que el bug fusionó en`);
        console.log('   el registro de otro número. NINGUNO se ha perdido del disco; el Paso 2 (migración) los');
        console.log('   re-cataloga como números distintos (ya con el mes recuperado y la dedup por cabecera+clave).');
    }
    if (DETALLE && detalle.length) {
        console.log('\n── Detalle (carpetas conflacionadas) ─────────────────────');
        for (const d of detalle.sort((a, b) => b.n - a.n)) {
            console.log(`\n• ${d.ruta}   [${d.n} docs${d.esSoloAño ? ', SOLO AÑO' : ''}]`);
            console.log(`    catalogado: ${d.catalogado}`);
            for (const a of d.absorbidos) console.log(`    absorbido : ${a}`);
        }
    } else if (!DETALLE && conflacion) {
        console.log('\n(añade --listar para ver carpeta por carpeta qué ficheros quedaron sin catalogar)');
    }
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
