// ── RECUPERAR EL TÍTULO ORIGINAL (obras traducidas) ─────────────────────────────────────────────────────
// Backfill SIN IA para lo ya catalogado: abre el EPUB/PDF, lee la PÁGINA DE CRÉDITOS/copyright y extrae el
// «Título original:» (y, en antologías, TODOS los que aparezcan) + un indicio de idioma original. El parser
// es COMPARTIDO con la campaña de mantenimiento (utils/titulo-original.js), así que ambos se comportan igual.
//
// Debe correr donde estén los FICHEROS (el NAS, o local con el árbol CDU montado); los que no encuentre el
// fichero se saltan y se cuentan. La campaña de mantenimiento hace esto MISMO al reposo, de forma continua;
// este script es para forzar una pasada puntual.
//
// DRY-RUN por defecto (no escribe): lista qué título original se pondría a cada libro.
//   node scripts/recuperar-titulo-original.js                 (informe)
//   node scripts/recuperar-titulo-original.js --limite 50     (informe, primeros N libros con fichero)
//   node scripts/recuperar-titulo-original.js --ejecutar       (aplica; BACKUP recomendado)
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { recuperarOriginalesDeFichero } from '../src/utils/titulo-original.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = parseInt((args[args.indexOf('--limite') + 1] || '0'), 10) || 0;

async function main() {
  const db = await conectarDB();
  const bib = db.collection('biblioteca');
  const PROY = { titulo: 1, nombre_archivo: 1, ruta_base: 1, cdu: 1, formatos: 1, isbn: 1, issn: 1, idioma: 1, idioma_original: 1, 'año_edicion': 1, mes_publicacion: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1 };
  // Sacamos PRIMERO todos los _id (consulta rápida que se drena de golpe). Procesar cada libro abre y parsea
  // su fichero (LENTO en el Atom); mantener un cursor abierto durante ese trabajo lo agota en Atlas
  // (CursorNotFound, code 43, a los ~10 min de inactividad). Con los _id en memoria no hay cursor vivo.
  const ids = (await bib.find(
    { tipo_recurso: 'libro', titulo_original: { $exists: false }, formatos: { $in: ['epub', 'pdf'] } },
    { projection: { _id: 1 } },
  ).toArray()).map((d) => d._id);
  console.log(`Candidatos (libros epub/pdf sin título original): ${ids.length}`);

  let nEscaneados = 0, nSinFichero = 0, nConOriginal = 0, nAplicados = 0, nErrores = 0;
  for (const _id of ids) {
    if (LIMITE && nEscaneados >= LIMITE) break;
    const doc = await bib.findOne({ _id }, { projection: PROY });
    if (!doc) continue;
    const ruta = path.join(carpetaDeDoc(doc), doc.nombre_archivo || '');
    let existe = true;
    try { await fs.access(ruta); } catch { existe = false; }
    if (!doc.nombre_archivo || !existe) { nSinFichero++; continue; }
    nEscaneados++;

    let res;
    try { res = await recuperarOriginalesDeFichero(ruta, doc.titulo); }
    catch (e) { nErrores++; continue; }

    if (!res.titulo_original) continue;
    nConOriginal++;
    const etiqueta = res.titulos_originales.length
      ? `[${res.titulos_originales.map((o) => `«${o}»`).join(', ')}]`
      : `«${res.titulo_original}»`;
    console.log(`  «${String(doc.titulo || '').slice(0, 60)}»  →  ${etiqueta}${res.idioma_original ? ` · idioma orig: ${res.idioma_original}` : ''}`);

    if (EJECUTAR) {
      const set = { titulo_original: res.titulo_original, fecha_actualizacion: new Date() };
      if (res.titulos_originales.length) set.titulos_originales = res.titulos_originales;
      // idioma_original solo si es DISTINTO del idioma del documento y aún no lo tiene.
      if (res.idioma_original && res.idioma_original !== doc.idioma && !doc.idioma_original) set.idioma_original = res.idioma_original;
      await bib.updateOne({ _id: doc._id }, { $set: set });
      nAplicados++;
    }
  }

  console.log(`\nLibros escaneados (con fichero): ${nEscaneados}`);
  console.log(`Sin fichero accesible (saltados): ${nSinFichero}`);
  console.log(`Con título original detectado: ${nConOriginal}${nErrores ? ` · errores de lectura: ${nErrores}` : ''}`);
  if (EJECUTAR) console.log(`Aplicados: ${nAplicados}`);
  else console.log('\n(dry-run) No se ha escrito nada. Relanza con --ejecutar para aplicar. ⚠ Haz BACKUP antes.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
