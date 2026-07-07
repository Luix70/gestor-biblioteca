/**
 * REPARAR TRANSMEDIA — arregla, SIN re-ingerir, las colecciones transmedia ya catalogadas cuyos documentos
 * se insertaron antes de los fixes de presentación. Tres cosas, todas ADITIVAS (nunca borra ni mueve nada):
 *
 *   1) `fecha_ingreso` — se la pone (desde el timestamp del _id) a los miembros que no la tengan, para que
 *      el Catálogo los ordene y los MUESTRE (sin ella caían al final → «no salían en el catálogo»).
 *   2) PORTADA propia — a cada material/guía en PDF (test, ejercicios, solucionario, glosario, guía) le
 *      renderiza SU 1ª página con poppler → deja de heredar —repetida— la `cover.jpg` del lector; y a las
 *      lecturas sin portada también. Las portadas viven en `<colección>/.portadas/` (oculta, ruta_fija).
 *   3) ÍNDICE FTS — reindexa cada miembro para que aparezca en la Búsqueda de texto del panel.
 *
 * Uso:  node scripts/reparar-transmedia.js            (DRY-RUN: solo informa)
 *       node scripts/reparar-transmedia.js --ejecutar  (aplica los cambios)
 */
import 'dotenv/config';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { renderizarPortadaMiembro } from '../src/utils/transmedia.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// Ruta absoluta en disco a partir de una ruta web `/recursos/…` (inversa de `webDe`).
const absDe = (web) => path.join(DIR_CDU, ...String(web || '').replace(/^\/recursos\//, '').split('/').filter(Boolean));

async function main() {
    const db = await conectarDB();
    const cols = await db.collection('colecciones').find({ tipo: 'transmedia' }).toArray();
    if (!cols.length) {
        console.log('No hay colecciones transmedia. Nada que reparar.');
        return;
    }
    console.log(`${EJECUTAR ? '⚙️  EJECUTANDO' : '🔎 DRY-RUN (nada se modifica)'} · ${cols.length} colección(es) transmedia\n`);

    let totFecha = 0, totPortada = 0, totFormato = 0, totIndex = 0;

    for (const col of cols) {
        const carpetaColeccion = absDe(col.raiz_web);
        const webColeccion = col.raiz_web;
        const miembros = await db.collection('biblioteca').find({ coleccion: col._id }).toArray();
        console.log(`📦 «${col.nombre}» · ${miembros.length} miembros · ${webColeccion || '(sin raiz_web)'}`);

        let nFecha = 0, nPortada = 0, nFormato = 0, nIndex = 0;
        for (const doc of miembros) {
            const set = {};

            // 1) fecha_ingreso desde el timestamp del _id (cuándo se insertó).
            if (!doc.fecha_ingreso) { set.fecha_ingreso = doc._id.getTimestamp(); nFecha++; }

            // 2) Portada propia para materiales/guías en PDF, y para lecturas sin portada. (Audiolibros y
            //    otros sin PDF se saltan: no hay página que rasterizar. Y si YA se renderizó en un pase
            //    anterior —portada en «/.portadas/»— no se re-renderiza: el script es re-ejecutable barato.)
            const esPdf = /\.pdf$/i.test(doc.nombre_archivo || '');
            const esLectura = doc.rol_material === 'lectura';
            const yaPropia = /\/\.portadas\//.test(doc.portada || '');
            const necesitaPortada = esPdf && webColeccion && !yaPropia && (!esLectura || !doc.portada);
            if (necesitaPortada) {
                if (EJECUTAR) {
                    const absPdf = path.join(absDe(doc.ruta_base), doc.nombre_archivo);
                    const nueva = await renderizarPortadaMiembro(absPdf, carpetaColeccion, webColeccion, doc._id);
                    if (nueva) { set.portada = nueva; nPortada++; }
                } else {
                    nPortada++; // en dry-run solo se cuenta
                }
            }

            // 2b) formatos: una lectura con audios debe declarar 'audio' junto a 'pdf' (así el thumbnail
            //     avisa de que trae audiolibro; hasta ahora solo se veía como PDF).
            if (doc.audios?.length && Array.isArray(doc.formatos) && doc.formatos.includes('pdf') && !doc.formatos.includes('audio')) {
                set.formatos = [...doc.formatos, 'audio'];
                nFormato++;
            }

            if (Object.keys(set).length && EJECUTAR) {
                await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
            }

            // 3) Reindexar en el FTS (idempotente). Se hace tras el $set para indexar el estado final.
            if (EJECUTAR) { if (await indexarDoc(db, doc._id)) nIndex++; } else { nIndex++; }
        }

        console.log(`   → fecha_ingreso: ${nFecha} · portadas: ${nPortada} · formatos: ${nFormato} · reindexados: ${nIndex}\n`);
        totFecha += nFecha; totPortada += nPortada; totFormato += nFormato; totIndex += nIndex;
    }

    console.log('─'.repeat(60));
    console.log(`Total → fecha_ingreso: ${totFecha} · portadas: ${totPortada} · formatos: ${totFormato} · reindexados: ${totIndex}`);
    if (!EJECUTAR) console.log('\n(DRY-RUN) Repite con  --ejecutar  para aplicar los cambios.');
}

main()
    .then(() => process.exit(0))
    .catch((e) => { console.error('Error:', e); process.exit(1); });
