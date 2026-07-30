/**
 * COMICS A CBZ — para una carpeta dada, recorre sus SUBCARPETAS y allí donde encuentra una con MUCHAS imágenes
 * sueltas (> N, por defecto 10) crea un .cbz (zip STORE, sin recomprimir) con todas ellas, LO NOMBRA como la
 * subcarpeta, lo promueve a la carpeta principal y ELIMINA la subcarpeta de imágenes sueltas.
 *
 * SEGURIDAD (máxima del proyecto: no perder información):
 *   · El cbz se VERIFICA byte a byte (se reabre y se compara cada página con su original) ANTES de borrar nada.
 *     Si la verificación falla, NO se borra el origen y se avisa.
 *   · Solo se borra la subcarpeta si contiene ÚNICAMENTE imágenes (+ basura de sistema: Thumbs.db, .DS_Store…).
 *     Si tiene CUALQUIER otro contenido (ficheros no-imagen o subcarpetas), el cbz se crea igual pero la carpeta
 *     se CONSERVA y se avisa (revísala tú). Así nunca se pierde nada que no esté ya, idéntico, dentro del cbz.
 *   · DRY-RUN por defecto: enseña el plan sin tocar nada. Añade --ejecutar para hacerlo.
 *
 * Recorre en profundidad: una subcarpeta con > N imágenes se trata como un cómic (se empaqueta; no se entra en
 * sus subcarpetas). Las subcarpetas con ≤ N imágenes se siguen explorando hacia dentro. Todos los cbz van a la
 * CARPETA PRINCIPAL (la dada); ante un choque de nombre se añade « (2)», « (3)»… para no pisar ninguno.
 *
 * Uso:
 *   node scripts/comics-a-cbz.js "<carpeta>"                 (DRY-RUN: solo informa)
 *   node scripts/comics-a-cbz.js "<carpeta>" --ejecutar      (crea los cbz y borra las carpetas puras)
 *   node scripts/comics-a-cbz.js "<carpeta>" --min=20 --ejecutar   (umbral distinto)
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import { esImagenArchivo } from '../src/utils/criba-material.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const MIN = Math.max(1, parseInt((args.find((a) => a.startsWith('--min=')) || '').split('=')[1] || '10', 10) || 10);
const RAIZ = args.find((a) => !a.startsWith('--'));
if (!RAIZ) {
    console.error('Uso: node scripts/comics-a-cbz.js "<carpeta>" [--min=10] [--ejecutar]');
    process.exit(1);
}

// Basura de sistema que NO cuenta como «contenido» (se puede borrar con la carpeta sin perder nada real).
const esBasura = (n) => /^(thumbs\.db|desktop\.ini|\.ds_store|\.directory)$/i.test(n) || n.startsWith('.');
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');
// Orden NATURAL (1,2,…,10,11 — no 1,10,11,2), para que las páginas del cómic queden en orden.
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
// Nombre de fichero válido en Windows+Linux (sin caracteres prohibidos ni punto/espacio final).
const sanear = (n) => n.replace(/[/\\:*?"<>|]/g, '_').replace(/[ .]+$/, '').trim() || 'comic';
const existe = (p) => fs.access(p).then(() => true, () => false);

/**
 * Recorre `raiz` y devuelve las SUBCARPETAS que son cómics (> MIN imágenes directas). No entra en las que ya son
 * cómic. Cada candidato: { dir, imagenes:[nombres ordenados], puro:bool } (puro = solo imágenes + basura).
 */
async function buscarCandidatos(raiz) {
    const out = [];
    const rec = async (d) => {
        let ents;
        try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        const imagenes = ents.filter((e) => e.isFile() && esImagenArchivo(e.name) && !esBasura(e.name)).map((e) => e.name);
        if (imagenes.length > MIN) {
            // Puro = ni subcarpetas ni ficheros que no sean imagen/basura → se podrá borrar tras verificar el cbz.
            const puro = !ents.some((e) => e.isDirectory()) &&
                !ents.some((e) => e.isFile() && !esImagenArchivo(e.name) && !esBasura(e.name));
            out.push({ dir: d, imagenes: imagenes.sort(natural), puro });
            return; // es un cómic → no se entra en sus subcarpetas
        }
        for (const e of ents) if (e.isDirectory()) await rec(path.join(d, e.name));
    };
    // Se EXAMINAN LAS SUBCARPETAS de la raíz (la raíz es la carpeta principal, destino de los cbz — no se empaqueta).
    let raizEnts;
    try { raizEnts = await fs.readdir(raiz, { withFileTypes: true }); }
    catch (e) { console.error(`No se puede leer «${raiz}»: ${e.message}`); process.exit(1); }
    for (const e of raizEnts) if (e.isDirectory()) await rec(path.join(raiz, e.name));
    return out;
}

