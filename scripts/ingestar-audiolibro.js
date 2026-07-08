/**
 * INGESTA DE AUDIOLIBRO (CLI) — cataloga una carpeta de audiolibro puro (o un contenedor con varios) como
 * documentos `naturaleza:'audiolibro'`: playlist de pistas + carrusel con TODAS las imágenes. Identificación
 * barata y sin IA (tags de audio + nombre de carpeta). Ver src/utils/audiolibro.js.
 *
 * Uso:  node scripts/ingestar-audiolibro.js "<carpeta>"              (DRY-RUN: imprime el plan)
 *       node scripts/ingestar-audiolibro.js "<carpeta>" --ejecutar    (cataloga de verdad)
 */
import 'dotenv/config';
import { analizarAudiolibro, ingestarAudiolibro } from '../src/utils/audiolibro.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const dir = args.find((a) => !a.startsWith('--'));

const seg = (s) => (s == null ? '—' : s % 60 === 0 && s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s / 60)}m ${Math.round(s % 60)}s`);

async function main() {
    if (!dir) { console.error('Falta la carpeta. Uso: node scripts/ingestar-audiolibro.js "<carpeta>" [--ejecutar]'); process.exit(1); }

    if (!EJECUTAR) {
        const { unidades } = await analizarAudiolibro(dir);
        if (!unidades.length) { console.log('🔎 No se encontró audio que catalogar en:', dir); return; }
        console.log(`🔎 DRY-RUN · ${unidades.length} audiolibro(s) detectado(s) en «${dir}»\n`);
        for (const u of unidades) {
            const imgs = u.imagenes.reduce((m, im) => ((m[im.clase] = (m[im.clase] || 0) + 1), m), {});
            const imgTxt = Object.entries(imgs).map(([k, v]) => `${v} ${k}`).join(', ') || '—';
            console.log(`📀 «${u.titulo}»`);
            console.log(`   autor:     ${u.autor || '(sin autor)'}${u.autor ? ` [${u.autorFuente || 'carpeta'}]` : ''}${u.coral ? ' · (varios narradores → sin autor de ID3)' : ''}`);
            console.log(`   año:       ${u.anio || '—'}   ·   CDU: ${u.cdu} (deducida)   ·   idioma: ${u.idioma} (deducido)`);
            console.log(`   narrador:  ${u.narrador || '—'}   ·   género: ${u.genero || '—'}`);
            console.log(`   pistas:    ${u.audios.length}   ·   duración total: ${seg(u.duracionTotal)}`);
            console.log(`   imágenes:  ${u.imagenes.length} (${imgTxt})${u.tienePortadaEmbebida ? ' · +carátula embebida' : ''}`);
            console.log(`   portada:   ${u.portadaRel || (u.tienePortadaEmbebida ? '(embebida en el audio)' : '(ninguna)')}`);
            if (u.pdfs.length) console.log(`   PDF texto: ${u.pdfs.join(', ')}`);
            console.log(`   muestra:   ${u.audios.slice(0, 3).map((a) => a.titulo).join('  |  ')}${u.audios.length > 3 ? '  |  …' : ''}`);
            console.log('');
        }
        console.log('(DRY-RUN) Repite con  --ejecutar  para catalogar.');
        return;
    }

    const r = await ingestarAudiolibro(dir, {});
    for (const res of r.resultados || []) {
        console.log(res.ok
            ? `✔ «${res.titulo}» · ${res.audios} pistas · ${res.imagenes} imágenes · ${res.web}${res.origenReciclado ? ' · origen reciclado' : ' · origen CONSERVADO'}`
            : `✗ «${res.titulo}» · ${res.motivo}`);
    }
    if (!r.ok) console.log('No se catalogó ningún audiolibro.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error('Error:', e); process.exit(1); });
