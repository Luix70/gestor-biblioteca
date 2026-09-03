#!/usr/bin/env node
/**
 * diagnosticar-irreparables.js — Explica, documento a documento, POR QUÉ un recurso está SIN PORTADA y si es
 * recuperable. Solo DIAGNÓSTICO: no escribe nada en la BD ni en disco. Complementa a `reparar-portadas.js`:
 * mientras aquél repara, éste te dice exactamente cuáles de los «irreparables» lo son de verdad y cuáles no.
 *
 * Para cada documento sin portada PRUEBA (en local, sin IA) todas las vías de rescate, EN ORDEN de preferencia:
 *   1) FICHERO rasterizable (PDF/DjVu/cómic) → lo resuelve el flujo normal (aquí no se rasteriza, solo se marca).
 *   2) CUBIERTA EMBEBIDA del propio fichero: EPUB (OPF), MOBI/AZW (EXTH+coverOffset), CHM (imagen del paquete).
 *   3) IMAGEN SUELTA en su carpeta (cover.jpg/folder.jpg…, recursiva).
 *   4) CARÁTULA ID3 de las pistas de audio (audiolibros).
 *   5) PORTADA REMOTA por ISBN (OpenLibrary+Amazon+Google Books) — solo se COMPRUEBA de verdad con --remoto
 *      (hace red); sin la opción se marca «posible» si hay ISBN.
 * Lo que no cae en ninguna vía es IRREPARABLE de verdad, con el motivo concreto (no hay imagen dentro del
 * fichero y su formato no se puede rasterizar, o no hay fichero/ISBN de ningún tipo).
 *
 * ⚠ Debe correr DONDE ESTÁN LOS FICHEROS (el NAS): la BD es Atlas (compartida), pero las comprobaciones de
 * disco (fichero original, imagen suelta, lectores mobi/chm/audio) necesitan el árbol CDU real. En local solo
 * verás «sin fichero» para casi todo. Con `docker exec` AÑADE -t (si no, Node bufferiza y parece colgado):
 *   sudo docker exec -t gestor-biblioteca node scripts/diagnosticar-irreparables.js
 *
 * Uso:
 *   node scripts/diagnosticar-irreparables.js                 (todos los que no tienen portada)
 *   node scripts/diagnosticar-irreparables.js --remoto        (además comprueba de verdad la portada por ISBN)
 *   node scripts/diagnosticar-irreparables.js --id <ObjectId> (un documento)
 *   node scripts/diagnosticar-irreparables.js --informe irrep.txt   (vuelca la lista COMPLETA a un .txt)
 */
import 'dotenv/config';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { detectarTipo } from '../src/orquestador.js';
import { carpetaDeDoc, archivoOriginal } from '../src/mantenimiento/util-mantenimiento.js';
import { extraerMetadatosEpub } from '../src/utils/lector-epub.js';
import { leerMobi } from '../src/utils/lector-mobi.js';
import { leerChm } from '../src/utils/lector-chm.js';
import { leerMetadatosAudio } from '../src/utils/lector-audio.js';
import { bufferPortadaPorISBN } from '../src/utils/portadas-isbn.js';

const REMOTO = process.argv.includes('--remoto');
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const idArg = arg('--id');
const informeArg = arg('--informe');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const absDe = (web) => (web ? path.join(DIR_CDU, ...(web.startsWith('/recursos/') ? web.slice('/recursos/'.length) : web).split('/')) : null);
const existe = (p) => (p ? fs.access(p).then(() => true).catch(() => false) : Promise.resolve(false));

