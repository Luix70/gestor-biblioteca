#!/usr/bin/env node
/**
 * VERIFICAR IMPORTS — comprueba que cada `import { a, b } from './modulo.js'` del proyecto pide nombres que ese
 * módulo de verdad EXPORTA. Sin dependencias y sin ejecutar nada (no conecta a la base ni arranca el vigilante).
 *
 * Por qué (30-sep): `node --check` solo mira la sintaxis de UN fichero. Al reescribir `buscador-crossref.js` se
 * perdieron dos funciones que importaban otros tres módulos; cada fichero pasaba su `--check`, y la aplicación no
 * arrancó en el NAS («does not provide an export named 'buscarPorDOI'»). Esto lo habría avisado en un segundo.
 *
 *   node scripts/verificar-imports.js        (código de salida 1 si falta algún nombre)
 *
 * Ejecutarlo antes de cada commit que toque `src/` o `scripts/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CARPETAS = ['src', 'scripts'];

/** Todos los .js de una carpeta, en profundidad. */
function ficherosJs(carpeta) {
    const salida = [];
    for (const entrada of fs.readdirSync(carpeta, { withFileTypes: true })) {
        const ruta = path.join(carpeta, entrada.name);
        if (entrada.isDirectory()) salida.push(...ficherosJs(ruta));
        else if (/\.(js|mjs)$/.test(entrada.name)) salida.push(ruta);
    }
    return salida;
}

/** Quita comentarios (de bloque y de línea) para no leer imports o exports de un texto comentado. */
const sinComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const cacheExportados = new Map();
/** Nombres que exporta un módulo (siguiendo sus `export … from` y `export * from`). */
function exportados(ruta, enCurso = new Set()) {
    if (cacheExportados.has(ruta)) return cacheExportados.get(ruta);
    const nombres = new Set();
    if (enCurso.has(ruta) || !fs.existsSync(ruta)) return nombres;
    enCurso.add(ruta);
    const codigo = sinComentarios(fs.readFileSync(ruta, 'utf8'));

    // export function x / export async function x / export const x / export let x / export class X
    for (const m of codigo.matchAll(/^\s*export\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gmu)) nombres.add(m[1]);
    // export const { a, b } = …   (desestructurado)
    for (const m of codigo.matchAll(/^\s*export\s+(?:const|let|var)\s*\{([^}]*)\}/gm)) {
        for (const parte of m[1].split(',')) { const n = parte.split(':').pop().trim(); if (n) nombres.add(n); }
    }
    if (/^\s*export\s+default\b/m.test(codigo)) nombres.add('default');
    // export { a, b as c }            y            export { a, b as c } from './otro.js'
    for (const m of codigo.matchAll(/^\s*export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/gm)) {
        for (const parte of m[1].split(',')) {
            const n = parte.trim().split(/\s+as\s+/).pop().trim();
            if (n) nombres.add(n);
        }
    }
    // export * from './otro.js'
    for (const m of codigo.matchAll(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/gm)) {
        if (!m[1].startsWith('.')) continue;
        for (const n of exportados(path.resolve(path.dirname(ruta), m[1]), enCurso)) if (n !== 'default') nombres.add(n);
    }
    cacheExportados.set(ruta, nombres);
    return nombres;
}

const fallos = [];
let comprobados = 0;
for (const carpeta of CARPETAS) {
    for (const fichero of ficherosJs(path.join(RAIZ, carpeta))) {
        const codigo = sinComentarios(fs.readFileSync(fichero, 'utf8'));
        // import Defecto, { a, b as c } from './x.js'     ·     import { a } from './x.js'
        for (const m of codigo.matchAll(/^\s*import\s+(?:([\p{L}_$][\p{L}\p{N}_$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/gmu)) {
            const [, porDefecto, lista, origen] = m;
            if (!origen.startsWith('.')) continue;   // paquetes de npm y módulos de Node: no se miran
            const destino = path.resolve(path.dirname(fichero), origen);
            const donde = `${path.relative(RAIZ, fichero)} ← ${origen}`;
            if (!fs.existsSync(destino)) { fallos.push(`${donde}: el fichero no existe`); continue; }
            const disponibles = exportados(destino);
            const pedidos = (lista || '').split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
            if (porDefecto) pedidos.push('default');
            for (const nombre of pedidos) {
                comprobados++;
                if (!disponibles.has(nombre)) fallos.push(`${donde}: no exporta «${nombre}»`);
            }
        }
    }
}

if (fallos.length) {
    console.error(`⛔ ${fallos.length} import(s) que no casan con lo que exporta su módulo:`);
    for (const f of fallos) console.error(`   ${f}`);
    process.exit(1);
}
console.log(`✅ ${comprobados} nombres importados, todos exportados por su módulo.`);
