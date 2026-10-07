/**
 * LIMPIAR TÍTULOS: la mención de responsabilidad pegada y las MAYÚSCULAS sostenidas (utils/titulos.js, lo mismo que
 * aplica ya la ingesta).
 *
 *   1. MENCIÓN: «DICTIONARY OF SCIENCE; ED. BY JOHN DAINTITH.» → título «Dictionary of Science» + John Daintith
 *      (editor); «La isla del tesoro (il. N. C. Wyeth; trad. Francisco Torres Oliver)» → ilustrador y traductor;
 *      «…, by Mary L. Boas» → autora. Solo si TODA la cola son nombres (explotar-mencion); las personas se AÑADEN si
 *      no estaban (autor → autores[]; el resto → contribuciones[] con su rol). Medido 8-oct: 91 títulos.
 *   2. MAYÚSCULAS: «THE CAMBRIDGE ENCYCLOPEDIA OF THE ENGLISH LANGUAGE» → el título del Fichero para su ISBN si dice
 *      lo mismo (trae la grafía buena, con acentos), o Title Case cuidadoso (números romanos en mayúscula). También
 *      el subtítulo. Medido 8-oct: 856 títulos.
 * Los números de revista no se tocan (su título se compone con la cabecera). Diario `deshacer[]`; solo base de datos.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/limpiar-titulos-mencion.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/limpiar-titulos-mencion.js --ejecutar
 *   … --solo-mencion | --solo-mayusculas
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { separarMencionDelTitulo, capitalizarTitulo, tituloEnMayusculas } from '../src/utils/titulos.js';
import { explotarMencion } from '../src/utils/explotar-mencion.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const MENCION = !args.includes('--solo-mayusculas');
const MAYUSCULAS = !args.includes('--solo-mencion');
const ORIGEN = 'limpiar-titulos-mencion';

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · títulos con mención pegada o en mayúsculas\n`);

const filtro = { tipo_recurso: { $ne: 'revista' } };
const total = await bib.countDocuments(filtro);
const p = progreso(total, 'Revisando títulos');
const cuenta = { mencion: 0, autoridad: 0, titleCase: 0, subtitulo: 0 };
const ejemplos = { mencion: [], autoridad: [], titleCase: [] };
const apunta = (clase, texto) => { if (ejemplos[clase].length < 40) ejemplos[clase].push(texto); };

for await (const d of bib.find(filtro, { projection: { titulo: 1, subtitulo: 1, isbn: 1, autores: 1, contribuciones: 1 } })) {
  p.paso(d.titulo);
  const set = {};
  let titulo = d.titulo;
  let personas = [];

  // 1. Mención pegada.
  if (MENCION) {
    const sep = separarMencionDelTitulo(titulo, explotarMencion);
    if (sep) {
      titulo = sep.titulo;
      personas = sep.personas;
      cuenta.mencion++;
      apunta('mencion', `«${d.titulo}» → «${sep.titulo}» + ${sep.personas.map((x) => `${x.nombre} [${x.rol}]`).join(' · ')}`);
    }
  }

  // 2. Mayúsculas: el del Fichero si dice lo mismo; si no, Title Case.
  if (MAYUSCULAS && (tituloEnMayusculas(titulo) || tituloEnMayusculas(d.subtitulo))) {
    let aut = null;
    if (d.isbn) aut = await buscarEnFicheroLocal({ isbns: variantesISBN(d.isbn) }).catch(() => null);
    const capT = capitalizarTitulo(titulo, { autoridad: aut?.titulo });
    if (capT) {
      const deAutoridad = aut?.titulo && capT === String(aut.titulo).trim();
      cuenta[deAutoridad ? 'autoridad' : 'titleCase']++;
      apunta(deAutoridad ? 'autoridad' : 'titleCase', `«${titulo}» → «${capT}»`);
      titulo = capT;
    }
    const capS = capitalizarTitulo(d.subtitulo, { autoridad: aut?.subtitulo });
    if (capS) { set.subtitulo = capS; cuenta.subtitulo++; }
  }
  if (titulo !== d.titulo) set.titulo = titulo;
  if (!Object.keys(set).length) continue;
  if (!EJECUTAR) continue;

  // Las personas de la mención: se añaden las que falten (autor → autores[]; el resto → contribuciones[]).
  const autores = [...(d.autores || [])];
  const contribuciones = [...(d.contribuciones || [])];
  for (const persona of personas) {
    const r = await resolverPersona(db, persona.nombre);
    if (!r) continue;
    if (persona.rol === 'autor') {
      if (!autores.some((a) => String(a) === String(r._id))) autores.push(r._id);
    } else if (!contribuciones.some((c) => String(c.persona) === String(r._id) && c.rol === persona.rol)) {
      contribuciones.push({ persona: r._id, rol: persona.rol });
    }
  }
  if (personas.length) { set.autores = autores; set.contribuciones = contribuciones; }
  set.fecha_actualizacion = new Date();
  await bib.updateOne({ _id: d._id }, {
    $set: set,
    $push: {
      deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo: d.titulo, subtitulo: d.subtitulo ?? null, autores: d.autores ?? [], contribuciones: d.contribuciones ?? [] } },
      alertas_agente: `Título «${d.titulo}» → «${titulo}»${personas.length ? ` (mención separada: ${personas.map((x) => `${x.nombre} [${x.rol}]`).join('; ')})` : ''} (scripts/${ORIGEN}).`,
    },
  });
  await indexarDoc(db, d._id).catch(() => {});
}
p.fin();

console.log(`\n1 · Mención separada del título: ${cuenta.mencion}`);
ejemplos.mencion.forEach((e) => console.log(`     ${e}`));
console.log(`\n2 · Mayúsculas → grafía del Fichero (mismo ISBN, mismo título): ${cuenta.autoridad}`);
ejemplos.autoridad.forEach((e) => console.log(`     ${e}`));
console.log(`\n    Mayúsculas → Title Case: ${cuenta.titleCase}`);
ejemplos.titleCase.forEach((e) => console.log(`     ${e}`));
console.log(`\n    Subtítulos en mayúsculas arreglados: ${cuenta.subtitulo}`);
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
process.exit(0);
