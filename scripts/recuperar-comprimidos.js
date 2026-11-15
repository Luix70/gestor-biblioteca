#!/usr/bin/env node
/**
 * RECUPERAR COMPRIMIDOS — devuelve a PreProceso lo que la Papelera y la Cuarentena se quedaron de los comprimidos, para
 * que se preprocese otra vez con las reglas corregidas el 15-nov (vigilante·expandirComprimidos).
 *
 * Incidente 15-nov:
 *   · SCIENCE.zip (16,7 GB), DIY.zip (52 GB), ANTHOLOGIES.zip (23,9 GB) y NEWS.zip (37,5 GB), SANOS, acabaron en
 *     Cuarentena/ilegibles porque el extractor tenía un tope fijo de 5 minutos; el resto de MAGAZINES pasó al Inbox y
 *     la carpeta se dio por «completa».
 *   · 28 zip/rar/7z de solo imágenes (artbooks: Fate Stay Night Visual Collection…) se abrieron en carpetas de
 *     imágenes sueltas y el original fue a la Papelera, cuando son libros de láminas: van como .cbz/.cbr/.cb7.
 *
 * Regla del usuario: «sé conservador; más vale procesar de nuevo y detectar duplicados que perder datos». Así que:
 *   A) CUARENTENA: cada depósito desde --desde (salvo «duplicados», que volvería a caer allí en bucle) devuelve sus
 *      ficheros a PreProceso, a la MISMA ruta relativa que tenían (PreProceso/… o Inbox/… → PreProceso/…). El depósito
 *      (ya solo su estado.json) va a la Papelera.
 *   B) PAPELERA: cada comprimido reciclado al abrirse («comprimido-expandido») desde --desde vuelve a su sitio en
 *      PreProceso. Casos:
 *        · de solo imágenes y su carpeta abierta SIGUE en PreProceso con los mismos ficheros → vuelve el comprimido
 *          (la próxima pasada lo convierte en cómic) y la carpeta abierta va a la Papelera (es una copia de él);
 *        · de otra cosa y su carpeta abierta SIGUE en PreProceso → no se toca: su contenido está ahí entero;
 *        · su carpeta ya no está (pasó al Inbox / se catalogó) → vuelve igualmente: se reprocesa y lo idéntico se
 *          detecta por hash al catalogar. Lo de solo imágenes puede dar una ficha duplicada (cbz junto al PDF que se
 *          hizo de las imágenes): se listan para revisarlas.
 *   Nada se borra: todo se MUEVE con copia verificada (utils/mover-arbol.js), y nunca se pisa nada (nombre libre).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/recuperar-comprimidos.js                 (en seco: la lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/recuperar-comprimidos.js --ejecutar
 *   … --desde 2026-11-09      desde ese día (por defecto 2026-11-14; el 9-nov hay 1.090 comprimidos ya abiertos)
 *   … --sin-cuarentena | --sin-papelera
 *
 * No toca la base de datos. Mover 130 GB entre montajes tarda (copia + verificación): déjalo correr.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { progreso } from '../src/utils/progreso-cli.js';
import { listarComprimido, ficherosDelListado } from '../src/utils/extraer-archivo.js';
import { esComprimidoDeImagenes, destinoComic } from '../src/utils/comprimido-imagenes.js';
import { escribirGuia } from '../src/utils/guia-ingesta.js';
import { moverArbol, destinoLibre } from '../src/utils/mover-arbol.js';
import { reciclarCarpeta, MANIFIESTO_PAPELERA } from '../src/utils/papelera.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_PRE = resolver(process.env.PATH_PREPROCESO, 'PreProceso');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const DIR_RECICLAJE = resolver(process.env.PATH_RECICLAJE, 'Recycling');
const SIN_RUTA = '_Recuperado';   // si no se sabe de dónde vino

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const DESDE = arg('--desde') || '2026-11-14';
const CON_CUARENTENA = !args.includes('--sin-cuarentena');
const CON_PAPELERA = !args.includes('--sin-papelera');
if (!/^\d{4}-\d{2}-\d{2}$/.test(DESDE)) { console.error('--desde AAAA-MM-DD'); process.exit(1); }

const existe = (p) => fs.access(p).then(() => true, () => false);
const gb = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const tam = (p) => fs.stat(p).then((s) => s.size, () => 0);

/** Ruta original (del contenedor) → su sitio en PreProceso: misma ruta relativa a PreProceso o al Inbox. */
function destinoEnPreproceso(origen) {
    const o = path.resolve(String(origen || ''));
    for (const raiz of [DIR_PRE, DIR_INBOX]) {
        const rel = path.relative(raiz, o);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return path.join(DIR_PRE, rel);
    }
    return path.join(DIR_PRE, SIN_RUTA, path.basename(o));
}

