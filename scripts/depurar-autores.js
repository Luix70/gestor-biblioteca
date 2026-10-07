/**
 * DEPURAR AUTORES: grafías repetidas de una misma persona y autores-artefacto («[?]_…») en los libros.
 *
 *   1. GRAFÍAS: autores cuyo nombre es el mismo salvo mayúsculas, acentos, puntuación o espacios («Tolkien, J. R. R.»
 *      / «Tolkien, J.R.R.», «Charles H. Anderson» / «Charles H.. Anderson», «René Chartrand» ×5) se funden en uno
 *      (utils/gestion-autores · fusionarAutores: libros y colaboraciones pasan al que se queda; las otras grafías a
 *      sus nombres alternativos). Medido el 7-oct: 642 grupos, 1.301 autores. No toca nombres en otro orden
 *      («J. R. R. Tolkien»): podrían ser dos personas, se funden a mano en Autores.
 *   2. AUTORES-ARTEFACTO en los libros (los marcados «[?]_» por marcar-autores-basura: frases del copyright, cargos,
 *      metadatos del PDF): si el libro tiene además sus autores de verdad, el artefacto se quita; si es el único, se
 *      sustituye por los de la autoridad de su ISBN (Fichero local; con `--online`, también la BNE y OpenLibrary en
 *      línea). Sin sustituto, se deja y va a la selección «Autor artefacto sin sustituto».
 *   3. Los «[?]_» que se quedan sin libros se retiran.
 * Antes de fundir o retirar, cada autor se copia en `autores_retirados`; en cada libro, diario `deshacer[]`.
 * La ingesta ya no los crea (autor-normalizar · depurarAutores; resolver-persona reconoce las grafías).
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/depurar-autores.js                       (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/depurar-autores.js --ejecutar [--online]
 *   … --fases 1,2,3    solo esas fases
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { claveAutor, normalizarAutor, depurarAutores } from '../src/utils/autor-normalizar.js';
import { esAutorArtefacto } from '../src/utils/parsear-nombre.js';
import { fusionarAutores } from '../src/utils/gestion-autores.js';
import { resolverPersona, asegurarClavesAutores } from '../src/utils/resolver-persona.js';
import { buscarAutoridadPorISBN } from '../src/utils/autoridad-isbn.js';
import { buscarPorCriterios } from '../src/utils/buscador-bibliografico.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const ONLINE = args.includes('--online');
const FASES = new Set(String(arg('--fases') || '1,2,3').split(',').map((x) => x.trim()));
const ORIGEN = 'depurar-autores';
const PREFIJO_BASURA = '[?]_';
const SELECCION = 'Autor artefacto sin sustituto';

const db = await conectarDB();
const colAut = db.collection('autores');
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · depurar autores (fases ${[...FASES].join(', ')})\n`);

/** Copia de un autor antes de fundirlo o retirarlo (para poder deshacerlo). */
async function retirarCopia(autor, motivo, extra = {}) {
  const { _id, ...copia } = autor;
  await db.collection('autores_retirados').updateOne({ _id_original: _id }, {
    $setOnInsert: { ...copia, _id_original: _id, retirada: { fecha: new Date(), origen: ORIGEN, motivo, ...extra } },
  }, { upsert: true });
}

