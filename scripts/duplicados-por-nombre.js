/**
 * DUPLICADOS POR NOMBRE (dentro de la MISMA carpeta) — localiza documentos que son la MISMA obra representada con
 * nombres que solo difieren en cosas COSMÉTICAS o de CODIFICACIÓN, y propone quedarse con el más grande, enviando
 * el resto a una papelera (nunca borra). NO son duplicados por hash (esos ya se depuraron): aquí el criterio es el
 * NOMBRE, comparado con cuidado para NO fusionar tomos de una serie.
 *
 * QUÉ CUENTA COMO DUPLICADO (mismo formato, misma carpeta):
 *   · Nombres IDÉNTICOS tras normalizar lo cosmético: minúsculas, sin acentos, corchetes/llaves → paréntesis
 *     ([Retail]=(Retail)), guiones unicode → '-', extensión en minúsculas (.PDF=.pdf).
 *   · Nombres iguales salvo CARACTERES PERDIDOS por codificación ('?' o '�'), que se tratan como COMODÍN: solo
 *     casan si la LONGITUD coincide y las diferencias están SOLO en esas posiciones (con un tope). Así
 *     «…750–940…» = «…750?940…» y «Aršāma» = «Ar??ma».
 * QUÉ NO (para no perder únicos): cualquier diferencia en un carácter REAL (un dígito, una letra, un romano) →
 *   NO se agrupan. Por eso «Volume I/II/III» y «Book 24/25» quedan SIEMPRE separados. Sin similitud difusa.
 *
 * CUÁL SE CONSERVA: el de MAYOR TAMAÑO (empate → el de nombre «limpio» sin ?/�, luego el más corto, luego alfabético).
 *
 * FLUJO (nunca borra; papelera conservando la estructura de carpetas):
 *   1) node scripts/duplicados-por-nombre.js "<carpeta>"            → escribe el PLAN «_plan-duplicados.json» en la
 *      raíz (preselección conservar/eliminar + tamaños) y lo resume por consola. NO toca nada.
 *   2) Revisa/edita el plan (cambia «accion»: "conservar" | "eliminar" en los ficheros que quieras).
 *   3) node scripts/duplicados-por-nombre.js "<carpeta>" --ejecutar → lee el plan y MUEVE los "eliminar" a
 *      «_papelera-duplicados/<misma ruta relativa>» (recuperable). Solo mueve si en su grupo queda un "conservar".
 */
import fs from 'fs/promises';
import path from 'path';

import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const RAIZ = args.find((a) => !a.startsWith('--'));
const PLAN_FICHERO = '_plan-duplicados.json';
const PAPELERA = '_papelera-duplicados';
const MAX_COMODIN = 0.25; // los '?' (pérdida de codificación) no pueden ser más del 25% del nombre

const existe = (p) => fs.access(p).then(() => true, () => false);
const tieneRarezas = (n) => /[?�]/.test(n);

// Nombre BASE (sin extensión) normalizado a lo COSMÉTICO. Conserva números, romanos y palabras (para no fusionar
// tomos). Deja '?' como marca de carácter perdido (se compara como comodín en `mismaObra`).
function normBase(base) {
    return base
        .normalize('NFD').replace(/[̀-ͯ]/g, '')   // sin acentos/diacríticos
        .replace(/�/g, '?')                             // carácter de reemplazo � → ?
        .replace(/[–—−]/g, '-')               // – — − → guion normal
        .replace(/[\[{]/g, '(').replace(/[\]}]/g, ')')       // corchetes/llaves → paréntesis (cosmético)
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}
const formatoDe = (nombre) => path.extname(nombre).slice(1).toLowerCase();

// ¿Dos nombres YA normalizados representan la misma obra? Idénticos, o iguales salvo posiciones con '?' (comodín),
// con misma longitud y pocos comodines. Cualquier diferencia en un carácter REAL → false (protege los tomos).
function mismaObra(a, b) {
    if (a === b) return { dup: true, criterio: 'idéntico' };
    if (a.length !== b.length) return { dup: false };
    let comodines = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === '?' || b[i] === '?') { comodines++; continue; } // uno perdió el carácter → comodín
        return { dup: false };                                       // difieren en un carácter real → NO
    }
    if (comodines && comodines <= Math.max(1, Math.floor(a.length * MAX_COMODIN))) return { dup: true, criterio: 'comodín' };
    return { dup: false };
}

