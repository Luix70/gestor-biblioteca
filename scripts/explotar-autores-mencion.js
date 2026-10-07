/**
 * EXPLOTAR LOS «AUTORES» QUE SON EN REALIDAD UNA MENCIÓN DE RESPONSABILIDAD: «edited by Christopher Fox, Roy Porter,
 * and Robert Wokler», «Clayton Donnell • Illustrated by H Johnson, L Ray», «Langton, Nancy, Robbins, Stephen…»,
 * «K. Lee Lerner and Brenda Wilmoth Lerner, editors». Cada uno se cambia, en todos sus libros, por las PERSONAS que
 * nombra con su ROL (autor → `autores[]`; editor, ilustrador, prologuista, traductor → `contribuciones[]`), y el
 * registro falso se retira. También los «[?]_» que eran un autor real mal marcado («[?]_Moore, Will H.»): pasan a la
 * persona de verdad. La mención se interpreta con utils/explotar-mencion.js (la misma que usa ya la ingesta); si algún
 * trozo no parece un nombre (cargos, frases, instituciones), no se toca y queda en la lista para hacerlo a mano.
 *
 * Candidatos: los autores «[?]_» y los que, sin marca, nombran a VARIAS personas o un rol («A, B and C», «eds.»).
 * Copia de cada autor retirado en `autores_retirados`; en cada libro, diario `deshacer[]`.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/explotar-autores-mencion.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/explotar-autores-mencion.js --ejecutar
 *   … --solo-marcados     solo los «[?]_»
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { explotarMencion } from '../src/utils/explotar-mencion.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SOLO_MARCADOS = args.includes('--solo-marcados');
const ORIGEN = 'explotar-autores-mencion';
const MARCA = '[?]_';

const db = await conectarDB();
const colAut = db.collection('autores');
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · autores que son una mención con varias personas o roles\n`);

// Candidatos: los marcados y (salvo --solo-marcados) los que tienen pinta de lista o de rol.
const RE_PINTA = /,.*,|\s(?:and|&|with|y)\s|\b(?:edited|illustrated|translated|foreword)\s+by\b|\beds?\.|\beditors?\b|[•·]/i;
const filtro = SOLO_MARCADOS
  ? { nombre: { $regex: '^\\[\\?\\]_' } }
  : { $or: [{ nombre: { $regex: '^\\[\\?\\]_' } }, { nombre: { $regex: RE_PINTA.source, $options: 'i' } }] };
const candidatos = await colAut.find(filtro, { projection: { nombre: 1 } }).toArray();

const aplicar = [];
const aMano = [];
for (const a of candidatos) {
  const marcado = a.nombre.startsWith(MARCA);
  const m = explotarMencion(a.nombre);
  if (!m.fiable) { if (marcado) aMano.push({ a, motivo: m.motivo }); continue; }
  // Sin marca, solo si de verdad nombra a VARIAS personas o un rol (no un «Apellido, Nombre» corriente).
  const cambia = marcado || m.personas.length > 1 || m.personas[0].rol !== 'autor';
  if (!cambia) continue;
  // Sin marca, más exigente: ninguna «persona» de una sola palabra («Leighton Ralph, Gottlieb, A. Michael» →
  // «Gottlieb»). Los marcados ya se sabía que estaban mal; estos no.
  if (!marcado && m.personas.some((p) => p.nombre.trim().split(/\s+/).length < 2)) continue;
  // Una sola persona, mismo nombre y sin marca: nada que hacer.
  if (!marcado && m.personas.length === 1 && m.personas[0].nombre === a.nombre && m.personas[0].rol === 'autor') continue;
  aplicar.push({ a, personas: m.personas });
}

const etiqueta = (p) => `${p.nombre}${p.rol !== 'autor' ? ` [${p.rol}]` : ''}`;
console.log(`Candidatos: ${candidatos.length} · se explotan: ${aplicar.length} · «[?]_» que no se entienden (a mano): ${aMano.length}\n`);
for (const x of aplicar) console.log(`   «${x.a.nombre.replace(MARCA, '[?] ')}»\n       → ${x.personas.map(etiqueta).join(' · ')}`);

if (aMano.length) {
  console.log('\nA mano (no se tocan):');
  for (const x of aMano) console.log(`   «${x.a.nombre.replace(MARCA, '')}» — ${x.motivo}`);
}

let libros = 0;
if (EJECUTAR && aplicar.length) {
  const p = progreso(aplicar.length, 'Explotando');
  for (const { a, personas } of aplicar) {
    p.paso(a.nombre);
    // Las personas, resueltas una vez (la puerta única: reconoce grafías, crea si no existe).
    const resueltas = [];
    for (const persona of personas) {
      const r = await resolverPersona(db, persona.nombre);
      if (r && String(r._id) !== String(a._id)) resueltas.push({ _id: r._id, rol: persona.rol });
    }
    if (!resueltas.length) { p.nota(`  ⚠ «${a.nombre}»: no se pudo resolver a nadie`); continue; }
    const docs = await bib.find({ $or: [{ autores: a._id }, { 'contribuciones.persona': a._id }] }, { projection: { autores: 1, contribuciones: 1 } }).toArray();
    for (const d of docs) {
      const eraAutor = (d.autores || []).some((x) => String(x) === String(a._id));
      const rolesPrevios = (d.contribuciones || []).filter((c) => String(c.persona) === String(a._id)).map((c) => c.rol);
      // autores[]: en su sitio, el registro falso se cambia por las personas con rol «autor».
      const autores = [];
      for (const x of d.autores || []) {
        if (String(x) !== String(a._id)) { if (!autores.some((y) => String(y) === String(x))) autores.push(x); continue; }
        for (const r of resueltas.filter((r) => r.rol === 'autor')) if (!autores.some((y) => String(y) === String(r._id))) autores.push(r._id);
      }
      // contribuciones[]: fuera el falso; dentro los editores/ilustradores… y, si el falso solo era colaborador
      // (no autor), sus «autores» entran con el rol que tenía.
      const contribuciones = (d.contribuciones || []).filter((c) => String(c.persona) !== String(a._id));
      const anadir = (persona, rol) => {
        if (!contribuciones.some((c) => String(c.persona) === String(persona) && c.rol === rol)) contribuciones.push({ persona, rol });
      };
      for (const r of resueltas) {
        if (r.rol !== 'autor') anadir(r._id, r.rol);
        else if (!eraAutor) for (const rol of rolesPrevios) anadir(r._id, rol);
      }
      await bib.updateOne({ _id: d._id }, {
        $set: { autores, contribuciones, fecha_actualizacion: new Date() },
        $push: {
          deshacer: { fecha: new Date(), origen: ORIGEN, antes: { autores: d.autores ?? [], contribuciones: d.contribuciones ?? [] } },
          alertas_agente: `Autor «${a.nombre.replace(MARCA, '')}» → ${personas.map(etiqueta).join('; ')} (scripts/${ORIGEN}).`,
        },
      });
      await indexarDoc(db, d._id).catch(() => {});
      libros++;
    }
    const { _id, ...copia } = await colAut.findOne({ _id: a._id }) || a;
    await db.collection('autores_retirados').updateOne({ _id_original: a._id }, {
      $setOnInsert: { ...copia, _id_original: a._id, retirada: { fecha: new Date(), origen: ORIGEN, personas, libros: docs.map((d) => d._id) } },
    }, { upsert: true });
    await colAut.deleteOne({ _id: a._id });
  }
  p.fin();
}

console.log(`\n=== ${EJECUTAR ? `HECHO · ${aplicar.length} autores explotados · ${libros} libros` : `DRY-RUN · ${aplicar.length} autores se explotarían`} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
process.exit(0);
