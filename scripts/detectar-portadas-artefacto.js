/**
 * DETECTAR PORTADAS ARTEFACTO — y reparar los libros que las tienen.
 *
 * Una portada artefacto es una imagen que NO es la cubierta de ningún libro: el banner que un grupo de ripeo mete
 * como página 1 de todos sus PDF («We Trip The Light Fantastic»: el mismo en «Beer», «Deadly Connections», «G. E.
 * Moore's Ethical Theory»… — la cubierta real estaba en la página 2), un «cover not available», el logo de un
 * maquetador. Señal inequívoca: la MISMA imagen (byte a byte) como portada de libros DISTINTOS.
 *
 * Qué hace:
 *   1. Agrupa las portadas del catálogo por tamaño y, solo las de tamaño repetido, por SHA-256 (barato).
 *   2. Un grupo con 2 o más OBRAS distintas es un artefacto. No cuentan como distintas: el mismo libro en dos
 *      ficheros, los tomos de una misma obra ni los miembros de una misma colección (comparten con todo derecho la
 *      portada del conjunto), ni títulos que solo difieren en el número («Drama for Students Vol 1» / «Vol 13»).
 *   3. Lo REGISTRA (colección `portadas_artefacto`, utils/portadas-artefacto.js) con su SHA y, si salió de un PDF, con
 *      la huella perceptiva de ESA página — así la ingesta y la re-extracción la SALTAN en cualquier PDF futuro del
 *      mismo grupo de ripeo, como saltan las páginas en blanco.
 *   4. REPARA cada libro afectado: re-extrae sus imágenes de su propio fichero (ya sin el artefacto: en un PDF sale
 *      la siguiente página con contenido, que suele ser la cubierta real); si el fichero no da otra, portada remota
 *      por ISBN. No borra nada del disco; conserva las imágenes añadidas a mano.
 *
 * SELECCIONES (por defecto): crea (o actualiza) una SELECCIÓN por grupo sospechoso, «Portada sospechosa <sha8>
 * (N)», para revisarla en el panel y decidir allí con la acción «🚩 Portada sospechosa…» (quitar portada /
 * re-extraer omitiendo la sospechosa / primera página de texto). No toca los documentos: solo crea selecciones.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js              (lista + selecciones)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js --sin-selecciones   (solo lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js --ejecutar   (registra y repara TODO solo)
 *   … --obras N    mínimo de obras distintas que deben compartir la imagen (por defecto 2)
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { conectarDB } from '../src/database.js';
import { DIR_CDU, carpetaDeDoc, archivoOriginal } from '../src/mantenimiento/util-mantenimiento.js';
import { medirTinta } from '../src/utils/rasterizar-pdf.js';
import { registrarArtefacto, huellaInformativa, distanciaHuellas } from '../src/utils/portadas-artefacto.js';
import { reextraerImagenesDoc } from '../src/utils/reextraer-imagenes.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { crearSeleccion, reemplazarDocs } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SELECCIONES = !args.includes('--sin-selecciones');
const iObras = args.indexOf('--obras');
const MIN_OBRAS = iObras >= 0 ? Math.max(2, Number(args[iObras + 1]) || 2) : 2;
const TINTA_MIN = Number(process.env.PDF_TINTA_MIN || 0.005);

const db = await conectarDB();
const col = db.collection('biblioteca');
const abs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
// Título comparable SIN números ni «vol»: «Poetry for students 02» y «… 05» son la MISMA serie, no obras distintas.
const RE_DIACRITICOS = new RegExp(String.raw`[\u0300-\u036f]`, 'g');
const RE_DESIGNADOR = new RegExp(String.raw`\b(vol|volume|volumen|tomo|t|n|no)\b\.?`, 'g');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
    .replace(RE_DESIGNADOR, '').replace(/[^a-z]/g, '').slice(0, 20);
// UNIDAD de obra: los TOMOS de una obra comparten con todo derecho la portada del conjunto (Grzimek, las
// enciclopedias de Gale), igual que los títulos que solo difieren en el número («Novels for Students Vol 10/11»).
// Pertenecer a la misma COLECCIÓN no basta: hay colecciones-cajón con libros sin relación (medido: 415 EPUB en
// español con la misma imagen desaparecían del informe por compartir colección). Esos grupos se marcan «de
// colección»: se crea su selección igual, pero quedan FUERA de la reparación automática (--ejecutar), por si la
// imagen es la portada legítima de una serie (p. ej. la de una colección de audiolibros).
const unidad = (d) => (d.obra ? `o:${d.obra}` : `t:${norm(d.titulo)}`);
const deUnaColeccion = (ds) => ds.every((d) => d.coleccion && String(d.coleccion) === String(ds[0].coleccion));

// ── 1. Portadas: por tamaño, y SHA solo de los tamaños repetidos ─────────────────────────────────────────
const docs = await col.find({ portada: { $exists: true, $ne: null } },
    { projection: { portada: 1, titulo: 1, isbn: 1, nombre_archivo: 1, imagenes: 1, ruta_base: 1, obra: 1, coleccion: 1 } }).toArray();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : SELECCIONES ? '📋 SELECCIONES (no toca los documentos)' : '🔍 DRY-RUN'} · ${docs.length} documentos con portada`);
// Fase 1: tamaño de cada portada (stat, sin leerla).
const porTam = new Map();
let i = 0;
for (const d of docs) {
    if (++i % 500 === 0) process.stdout.write(`\r\x1b[K   1/2 · tamaños: ${i}/${docs.length}`);
    try {
        const st = await fs.stat(abs(d.portada));
        if (!porTam.has(st.size)) porTam.set(st.size, []);
        porTam.get(st.size).push(d);
    } catch { /* no está */ }
}
// Fase 2: SHA solo de las de tamaño repetido. (Antes esta fase no mostraba progreso y parecía colgada en «64000».)
const aLeer = [...porTam.values()].filter((ds) => ds.length > 1).flat();
const porSha = new Map();
let k = 0;
for (const d of aLeer) {
    if (++k % 200 === 0) process.stdout.write(`\r\x1b[K   2/2 · comparando portadas de igual tamaño: ${k}/${aLeer.length}`);
    try {
        const sha = crypto.createHash('sha256').update(await fs.readFile(abs(d.portada))).digest('hex');
        if (!porSha.has(sha)) porSha.set(sha, []);
        porSha.get(sha).push(d);
    } catch { /* */ }
}
process.stdout.write('\r\x1b[K');

