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
 *   6. (opcional) --series: RECOLOCA cada libro (roto o correcto) en su colección real «Osprey <Serie>» según
 *      la serie del nombre de archivo (Elite, Campaign, Warrior, New Vanguard, Essential Histories, Fortress…);
 *      hoy están TODOS mal metidos en «Osprey Men at Arms». Usa asignarColeccion (crea la colección si falta).
 * Los arreglos de título/autor/ISBN solo tocan los ROTOS (título «Osprey», ISBN bogus, o con algún autor que
 * sale del nombre); los CORRECTOS se dejan como están (con --series también se recolocan por serie).
 *
 * Uso:
 *   node scripts/reparar-osprey.js                             (DRY-RUN: solo informa)
 *   node scripts/reparar-osprey.js --ejecutar                 (aplica los arreglos de título/autor/ISBN)
 *   node scripts/reparar-osprey.js --series --ejecutar        (+ recoloca cada libro en «Osprey <Serie>»)
 *   node scripts/reparar-osprey.js --series --cdu 355 --ejecutar
 *   node scripts/reparar-osprey.js --coleccion <id>           (otra colección; por defecto «Osprey Men at Arms»)
 *
 * ⚠ Cambia CIENTOS de documentos y borra autores: haz COPIA DE SEGURIDAD antes de --ejecutar.
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { autorTieneInversion } from '../src/utils/gestion-autores.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { asignarColeccion } from '../src/utils/agrupar-docs.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const argSeries = process.argv.includes('--series'); // recolocar cada libro en «Osprey <Serie>» (Elite/Campaign/…)
const argCol = (() => { const i = process.argv.indexOf('--coleccion'); return i >= 0 ? process.argv[i + 1] : null; })();
const argCdu = (() => { const i = process.argv.indexOf('--cdu'); return i >= 0 ? String(process.argv[i + 1] || '').trim() : null; })();
const ISBN_BOGUS = '0140110925';