// ─── 1. Grafías de una misma persona ──────────────────────────────────────────────────────────────────────
if (FASES.has('1')) {
  const autores = await colAut.find({}, { projection: { nombre: 1, biografia: 1, foto: 1 } }).toArray();
  // Libros por autor (como autor o como colaborador): para elegir el que se queda.
  const usos = new Map();
  for (const f of await bib.aggregate([{ $project: { a: { $setUnion: [{ $ifNull: ['$autores', []] }, { $ifNull: ['$contribuciones.persona', []] }] } } },
    { $unwind: '$a' }, { $group: { _id: '$a', n: { $sum: 1 } } }]).toArray()) usos.set(String(f._id), f.n);
  const grupos = new Map();
  for (const a of autores) {
    if (String(a.nombre || '').startsWith(PREFIJO_BASURA)) continue;
    const k = claveAutor(a.nombre);
    if (k.length < 4) continue;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push({ ...a, n: usos.get(String(a._id)) || 0 });
  }
  const mezcla = (t) => /\p{Ll}/u.test(t) && /\p{Lu}/u.test(t);
  const acentos = (t) => /[À-ſ]/.test(t);
  // Se queda: el de trabajo hecho (biografía/foto), el de más libros, el escrito con mayúsculas y minúsculas y
  // acentos, y con los espacios tras las iniciales («J. R. R.» antes que «J.R.R.»).
  const espacios = (t) => (String(t).match(/\. /g) || []).length;
  const limpio = (t) => normalizarAutor(t).nombre === String(t).trim();   // sin punto final, guion colgando, «..»
  // Entre grafías de UNA persona importa cómo está escrito, más que cuántos libros tenga cada grafía: «René
  // Chartrand» (4) antes que «Rene Chartrand» (16) o «RENÉ CHARTRAND» (12).
  const elegir = (g) => [...g].sort((a, b) => (!!(b.biografia || b.foto) - !!(a.biografia || a.foto))
    || (limpio(b.nombre) - limpio(a.nombre)) || (mezcla(b.nombre) - mezcla(a.nombre)) || (acentos(b.nombre) - acentos(a.nombre))
    || (espacios(b.nombre) - espacios(a.nombre)) || (b.n - a.n))[0];
  const lista = [...grupos.values()].filter((g) => g.length > 1).map((g) => ({ destino: elegir(g), grupo: g }));
  console.log(`1 · Grafías de una misma persona: ${lista.length} grupos · ${lista.reduce((s, x) => s + x.grupo.length - 1, 0)} autores se funden`);
  for (const { destino, grupo } of lista.slice(0, 25)) {
    console.log(`     «${destino.nombre}» (${destino.n}) ← ${grupo.filter((a) => a !== destino).map((a) => `«${a.nombre}» (${a.n})`).join(', ')}`);
  }
  if (EJECUTAR && lista.length) {
    const p = progreso(lista.length, 'Fundiendo grafías');
    for (const { destino, grupo } of lista) {
      p.paso(destino.nombre);
      const otros = grupo.filter((a) => a !== destino);
      for (const a of otros) await retirarCopia(await colAut.findOne({ _id: a._id }) || a, 'grafía de otro', { fundido_en: destino._id });
      const r = await fusionarAutores(db, String(destino._id), otros.map((a) => String(a._id)));
      if (!r.ok) p.nota(`  ⚠ «${destino.nombre}»: ${r.motivo}`);
      await colAut.updateOne({ _id: destino._id }, { $set: { clave: claveAutor(destino.nombre) } });
    }
    p.fin();
  }
  console.log('');
}

// Autores que da la autoridad, limpios: «edited by A, B, and C» → A, B, C; «Various», «AA. VV.» → ninguno.
const RE_VARIOS = /^(?:various|varios|vv\.?\s*aa\.?|aa\.?\s*vv\.?|unknown|anonymous|an[oó]nimo|desconocido)$/i;
const RE_EDITADO_POR = /^(?:edited|ed\.|compiled|selected|translated)\s+(?:and\s+\w+\s+)?by\s+(.+)$/i;
function autoresDeAutoridad(lista) {
  const nombres = [];
  for (const bruto of lista || []) {
    const t = String(bruto || '').trim();
    const m = t.match(RE_EDITADO_POR);
    if (m) nombres.push(...m[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).filter(Boolean));
    else nombres.push(t);
  }
  return depurarAutores(nombres.filter((n) => !RE_VARIOS.test(n)), { esArtefacto: esAutorArtefacto }).autores;
}

