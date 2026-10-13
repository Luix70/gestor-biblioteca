/**
 * CORREGIR LA CLASE 2 (RELIGIÓN) QUE PUSO LA TABLA ANTIGUA (13-oct).
 *
 * La tabla determinista Dewey → CDU tenía la clase 2 ANTERIOR a la reorganización: Dewey 220 (Biblia) → «22» y
 * 230 (teología cristiana) → «23». En la CDU de hoy 22 son las religiones del Lejano Oriente y 23 el hinduismo, así
 * que «Biblical criticism» o «Hard sayings of the Bible» estaban entre los libros de hinduismo. Y como lo resuelto
 * por la tabla se guarda en la caché como «Manual» (verificado), la caché lo seguía imponiendo aunque la tabla se
 * corrigiera (clasificador-cdu, 13-oct: 220 → 27, 230 → 27, 290 → 2).
 *
 * Hace dos cosas:
 *   1. corrige en la caché las equivalencias Dewey 22x/23x/29x que guardan el valor viejo (22/23/29);
 *   2. pasa a 27 (o 2) los libros que tienen ese valor viejo por su Dewey 22x/23x/29x. Nunca toca una CDU manual ni
 *      una de la BNE o impresa. Mueve la carpeta por el camino seguro y deja alerta con la de antes.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-cdu-religion.js               (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/corregir-cdu-religion.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEquivalenciaExterna } from '../src/clasificador-cdu.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { rangoFuente, fuenteCduDoc, RANGO_CDU } from '../src/utils/prioridad-cdu.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// Valor viejo de la tabla → familia de Dewey a la que se aplicaba.
const VIEJOS = [
  { de: '22', dewey: /^22\d/ },
  { de: '23', dewey: /^23\d/ },
  { de: '29', dewey: /^29\d/ },
];

const PROYECCION = {
  titulo: 1, cdu: 1, cdu_fuente: 1, dewey: 1, lcc: 1, cdu_manual: 1, locked: 1, ruta_base: 1, portada: 1, imagenes: 1,
  obra: 1, coleccion: 1, ruta_fija: 1, naturaleza: 1, tipo_recurso: 1, isbn: 1, issn: 1, año_edicion: 1,
  mes_publicacion: 1, alertas_agente: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1,
};

async function main() {
  const db = await conectarDB();
  const col = db.collection('biblioteca');
  console.log(`\n✝ Corregir la clase 2 de la tabla antigua — ${EJECUTAR ? '⚠️  EJECUTAR (mueve carpetas)' : 'DRY-RUN (no toca nada)'}\n`);

  // 1) La caché.
  const eqs = await db.collection('equivalencias_cdu').find({ sistema_origen: 'dewey', cdu: { $in: VIEJOS.map((v) => v.de) } }).toArray();
  let cacheCorregidas = 0;
  for (const e of eqs) {
    const v = VIEJOS.find((x) => x.de === e.cdu && x.dewey.test(e.codigo_origen));
    if (!v) continue;
    const tabla = await buscarEquivalenciaExterna('dewey', e.codigo_origen);
    if (!tabla || tabla === e.cdu) continue;
    console.log(`   caché  dewey ${String(e.codigo_origen).padEnd(14)} «${e.cdu}» → «${tabla}»  (${e.usos || 0} usos)`);
    if (EJECUTAR) {
      await db.collection('equivalencias_cdu').updateOne({ _id: e._id },
        { $set: { cdu: tabla, fecha_correccion: new Date(), cdu_anterior: e.cdu } });
    }
    cacheCorregidas++;
  }

  // 2) Los libros.
  const cambios = [];
  const omitidos = {};
  for (const v of VIEJOS) {
    const docs = await col.find({ cdu: v.de, dewey: { $regex: v.dewey.source } }, { projection: PROYECCION }).toArray();
    for (const d of docs) {
      const motivo = d.cdu_manual ? 'CDU fijada a mano' : d.locked ? 'bloqueado'
        : rangoFuente(fuenteCduDoc(d)) > RANGO_CDU.clasificador ? 'CDU de la BNE o impresa' : null;
      if (motivo) { omitidos[motivo] = (omitidos[motivo] || 0) + 1; continue; }
      // Si su LCC dice OTRA clase, el Dewey 22x/23x es el que está mal («Database Marketing» con Dewey 220.6): no se
      // le da 27; lo decidirá la auditoría.
      const porLcc = d.lcc ? await buscarEquivalenciaExterna('lcc', d.lcc) : null;
      if (porLcc && !String(porLcc).startsWith('2')) { omitidos['su LCC dice otra clase (el Dewey es el dudoso)'] = (omitidos['su LCC dice otra clase (el Dewey es el dudoso)'] || 0) + 1; continue; }
      const nueva = await buscarEquivalenciaExterna('dewey', d.dewey);
      if (nueva && nueva !== d.cdu) cambios.push({ doc: d, nueva });
    }
  }
  console.log(`\n   Equivalencias de la caché a corregir: ${cacheCorregidas}`);
  console.log(`   Libros a corregir: ${cambios.length}`);
  for (const [m, n] of Object.entries(omitidos)) console.log(`   No se tocan: ${n} — ${m}`);
  for (const c of cambios.slice(0, 20)) console.log(`     [${c.doc.dewey}] ${String(c.doc.titulo).slice(0, 55)}  «${c.doc.cdu}» → «${c.nueva}»`);

  if (!EJECUTAR) {
    console.log(`\n   → Para aplicarlo: --ejecutar   (${cacheCorregidas} equivalencias, ${cambios.length} libros; mueve sus carpetas)\n`);
    process.exit(0);
  }

  // SALVAGUARDA: solo donde vive el árbol CDU.
  const muestra = cambios.slice(0, 20);
  let vistas = 0;
  for (const c of muestra) if (await carpetaExiste(carpetaDeDoc(c.doc))) vistas++;
  if (muestra.length && vistas < Math.ceil(muestra.length / 2)) {
    console.error(`\n   ❌ Solo ${vistas} de ${muestra.length} carpetas de muestra existen en ESTA máquina: ejecútalo en el NAS.\n`);
    process.exit(1);
  }

  let hechos = 0, movidos = 0, fallos = 0;
  const p = progreso(cambios.length, 'Corrigiendo');
  for (const c of cambios) {
    p.paso(c.doc.titulo);
    try {
      const reub = await reubicarPorCdu(c.doc, c.nueva);
      if (!reub) continue;
      await aplicarCambio(col, c.doc, carpetaDeDoc({ ...c.doc, ...reub.set }), {
        set: reub.set,
        alertas: [`CDU corregida: «${c.doc.cdu}» era la clase 2 ANTIGUA para su Dewey ${c.doc.dewey} → «${c.nueva}» (CDU moderna).`],
      });
      if (reub.set.ruta_base && reub.set.ruta_base !== c.doc.ruta_base) movidos++;
      hechos++;
    } catch (e) {
      fallos++;
      p.nota(`⚠️  ${c.doc._id}: ${e.message}`);
    }
  }
  p.fin();
  console.log(`\n   ✔ Caché: ${cacheCorregidas} · libros corregidos: ${hechos} · carpetas movidas: ${movidos}${fallos ? `  ·  ⚠️  fallos: ${fallos}` : ''}\n`);
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