// Normaliza para comparar «autor sale del nombre de archivo»: minúsculas, sin acentos, solo alfanumérico.
const norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Serie Osprey → nombre de colección canónico «Osprey <Serie>». Reconoce las series conocidas (incl. abreviaturas
// como MAA/NVG); una serie limpia no listada (solo letras/espacios, ≥3) también vale. Ruido → null (no recoloca).
const SERIES_OSPREY = {
    'maa': 'Men at Arms', 'men at arms': 'Men at Arms', 'men-at-arms': 'Men at Arms',
    'eli': 'Elite', 'elite': 'Elite', 'cam': 'Campaign', 'campaign': 'Campaign',
    'war': 'Warrior', 'warrior': 'Warrior', 'for': 'Fortress', 'fortress': 'Fortress',
    'nvg': 'New Vanguard', 'new vanguard': 'New Vanguard', 'van': 'Vanguard', 'vanguard': 'Vanguard',
    'ess': 'Essential Histories', 'essential histories': 'Essential Histories', 'essential histories special': 'Essential Histories Special',
    'aoa': 'Aircraft of the Aces', 'aircraft of the aces': 'Aircraft of the Aces',
    'com': 'Combat Aircraft', 'combat aircraft': 'Combat Aircraft', 'duel': 'Duel', 'raid': 'Raid',
    'weapon': 'Weapon', 'command': 'Command', 'general military': 'General Military',
    'battle orders': 'Battle Orders', 'order of battle': 'Order of Battle', 'orders of battle': 'Order of Battle',
    'modelling': 'Modelling', 'modelling manuals': 'Modelling Manuals', 'modelling masterclass': 'Modelling Masterclass',
    'superbase': 'Superbase', 'aviation pioneers': 'Aviation Pioneers', 'x planes': 'X-Planes', 'air vanguard': 'Air Vanguard',
};
// Solo recoloca a una serie CONOCIDA (evita crear colecciones basura con títulos mal parseados como
// «Byzantine Armies» o «Roman Military Clothing»). Lo no reconocido se queda en su colección actual.
function nombreColeccionSerie(serie) {
    const s = String(serie || '').replace(/[^A-Za-z ]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const canon = SERIES_OSPREY[s];
    return canon ? 'Osprey ' + canon : null;
}

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
const docs = await bib.find(filtro, { projection: { titulo: 1, autores: 1, isbn: 1, dewey: 1, lcc: 1, cdu: 1, nombre_archivo: 1, coleccion: 1, coleccion_nombre: 1, coleccion_numero: 1 } }).toArray();
console.log(`Documentos en el ámbito: ${docs.length}\n`);

// Cache de nombres de autor.
const idsAut = [...new Set(docs.flatMap((d) => (d.autores || []).map(String)))].map((s) => new ObjectId(s));
const nombreAut = new Map((await autoresCol.find({ _id: { $in: idsAut } }, { projection: { nombre: 1 } }).toArray()).map((a) => [String(a._id), a.nombre]));

let reparados = 0, intactos = 0, sinNombre = 0, recolocados = 0;
const autoresQuitados = new Set();     // ids que se retiran de algún doc → candidatos a huérfano
const recolocar = new Map();           // «Osprey <Serie>» → [docId] a mover con asignarColeccion

for (const d of docs) {
    const nombre = d.nombre_archivo || '';
    if (!nombre) { sinNombre++; continue; }
    const nf = norm(nombre);
    const parsed = parsearNombreOsprey(nombre);
    const auts = (d.autores || []).map((id) => ({ id: String(id), nombre: nombreAut.get(String(id)) || '' }));
    const falsos = auts.filter((a) => a.nombre && norm(a.nombre).length >= 3 && nf.includes(norm(a.nombre)));
    const esRoto = String(d.titulo || '').trim().toLowerCase() === 'osprey' || d.isbn === ISBN_BOGUS || falsos.length > 0;

    // RECOLOCAR POR SERIE (--series): a TODOS (rotos y correctos), la serie del nombre → «Osprey <Serie>». Solo
    // si difiere de la colección actual (por nombre). El falso autor lleva la misma serie, pero el nombre de
    // archivo es más fiable.
    let colDestino = null;
    if (argSeries) {
        const colNombre = nombreColeccionSerie(parsed.serie);
        if (colNombre && colNombre.toLowerCase() !== String(d.coleccion_nombre || '').toLowerCase()) colDestino = colNombre;
    }

    if (!esRoto && !colDestino) { intactos++; continue; }

    const set = {}, unset = {};
    if (esRoto) {
        // Título real del nombre de archivo (si es válido y aporta).
        if (parsed.titulo && parsed.titulo.length >= 2 && parsed.titulo.toLowerCase() !== 'osprey' && parsed.titulo !== d.titulo) set.titulo = parsed.titulo;
        // Quitar autores FALSOS (los que salen del nombre de archivo).
        const nuevosAut = (d.autores || []).filter((id) => !falsos.some((f) => f.id === String(id)));
        if (nuevosAut.length !== (d.autores || []).length) { set.autores = nuevosAut; falsos.forEach((f) => autoresQuitados.add(f.id)); }
        // ISBN bogus → fuera (con su dewey/lcc equivocados).
        if (d.isbn === ISBN_BOGUS) { unset.isbn = ''; if (d.dewey) unset.dewey = ''; if (d.lcc) unset.lcc = ''; }
        // CDU opcional (los reparados a la CDU dada).
        if (argCdu) set.cdu = argCdu;
    }
    // Nº de serie → coleccion_numero (para rotos y para recolocados; asignarColeccion luego lo conserva).
    if (parsed.numero && d.coleccion_numero !== parsed.numero) set.coleccion_numero = parsed.numero;
    // Anotar la recolocación (el movimiento real lo hace asignarColeccion tras el bucle).
    if (colDestino) { if (!recolocar.has(colDestino)) recolocar.set(colDestino, []); recolocar.get(colDestino).push(d._id); recolocados++; }

    if (esRoto) reparados++;
    console.log(`  ✔ «${String(d.titulo).slice(0, 22)}» → «${(set.titulo || d.titulo).slice(0, 38)}»${set.autores ? ` · −${falsos.length} autor(es) falso(s)` : ''}${unset.isbn ? ' · −ISBN bogus' : ''}${set.coleccion_numero ? ` · nº ${set.coleccion_numero}` : ''}${colDestino ? ` · → «${colDestino}»` : ''}`);
    if (EJECUTAR && (Object.keys(set).length || Object.keys(unset).length)) {
        const upd = {};
        if (Object.keys(set).length) upd.$set = { ...set, fecha_actualizacion: new Date() };
        if (Object.keys(unset).length) upd.$unset = unset;
        await bib.updateOne({ _id: d._id }, upd);
        await indexarDoc(db, d._id).catch(() => {});
    }
}

console.log(`\nReparados: ${reparados} · intactos (correctos): ${intactos}${sinNombre ? ` · sin nombre_archivo: ${sinNombre}` : ''}`);

// RECOLOCAR POR SERIE (--series): mover cada lote a su colección «Osprey <Serie>» con asignarColeccion (crea la
// colección si no existe, conserva el coleccion_numero ya fijado, y borra la colección vieja si queda vacía).
if (argSeries && recolocar.size) {
    console.log(`\n── Recolocación por serie (${recolocados} docs → ${recolocar.size} colección(es)) ──`);
    for (const [nombreCol, ids] of [...recolocar.entries()].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  · «${nombreCol}» ← ${ids.length} doc(s)${EJECUTAR ? '' : ' (se movería)'}`);
        if (EJECUTAR) {
            const r = await asignarColeccion(db, ids.map(String), { nombre: nombreCol, tipo: 'libro' }).catch((e) => ({ ok: false, motivo: e.message }));
            if (!r.ok) console.warn(`    ⚠ no se pudo recolocar en «${nombreCol}»: ${r.motivo}`);
            else for (const id of ids) await indexarDoc(db, id).catch(() => {});
        }
    }
} else if (argSeries) {
    console.log(`\n(--series) Nada que recolocar: todos ya están en su colección de serie.`);
}

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