/** Escribe un .cbz (STORE) con las imágenes y lo VERIFICA byte a byte. { ok, paginas } | { ok:false, motivo }. */
async function escribirCbzVerificado(dir, imagenes, destino) {
    const zip = new AdmZip();
    const firmas = new Map();
    for (const nombre of imagenes) {
        let buf;
        try { buf = await fs.readFile(path.join(dir, nombre)); } catch { return { ok: false, motivo: `no se pudo leer «${nombre}»` }; }
        zip.addFile(nombre, buf);
        firmas.set(nombre, sha(buf));
    }
    zip.getEntries().forEach((e) => { e.header.method = 0; }); // 0 = STORED: un JPG ya está comprimido; sin quemar CPU
    zip.writeZip(destino);
    let leido;
    try { leido = new AdmZip(destino); } catch (e) { return { ok: false, motivo: `el cbz no abre: ${e.message}` }; }
    const ents = leido.getEntries();
    if (ents.length !== imagenes.length) return { ok: false, motivo: `faltan páginas: ${ents.length}/${imagenes.length}` };
    for (const e of ents) if (firmas.get(e.entryName) !== sha(e.getData())) return { ok: false, motivo: `«${e.entryName}» no coincide byte a byte` };
    return { ok: true, paginas: ents.length };
}

async function main() {
    const raiz = path.resolve(RAIZ);
    console.log(`\nCómics a CBZ  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]  · carpeta: ${raiz}  · umbral: > ${MIN} imágenes`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se crea ni se borra nada.\n'); else console.log('');

    const candidatos = await buscarCandidatos(raiz);
    if (!candidatos.length) { console.log('No hay subcarpetas con más de ' + MIN + ' imágenes. Nada que hacer.'); process.exit(0); }
    console.log(`Subcarpetas de cómic encontradas: ${candidatos.length}\n`);

    let creados = 0, borradas = 0, conservadas = 0, fallidos = 0;
    for (let i = 0; i < candidatos.length; i++) {
        const c = candidatos[i];
        const nombre = path.basename(c.dir);
        // Destino en la carpeta PRINCIPAL, con el nombre de la subcarpeta y sufijo si ya existe (no pisar ninguno).
        let destino = path.join(raiz, `${sanear(nombre)}.cbz`);
        for (let n = 2; await existe(destino); n++) destino = path.join(raiz, `${sanear(nombre)} (${n}).cbz`);
        const rel = path.relative(raiz, c.dir) || nombre;
        const marca = `[${i + 1}/${candidatos.length}]`;

        if (!EJECUTAR) {
            console.log(`${marca} «${rel}» (${c.imagenes.length} img) → ${path.basename(destino)}` +
                (c.puro ? '  · se borrará la carpeta' : '  · ⚠ carpeta CONSERVADA (tiene contenido no-imagen/subcarpetas)'));
            continue;
        }

        const r = await escribirCbzVerificado(c.dir, c.imagenes, destino);
        if (!r.ok) {
            console.error(`${marca} ✖ «${rel}»: ${r.motivo} — NO se toca la carpeta`);
            fallidos++;
            continue;
        }
        creados++;
        // Borrado SEGURO: el cbz ya está verificado byte a byte (las imágenes están, idénticas, dentro). Solo se
        // borra si la carpeta es PURA (imágenes + basura); si no, se conserva para que la revises.
        if (c.puro) {
            await fs.rm(c.dir, { recursive: true, force: true });
            borradas++;
            console.log(`${marca} ✔ ${path.basename(destino)} (${r.paginas} pág) · carpeta «${rel}» borrada`);
        } else {
            conservadas++;
            console.log(`${marca} ✔ ${path.basename(destino)} (${r.paginas} pág) · ⚠ carpeta «${rel}» CONSERVADA (contenido no-imagen)`);
        }
    }

    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    if (!EJECUTAR) {
        console.log(`  A empaquetar: ${candidatos.length}  (puras que se borrarían: ${candidatos.filter((c) => c.puro).length}, conservadas: ${candidatos.filter((c) => !c.puro).length})`);
        console.log('  (simulación) Nada tocado. Re-ejecuta con --ejecutar.');
    } else {
        console.log(`  CBZ creados: ${creados} · carpetas borradas: ${borradas} · conservadas: ${conservadas} · fallidos: ${fallidos}`);
    }
    process.exit(0);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
