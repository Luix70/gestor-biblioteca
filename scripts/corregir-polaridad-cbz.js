#!/usr/bin/env node
/**
 * CORRIGE LA POLARIDAD (negativo) DE LAS LÁMINAS BITONALES QUE YA ESTÁN DENTRO DE UN CBZ.
 *
 * Los cbz empaquetados antes del arreglo llevan las láminas en NEGATIVO: `pdfimages` vuelca la imagen tal como
 * está guardada en el PDF y, en un stencil (ImageMask), eso sale invertido. Ver `src/utils/png-polaridad.js`.
 *
 * Lo importante: NO hay que volver a convertir los PDF originales (horas de trabajo). Los PNG que hay dentro
 * del cbz son exactamente los que produjo `pdfimages`, así que se corrigen ahí mismo. Y la corrección no
 * recomprime: solo reescribe la cabecera del PNG y le mete una paleta invertida, con los datos intactos. Por
 * eso esto tarda minutos y no horas.
 *
 *   node scripts/corregir-polaridad-cbz.js <ruta.cbz | carpeta> [más rutas…] [--ejecutar]
 *
 * Por DEFECTO es dry-run: dice qué haría y no toca nada. Con `--ejecutar` reescribe cada cbz, y solo después
 * de VERIFICARLO página a página (si la verificación falla, se restaura el original y no se pierde nada).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import crypto from 'node:crypto';
import { corregirPolaridadBuffer } from '../src/utils/png-polaridad.js';

const escribir = (s = '') => process.stdout.write(s + '\n');   // NO console.log: consola-timestamp lo silenciaría
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const rutas = args.filter((a) => !a.startsWith('--'));

if (!rutas.length) {
    escribir('\nUso: node scripts/corregir-polaridad-cbz.js <ruta.cbz | carpeta> [...] [--ejecutar]\n');
    process.exit(1);
}

/** Todos los .cbz de una ruta (fichero suelto o carpeta, recursiva). */
async function buscarCbz(ruta, nivel = 6) {
    const st = await fs.stat(ruta).catch(() => null);
    if (!st) return [];
    if (st.isFile()) return /\.cbz$/i.test(ruta) ? [ruta] : [];
    if (nivel < 0) return [];
    const out = [];
    for (const e of await fs.readdir(ruta, { withFileTypes: true }).catch(() => [])) {
        out.push(...await buscarCbz(path.join(ruta, e.name), nivel - 1));
    }
    return out.sort();
}

const cbzs = [];
for (const r of rutas) cbzs.push(...await buscarCbz(path.resolve(r)));

if (!cbzs.length) { escribir('\nNo se ha encontrado ningún .cbz en esas rutas.\n'); process.exit(1); }

escribir(`\n${EJECUTAR ? '⚙️  EJECUTAR' : '🔍 DRY-RUN'} · ${cbzs.length} cbz\n`);

let totalPag = 0, totalCorr = 0, tocados = 0, fallos = 0;

for (const ruta of cbzs) {
    let zip;
    try { zip = new AdmZip(ruta); } catch (e) { escribir(`  ✖ ${path.basename(ruta)}: no abre (${e.message})`); fallos++; continue; }

    const entradas = zip.getEntries().filter((e) => !e.isDirectory);
    const nuevos = new Map();     // nombre → buffer corregido
    for (const e of entradas) {
        if (!/\.png$/i.test(e.entryName)) continue;
        let corregido = null;
        try { corregido = corregirPolaridadBuffer(e.getData()); } catch { /* una página rara no tumba el resto */ }
        if (corregido) nuevos.set(e.entryName, corregido);
    }
    totalPag += entradas.length;
    totalCorr += nuevos.size;

    const marca = nuevos.size ? '↺' : '·';
    escribir(`  ${marca} ${path.basename(ruta)}: ${entradas.length} página(s), ${nuevos.size} en negativo`);
    if (!nuevos.size || !EJECUTAR) continue;

    // Reescritura: mismas entradas y mismo ORDEN (el orden ES la paginación), cambiando solo las corregidas.
    const salida = new AdmZip();
    const firmas = new Map();
    for (const e of entradas) {
        const buf = nuevos.get(e.entryName) || e.getData();
        salida.addFile(e.entryName, buf);
        firmas.set(e.entryName, sha(buf));
    }
    salida.getEntries().forEach((e) => { e.header.method = 0; });   // 0 = STORED, como el empaquetador

    // Se escribe a un temporal y solo se sustituye el bueno si la verificación pasa: si algo va mal, el cbz
    // original sigue intacto. Es la misma política que en el empaquetado.
    const tmp = ruta + '.nuevo';
    try {
        salida.writeZip(tmp);
        const leido = new AdmZip(tmp);
        const ents = leido.getEntries().filter((e) => !e.isDirectory);
        if (ents.length !== entradas.length) throw new Error(`faltan páginas: ${ents.length}/${entradas.length}`);
        for (const e of ents) {
            if (firmas.get(e.entryName) !== sha(e.getData())) throw new Error(`«${e.entryName}» no coincide byte a byte`);
        }
        await fs.rename(tmp, ruta);
        tocados++;
    } catch (e) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        escribir(`      ✖ NO se ha tocado: la verificación falló (${e.message})`);
        fallos++;
    }
}

escribir(`\n${'─'.repeat(70)}`);
escribir(`  ${cbzs.length} cbz · ${totalPag} páginas · ${totalCorr} en negativo` + (fallos ? ` · ${fallos} con problemas` : ''));
if (!EJECUTAR) escribir('\n  (DRY-RUN) No se ha tocado nada. Repite con --ejecutar para corregirlos.\n');
else escribir(`\n  ${tocados} cbz reescritos y verificados página a página.\n`);
process.exit(fallos ? 1 : 0);