// ── 2. Artefactos: la misma imagen en N obras distintas ──────────────────────────────────────────────────
const artefactos = [...porSha.entries()]
    .map(([sha, ds]) => ({ sha, ds, obras: new Set(ds.map(unidad)).size, coleccion: deUnaColeccion(ds) }))
    .filter((g) => g.ds.length > 1 && g.obras >= MIN_OBRAS)
    .sort((a, b) => b.ds.length - a.ds.length);
console.log(`   Portadas idénticas en ${MIN_OBRAS}+ obras distintas: ${artefactos.length} imagen(es) · ${artefactos.reduce((s, g) => s + g.ds.length, 0)} documento(s)\n`);

// Huella de la página de PDF que dio esa portada: la 1.ª con contenido (la que la extracción tomó por portada).
async function huellaDePortadaPdf(d) {
    const im = (d.imagenes || []).find((x) => x.ruta === d.portada);
    if (!im || !/^pdf/.test(String(im.origen || ''))) return null;
    const pdf = await archivoOriginal(carpetaDeDoc(d), d.nombre_archivo).catch(() => null);
    if (!pdf || !/\.pdf$/i.test(pdf)) return null;
    const m = await medirTinta(pdf, [1, 2, 3, 4, 5, 6, 7, 8]).catch(() => new Map());
    for (let p = 1; p <= 8; p++) { const x = m.get(p); if (x && x.tinta >= TINTA_MIN) return x.huella; }
    return null;
}