// Elige el fichero a CONSERVAR de un grupo: mayor tamaño → nombre limpio (sin ?/�) → más corto → alfabético.
function elegirConservado(archivos) {
    return [...archivos].sort((x, y) =>
        (y.tamano - x.tamano) ||
        ((tieneRarezas(x.nombre) ? 1 : 0) - (tieneRarezas(y.nombre) ? 1 : 0)) ||
        (x.nombre.length - y.nombre.length) ||
        x.nombre.localeCompare(y.nombre),
    )[0];
}

/** Recorre el árbol y, POR CARPETA, agrupa los ficheros del MISMO formato que son la misma obra (≥2 = duplicados). */
async function buscarGrupos(raiz) {
    const grupos = [];
    const rec = async (dir) => {
        let ents;
        try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        // Ficheros directos de esta carpeta (excluye la propia papelera y el plan).
        const ficheros = [];
        for (const e of ents) {
            if (e.isDirectory()) { if (e.name !== PAPELERA) await rec(path.join(dir, e.name)); continue; }
            if (e.name === PLAN_FICHERO) continue;
            const abs = path.join(dir, e.name);
            const st = await fs.stat(abs).catch(() => null);
            if (st) ficheros.push({ nombre: e.name, tamano: st.size, norm: normBase(e.name.slice(0, e.name.length - path.extname(e.name).length)) });
        }
        // Agrupa por formato y, dentro, por «misma obra» (greedy contra el representante del grupo).
        const porFmt = new Map();
        for (const f of ficheros) { const k = formatoDe(f.nombre); (porFmt.get(k) || porFmt.set(k, []).get(k)).push(f); }
        for (const [fmt, arr] of porFmt) {
            const usados = new Array(arr.length).fill(false);
            for (let i = 0; i < arr.length; i++) {
                if (usados[i]) continue;
                const grupo = [arr[i]]; usados[i] = true; let criterio = 'idéntico';
                for (let j = i + 1; j < arr.length; j++) {
                    if (usados[j]) continue;
                    const r = mismaObra(arr[i].norm, arr[j].norm);
                    if (r.dup) { grupo.push(arr[j]); usados[j] = true; if (r.criterio === 'comodín') criterio = 'comodín'; }
                }
                if (grupo.length >= 2) grupos.push({ carpeta: path.relative(raiz, dir) || '.', formato: fmt, criterio, archivos: grupo });
            }
        }
    };
    await rec(raiz);
    return grupos;
}

const humano = (b) => b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';

async function generar(raiz) {
    console.log(`\nDuplicados por nombre — GENERAR PLAN · carpeta: ${raiz}\n`);
    process.stdout.write('Explorando el árbol… ');
    const grupos = await buscarGrupos(raiz);
    process.stdout.write('hecho.\n');
    if (!grupos.length) { console.log('No se han encontrado duplicados por nombre. Nada que planificar.'); process.exit(0); }

    let aEliminar = 0, bytes = 0;
    const plan = { generado: null, raiz, papelera: PAPELERA, criterio: 'conservar el MÁS GRANDE; revisa y edita «accion» antes de --ejecutar', grupos: [] };
    for (const g of grupos) {
        const conservado = elegirConservado(g.archivos);
        const archivos = g.archivos.map((f) => {
            const accion = f === conservado ? 'conservar' : 'eliminar';
            if (accion === 'eliminar') { aEliminar++; bytes += f.tamano; }
            return { nombre: f.nombre, tamano: f.tamano, tamano_h: humano(f.tamano), rareza: tieneRarezas(f.nombre) || undefined, accion, motivo: accion === 'conservar' ? 'el más grande' : undefined };
        });
        plan.grupos.push({ carpeta: g.carpeta, formato: g.formato, criterio: g.criterio, archivos });
    }
    plan.resumen = { grupos: grupos.length, a_eliminar: aEliminar, espacio_a_liberar_h: humano(bytes) };

    const rutaPlan = path.join(raiz, PLAN_FICHERO);
    await fs.writeFile(rutaPlan, JSON.stringify(plan, null, 2), 'utf8');

    // Resumen legible por consola (una muestra; el detalle completo está en el plan).
    console.log(`\nGrupos de duplicados: ${grupos.length} · a eliminar: ${aEliminar} · espacio a liberar: ${humano(bytes)}\n`);
    for (const g of plan.grupos.slice(0, 20)) {
        console.log(`  [${g.formato}] ${g.carpeta}   (${g.criterio})`);
        for (const a of g.archivos) console.log(`     ${a.accion === 'conservar' ? '✔ CONSERVA' : '✖ elimina '} ${a.tamano_h.padStart(8)}  ${a.rareza ? '⚠ ' : '  '}${a.nombre}`);
    }
    if (plan.grupos.length > 20) console.log(`  … y ${plan.grupos.length - 20} grupos más (todos en el plan).`);
    console.log(`\n📄 Plan escrito en: ${rutaPlan}`);
    console.log('   Revísalo/edítalo (campo «accion»: "conservar" | "eliminar") y luego:');
    console.log(`   node scripts/duplicados-por-nombre.js "${raiz}" --ejecutar`);
    process.exit(0);
}

