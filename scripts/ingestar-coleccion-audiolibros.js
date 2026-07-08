/**
 * INGESTA DE COLECCIÓN DE AUDIOLIBROS (CLI). Cataloga una carpeta con varios audiolibros como una (o varias)
 * colección: un audiolibro por libro (playlist por apartado/disco) + un doc por PDF + un doc por VÍDEO
 * (descargable) + manifiesto de lo no catalogado. Ver src/utils/coleccion-audiolibros.js.
 *
 * Uso:  node scripts/ingestar-coleccion-audiolibros.js "<carpeta>"             (DRY-RUN: imprime el plan)
 *       node scripts/ingestar-coleccion-audiolibros.js "<carpeta>" --ejecutar   (cataloga)
 */
import 'dotenv/config';
import { analizarColeccionAudiolibros, ingestarColeccionAudiolibros } from '../src/utils/coleccion-audiolibros.js';

const seg = (s) => (s == null ? '—' : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const dir = args.find((a) => !a.startsWith('--'));

async function main() {
    if (!dir) { console.error('Falta la carpeta.'); process.exit(1); }

    if (EJECUTAR) {
        const r = await ingestarColeccionAudiolibros(dir, {});
        for (const res of r.resultados || []) {
            console.log(res.ok
                ? `✔ «${res.coleccion}» · ${res.insertados} miembro(s)${res.videos ? ` (incl. ${res.videos} vídeo/s)` : ''}${res.sinCatalogar ? ` · ${res.sinCatalogar} sin catalogar (en _contenido.txt)` : ''} · ${res.web}${res.reciclado ? ' · origen reciclado' : ' · origen CONSERVADO'}`
                : `✗ «${res.coleccion}» · ${res.motivo}`);
        }
        if (!r.ok) console.log('No se catalogó ninguna colección.');
        return;
    }

    const { colecciones } = await analizarColeccionAudiolibros(dir);
    console.log(`🔎 DRY-RUN · ${colecciones.length} colección(es) detectada(s)\n`);
    for (const c of colecciones) {
        console.log(`══ Colección «${c.nombre}» → ${c.totales.audiolibros} audiolibro(s) + ${c.totales.pdfs} PDF(s) + ${c.totales.videos} vídeo(s)${c.totales.otros ? ` · ${c.totales.otros} sin catalogar (irán al manifiesto)` : ''} ══`);
        for (const l of c.miembros) {
            const a = l.audiolibro;
            if (a) {
                const grupos = [...new Set(a.audios.map((x) => x.grupo).filter(Boolean))];
                console.log(`  📀 ${a.titulo}`);
                console.log(`     autor: ${a.autor || (a.coral ? '(coral)' : '(sin autor)')}  ·  ${a.anio || '—'}  ·  CDU ${a.cdu}  ·  ${a.idioma}${a.isbn ? `  ·  ISBN ${a.isbn}${a.ficheroHit ? ' ✓Fichero' : ''}` : ''}`);
                console.log(`     ${a.audios.length} pistas · ${seg(a.duracionTotal)}${grupos.length ? `  ·  apartados: ${grupos.join(' | ')}` : ''}`);
            } else {
                console.log(`  📁 ${l.nombre}  (sin audio)`);
            }
            for (const p of l.pdfs) console.log(`     📄 PDF: ${p.titulo}`);
            for (const v of l.videos) console.log(`     🎬 VÍDEO: ${v.titulo} (.${v.ext})`);
            for (const o of l.otros) console.log(`     ⚠️  sin catalogar (al manifiesto): ${o}`);
        }
        console.log('');
    }
    console.log('(DRY-RUN) Repite con  --ejecutar  para catalogar.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('Error:', e); process.exit(1); });
