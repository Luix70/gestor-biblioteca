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
//   node scripts/recuperar-titulo-original.js --revisar-existentes [--ejecutar]
//        relee SOLO los que ya tienen «título original» sin idioma original (minutos) y quita los falsos: ver revisarExistentes()
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { recuperarOriginalesDeFichero } from '../src/utils/titulo-original.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = parseInt((args[args.indexOf('--limite') + 1] || '0'), 10) || 0;
const REVISAR_EXISTENTES = args.includes('--revisar-existentes');

// ── --revisar-existentes: los «títulos originales» ya guardados que NO lo son ─────────────────────────────────────
// Antes del 6-oct se guardaba cualquier «Título original:», y ePubLibre lo escribe en TODOS sus libros, también en
// los escritos en español. Relee SOLO los que tienen título original sin idioma original ni traductor (~800, unos
// minutos; no las 7 h de la pasada completa) y quita el falso «título original» cuando, sin rastro de traducción
// junto a la etiqueta:
//   · es el mismo título que el del libro (con o sin subtítulo), o
//   · es basura leída como título («Título», «AÑO», un párrafo, el pie de imprenta).
// NO cambia el título: sin la palabra «traducción» no se sabe si es una traducción (muchas no la llevan cerca:
// «How the West brought war to Ukraine» en un libro en español; «Un billet de loterie», a una letra de «Un billete
// de lotería»), así que lo distinto se queda como estaba. Las traducciones con idioma reconocible ganan su idioma original.
async function revisarExistentes(db) {
  const { textoCreditos, titulosOriginales, hayTraduccionCerca, idiomaOriginalDeTexto } = await import('../src/utils/titulo-original.js');
  const { tituloComparable } = await import('../src/utils/titulo-libro.js');
  const { progreso } = await import('../src/utils/progreso-cli.js');
  const RE_BASURA = /^(?:t[ií]tulo|title|a[ñn]o|autor|author|editorial|isbn)\b|derechos reservados|printed and|impreso/i;
  const bib = db.collection('biblioteca');
  const ORIGEN = 'recuperar-titulo-original';
  const PROY = { titulo: 1, subtitulo: 1, titulo_original: 1, nombre_archivo: 1, ruta_base: 1, cdu: 1, formatos: 1, isbn: 1, issn: 1, idioma: 1, 'año_edicion': 1, mes_publicacion: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1, tipo_recurso: 1 };
  const ids = (await bib.find(
    { titulo_original: { $exists: true }, idioma_original: { $exists: false }, 'titulos_originales.1': { $exists: false }, 'contribuciones.rol': { $ne: 'traductor' } },
    { projection: { _id: 1 } },
  ).toArray()).map((d) => d._id);
  console.log(`Con «título original» y sin idioma original ni traductor: ${ids.length}`);

  // El mismo título: las mismas palabras, o unas empiezan por las otras (subtítulo). Sin tolerar erratas.
  const mismo = (a, b) => {
    const [x, y] = [tituloComparable(a), tituloComparable(b)].sort((m, n) => m.length - n.length);
    return !!x && (x === y || y.startsWith(x + ' '));
  };
  const cuenta = { traduccion: 0, mismo: 0, basura: 0, distinto: 0, sinFichero: 0, sinEtiqueta: 0 };
  const ejemplos = [];
  const prog = progreso(ids.length || 1, 'Releyendo créditos');
  for (const _id of ids) {
    const doc = await bib.findOne({ _id }, { projection: PROY });
    prog.paso(doc?.titulo);
    if (!doc?.nombre_archivo) { cuenta.sinFichero++; continue; }
    const ruta = path.join(carpetaDeDoc(doc), doc.nombre_archivo);
    try { await fs.access(ruta); } catch { cuenta.sinFichero++; continue; }
    const texto = await textoCreditos(ruta);
    const titulos = titulosOriginales(texto, '');
    if (!titulos.length) { cuenta.sinEtiqueta++; continue; }
    const idioma = idiomaOriginalDeTexto(texto);
    if (idioma || hayTraduccionCerca(texto)) {
      cuenta.traduccion++;
      if (EJECUTAR && idioma && idioma !== doc.idioma) await bib.updateOne({ _id }, { $set: { idioma_original: idioma } });
      continue;
    }
    // Se juzga lo GUARDADO (lo que se quitaría), no lo releído: al releer, la línea puede venir con el pie de imprenta
    // pegado («the lost chronicles of the maya kings derechos reservados…»), y lo guardado es una traducción buena.
    const guardado = String(doc.titulo_original);
    const motivo = mismo(guardado, doc.titulo) ? 'mismo' : (RE_BASURA.test(guardado) || guardado.length > 120) ? 'basura' : null;
    if (!motivo) { cuenta.distinto++; continue; }
    cuenta[motivo]++;
    if (ejemplos.length < 25) ejemplos.push(`${motivo === 'mismo' ? 'mismo ' : 'basura'} · «${doc.titulo}» · «${String(doc.titulo_original).slice(0, 80)}»`);
    if (EJECUTAR) {
      // «Destellos de luna» / «Destellos de luna. Pioneros de la ciencia ficción japonesa»: lo que el «original» decía de
      // más es el subtítulo; si el libro no tiene, pasa a serlo (no se pierde nada).
      const set = { fecha_actualizacion: new Date() };
      if (motivo === 'mismo' && !doc.subtitulo && tituloComparable(guardado).length > tituloComparable(doc.titulo).length) {
        const resto = guardado.slice(String(doc.titulo).replace(/[»"']+$/, '').length).replace(/^[\s.:;,–—-]+/, '').trim();
        if (resto && tituloComparable(guardado).endsWith(tituloComparable(resto))) set.subtitulo = resto;
      }
      await bib.updateOne({ _id }, {
        $unset: { titulo_original: '', titulos_originales: '' },
        $set: set,
        $push: { deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo_original: doc.titulo_original, subtitulo: doc.subtitulo ?? null } } },
      });
      await indexarDoc(db, _id).catch(() => {});
    }
  }
  console.log(`\n(${prog.fin()})`);
  ejemplos.forEach((e) => console.log(`   ${e}`));
  console.log(`\nTraducciones (se quedan): ${cuenta.traduccion} · distinto, quizá traducción (se queda): ${cuenta.distinto}`);
  console.log(`Falso «título original» que se quita: ${cuenta.mismo} el mismo título · ${cuenta.basura} basura`);
  console.log(`Sin fichero: ${cuenta.sinFichero} · sin la etiqueta al releer: ${cuenta.sinEtiqueta}`);
  if (!EJECUTAR) console.log('\n(dry-run) No se ha escrito nada. Relanza con --ejecutar para aplicar.');
}

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
  const { progreso } = await import('../src/utils/progreso-cli.js');
  const prog = progreso(LIMITE ? Math.min(LIMITE, ids.length) : ids.length, 'Leyendo créditos');
  for (const _id of ids) {
    if (LIMITE && nEscaneados >= LIMITE) break;
    const doc = await bib.findOne({ _id }, { projection: PROY });
    prog.paso(doc?.titulo);
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
    prog.nota(`  «${String(doc.titulo || '').slice(0, 60)}»  →  ${etiqueta}${res.idioma_original ? ` · idioma orig: ${res.idioma_original}` : ''}`);

    if (EJECUTAR) {
      const set = { titulo_original: res.titulo_original, fecha_actualizacion: new Date() };
      if (res.titulos_originales.length) set.titulos_originales = res.titulos_originales;
      // idioma_original solo si es DISTINTO del idioma del documento y aún no lo tiene.
      if (res.idioma_original && res.idioma_original !== doc.idioma && !doc.idioma_original) set.idioma_original = res.idioma_original;
      await bib.updateOne({ _id: doc._id }, { $set: set });
      await indexarDoc(db, doc._id).catch(() => {}); // refresca el índice FTS (título original ya buscable)
      nAplicados++;
    }
  }

  console.log(`\n(${prog.fin()})`);
  console.log(`Libros escaneados (con fichero): ${nEscaneados}`);
  console.log(`Sin fichero accesible (saltados): ${nSinFichero}`);
  console.log(`Con título original detectado: ${nConOriginal}${nErrores ? ` · errores de lectura: ${nErrores}` : ''}`);
  if (EJECUTAR) console.log(`Aplicados: ${nAplicados}`);
  else console.log('\n(dry-run) No se ha escrito nada. Relanza con --ejecutar para aplicar. ⚠ Haz BACKUP antes.');
}

(REVISAR_EXISTENTES ? conectarDB().then(revisarExistentes) : main()).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