const RE_IMG = /\.(jpe?g|png|webp)$/i;
const RE_NOMBRE_PORTADA = /(cover|folder|front|portada|car[áa]tula|caratula|album)/i;
const RE_NO_PORTADA = /(contra|back|trasera|reverso|spine|lomo)/i;
// ¿Hay alguna imagen suelta aprovechable en la carpeta del documento (recursiva, acotada)? (Igual criterio que
// reparar-portadas.js: descarta miniaturas <8 KB.) Solo nos interesa SI existe, no cuál.
async function hayImagenSuelta(carpeta, nivel = 3) {
    if (!carpeta || nivel < 0) return false;
    let ents;
    try { ents = await fs.readdir(carpeta, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
        if (e.name.startsWith('.') || e.name.startsWith('@')) continue;
        const p = path.join(carpeta, e.name);
        if (e.isDirectory()) { if (await hayImagenSuelta(p, nivel - 1)) return true; continue; }
        if (!RE_IMG.test(e.name) || RE_NO_PORTADA.test(e.name)) continue;
        const st = await fs.stat(p).catch(() => null);
        if (st && st.size >= 8 * 1024) return true;
    }
    return false;
}

// ¿Alguna de las primeras pistas de audio trae carátula ID3 (APIC)? (Igual que reparar: hasta 40 pistas.)
async function hayCaratulaAudio(doc) {
    for (const a of (Array.isArray(doc.audios) ? doc.audios : []).slice(0, 40)) {
        const abs = absDe(a?.ruta);
        if (!abs || !(await existe(abs))) continue;
        const meta = await leerMetadatosAudio(abs).catch(() => null);
        if (meta?.portada?.buffer?.length) return true;
    }
    return false;
}

// Clasifica UN documento sin portada. Devuelve { categoria, via, motivo }.
async function clasificar(doc) {
    const carpeta = carpetaDeDoc(doc);
    const original = await archivoOriginal(carpeta, doc.nombre_archivo).catch(() => null);
    const tipo = original ? detectarTipo(original) : null;

    // 1) Fichero rasterizable → lo resuelve el flujo normal (no rasterizamos aquí, solo lo constatamos).
    if (['pdf', 'djvu', 'comic'].includes(tipo)) return { categoria: 'REPARABLE_RASTER', via: `fichero ${tipo}`, motivo: '' };

    // 2) Cubierta EMBEBIDA del propio fichero (gratis, sin IA).
    if (tipo === 'epub') {
        const cub = (await extraerMetadatosEpub(original).catch(() => ({}))).cubierta_base64;
        if (cub) return { categoria: 'REPARABLE_EMBEBIDA', via: 'cubierta EPUB', motivo: '' };
    } else if (tipo === 'mobi') {
        const m = await leerMobi(original).catch(() => null);
        if (m?.portada?.buf?.length) return { categoria: 'REPARABLE_EMBEBIDA', via: 'cubierta MOBI', motivo: '' };
    } else if (tipo === 'chm') {
        const c = await leerChm(original).catch(() => null);
        if (c?.portada?.buf?.length) return { categoria: 'REPARABLE_EMBEBIDA', via: 'imagen en CHM', motivo: '' };
    }

    // 3) Imagen suelta en la carpeta.
    if (await hayImagenSuelta(carpeta)) return { categoria: 'REPARABLE_SUELTA', via: 'imagen suelta en carpeta', motivo: '' };

    // 4) Carátula ID3 de audio.
    if ((doc.audios || []).length && (await hayCaratulaAudio(doc))) return { categoria: 'REPARABLE_AUDIO', via: 'carátula ID3', motivo: '' };

    // 5) Portada remota por ISBN (solo se COMPRUEBA de verdad con --remoto; hace red).
    if (doc.isbn) {
        if (!REMOTO) return { categoria: 'POSIBLE_REMOTA', via: 'ISBN (sin comprobar; usa --remoto)', motivo: '' };
        const buf = await bufferPortadaPorISBN(doc.isbn).catch(() => null);
        if (buf) return { categoria: 'REPARABLE_REMOTA', via: 'portada remota por ISBN', motivo: '' };
    }

    // Nada funcionó → irreparable de verdad, con el motivo concreto. Se distingue el «software/ISO sin fichero»
    // (nunca tuvo un fichero-documento) del «fichero declarado pero AUSENTE en disco» (ingesta interrumpida o
    // carpeta movida) — son problemas distintos y llevan a arreglos distintos.
    let motivo;
    if (!original && !(doc.audios || []).length) {
        motivo = doc.nombre_archivo
            ? `el fichero «${doc.nombre_archivo}» NO está en disco (¿ingesta interrumpida o carpeta movida?)${doc.isbn ? '' : ', y sin ISBN'}`
            : 'sin fichero-documento (software/ISO catalogado por carpeta) y sin imagen ni ISBN';
    } else if ((doc.audios || []).length) {
        motivo = `${doc.audios.length} pista(s) de audio sin carátula ID3 y sin imagen suelta${doc.isbn ? '' : ' ni ISBN'}`;
    } else {
        motivo = `formato «${tipo}» sin cubierta extraíble (CHM de solo texto, Word/archivo sin imágenes, MOBI con DRM)${doc.isbn ? (REMOTO ? ' y sin portada remota por ISBN' : '') : ' y sin ISBN'}`;
    }
    return { categoria: 'IRREPARABLE', via: '', motivo };
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');
    const filtro = idArg
        ? { _id: new ObjectId(idArg) }
        : { $or: [{ portada: null }, { portada: { $exists: false } }, { portada: '' }] };
    const proj = { titulo: 1, portada: 1, ruta_base: 1, isbn: 1, formatos: 1, nombre_archivo: 1, audios: 1, tipo_recurso: 1 };
    const ids = (await col.find(filtro, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
    console.log(`🔍 ${ids.length} documento(s) sin portada a diagnosticar${REMOTO ? ' (con comprobación remota por ISBN)' : ''}\n`);

    const cats = {};
    const filas = [];   // línea completa por documento (para el informe / detalle)
    let i = 0;
    for (const _id of ids) {
        const doc = await col.findOne({ _id }, { projection: proj });
        if (!doc) continue;
        i++;
        const r = await clasificar(doc);
        cats[r.categoria] = (cats[r.categoria] || 0) + 1;
        const fmt = (doc.formatos || []).join(',') || '(sin fmt)';
        filas.push(`${r.categoria.padEnd(18)} ${doc._id} · [${fmt}] ${doc.isbn ? 'ISBN ' + doc.isbn + ' · ' : ''}${(doc.titulo || '(sin título)').slice(0, 55)}${r.via ? ' — ' + r.via : ''}${r.motivo ? ' — ' + r.motivo : ''}`);
        const pos = `[${String(i).padStart(String(ids.length).length)}/${ids.length}]`;
        process.stdout.write(`${pos} ${r.categoria}${r.via ? ' (' + r.via + ')' : ''} · ${(doc.titulo || '').slice(0, 45)}\n`);
    }

    const orden = ['REPARABLE_RASTER', 'REPARABLE_EMBEBIDA', 'REPARABLE_SUELTA', 'REPARABLE_AUDIO', 'REPARABLE_REMOTA', 'POSIBLE_REMOTA', 'IRREPARABLE'];
    console.log('\n=== RESUMEN ===');
    let recuperables = 0;
    for (const k of orden) {
        if (!cats[k]) continue;
        console.log(`  ${k.padEnd(18)}: ${cats[k]}`);
        if (k.startsWith('REPARABLE')) recuperables += cats[k];
    }
    console.log(`  ${'—'.repeat(30)}`);
    console.log(`  RECUPERABLES (seguros): ${recuperables}`);
    if (cats.POSIBLE_REMOTA) console.log(`  + POSIBLES por ISBN    : ${cats.POSIBLE_REMOTA}  (relanza con --remoto para confirmar)`);
    console.log(`  IRREPARABLES de verdad : ${cats.IRREPARABLE || 0}  (sin ninguna imagen dentro del fichero y sin fuente remota)`);

    if (informeArg) {
        const ruta = path.isAbsolute(informeArg) ? informeArg : path.resolve(process.cwd(), informeArg);
        await fs.writeFile(ruta, filas.join('\n') + '\n', 'utf8');
        console.log(`\n📄 Informe completo escrito en: ${ruta}`);
    } else {
        // Sin --informe, se muestran en consola SOLO los irreparables (que es lo que interesa investigar).
        const irr = filas.filter((f) => f.startsWith('IRREPARABLE'));
        if (irr.length) { console.log('\n--- IRREPARABLES (detalle) ---'); for (const f of irr) console.log('  ' + f); }
    }
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
