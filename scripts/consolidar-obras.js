// ── CONSOLIDAR OBRAS MULTIVOLUMEN EN UNA SOLA CARPETA ───────────────────────────────────────────────────
// Todos los tomos de una misma obra deben vivir JUNTOS en /CDU/<cdu>/obras/<TÍTULO de la obra>/vol-N/. Por un
// bug (la carpeta se derivaba de campos del TOMO — isbn_obra|título|id —, no del registro de obra), un tomo
// añadido después podía caer en OTRA carpeta (otro nombre o incluso otra CDU). Este script REVISA las obras
// existentes y REUBICA cada tomo disperso a la carpeta canónica de su obra:
//   · CDU canónica = la de la obra (obras.cdu); si falta, la más común entre sus tomos (y se fija en la obra).
//   · Nombre de carpeta = el isbn_obra de la obra si lo tiene; si no, su título canónico (obras.titulo).
//   · Hoja = vol-<volumen_numero> (o vol-x si no consta); si dos tomos colisionaran en la misma hoja, el
//     segundo lleva un sufijo del _id (1 doc ↔ 1 carpeta), igual que en la ingesta.
// Mueve la carpeta con verificación (fs.rename atómico si es el mismo volumen; si no, copia+verifica) y
// actualiza en la BD ruta_base, portada, imagenes[].ruta, cdu y obra_titulo (canónico). NO borra documentos.
//
// DRY-RUN por defecto (no toca disco ni BD): informa qué se reubicaría.
//   node scripts/consolidar-obras.js            (informe)
//   node scripts/consolidar-obras.js --ejecutar  (aplica; BACKUP recomendado)
import 'dotenv/config';
import '../src/config.js';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { rutaCatalogo } from '../src/utils/rutas.js';
import { carpetaDeDoc, webDeDoc, moverCarpetaConVerificacion, carpetaExiste, DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// Ruta canónica de un tomo dentro de su obra (opcional discriminador para deshacer colisiones de vol).
function rutaTomo(doc, obra, cduCanon, discriminador) {
  return rutaCatalogo({
    cdu: cduCanon,
    tipo_recurso: doc.tipo_recurso || 'libro',
    id: doc._id,
    titulo: doc.titulo,
    obra: obra.isbn_obra || obra.titulo, // carpeta por isbn_obra si la obra lo tiene; si no, por título
    volumen_numero: doc.volumen_numero,
    discriminador,
  });
}

async function main() {
  const db = await conectarDB();
  const bib = db.collection('biblioteca');
  const colObras = db.collection('obras');
  const obras = await colObras.find({}).toArray();

  let nObras = 0, nDispersas = 0, nMovidos = 0, nYaOk = 0, nSoloBD = 0, nColision = 0, nErrores = 0, nCduFijada = 0;

  for (const obra of obras) {
    if (!obra.titulo) continue;
    const vols = await bib.find({ obra: obra._id }).toArray();
    if (!vols.length) continue;
    nObras++;

    // CDU canónica: la de la obra o, si falta, la más común entre sus tomos.
    let cduCanon = obra.cdu || '';
    if (!cduCanon) {
      const freq = {};
      for (const d of vols) if (d.cdu) freq[d.cdu] = (freq[d.cdu] || 0) + 1;
      cduCanon = Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0] || '';
      if (cduCanon && EJECUTAR) { await colObras.updateOne({ _id: obra._id }, { $set: { cdu: cduCanon } }); nCduFijada++; }
    }

    // ¿Están todos en la MISMA carpeta base de obra? (para el recuento de «dispersas»).
    const basesObra = new Set(vols.map((d) => path.dirname(carpetaDeDoc(d)))); // .../obras/<algo>
    const dispersa = basesObra.size > 1;
    if (dispersa) nDispersas++;

    const ocupadas = new Set(); // rutas destino ya reclamadas en ESTA obra (para el discriminador)
    for (const doc of vols) {
      try {
        // Destino canónico; si ya lo reclamó otro tomo (mismo vol / ambos sin número), añade discriminador.
        let rc = rutaTomo(doc, obra, cduCanon);
        if (ocupadas.has(rc.relativa)) rc = rutaTomo(doc, obra, cduCanon, String(doc._id).slice(-6));
        ocupadas.add(rc.relativa);

        const destino = path.join(DIR_CDU, rc.relativa);
        const actual = carpetaDeDoc(doc);
        if (destino === actual) { nYaOk++; continue; }

        console.log(`  «${String(obra.titulo).slice(0, 40)}» vol ${doc.volumen_numero ?? '?'}:`);
        console.log(`      de  ${webDeDoc(doc)}`);
        console.log(`      a   ${rc.web}`);

        if (!EJECUTAR) { nMovidos++; continue; }

        // Preparar el $set (ruta_base + remap de portada/imagenes + cdu + obra_titulo canónico).
        const rutaBaseVieja = webDeDoc(doc);
        const remap = (p) => (p && p.startsWith(rutaBaseVieja) ? rc.web + p.slice(rutaBaseVieja.length) : p);
        const set = { ruta_base: rc.web, obra_titulo: obra.titulo };
        if (obra.isbn_obra) set.isbn_obra = obra.isbn_obra; // canónico (mismo en todos los tomos)
        if (cduCanon) set.cdu = cduCanon;
        if (doc.portada) set.portada = remap(doc.portada);
        if (doc.imagenes?.length) set.imagenes = doc.imagenes.map((im) => ({ ...im, ruta: remap(im.ruta) }));

        const existeVieja = await carpetaExiste(actual);
        if (!existeVieja) { // sin carpeta en disco → solo BD
          await bib.updateOne({ _id: doc._id }, { $set: set });
          nSoloBD++; console.log('      · sin carpeta en disco → solo BD');
          continue;
        }
        if (await carpetaExiste(destino)) { // el destino ya existe (otro doc) → no pisar
          nColision++; console.log('      · ⚠️ destino ya existe — NO se mueve (revisar a mano)');
          continue;
        }
        const archivosEnBD = [doc.portada ? path.basename(doc.portada) : null, ...(doc.imagenes || []).map((im) => path.basename(im.ruta))].filter(Boolean);
        await moverCarpetaConVerificacion(actual, destino, archivosEnBD);
        await bib.updateOne({ _id: doc._id }, { $set: set });
        nMovidos++;
      } catch (e) { nErrores++; console.warn(`      ⚠️ error: ${e.message}`); }
    }
  }

  console.log(`\nObras con tomos: ${nObras} · dispersas (tomos en >1 carpeta): ${nDispersas}`);
  console.log(`Tomos ${EJECUTAR ? 'movidos' : 'que se moverían'}: ${nMovidos} · ya correctos: ${nYaOk}`);
  if (EJECUTAR) console.log(`Solo BD (sin carpeta): ${nSoloBD} · colisiones no movidas: ${nColision} · CDU fijadas en obra: ${nCduFijada} · errores: ${nErrores}`);
  else console.log('\n(dry-run) No se ha tocado nada. Relanza con --ejecutar para aplicar. ⚠ Haz BACKUP antes.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