/** Ficheros (rutas relativas POSIX) de un árbol. */
async function ficherosDe(dir, base = '') {
    const out = [];
    for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true }).catch(() => [])) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...await ficherosDe(dir, rel));
        else out.push(rel);
    }
    return out;
}

/** La carpeta en que se abrió `comprimido` (junto a él: «base», «base (2)»…), si sigue ahí. */
async function carpetaAbierta(destino) {
    const dir = path.dirname(destino);
    const base = path.basename(destino).replace(/(\.tar)?\.[^.]+$/i, '').trim();
    // «base» o «base (N)», como los nombra expandirComprimidos cuando ya existe uno.
    const esSuya = (n) => n === base || (n.startsWith(`${base} (`) && /^\d+\)$/.test(n.slice(base.length + 2)));
    const hallados = [];
    for (const n of await fs.readdir(dir).catch(() => [])) {
        if (esSuya(n) && (await fs.stat(path.join(dir, n)).catch(() => null))?.isDirectory()) hallados.push(path.join(dir, n));
    }
    return hallados;
}

/** ¿Esta carpeta es exactamente lo que sale del comprimido? (mismos nombres de fichero, en la misma cantidad) */
function casaConListado(ficheros, entradas) {
    const listados = ficherosDelListado(entradas).map((x) => path.posix.basename(x));
    const enCarpeta = ficheros.map((f) => path.posix.basename(f));
    if (!listados.length || listados.length !== enCarpeta.length) return false;
    const set = new Set(enCarpeta);
    return listados.every((n) => set.has(n));
}

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · recuperar comprimidos de la Papelera y la Cuarentena desde el ${DESDE} → PreProceso\n`);

const acciones = [];   // { tipo, fuente, destino, bytes, nota, carpetaARetirar?, deposito?, subPapelera? }
const omitidos = [];

// ── A) CUARENTENA ──────────────────────────────────────────────────────────────────────────────────────────────
if (CON_CUARENTENA) {
    for (const cat of await fs.readdir(DIR_CUARENTENA, { withFileTypes: true }).catch(() => [])) {
        if (!cat.isDirectory() || cat.name === 'duplicados' || cat.name.startsWith('.')) continue;
        for (const dep of await fs.readdir(path.join(DIR_CUARENTENA, cat.name), { withFileTypes: true }).catch(() => [])) {
            if (!dep.isDirectory()) continue;
            const dirDep = path.join(DIR_CUARENTENA, cat.name, dep.name);
            const estado = await fs.readFile(path.join(dirDep, 'estado.json'), 'utf8').then(JSON.parse, () => null);
            const fecha = String(estado?.fecha || (await fs.stat(dirDep)).mtime.toISOString()).slice(0, 10);
            if (fecha < DESDE) continue;
            const archivos = estado?.archivos?.length ? estado.archivos : (await fs.readdir(dirDep)).filter((n) => n !== 'estado.json' && !n.startsWith('.'));
            archivos.forEach((nombre, i) => acciones.push({
                tipo: `cuarentena/${cat.name}`,
                fuente: path.join(dirDep, nombre),
                destino: destinoEnPreproceso(estado?.rutas_originales?.[i] || nombre),
                nota: estado?.error?.mensaje ? String(estado.error.mensaje).split('\n')[0].slice(0, 120) : '',
                deposito: dirDep,
            }));
        }
    }
}

// ── B) PAPELERA ────────────────────────────────────────────────────────────────────────────────────────────────
if (CON_PAPELERA) {
    const subs = (await fs.readdir(DIR_RECICLAJE, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && /comprimido-expandido/.test(e.name))
        .filter((e) => (/^\d+_(\d{4}-\d{2}-\d{2})_/.exec(e.name)?.[1] || '') >= DESDE);
    const p = progreso(subs.length, 'Mirando la Papelera');
    for (const e of subs) {
        p.paso(e.name);
        const sub = path.join(DIR_RECICLAJE, e.name);
        const man = await fs.readFile(path.join(sub, MANIFIESTO_PAPELERA), 'utf8').then(JSON.parse, () => null);
        for (const it of man?.items || []) {
            if (it.tipo !== 'file') continue;
            const fuente = path.join(sub, it.rel);
            if (!(await existe(fuente))) continue;
            const destino = destinoEnPreproceso(it.origen);
            let entradas = null;
            try { entradas = await listarComprimido(fuente); } catch { /* ilegible: se devuelve igual */ }
            const laminas = entradas && esComprimidoDeImagenes(entradas);
            const abiertas = await carpetaAbierta(destino);
            let casada = null;
            for (const c of abiertas) if (entradas && casaConListado(await ficherosDe(c), entradas)) { casada = c; break; }
            if (casada && !laminas) {
                omitidos.push(`${path.relative(DIR_PRE, destino)}: su contenido sigue entero en «${path.relative(DIR_PRE, casada)}»`);
                continue;
            }
            // Láminas demasiado grandes para un solo cbz: la carpeta abierta ya es lo que haría falta; basta guiarla
            // «empaquetar» (tomos de CBZ_MAX_BYTES). No se mueve nada; el comprimido se queda en la Papelera.
            if (casada && laminas && destinoComic(fuente, await tam(fuente))?.empaquetar) {
                acciones.push({
                    tipo: 'láminas grandes: su carpeta abierta se guía «empaquetar» (tomos cbz)',
                    fuente, destino: casada, guiarEmpaquetar: true,
                    nota: `la carpeta «${path.basename(casada)}» se queda; el comprimido sigue en la Papelera`,
                });
                continue;
            }
            acciones.push({
                tipo: casada ? 'papelera → cómic (y su carpeta abierta a la Papelera)' : (laminas ? 'papelera (láminas; ¿ficha duplicada?)' : 'papelera'),
                fuente, destino, subPapelera: sub, carpetaARetirar: casada,
                nota: casada ? `sustituye a la carpeta «${path.basename(casada)}» (${entradas.length} entradas)` : (abiertas.length ? `hay una carpeta «${path.basename(abiertas[0])}» que NO casa: se conserva` : ''),
            });
        }
    }
    p.fin();
}

for (const a of acciones) a.bytes = await tam(a.fuente);

// ── Informe ────────────────────────────────────────────────────────────────────────────────────────────────────
const porTipo = new Map();
for (const a of acciones) porTipo.set(a.tipo, [...(porTipo.get(a.tipo) || []), a]);
for (const [tipo, lista] of porTipo) {
    console.log(`\n· ${tipo}: ${lista.length} (${gb(lista.reduce((s, a) => s + a.bytes, 0))})`);
    for (const a of lista) console.log(`    ${path.basename(a.fuente)} (${gb(a.bytes)}) → ${path.relative(DIR_PRE, a.destino)}${a.nota ? `\n        ${a.nota}` : ''}`);
}
if (omitidos.length) {
    console.log(`\n· No hace falta devolverlos: ${omitidos.length}`);
    for (const o of omitidos) console.log(`    ${o}`);
}
const total = acciones.reduce((s, a) => s + a.bytes, 0);
console.log(`\nTotal: ${acciones.length} fichero(s), ${gb(total)}.`);

if (!EJECUTAR) {
    console.log('\n(En seco: no se ha movido nada. Repite con --ejecutar.)');
    process.exit(0);
}

// ── Aplicar ────────────────────────────────────────────────────────────────────────────────────────────────────
let hechos = 0, fallos = 0;
const depositos = new Set(), subsPapelera = new Set();
const p2 = progreso(acciones.length, 'Devolviendo');
for (const a of acciones) {
    p2.paso(`${path.basename(a.fuente)} (${gb(a.bytes)})`);
    try {
        if (a.guiarEmpaquetar) {
            await escribirGuia(a.destino, { accion: 'empaquetar', alcance: 'todo', perfil: { origen: 'comprimido' } });
            hechos++;
            p2.nota(`✓ ${path.relative(DIR_PRE, a.destino)}: guiada «empaquetar»`);
            continue;
        }
        const destino = await destinoLibre(a.destino);
        await moverArbol(a.fuente, destino);
        if (a.carpetaARetirar) await reciclarCarpeta(a.carpetaARetirar, 'abierta-sustituida-por-su-comprimido');
        if (a.deposito) depositos.add(a.deposito);
        if (a.subPapelera) subsPapelera.add(a.subPapelera);
        hechos++;
        p2.nota(`✓ ${path.basename(a.fuente)} → ${path.relative(DIR_PRE, destino)}`);
    } catch (e) {
        fallos++;
        p2.nota(`✗ ${path.basename(a.fuente)}: ${e.message} (se queda donde estaba)`);
    }
}
p2.fin();

// Depósitos de Cuarentena ya vacíos (solo su estado.json) → a la Papelera; subcarpetas de la Papelera con solo el
// manifiesto → fuera. Lo que aún tenga algo, se queda.
for (const dep of depositos) {
    const resto = (await fs.readdir(dep).catch(() => [])).filter((n) => n !== 'estado.json');
    if (!resto.length) await reciclarCarpeta(dep, 'cuarentena-devuelta-a-preproceso');
}
for (const sub of subsPapelera) {
    const resto = (await fs.readdir(sub).catch(() => [])).filter((n) => n !== MANIFIESTO_PAPELERA);
    if (!resto.length) await fs.rm(sub, { recursive: true, force: true }).catch(() => {});
}
console.log(`\n✅ ${hechos} devuelto(s) a PreProceso${fallos ? ` · ${fallos} con error (se quedan donde estaban)` : ''}. La próxima pasada de PreProceso los abre (o los convierte en cómic).`);
process.exit(0);
