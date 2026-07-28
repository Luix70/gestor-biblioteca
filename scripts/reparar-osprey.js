/**
 * REPARAR OSPREY — recatalogar los libros Osprey mal ingeridos. El NOMBRE DE ARCHIVO trae la verdad
 * («Osprey - Men at Arms 051 - Spanish Armies of the Napoleonic Wars.pdf»), pero muchos quedaron con:
 *   · título = «Osprey»: un ISBN BOGUS COMPARTIDO (0140110925 = un libro Penguin llamado «Osprey») «confirmaba»
 *     ese título en cada conformación/enriquecimiento y traía su dewey/lcc equivocados;
 *   · «autores» = FRAGMENTOS del propio nombre de archivo («Elite 074», «Privateers», «Pirates 1730», y hasta
 *     el nombre de la serie «Men at Arms»);
 *
 * ESTRATEGIA (la fuente fiable es el NOMBRE DE ARCHIVO, no el ISBN, que aquí es basura):
 *   1. Título REAL = lo que va tras «<Serie> <NNN> - » (quitando el «Osprey - » inicial) del nombre de archivo.
 *   2. Autor FALSO = aquel cuyo nombre APARECE dentro del nombre de archivo (un autor real NO está ahí). Se
 *      quita del documento; si queda huérfano y SIN inversión (bio/foto/fechas), se borra.
 *   3. ISBN bogus 0140110925 → se quita, junto al dewey/lcc que vinieron de él.
 *   4. coleccion_numero = el <NNN> de la serie.
 *   5. (opcional) --cdu <código>: fija esa CDU a los reparados (útil: «Osprey Men at Arms» = militar → 355).
 * Solo toca los ROTOS (título «Osprey», ISBN bogus, o con algún autor que sale del nombre). Los CORRECTOS
 * (título y autores buenos, con su ISBN propio) se dejan INTACTOS.
 *
 * Uso:
 *   node scripts/reparar-osprey.js                      (DRY-RUN: solo informa)
 *   node scripts/reparar-osprey.js --ejecutar           (aplica)
 *   node scripts/reparar-osprey.js --coleccion <id>     (otra colección; por defecto «Osprey Men at Arms»)
 *   node scripts/reparar-osprey.js --cdu 355 --ejecutar (además fija la CDU de los reparados)
 *
 * ⚠ Cambia CIENTOS de documentos y borra autores: haz COPIA DE SEGURIDAD antes de --ejecutar.
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { autorTieneInversion } from '../src/utils/gestion-autores.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const argCol = (() => { const i = process.argv.indexOf('--coleccion'); return i >= 0 ? process.argv[i + 1] : null; })();
const argCdu = (() => { const i = process.argv.indexOf('--cdu'); return i >= 0 ? String(process.argv[i + 1] || '').trim() : null; })();
const ISBN_BOGUS = '0140110925';

// Normaliza para comparar «autor sale del nombre de archivo»: minúsculas, sin acentos, solo alfanumérico.
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Del nombre de archivo saca { serie, numero, titulo }. «Osprey - Men at Arms 051 - Spanish Armies…» → serie
// «Men at Arms», numero «51», titulo «Spanish Armies…». También «MAA 288 American Indians…».
function parsearNombreOsprey(nombreArchivo) {
    let s = String(nombreArchivo || '').replace(/\.[a-z0-9]{2,5}$/i, '');   // quita la extensión
    s = s.replace(/^\s*osprey\s*[-–—:]\s*/i, '').trim();                    // quita el «Osprey - » inicial
    const m = s.match(/^(.*?)\b(\d{1,3})\b\s*[-–—:.]*\s*(.+)$/);            // «<serie> <NNN> [sep] <título>»
    if (m && m[3] && m[3].trim().length >= 2) {
        return { serie: m[1].replace(/[-–—:.\s]+$/, '').trim() || null, numero: String(parseInt(m[2], 10)), titulo: m[3].trim() };
    }
    return { serie: null, numero: null, titulo: s };
}

const db = await conectarDB();
const bib = db.collection('biblioteca');
const autoresCol = db.collection('autores');

console.log(`\n=== Reparar Osprey ${EJECUTAR ? '· MODO EJECUCIÓN' : '· SIMULACIÓN (dry-run)'} ===\n`);

// Colección objetivo (por id, o por nombre «Osprey Men at Arms»).
let colId = null;
if (argCol && ObjectId.isValid(argCol)) colId = new ObjectId(argCol);
else {
    const c = await db.collection('colecciones').findOne({ nombre: /osprey men at arms/i }, { projection: { _id: 1, nombre: 1 } });
    if (c) { colId = c._id; console.log(`Colección: «${c.nombre}» [${c._id}]`); }
}
const filtro = colId ? { coleccion: colId } : { titulo: /^osprey$/i };
const docs = await bib.find(filtro, { projection: { titulo: 1, autores: 1, isbn: 1, dewey: 1, lcc: 1, cdu: 1, nombre_archivo: 1, coleccion: 1, coleccion_numero: 1 } }).toArray();
console.log(`Documentos en el ámbito: ${docs.length}\n`);

// Cache de nombres de autor.
const idsAut = [...new Set(docs.flatMap((d) => (d.autores || []).map(String)))].map((s) => new ObjectId(s));
const nombreAut = new Map((await autoresCol.find({ _id: { $in: idsAut } }, { projection: { nombre: 1 } }).toArray()).map((a) => [String(a._id), a.nombre]));

let reparados = 0, intactos = 0, sinNombre = 0;
const autoresQuitados = new Set();   // ids que se retiran de algún doc → candidatos a huérfano

