/**
 * Ingesta de una carpeta TRANSMEDIA (una colección con estructura preservada: PDFs + audios + portadas).
 * DRY-RUN por defecto: analiza y muestra el PLAN (colección, CDU deducida, y por cada PDF nivel/unidad/rol/
 * audios) SIN copiar ni escribir nada. Con --ejecutar copia el árbol al CDU y cataloga (⚠ inserta en Atlas).
 *
 *   node scripts/ingestar-transmedia.js "Test Battery/52.Archivos transmedia"
 *   node scripts/ingestar-transmedia.js "Test Battery/52.Archivos transmedia" --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { analizarTransmedia, ingestarTransmedia, esCarpetaTransmedia } from '../src/utils/transmedia.js';
import { conectarDB } from '../src/database.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const dir = args.find((a) => !a.startsWith('--'));

async function main() {
    if (!dir) {
        console.error('Uso: node scripts/ingestar-transmedia.js "<carpeta>" [--ejecutar]');
        process.exit(1);
    }

    const esTrans = await esCarpetaTransmedia(dir);
    console.log(`\nCarpeta:      ${dir}`);
    console.log(`¿Transmedia?  ${esTrans ? 'SÍ (hay audio o marcador .transmedia)' : 'no detectado (sin audio)'}\n`);

    const plan = await analizarTransmedia(dir);
    console.log(`Colección:    «${plan.nombreColeccion}»`);
    console.log(`CDU deducida: ${plan.cdu}  (editable después)   ·   idioma: ${plan.idioma}`);
    console.log(`Totales:      ${plan.totales.pdfs} PDF · ${plan.totales.audios} audios · ${plan.totales.covers} portadas · ${plan.totales.audiolibros} audiolibros\n`);

    const porRol = {}, porNivel = {};
    for (const m of plan.miembros) {
        porRol[m.rol_material] = (porRol[m.rol_material] || 0) + 1;
        const n = m.nivel || '(sin nivel)';
        porNivel[n] = (porNivel[n] || 0) + 1;
    }
    console.log('Por rol_material:', porRol);
    console.log('Por nivel:       ', porNivel);

    console.log('\nMuestra (primeros 14 miembros):');
    for (const m of plan.miembros.slice(0, 14)) {
        console.log(`  [${(m.nivel || '—').padEnd(7)}] ${m.rol_material.padEnd(12)} «${m.titulo.slice(0, 42)}»`
            + `${m.autores.length ? ' · ' + m.autores.join(', ') : ''}${m.audios_rel.length ? ` · 🔊${m.audios_rel.length}` : ''}`);
    }
    if (plan.audiolibros.length) {
        console.log('\nAudiolibros (audio sin PDF de lectura):');
        for (const a of plan.audiolibros.slice(0, 8)) console.log(`  [${(a.nivel || '—').padEnd(7)}] «${a.titulo}» · 🔊${a.audios_rel.length}`);
    }

    if (!EJECUTAR) {
        console.log('\nDRY-RUN: no se ha copiado ni escrito NADA. Repite con --ejecutar para catalogar');
        console.log('(⚠ copia el árbol al CDU e INSERTA documentos en Atlas de producción).');
        process.exit(0);
    }

    console.log('\nEJECUTANDO: copiando el árbol al CDU y catalogando…');
    const r = await ingestarTransmedia(dir, { db: await conectarDB() });
    console.log(r.ok
        ? `✔ «${r.coleccion}» · CDU ${r.cdu} · ${r.insertados} documentos (${r.deduplicados} deduplicados por hash) · ${r.web}`
        : `✗ ${r.motivo}`);
    process.exit(r.ok ? 0 : 1);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