let reparados = 0, fallos = 0, seleccionesHechas = 0;
for (const g of artefactos) {
    // Huella: de hasta dos PDFs del grupo; si coinciden (o solo hay una), se registra.
    const huellas = [];
    // (Solo al ejecutar: rasterizar PDFs para listar sería lento y no hace falta para crear las selecciones.)
    if (EJECUTAR) for (const d of g.ds) { if (huellas.length >= 2) break; const h = await huellaDePortadaPdf(d); if (h) huellas.push(h); }
    const huella = huellas.length && huellaInformativa(huellas[0]) && (huellas.length < 2 || distanciaHuellas(huellas[0], huellas[1]) <= 6) ? huellas[0] : null;
    console.log(`🖼️  ${g.sha.slice(0, 12)} · ${g.ds.length} documento(s), ${g.obras} obras${g.coleccion ? ' · TODOS DE UNA COLECCIÓN' : ''} · huella de página ${huella || '—'} · ej. ${g.ds[0].portada}`);
    for (const d of g.ds.slice(0, 5)) console.log(`     «${String(d.titulo).slice(0, 50)}» · ${String(d.nombre_archivo || '').slice(0, 60)}`);
    if (g.ds.length > 5) console.log(`     … y ${g.ds.length - 5} más`);
    if (SELECCIONES) {
        // Una por grupo; si ya existe (otra pasada), se ACTUALIZAN sus miembros en vez de duplicarla.
        const prefijo = `Portada sospechosa ${g.sha.slice(0, 8)}`;
        const deColeccion = g.coleccion ? ' · de colección' : '';
        const nombre = `${prefijo} (${g.ds.length})${deColeccion}`;
        const descripcion = `La MISMA imagen es la portada de ${g.ds.length} documentos (${g.obras} obras distintas): probablemente no es la de ninguno. `
            + (g.coleccion ? 'Todos pertenecen a la MISMA colección: puede ser la portada de la serie (legítima) o una colección-cajón. ' : '')
            + `Revísalos y usa «🚩 Portada sospechosa…» (quitar / re-extraer omitiendo la sospechosa / primera página de texto). `
            + `Ej.: ${g.ds.slice(0, 4).map((d) => `«${String(d.titulo || '').slice(0, 40)}»`).join(', ')}. sha ${g.sha}`;
        const ya = await db.collection('selecciones').findOne({ nombre: { $regex: `^${prefijo}` } }, { projection: { _id: 1 } });
        if (ya) {
            await reemplazarDocs(db, ya._id, g.ds.map((d) => d._id));
            await db.collection('selecciones').updateOne({ _id: ya._id }, { $set: { nombre, descripcion } });
        } else await crearSeleccion(db, { nombre, descripcion, docs: g.ds.map((d) => d._id) });
        seleccionesHechas++;
    }
    if (!EJECUTAR) continue;
    // Grupo de UNA colección: podría ser la portada legítima de la serie → no se toca solo; decide tú en su selección.
    if (g.coleccion) { console.log('       ↪ de una colección: no se repara automáticamente (revísalo en su selección).'); continue; }

    await registrarArtefacto(db, { huella, sha: g.sha, ejemplos: g.ds.map((d) => d._id), nota: String(g.ds[0].titulo || '').slice(0, 80) });
    for (const d of g.ds) {
        const completo = await col.findOne({ _id: d._id });
        const r = await reextraerImagenesDoc(db, completo).catch((e) => ({ ok: false, motivo: e.message }));
        if (r.ok) {
            reparados++;
            await col.updateOne({ _id: d._id }, { $push: { alertas_agente: 'Portada artefacto (la misma imagen en libros distintos) sustituida por la real, re-extraída del propio fichero.' } });
            const act = await col.findOne({ _id: d._id });
            await regenerarSidecarsDoc(db, act, carpetaDeDoc(act)).catch(() => {});
        } else { fallos++; console.log(`       ⚠️  «${String(d.titulo).slice(0, 40)}»: ${r.motivo}`); }
    }
}
if (SELECCIONES) console.log(`\n📋 ${seleccionesHechas} selección(es) «Portada sospechosa …» creadas/actualizadas: revísalas en el panel (Selecciones) y usa «🚩 Portada sospechosa…».`);
console.log(EJECUTAR
    ? `\nArtefactos registrados: ${artefactos.length} · libros reparados: ${reparados} · sin reparar: ${fallos}\n`
    : '\nNo se ha tocado ningún documento. (Para registrar y reparar todo automáticamente: --ejecutar.)\n');
process.exit(0);
