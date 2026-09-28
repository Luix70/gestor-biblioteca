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
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js              (DRY-RUN)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js --ejecutar
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

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
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
// UNIDAD de obra: los tomos de una obra y los miembros de una colección comparten con todo derecho la portada del
// conjunto (medido en el primer barrido: Grzimek, las enciclopedias de Gale, «Novels for Students», colecciones de
// audiolibros…) — no es un artefacto. Cuentan como UNA sola unidad; si no, el título sin números.
const unidad = (d) => (d.obra ? `o:${d.obra}` : d.coleccion ? `c:${d.coleccion}` : `t:${norm(d.titulo)}`);

// ── 1. Portadas: por tamaño, y SHA solo de los tamaños repetidos ─────────────────────────────────────────
const docs = await col.find({ portada: { $exists: true, $ne: null } },
    { projection: { portada: 1, titulo: 1, isbn: 1, nombre_archivo: 1, imagenes: 1, ruta_base: 1, obra: 1, coleccion: 1 } }).toArray();
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${docs.length} documentos con portada`);
const porTam = new Map();
let i = 0;
for (const d of docs) {
    if (++i % 2000 === 0) process.stdout.write(`\r   tamaños: ${i}/${docs.length}`);
    try { const st = await fs.stat(abs(d.portada)); porTam.set(st.size, [...(porTam.get(st.size) || []), d]); } catch { /* no está */ }
}
const porSha = new Map();
for (const ds of porTam.values()) {
    if (ds.length < 2) continue;
    for (const d of ds) {
        try {
            const sha = crypto.createHash('sha256').update(await fs.readFile(abs(d.portada))).digest('hex');
            porSha.set(sha, [...(porSha.get(sha) || []), d]);
        } catch { /* */ }
    }
}
process.stdout.write('\r' + ' '.repeat(40) + '\r');

// ── 2. Artefactos: la misma imagen en N obras distintas ──────────────────────────────────────────────────
const artefactos = [...porSha.entries()]
    .map(([sha, ds]) => ({ sha, ds, obras: new Set(ds.map(unidad)).size }))
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

let reparados = 0, fallos = 0;
for (const g of artefactos) {
    // Huella: de hasta dos PDFs del grupo; si coinciden (o solo hay una), se registra.
    const huellas = [];
    for (const d of g.ds) { if (huellas.length >= 2) break; const h = await huellaDePortadaPdf(d); if (h) huellas.push(h); }
    const huella = huellas.length && huellaInformativa(huellas[0]) && (huellas.length < 2 || distanciaHuellas(huellas[0], huellas[1]) <= 6) ? huellas[0] : null;
    console.log(`🖼️  ${g.sha.slice(0, 12)} · ${g.ds.length} documento(s), ${g.obras} obras · huella de página ${huella || '—'} · ej. ${g.ds[0].portada}`);
    for (const d of g.ds.slice(0, 5)) console.log(`     «${String(d.titulo).slice(0, 50)}» · ${String(d.nombre_archivo || '').slice(0, 60)}`);
    if (g.ds.length > 5) console.log(`     … y ${g.ds.length - 5} más`);
    if (!EJECUTAR) continue;

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
console.log(EJECUTAR
    ? `\nArtefactos registrados: ${artefactos.length} · libros reparados: ${reparados} · sin reparar: ${fallos}\n`
    : '\nDRY-RUN: no se ha registrado ni cambiado nada. Repite con --ejecutar.\n');
process.exit(0);
