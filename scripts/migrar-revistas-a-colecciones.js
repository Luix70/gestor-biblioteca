#!/usr/bin/env node
/**
 * MIGRACIÓN — cabeceras de revista (y series de libros) al modelo de COLECCIONES. DRY-RUN por defecto;
 * aplica con --ejecutar. Sustituye a migrar-revistas.js + reparar-revistas.js + reclasificar-libros.js.
 *
 * Modelo nuevo: la cabecera de una revista es una COLECCIÓN (tipo:'revista', pivote `issn`); cada número
 * es un doc de 'biblioteca' (tipo_recurso:'revista') miembro vía `doc.coleccion` + `clave_numero`. Una
 * serie de monografías con ISSN de serie (p. ej. «Graduate Texts in Physics», 1868-4513) es una COLECCIÓN
 * tipo:'libro'; sus miembros son LIBROS con su PROPIO ISBN. El ISSN vive en la colección, nunca en el libro.
 *
 * Fases (por defecto todas, en orden):
 *   1. INSPECT  — clasifica cada ISSN (revista vs serie-libros) por nº de títulos distintos. Solo lectura.
 *   2. MOVE     — copia las cabeceras antiguas (obras tipo:'revista') a colecciones tipo:'revista'.
 *   3. REWIRE   — reengancha cada número de revista a su colección-cabecera (doc.coleccion + clave_numero),
 *                 y RECLASIFICA a 'libro' los docs que en realidad son monografías de serie (Fix B).
 *   4. RECOVER  — re-cataloga los ficheros de número en disco SIN registro en BD (los que el bug fusionó).
 *   5. CLEANUP  — borra las obras tipo:'revista' que quedaron vacías tras reenganchar.
 *
 * Uso (en el contenedor del NAS):
 *   docker exec gestor-biblioteca node scripts/migrar-revistas-a-colecciones.js              # DRY-RUN
 *   docker exec gestor-biblioteca node scripts/migrar-revistas-a-colecciones.js --ejecutar
 *   docker exec gestor-biblioteca node scripts/migrar-revistas-a-colecciones.js --sin-recuperar --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { resolverCabecera, registrarNumeroEnColeccion } from '../src/utils/colecciones.js';
import { claveNumero, tituloCabecera, clasificarISSN, pareceSerieLibros } from '../src/utils/revistas.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';
import { validarISBN, variantesISBN } from '../src/utils/identificadores.js';
import { ingestarRecurso } from '../src/servicio-ingesta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');

const arg = (n) => process.argv.includes(n);
const EJECUTAR = arg('--ejecutar');
const SIN_RECUPERAR = arg('--sin-recuperar');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity; })();
// ISSN forzados a SERIE DE LIBROS por el usuario tras revisar el INSPECT: --libros=ISSN1,ISSN2,…
const LIBROS_OVERRIDE = new Set((process.argv.find(a => a.startsWith('--libros=')) || '')
    .replace('--libros=', '').split(',').map(s => s.trim()).filter(Boolean));

const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.zip', '.rar']);
const esDoc = (n) => EXT_DOC.has(path.extname(n).toLowerCase());
const idDe = (v) => (v && typeof v === 'object' && v._bsontype !== 'ObjectId' && v.$oid) ? v.$oid : v;

// ISBN incrustado en un nombre de archivo (libros nombrados por su ISBN: Springer, etc.).
function isbnDeNombre(nombre) {
    if (!nombre) return null;
    const re = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])/g;
    let m;
    while ((m = re.exec(nombre)) !== null) { const v = validarISBN(m[1]); if (v) return v; }
    return null;
}

/** ¿Este "número de revista" es en realidad un LIBRO? (clase del ISSN + señales por documento). */
function decidirLibro(doc, claseISSN) {
    if (doc.issn && LIBROS_OVERRIDE.has(doc.issn)) return { libro: true, motivo: 'forzado por --libros' };
    if (claseISSN === 'serie-libros') return { libro: true, motivo: 'ISSN de serie de libros' };
    if (doc.isbn) return { libro: true, motivo: 'tiene ISBN propio' };
    const isbn = isbnDeNombre(doc.nombre_archivo);
    if (isbn) return { libro: true, motivo: 'ISBN en el nombre', isbn };
    if (esTituloArtefacto(doc.titulo)) return { libro: true, motivo: 'título-artefacto' };
    if (pareceSerieLibros(doc.titulo)) return { libro: true, motivo: 'título de serie/editorial' };
    if (/\/obras\//.test(doc.ruta_base || '')) return { libro: true, motivo: 'colocado en obras/' };
    if ((doc.dewey || doc.lcc) && !doc.numero_issue && !doc.mes_publicacion) return { libro: true, motivo: 'Dewey/LCC sin nº de revista' };
    return { libro: false };
}

// ── FASE 1: INSPECT ───────────────────────────────────────────────────────────
async function inspeccionar(db) {
    const bib = db.collection('biblioteca');
    const revistas = await bib.find({ tipo_recurso: 'revista' }).toArray();
    const porISSN = new Map();
    let sinISSN = 0;
    for (const d of revistas) {
        if (!d.issn) { sinISSN++; continue; }
        let arr = porISSN.get(d.issn);
        if (!arr) porISSN.set(d.issn, arr = []);
        arr.push(d);
    }
    const clases = new Map(); // issn → 'revista'|'serie-libros'|'ambiguo'
    const filas = [];
    for (const [issn, docs] of porISSN) {
        const r = clasificarISSN(docs);
        clases.set(issn, r.clase);
        filas.push({ issn, ...r, titulo: tituloCabecera(docs[0].obra_titulo || docs[0].titulo) || issn });
    }
    filas.sort((a, b) => b.n - a.n);

    console.log(`\n══ FASE 1 · INSPECT ══  ${revistas.length} doc(s) tipo:'revista'  ·  ${porISSN.size} ISSN distinto(s)  ·  ${sinISSN} sin ISSN`);
    const tot = { revista: 0, 'serie-libros': 0, ambiguo: 0 };
    for (const f of filas) tot[f.clase]++;
    console.log(`  Clasificación de ISSN:  revista=${tot.revista}  serie-libros=${tot['serie-libros']}  ambiguo=${tot.ambiguo}`);
    console.log(`  ${'clase'.padEnd(13)} ${'n'.padStart(4)} ${'tít.dist'.padStart(8)} ${'c/fecha'.padStart(7)} ${'c/dewey'.padStart(7)}  ISSN · título`);
    for (const f of filas.slice(0, 40)) {
        console.log(`  ${f.clase.padEnd(13)} ${String(f.n).padStart(4)} ${String(f.distintos).padStart(8)} ${String(f.conFecha).padStart(7)} ${String(f.conDewey).padStart(7)}  ${f.issn} · ${f.titulo}`);
        if (f.clase === 'serie-libros' && f.titulos.length) console.log(`      → títulos: ${f.titulos.slice(0, 4).join(' | ')}${f.titulos.length > 4 ? ' …' : ''}`);
    }
    if (filas.length > 40) console.log(`  … y ${filas.length - 40} ISSN más`);
    return clases;
}

// ── FASE 2: MOVE — obras tipo:'revista' → colecciones tipo:'revista' ───────────
async function moverCabeceras(db) {
    const obras = db.collection('obras');
    const cabeceras = await obras.find({ tipo: 'revista' }).toArray();
    const mapa = new Map(); // String(obraId) → coleccionId
    console.log(`\n══ FASE 2 · MOVE ══  ${cabeceras.length} cabecera(s) en 'obras' (tipo:'revista')`);
    for (const c of cabeceras) {
        if (!EJECUTAR) { console.log(`  [dry-run] → colección tipo:'revista'  ${c.issn_obra || 's/issn'} · ${c.titulo || '(sin título)'}`); continue; }
        const { _id } = await resolverCabecera(db, {
            nombre: c.titulo, issn: c.issn_obra || null, tipo: 'revista',
            editorialId: idDe(c.editorial) || null, cdu: c.cdu || null, descripcion: c.descripcion || null,
        });
        if (_id) mapa.set(String(c._id), _id);
    }
    if (EJECUTAR) console.log(`  Cabeceras copiadas a colecciones: ${mapa.size}`);
    return mapa;
}

// ── FASE 3: REWIRE (+ RECLASSIFY) ──────────────────────────────────────────────
async function reengancharYReclasificar(db, clases, mapaObra) {
    const bib = db.collection('biblioteca');
    const revistas = await bib.find({ tipo_recurso: 'revista' }).toArray();
    const cuentaRew = {}, cuentaLib = {};
    let rewired = 0, reclasif = 0;

    for (const doc of revistas) {
        const clase = doc.issn ? (clases.get(doc.issn) || 'ambiguo') : null;
        const dec = decidirLibro(doc, clase);

        if (dec.libro) {
            cuentaLib[dec.motivo] = (cuentaLib[dec.motivo] || 0) + 1;
            reclasif++;
            if (!EJECUTAR) continue;
            const set = { tipo_recurso: 'libro' };
            const unset = { clave_numero: '', obra: '' };
            // ISBN propio (recuperado del nombre si faltaba).
            const isbn = dec.isbn || isbnDeNombre(doc.nombre_archivo);
            if (isbn && !doc.isbn) set.isbn = variantesISBN(isbn).find(v => v.length === 13) || isbn;
            // Serie de libros: cuelga el libro de una colección tipo:'libro' (pivote ISSN de serie).
            if (doc.issn) {
                const { _id } = await resolverCabecera(db, {
                    nombre: doc.coleccion_nombre || null, issn: doc.issn, tipo: 'libro',
                    editorialId: idDe(doc.editorial) || null, cdu: doc.cdu || null,
                });
                if (_id) set.coleccion = _id;
                unset.issn = ''; // la autoridad ISSN vive en la colección, no en el libro
            }
            await bib.updateOne({ _id: doc._id }, { $set: set, $unset: unset });
            continue;
        }

        // Número de revista genuino → reenganchar a su colección-cabecera.
        cuentaRew[clase || 'sin-issn'] = (cuentaRew[clase || 'sin-issn'] || 0) + 1;
        rewired++;
        if (!EJECUTAR) continue;

        let coleccionId = doc.obra ? mapaObra.get(String(doc.obra)) : null;
        const cabTitulo = tituloCabecera(doc.obra_titulo || doc.titulo);
        if (!coleccionId && (doc.issn || cabTitulo)) {
            const { _id } = await resolverCabecera(db, {
                nombre: cabTitulo, issn: doc.issn || null, tipo: 'revista',
                editorialId: idDe(doc.editorial) || null, cdu: doc.cdu || null,
            });
            coleccionId = _id;
        }
        if (!coleccionId) continue; // sin ISSN ni título usable: se deja como estaba

        const clave = claveNumero(doc);
        const set = { coleccion: coleccionId };
        if (cabTitulo) set.coleccion_nombre = cabTitulo;
        if (clave) set.clave_numero = clave;
        const unset = {};
        if (doc.obra) unset.obra = '';
        const upd = { $set: set };
        if (Object.keys(unset).length) upd.$unset = unset;
        await bib.updateOne({ _id: doc._id }, upd);
        await registrarNumeroEnColeccion(db, coleccionId, {
            clave: clave || null, 'año': doc.año_edicion ?? null, mes: doc.mes_publicacion ?? null, numero_issue: doc.numero_issue ?? null,
        }, doc._id);
    }

    console.log(`\n══ FASE 3 · REWIRE (+RECLASSIFY) ══`);
    console.log(`  Números reenganchados a su colección-cabecera: ${rewired}`);
    for (const [k, n] of Object.entries(cuentaRew)) console.log(`    · ${String(n).padStart(4)} × ${k}`);
    console.log(`  Reclasificados a LIBRO: ${reclasif}`);
    for (const [k, n] of Object.entries(cuentaLib)) console.log(`    · ${String(n).padStart(4)} × ${k}`);
}

// ── FASE 4: RECOVER — ficheros de número en disco sin registro ──────────────────
async function* carpetasDeRevista(dir, dentro = false) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const archivos = entradas.filter(e => e.isFile()).map(e => e.name);
    if (dentro && archivos.some(esDoc)) yield { dir, archivos };
    for (const e of entradas) {
        if (e.isDirectory()) yield* carpetasDeRevista(path.join(dir, e.name), dentro || e.name === 'revistas');
    }
}
async function recuperar(db) {
    const bib = db.collection('biblioteca');
    const all = await bib.find({}, { projection: { nombre_archivo: 1, archivos_originales: 1 } }).toArray();
    const conRegistro = new Set();
    for (const d of all) { if (d.nombre_archivo) conRegistro.add(d.nombre_archivo); for (const a of (d.archivos_originales || [])) conRegistro.add(a); }

    const perdidos = [];
    for await (const { dir, archivos } of carpetasDeRevista(DIR_CDU)) {
        const docFiles = archivos.filter(esDoc);
        if (docFiles.length < 2) continue;                          // una carpeta de un solo fichero no es una revista
        if (esTituloArtefacto(path.basename(dir))) continue;
        for (const f of docFiles) {
            if (conRegistro.has(f) || isbnDeNombre(f)) continue;    // ya catalogado, o pinta de libro
            perdidos.push(path.join(dir, f));
        }
    }
    console.log(`\n══ FASE 4 · RECOVER ══  ${perdidos.length} fichero(s) de número en disco sin registro`);

    const STAGING = path.join(RAIZ, 'temp', 'recup-revistas');
    let hechos = 0, fallos = 0, ausentes = 0, n = 0;
    for (const abs of perdidos) {
        if (n++ >= LIMITE) { console.log(`  (límite ${LIMITE} alcanzado)`); break; }
        if (!EJECUTAR) { console.log(`  [dry-run] re-catalogaría: ${path.relative(DIR_CDU, abs)}`); continue; }
        // El original VIVE en el árbol CDU; lo COPIAMOS a un staging desechable y catalogamos esa copia
        // (si fuera duplicado exacto el pipeline haría fs.rm del "origen" = borraría el del catálogo).
        try { await fs.access(abs); }
        catch { console.warn(`  ⊘ ya no está en disco: ${path.relative(DIR_CDU, abs)}`); ausentes++; continue; }
        await fs.mkdir(STAGING, { recursive: true });
        const copia = path.join(STAGING, path.basename(abs));
        try {
            await fs.copyFile(abs, copia);
            const r = await ingestarRecurso({ rutas: [copia] });
            console.log(`  ✔ ${r.operacion} · ${r.documento?.titulo || path.basename(abs)}`);
            hechos++;
        } catch (e) {
            console.warn(`  ✗ ${path.basename(abs)}: ${e.message}`);
            fallos++;
        } finally {
            await fs.rm(copia, { force: true }).catch(() => {});
        }
    }
    await fs.rm(STAGING, { recursive: true, force: true }).catch(() => {});
    if (EJECUTAR) console.log(`  Recatalogados: ${hechos} · fallos: ${fallos} · ausentes: ${ausentes}`);
}

