/**
 * TÍTULOS QUE SON EL NOMBRE DEL FICHERO. 8-oct: 3.609 libros tenían por título el nombre de su fichero tal cual,
 * p. ej. «(Series on partial differential equations and applications 1) Bernard Helffer-Semiclassical analysis,
 * Witten Laplacians, and statistical mechanics-World Scientific (2002)» (formato de Z-Library/Libgen, que el lector
 * de nombres no entendía; ahora sí: parsear-nombre · parsearNombreZlib). Se vuelve a leer el nombre y, si da un título
 * distinto:
 *   · con ISBN y un título del Fichero que es el mismo libro → el del Fichero (grafía buena);
 *   · si no → el leído del nombre.
 * Además rellena HUECOS con lo leído (autores, editorial, año) — nunca pisa lo que hay. Diario `deshacer[]`.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/retitular-por-nombre.js              (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/retitular-por-nombre.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { parsearNombreZlib } from '../src/utils/parsear-nombre.js';
import { mismoTituloLibro } from '../src/utils/titulo-libro.js';
import { capitalizarTitulo } from '../src/utils/titulos.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';
import { resolverEditorial } from '../src/utils/resolver-editorial.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const ORIGEN = 'retitular-por-nombre';
const sinExtension = (n) => String(n || '').replace(/\.[^.]+$/, '').trim();

const db = await conectarDB();
const bib = db.collection('biblioteca');
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · títulos que son el nombre del fichero\n`);

const filtro = { nombre_archivo: { $exists: true }, tipo_recurso: { $ne: 'revista' } };
const total = await bib.countDocuments(filtro);
const p = progreso(total, 'Revisando');
const cuenta = { candidatos: 0, fichero: 0, nombre: 0, autores: 0, editorial: 0, anio: 0 };
const ejemplos = [];
for await (const d of bib.find(filtro, { projection: { titulo: 1, subtitulo: 1, nombre_archivo: 1, isbn: 1, autores: 1, editorial: 1, año_edicion: 1, coleccion_nombre: 1, coleccion_numero: 1 } })) {
  p.paso(d.titulo);
  if (String(d.titulo || '').trim() !== sinExtension(d.nombre_archivo)) continue;
  cuenta.candidatos++;
  // Solo dos casos SEGUROS (el lector genérico confunde «Autor - Título» con «Título - Autor»: «Stephen King - Under
  // The Dome» daba «Stephen King»): (a) el nombre tiene el formato de Z-Library, que se lee sin ambigüedad; (b) el
  // libro tiene ISBN y el título del Fichero para él está ENTERO dentro del título actual.
  const leido = parsearNombreZlib(sinExtension(d.nombre_archivo)) || {};
  const aut = d.isbn ? await buscarEnFicheroLocal({ isbns: variantesISBN(d.isbn) }).catch(() => null) : null;
  const plano = (t) => ` ${String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const autDentro = aut?.titulo && String(aut.titulo).trim().split(/\s+/).length >= 2 && plano(d.titulo).includes(plano(aut.titulo));
  let titulo = null;
  let via = null;
  if (leido.titulo) {
    titulo = leido.titulo.trim();
    via = 'nombre';
    if (aut?.titulo && mismoTituloLibro(aut.titulo, titulo)) { titulo = String(aut.titulo).trim(); via = 'fichero'; }
  } else if (autDentro) {
    // Solo si QUITA algo (las mismas palabras con otra grafía no son asunto de este script) y lo que quita no es el
    // tomo («Art History … Vol 2» → «Art history» perdería el «Vol 2»).
    const sobra = plano(d.titulo).replace(plano(aut.titulo), ' ');
    if (plano(aut.titulo) === plano(d.titulo) || /\b(?:vol(?:ume)?|tomo|part|book|libro)\s*\d/i.test(sobra)) continue;
    titulo = String(aut.titulo).trim();
    via = 'fichero';
  }
  if (!titulo) continue;
  // Si el título del Fichero está DENTRO del original, se toma ese trozo del original con SU grafía («Adobe InDesign CC
  // Classroom in a Book», no el «Adobe Indesign Cc…» del Fichero), salvo que el original esté en mayúsculas o escrito
  // con puntos/guiones bajos en vez de espacios («Anthology.The.Mammoth.Book.of…»).
  if (via === 'fichero') {
    const orig = String(d.titulo);
    const limpio = !/[_]|\.\S/.test(orig) && /\p{Ll}/u.test(orig);
    const meta = plano(titulo).trim();
    if (limpio) {
      const inicios = [0, ...[...orig.matchAll(/\s+/g)].map((m) => m.index + m[0].length)];
      buscar: for (const i of inicios) {
        for (let j = i + 1; j <= orig.length; j++) {
          const c = plano(orig.slice(i, j)).trim();
          if (c === meta && !/[\p{L}\p{N}]/u.test(orig[j] || '')) {
            // Lo que se quita DELANTE tiene que ser un nombre o ruido («Wayne B. Nelson …»), no parte del título
            // («Encyclopedia of Chemical Compounds» no es «Chemical Compounds»).
            if (/\b(?:of|the|and|to|for|in|on|de|del|la|el|y|en|des|du)\b/.test(orig.slice(0, i))) { titulo = null; break buscar; }
            titulo = orig.slice(i, j).replace(/^[\s\-–—.:;,]+|[\s\-–—:;,]+$/g, '').trim();
            break buscar;
          }
          if (c.length > meta.length) break;
        }
      }
    }
  }
  if (!titulo) continue;
  titulo = titulo.replace(/\s*\.$/, '');                       // el punto final de los catálogos
  titulo = capitalizarTitulo(titulo) || titulo;                // el Fichero también trae alguno en MAYÚSCULAS
  // El artículo inicial que los catálogos quitan para ordenar («The Everest Story» → «Everest Story»): se conserva.
  const articulo = String(d.titulo).trim().match(/^(The|A|An|El|La|Los|Las|Lo|Un|Una|Le|Les|L'|Der|Die|Das|Il)\s+/i);
  if (articulo && !plano(titulo).startsWith(plano(articulo[1]))) titulo = `${articulo[1]} ${titulo}`;
  if (titulo === String(d.titulo).trim() || plano(titulo) === plano(d.titulo)) continue;
  // Lo que el título largo decía DESPUÉS del del Fichero, si se lee como un subtítulo (varias palabras, con palabras
  // de enlace, sin años, ediciones ni nombres de autor al final): «Drawing Graphs Methods and Models».
  let subDelResto = null;
  if (via === 'fichero' && !d.subtitulo && !aut?.subtitulo) {
    const largo = String(d.titulo).replace(/[_.]+/g, (m) => (m === '.' ? '. ' : ' ')).replace(/\s+/g, ' ').trim();
    const corte = largo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').indexOf(plano(titulo).trim().split(' ').slice(-1)[0]);
    let resto = corte >= 0 ? largo.slice(corte).replace(/^\S+/, '') : '';
    resto = resto.replace(/\([^)]*\)?\s*$/, '').replace(/\.\s*\p{Lu}[\p{L}.\s,&'-]*$/u, '').replace(/^[\s.:;,–—-]+|[\s.:;,–—-]+$/g, '').trim();
    const palabras = resto.split(/\s+/).filter(Boolean);
    const enlace = /\b(?:of|and|from|to|the|a|for|in|on|with|about|de|del|la|el|y|en|para|sobre|des|du|et|und)\b/;
    if (palabras.length >= 2 && enlace.test(resto) && !/\d{4}|\b(?:edition|ed\.|vol|volume|by)\b/i.test(resto)) subDelResto = resto;
  }
  cuenta[via]++;
  const set = { titulo, fecha_actualizacion: new Date() };
  const huecos = [];
  // El subtítulo que el título largo llevaba dentro: el del Fichero, si el libro no tiene.
  if (!d.subtitulo && via === 'fichero' && aut?.subtitulo) { set.subtitulo = String(aut.subtitulo).trim().replace(/\s*\.$/, ''); huecos.push('subtitulo'); }
  else if (subDelResto) { set.subtitulo = subDelResto; huecos.push('subtitulo'); }
  if (!(d.autores || []).length && (leido.autores || []).length) huecos.push('autores');
  if (!d.editorial && leido.editorial) huecos.push('editorial');
  if (!d.año_edicion && leido.año_edicion) huecos.push('año');
  // El número en la colección que dice el nombre («(Series on … 1) …»), si el libro está en ESA colección sin número.
  const mismaColeccion = (a, b) => plano(a).trim() === plano(b).trim();
  if (leido.coleccion_numero && !d.coleccion_numero && d.coleccion_nombre && mismaColeccion(d.coleccion_nombre, leido.coleccion_nombre)) {
    set.coleccion_numero = String(leido.coleccion_numero);
    huecos.push('nº de colección');
  }
  for (const h of huecos) { const k = h === 'año' ? 'anio' : h; cuenta[k] = (cuenta[k] || 0) + 1; }
  if (ejemplos.length < 40) ejemplos.push(`«${d.titulo.slice(0, 80)}» → «${titulo}»${via === 'fichero' ? ' (Fichero)' : ''}${huecos.length ? ` + ${huecos.join(', ')}` : ''}`);
  if (!EJECUTAR) continue;

  if (huecos.includes('autores')) {
    const ids = [];
    for (const n of leido.autores) { const r = await resolverPersona(db, n); if (r && !ids.some((x) => String(x) === String(r._id))) ids.push(r._id); }
    if (ids.length) set.autores = ids;
  }
  if (huecos.includes('editorial')) { const e = await resolverEditorial(db, leido.editorial, { isbn: d.isbn }); if (e) set.editorial = e; }
  if (huecos.includes('año')) set.año_edicion = leido.año_edicion;
  await bib.updateOne({ _id: d._id }, {
    $set: set,
    $push: {
      deshacer: { fecha: new Date(), origen: ORIGEN, antes: { titulo: d.titulo, subtitulo: d.subtitulo ?? null, coleccion_numero: d.coleccion_numero ?? null, autores: d.autores ?? [], editorial: d.editorial ?? null, año_edicion: d.año_edicion ?? null } },
      alertas_agente: `Título (era el nombre del fichero) → «${titulo}»${via === 'fichero' ? ', el del Fichero para su ISBN' : ''} (scripts/${ORIGEN}).`,
    },
  });
  await indexarDoc(db, d._id).catch(() => {});
}
p.fin();

console.log(`\nTítulos que son el nombre del fichero: ${cuenta.candidatos}`);
console.log(`Se cambian: ${cuenta.fichero + cuenta.nombre} (${cuenta.fichero} con el título del Fichero, ${cuenta.nombre} con el leído del nombre)`);
console.log(`Huecos que se rellenan: nº de colección ${cuenta['nº de colección'] || 0} · subtítulo ${cuenta.subtitulo || 0} · autores ${cuenta.autores} · editorial ${cuenta.editorial} · año ${cuenta.anio}\n`);
ejemplos.forEach((e) => console.log(`   ${e}`));
console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
if (!EJECUTAR) console.log('▶ Copia de la base antes (scripts/copia-base.js) y repite con --ejecutar.');
process.exit(0);
