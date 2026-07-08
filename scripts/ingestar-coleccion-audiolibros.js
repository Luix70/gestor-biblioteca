/**
 * INGESTA DE COLECCIÓN DE AUDIOLIBROS (CLI). De momento SOLO dry-run: imprime el plan (colección → libros →
 * apartados/discos + PDFs). El --ejecutar se añade tras validar el parseo. Ver src/utils/coleccion-audiolibros.js.
 *
 * Uso:  node scripts/ingestar-coleccion-audiolibros.js "<carpeta>"
 */
import 'dotenv/config';
import { analizarColeccionAudiolibros } from '../src/utils/coleccion-audiolibros.js';

const seg = (s) => (s == null ? '—' : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));

async function main() {
    if (!dir) { console.error('Falta la carpeta.'); process.exit(1); }
    const { colecciones } = await analizarColeccionAudiolibros(dir);
    console.log(`🔎 DRY-RUN · ${colecciones.length} colección(es) detectada(s)\n`);
    for (const c of colecciones) {
        console.log(`══ Colección «${c.nombre}» → ${c.totales.audiolibros} audiolibro(s) + ${c.totales.pdfs} PDF(s) ══`);
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
        }
        console.log('');
    }
}

main().then(() => process.exit(0)).catch((e) => { console.error('Error:', e); process.exit(1); });