// ── FASE 5: CLEANUP — borrar obras tipo:'revista' vacías ───────────────────────
async function limpiarCabecerasVacias(db) {
    const obras = db.collection('obras'), bib = db.collection('biblioteca');
    const cabeceras = await obras.find({ tipo: 'revista' }, { projection: { _id: 1, titulo: 1 } }).toArray();
    let borradas = 0;
    for (const c of cabeceras) {
        const usos = await bib.countDocuments({ obra: c._id });
        if (usos === 0) { if (EJECUTAR) await obras.deleteOne({ _id: c._id }); borradas++; }
    }
    console.log(`\n══ FASE 5 · CLEANUP ══  obras tipo:'revista' vacías ${EJECUTAR ? 'borradas' : 'a borrar'}: ${borradas} / ${cabeceras.length}`);
    await limpiarColeccionesVacias(db);
}

// Colecciones sin ningún miembro ni inventario (p. ej. cabeceras-fantasma que quedaron tras reclasificar
// sus únicos docs a libro). No toca las `locked` (intervención humana).
async function limpiarColeccionesVacias(db) {
    const colCol = db.collection('colecciones'), bib = db.collection('biblioteca');
    const cols = await colCol.find({ locked: { $ne: true } }, { projection: { numeros: 1 } }).toArray();
    let borradas = 0;
    for (const c of cols) {
        const usos = await bib.countDocuments({ coleccion: c._id });
        if (usos === 0 && !(c.numeros && c.numeros.length)) { if (EJECUTAR) await colCol.deleteOne({ _id: c._id }); borradas++; }
    }
    console.log(`           colecciones vacías ${EJECUTAR ? 'borradas' : 'a borrar'}: ${borradas} / ${cols.length}`);
}

async function main() {
    console.log(`🛠  Migración revistas → colecciones — ${EJECUTAR ? '⚠ EJECUTAR (aplica cambios)' : 'DRY-RUN (no cambia nada)'}`);
    console.log(`    Árbol CDU: ${DIR_CDU}`);
    const db = await conectarDB();
    const clases = await inspeccionar(db);
    const mapaObra = await moverCabeceras(db);
    await reengancharYReclasificar(db, clases, mapaObra);
    if (!SIN_RECUPERAR) await recuperar(db);
    await limpiarCabecerasVacias(db);
    if (!EJECUTAR) console.log('\n(esto fue un DRY-RUN; añade --ejecutar para aplicar)');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