// ─── 2. Autores-artefacto en los libros ───────────────────────────────────────────────────────────────────
const sinSustituto = [];
const arreglados = new Set();   // libros a los que la fase 2 les quita el artefacto (para contar bien la fase 3 en seco)
if (FASES.has('2')) {
  await asegurarClavesAutores(db).catch(() => {});
  const basura = await colAut.find({ nombre: { $regex: '^\\[\\?\\]_' } }, { projection: { nombre: 1 } }).toArray();
  const idsBasura = new Set(basura.map((a) => String(a._id)));
  const docs = await bib.find({ autores: { $in: basura.map((a) => a._id) } }, { projection: { titulo: 1, autores: 1, isbn: 1 } }).toArray();
  const cuenta = { quitado: 0, autoridad: 0, sinSustituto: 0 };
  const ejemplos = [];
  const p = progreso(docs.length || 1, 'Libros con autor artefacto');
  for (const d of docs) {
    p.paso(d.titulo);
    const buenos = d.autores.filter((a) => !idsBasura.has(String(a)));
    let nuevos = buenos;
    let via = 'quitado';
    if (!buenos.length) {
      // Sin autor de verdad: los de la autoridad de su ISBN.
      let nombres = [];
      if (d.isbn) {
        const isbns = variantesISBN(d.isbn);
        const aut = await buscarAutoridadPorISBN(isbns, { enLinea: ONLINE }).catch(() => null);
        nombres = autoresDeAutoridad(aut?.autores);
        if (!nombres.length && ONLINE) {
          const ol = await buscarPorCriterios({ isbns, incluirSinopsis: false }).catch(() => null);
          nombres = autoresDeAutoridad(ol?.autores);
        }
      }
      if (!nombres.length) {
        cuenta.sinSustituto++;
        sinSustituto.push(d._id);
        continue;
      }
      via = 'autoridad';
      nuevos = [];
      if (EJECUTAR) {
        for (const n of nombres) {
          const r = await resolverPersona(db, n);
          if (r && !nuevos.some((x) => String(x) === String(r._id))) nuevos.push(r._id);
        }
      }
      if (ejemplos.length < 20) ejemplos.push(`«${d.titulo}» → ${nombres.join('; ')}`);
    }
    cuenta[via]++;
    arreglados.add(String(d._id));
    if (EJECUTAR) {
      await bib.updateOne({ _id: d._id }, {
        $set: { autores: nuevos, fecha_actualizacion: new Date() },
        $push: {
          deshacer: { fecha: new Date(), origen: ORIGEN, antes: { autores: d.autores } },
          alertas_agente: via === 'quitado'
            ? `Autor(es)-artefacto quitado(s): tenía además sus autores de verdad (scripts/${ORIGEN}).`
            : `Autor-artefacto sustituido por los de la autoridad de su ISBN (scripts/${ORIGEN}).`,
        },
      });
      await indexarDoc(db, d._id).catch(() => {});
    }
  }
  p.fin();
  console.log(`2 · Libros con autor artefacto: ${docs.length}`);
  console.log(`     tenían además sus autores de verdad → se quita el artefacto: ${cuenta.quitado}`);
  console.log(`     solo el artefacto → los de la autoridad del ISBN: ${cuenta.autoridad}${ONLINE ? '' : ' (solo el Fichero; --online añade BNE y OpenLibrary)'}`);
  ejemplos.forEach((e) => console.log(`        ${e}`));
  console.log(`     sin sustituto (se deja; a la selección «${SELECCION}»): ${cuenta.sinSustituto}\n`);
  if (EJECUTAR && sinSustituto.length) {
    const ya = await db.collection('selecciones').findOne({ nombre: SELECCION });
    if (ya) await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { docs: sinSustituto, fecha_actualizacion: new Date() } });
    else await crearSeleccion(db, { nombre: SELECCION, descripcion: `Libros cuyo único autor es un artefacto («[?]_…»: una frase del copyright, un cargo, un metadato del PDF) y cuyo ISBN no da autores. Ponerle el autor a mano (scripts/${ORIGEN}).`, docs: sinSustituto });
  }
}

// ─── 3. Los «[?]_» que se quedan sin libros ───────────────────────────────────────────────────────────────
if (FASES.has('3')) {
  const basura = await colAut.find({ nombre: { $regex: '^\\[\\?\\]_' } }).toArray();
  const sinUso = [];
  for (const a of basura) {
    const suyos = await bib.find({ $or: [{ autores: a._id }, { 'contribuciones.persona': a._id }] }, { projection: { _id: 1 } }).toArray();
    // En seco, los libros que la fase 2 arreglaría ya no cuentan.
    const quedan = EJECUTAR ? suyos.length : suyos.filter((d) => !arreglados.has(String(d._id))).length;
    if (quedan === 0) sinUso.push(a);
  }
  console.log(`3 · Autores «[?]_» ${EJECUTAR ? 'sin libros' : 'que quedarían sin libros'} (se retiran): ${sinUso.length} de ${basura.length}`);
  if (EJECUTAR) {
    for (const a of sinUso) {
      await retirarCopia(a, 'artefacto sin libros');
      await colAut.deleteOne({ _id: a._id });
    }
  }
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar (y --online para buscar los autores que falten).');
else console.log('▶ Sidecars: campaña «sidecars».');
process.exit(0);