for (const d of docs) {
    const nombre = d.nombre_archivo || '';
    if (!nombre) { sinNombre++; continue; }
    const nf = norm(nombre);
    const auts = (d.autores || []).map((id) => ({ id: String(id), nombre: nombreAut.get(String(id)) || '' }));
    const falsos = auts.filter((a) => a.nombre && norm(a.nombre).length >= 3 && nf.includes(norm(a.nombre)));
    const esRoto = String(d.titulo || '').trim().toLowerCase() === 'osprey' || d.isbn === ISBN_BOGUS || falsos.length > 0;
    if (!esRoto) { intactos++; continue; }

    const parsed = parsearNombreOsprey(nombre);
    const set = {}, unset = {};
    // Título real del nombre de archivo (si es válido y aporta).
    if (parsed.titulo && parsed.titulo.length >= 2 && parsed.titulo.toLowerCase() !== 'osprey' && parsed.titulo !== d.titulo) set.titulo = parsed.titulo;
    // Quitar autores FALSOS (los que salen del nombre de archivo).
    const nuevosAut = (d.autores || []).filter((id) => !falsos.some((f) => f.id === String(id)));
    if (nuevosAut.length !== (d.autores || []).length) { set.autores = nuevosAut; falsos.forEach((f) => autoresQuitados.add(f.id)); }
    // ISBN bogus → fuera (con su dewey/lcc equivocados).
    if (d.isbn === ISBN_BOGUS) { unset.isbn = ''; if (d.dewey) unset.dewey = ''; if (d.lcc) unset.lcc = ''; }
    // Nº de serie → coleccion_numero.
    if (parsed.numero && d.coleccion && d.coleccion_numero !== parsed.numero) set.coleccion_numero = parsed.numero;
    // CDU opcional (los reparados a la CDU dada).
    if (argCdu) set.cdu = argCdu;

    if (!Object.keys(set).length && !Object.keys(unset).length) { intactos++; continue; }
    reparados++;
    console.log(`  ✔ «${String(d.titulo).slice(0, 22)}» → «${(set.titulo || d.titulo).slice(0, 40)}»${set.autores ? ` · −${falsos.length} autor(es) falso(s) [${falsos.map((f) => f.nombre).join(', ').slice(0, 50)}]` : ''}${unset.isbn ? ' · −ISBN bogus' : ''}${set.coleccion_numero ? ` · nº ${set.coleccion_numero}` : ''}`);
    if (EJECUTAR) {
        const upd = {};
        if (Object.keys(set).length) upd.$set = { ...set, fecha_actualizacion: new Date() };
        if (Object.keys(unset).length) upd.$unset = unset;
        await bib.updateOne({ _id: d._id }, upd);
        await indexarDoc(db, d._id).catch(() => {});
    }
}

console.log(`\nReparados: ${reparados} · intactos (correctos): ${intactos}${sinNombre ? ` · sin nombre_archivo: ${sinNombre}` : ''}`);

// Limpieza de autores FALSOS que quedan huérfanos (0 docs) y SIN inversión (bio/foto/fechas).
let borrados = 0, conservados = 0;
if (autoresQuitados.size) {
    console.log(`\nAutores retirados de algún doc: ${autoresQuitados.size} → revisando huérfanos…`);
    for (const idStr of autoresQuitados) {
        const oid = new ObjectId(idStr);
        const nDocs = EJECUTAR ? await bib.countDocuments({ $or: [{ autores: oid }, { 'contribuciones.persona': oid }] }) : 0;
        if (EJECUTAR && nDocs > 0) { conservados++; continue; } // aún referenciado por otro doc
        const a = await autoresCol.findOne({ _id: oid });
        if (!a) continue;
        if (autorTieneInversion(a)) { conservados++; continue; }  // tiene bio/foto → se conserva
        console.log(`  🗑  autor falso «${a.nombre}» [${idStr}]${EJECUTAR ? '' : ' (se borraría si queda huérfano)'}`);
        if (EJECUTAR) { await autoresCol.deleteOne({ _id: oid }); borrados++; }
    }
    console.log(`Autores falsos borrados: ${borrados}${conservados ? ` · conservados (con inversión o aún referenciados): ${conservados}` : ''}`);
}

if (EJECUTAR) {
    console.log(`\n✅ Hecho.${argCdu ? ` CDU fijada a ${argCdu}.` : ''}`);
    console.log(`\nSIGUIENTES PASOS para completar (los autores reales NO están en el nombre de archivo):`);
    console.log(`  1. ENRIQUECER en lote los Osprey con ISBN bueno: al quedar «autores» vacío (hueco) y el título`);
    console.log(`     ya corregido, el enriquecimiento rellena los autores REALES desde el ISBN. (Panel: selecciona`);
    console.log(`     la colección → «✨ Enriquecer».) Los de ISBN bogus quedan sin autor (ese ISBN no sirve).`);
    console.log(`  2. LIMPIAR autores huérfanos globalmente: node scripts/limpiar-autores-huerfanos.js --ejecutar`);
    if (!argCdu) console.log(`  3. CDU: son militares → «Asignar datos → CDU 355» en lote, o vuelve a Enriquecer.`);
} else {
    console.log(`\n(simulación) Re-ejecuta con --ejecutar para aplicar. Haz COPIA DE SEGURIDAD antes.`);
    console.log(`Nota: los autores REALES no salen del nombre de archivo; tras aplicar, ENRIQUECE los de ISBN`);
    console.log(`bueno (rellena autores desde el ISBN) y luego limpia-autores-huerfanos para el barrido global.`);
}
process.exit(0);