/** Nombre libre en la papelera (sufijo « (2)» si ya existe), sin pisar nada. */
async function rutaLibre(p) {
    const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
    let q = p;
    for (let n = 2; await existe(q); n++) q = path.join(dir, `${base} (${n})${ext}`);
    return q;
}

async function ejecutar(raiz) {
    const rutaPlan = path.join(raiz, PLAN_FICHERO);
    let plan;
    try { plan = JSON.parse(await fs.readFile(rutaPlan, 'utf8')); }
    catch { console.error(`No encuentro/leo el plan «${rutaPlan}». Genera primero el plan (sin --ejecutar).`); process.exit(1); }
    console.log(`\nDuplicados por nombre — EJECUTAR PLAN · ${rutaPlan}\n`);

    let movidos = 0, saltados = 0, bytes = 0;
    for (const g of plan.grupos || []) {
        const carpetaAbs = path.join(raiz, g.carpeta);
        const conservar = (g.archivos || []).filter((a) => a.accion === 'conservar');
        const eliminar = (g.archivos || []).filter((a) => a.accion === 'eliminar');
        // SEGURIDAD: no se toca el grupo si no quedaría al menos un "conservar" existente (no borrar la última copia).
        const hayConservadoVivo = (await Promise.all(conservar.map((a) => existe(path.join(carpetaAbs, a.nombre))))).some(Boolean);
        if (!hayConservadoVivo) { for (const a of eliminar) { saltados++; console.log(`  ⚠ SALTADO (sin copia conservada viva): ${path.join(g.carpeta, a.nombre)}`); } continue; }
        for (const a of eliminar) {
            const src = path.join(carpetaAbs, a.nombre);
            if (!await existe(src)) { continue; } // ya no está (¿movido antes?) → nada que hacer
            const dst = await rutaLibre(path.join(raiz, PAPELERA, g.carpeta, a.nombre)); // papelera conservando estructura
            await fs.mkdir(path.dirname(dst), { recursive: true });
            await fs.rename(src, dst);
            movidos++; bytes += (a.tamano || 0);
            console.log(`  ✖→papelera  ${path.join(g.carpeta, a.nombre)}`);
        }
    }
    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    console.log(`  Movidos a la papelera: ${movidos} · espacio liberado: ${humano(bytes)}${saltados ? ` · saltados: ${saltados}` : ''}`);
    console.log(`  Papelera (recuperable): ${path.join(raiz, PAPELERA)}`);
    process.exit(0);
}

// Se ejecuta solo si se invoca como script (no al importarlo para tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!RAIZ) {
        console.error('Uso: node scripts/duplicados-por-nombre.js "<carpeta>" [--ejecutar]');
        process.exit(1);
    }
    (EJECUTAR ? ejecutar(path.resolve(RAIZ)) : generar(path.resolve(RAIZ))).catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
}

export { normBase, mismaObra, formatoDe, elegirConservado, buscarGrupos };
