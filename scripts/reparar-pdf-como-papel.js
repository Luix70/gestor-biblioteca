/**
 * REPARA los documentos DIGITALES (PDF/EPUB) que un ingest/reproceso marcó por error como «papel»,
 * les explotó las páginas a decenas de JPG y dejó de enlazar el fichero como digital (bug de pérdida
 * de datos, corregido en orquestador.js: la rama esEscaneado ya NO marca papel ni explota). Aquí se
 * REPARA lo ya dañado:
 *   1) Identifica los sospechosos:
 *        A) formatos incluye 'papel' PERO nombre_archivo es un .pdf/.epub  → mal etiquetado.
 *        B) tiene MÁS DE 6 imágenes asociadas y un fichero digital         → bloat de explosión.
 *        C) nombre_archivo es .pdf/.epub pero el fichero NO está en ruta_base → posible pérdida.
 *   2) Comprueba si el fichero original está en la RUTA BASE; si no, lo busca en la PAPELERA.
 *   3) Con --ejecutar: re-etiqueta el formato al digital correcto (pdf/epub → soporte digital),
 *      RECORTA las imágenes a 5+1 = 6 (portada + 5; el resto se RECICLA a la Papelera, recuperable),
 *      restaura el fichero desde la Papelera a la ruta base si faltaba, y corrige la BD.
 *   4) Lista los que NO se puedan reparar (fichero ni en ruta ni en Papelera) para recuperarlos del backup.
 *
 * SEGURO: dry-run por defecto (no escribe nada). --ejecutar aplica. Correr en el NAS (ficheros en el árbol
 * CDU) o local con acceso a Atlas + el árbol. ⚠ BACKUP recomendado antes de --ejecutar.
 *   node scripts/reparar-pdf-como-papel.js               (informe)
 *   node scripts/reparar-pdf-como-papel.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { reciclar } from '../src/utils/papelera.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const MANTENER_IMGS = 6; // 5 + 1 (portada + 5)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_RECICLAJE = resolver(process.env.PATH_RECICLAJE, 'Recycling');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const FORMATO_POR_EXT = { '.pdf': 'pdf', '.epub': 'epub', '.mobi': 'mobi', '.azw': 'mobi', '.azw3': 'mobi', '.djvu': 'djvu' };
const esFicheroDigital = (nombre) => !!FORMATO_POR_EXT[path.extname(String(nombre || '')).toLowerCase()];

// Busca un fichero por nombre dentro de la Papelera (Recycling/**). Devuelve su ruta o null.
async function buscarEnPapelera(nombre) {
    const objetivo = String(nombre || '');
    if (!objetivo) return null;
    async function walk(dir) {
        let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return null; }
        for (const e of ents) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { const r = await walk(p); if (r) return r; }
            else if (e.name === objetivo) return p;
        }
        return null;
    }
    return walk(DIR_RECICLAJE);
}

async function main() {
    console.log(`\nReparación de PDF/EPUB mal marcados como «papel»  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]\n`);
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    // Sospechosos: formatos incluye 'papel' O tiene >6 imágenes O (nombre_archivo digital). Se filtra luego.
    const docs = await bib.find({
        $or: [
            { formatos: 'papel' },
            { 'imagenes.6': { $exists: true } }, // >6 imágenes (índice 6 = la 7.ª)
        ],
    }).toArray();

    const reparados = [], sinCambios = [], restauradosPapelera = [], irrecuperables = [];

    for (const doc of docs) {
        const nombre = doc.nombre_archivo || '';
        const digital = esFicheroDigital(nombre);
        const esPapel = Array.isArray(doc.formatos) && doc.formatos.includes('papel');
        const nImgs = (doc.imagenes || []).length;
        // Solo nos interesan los que TIENEN un fichero digital (pdf/epub/…): un escaneo real (imágenes del
        // usuario, sin fichero) con muchas imágenes es correcto y NO se toca.
        if (!digital) continue;
        // Sospechoso si: mal etiquetado papel, o exceso de imágenes.
        if (!esPapel && nImgs <= MANTENER_IMGS) continue;

        const carpeta = carpetaDeDoc(doc);
        const ficheroRuta = path.join(carpeta, nombre);
        let enRuta = await existe(ficheroRuta);
        const fmtDigital = FORMATO_POR_EXT[path.extname(nombre).toLowerCase()];
        const etiqueta = `«${String(doc.titulo || '').slice(0, 40)}» [${nombre}] · papel=${esPapel} · ${nImgs} img`;

        // Si el fichero NO está en la ruta, buscarlo en la Papelera.
        let origenPapelera = null;
        if (!enRuta) {
            origenPapelera = await buscarEnPapelera(nombre);
            if (!origenPapelera) { irrecuperables.push({ doc, etiqueta }); console.log(`  ✗ IRRECUPERABLE ${etiqueta} — ni en ruta ni en Papelera`); continue; }
        }

        // Plan de reparación.
        const nuevoFormato = [fmtDigital];
        // Imágenes a conservar: las 6 primeras cuyo fichero EXISTA; el resto se recicla.
        const imgs = doc.imagenes || [];
        const conservar = [], sobran = [];
        for (const im of imgs) {
            const f = path.join(carpeta, path.basename(im.ruta || ''));
            if (conservar.length < MANTENER_IMGS && await existe(f)) conservar.push(im);
            else sobran.push({ im, f });
        }
        if (conservar.length) conservar[0] = { ...conservar[0], tipo: 'portada' };
        const nuevaPortada = conservar[0] ? conservar[0].ruta : (doc.portada || null);

        console.log(`  ${EJECUTAR ? '→' : '·'} ${etiqueta}`);
        console.log(`        formato ${JSON.stringify(doc.formatos)} → ${JSON.stringify(nuevoFormato)} · imágenes ${nImgs} → ${conservar.length} (reciclar ${sobran.length})${enRuta ? '' : origenPapelera ? ' · restaurar PDF desde Papelera' : ''}`);

        if (!EJECUTAR) { reparados.push({ doc, etiqueta }); continue; }

        try {
            // 1) Restaurar el fichero desde la Papelera si faltaba.
            if (!enRuta && origenPapelera) {
                await fs.mkdir(carpeta, { recursive: true });
                await fs.copyFile(origenPapelera, ficheroRuta);
                const [o, d] = await Promise.all([fs.stat(origenPapelera), fs.stat(ficheroRuta)]);
                if (o.size !== d.size || d.size === 0) throw new Error('copia del PDF desde Papelera no íntegra');
                enRuta = true; restauradosPapelera.push(etiqueta);
            }
            // 2) Reciclar las imágenes sobrantes (a la Papelera, recuperable).
            if (sobran.length) await reciclar(sobran.map((x) => x.f), 'reparar-pdf-papel');
            // 3) Corregir la BD: formato digital + imágenes recortadas + portada + soporte digital.
            const set = { formatos: nuevoFormato, imagenes: conservar, fecha_actualizacion: new Date() };
            if (nuevaPortada) set.portada = nuevaPortada;
            set.alertas_agente = [...(doc.alertas_agente || []), 'Reparado: PDF/EPUB digital mal marcado como papel; formato y vista previa (6) corregidos.'];
            await bib.updateOne({ _id: doc._id }, { $set: set });
            reparados.push({ doc, etiqueta });
        } catch (e) {
            console.error(`        ✗ error: ${e.message}`);
            irrecuperables.push({ doc, etiqueta: etiqueta + ` (error: ${e.message})` });
        }
    }

    console.log(`\n${'═'.repeat(70)}\nRESUMEN`);
    console.log(`  ${EJECUTAR ? 'Reparados' : 'A reparar'}:            ${reparados.length}`);
    if (restauradosPapelera.length) console.log(`  PDF restaurados de Papelera: ${restauradosPapelera.length}`);
    console.log(`  Irrecuperables (backup):     ${irrecuperables.length}`);
    if (irrecuperables.length) {
        console.log('\n  ── RECUPERAR DEL BACKUP (fichero ni en ruta ni en Papelera) ──');
        for (const x of irrecuperables) console.log(`     · ${x.doc._id}  ${x.etiqueta}`);
    }
    if (!EJECUTAR) console.log('\nDry-run: no se ha escrito nada. Repite con --ejecutar (⚠ BACKUP antes). Las imágenes sobrantes van a la Papelera (recuperables).');
    else console.log('\nHecho. Regenera los sidecars si quieres: node scripts/regenerar-registros.js --ejecutar');
    process.exit(0);
}

main().catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
