#!/usr/bin/env node
/**
 * MIGRACIÓN de revistas — Paso 2 (recuperación). DRY-RUN por defecto; aplica con --ejecutar.
 *
 * Dos fases (por defecto se ejecutan ambas, en este orden):
 *
 *   FASE BACKFILL  (--backfill): enlaza los documentos de revista YA catalogados a su CABECERA
 *     (obra tipo:'revista' por ISSN, o por título normalizado), fijándoles obra / obra_titulo /
 *     clave_numero y reconstruyendo el inventario `numeros[]` de cada cabecera. Así el catálogo
 *     EXISTENTE queda con el nuevo modelo (antes las revistas eran documentos planos sin cabecera).
 *
 *   FASE RECUPERAR (--recuperar): re-cataloga los ficheros de número que están EN DISCO pero SIN
 *     documento en BD (los que el bug fusionó en el registro de otro). Pasan por el pipeline ya
 *     corregido (mes recuperado + dedup por cabecera+clave) → vuelven como números distintos.
 *
 * Solo toca REVISTAS GENUINAS: salta los libros mal clasificados como revista (nombre de fichero con
 * pinta de ISBN, o título-artefacto del productor) — esos son de la Fix B (migración aparte).
 *
 * Requiere haber corrido antes `node scripts/setup-mongo.js` (índices issn_obra / obra+clave_numero).
 *
 * Uso (en el contenedor del NAS):
 *   docker exec gestor-biblioteca node scripts/migrar-revistas.js                 # dry-run, ambas fases
 *   docker exec gestor-biblioteca node scripts/migrar-revistas.js --backfill      # solo backfill (dry-run)
 *   docker exec gestor-biblioteca node scripts/migrar-revistas.js --ejecutar      # aplica ambas fases
 *   docker exec gestor-biblioteca node scripts/migrar-revistas.js --recuperar --limite 5 --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { resolverCabecera, registrarNumeroEnColeccion as registrarNumeroEnCabecera } from '../src/utils/colecciones.js';
import { claveNumero, tituloCabecera } from '../src/utils/revistas.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';
import { ingestarRecurso } from '../src/servicio-ingesta.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');

const arg = (n) => process.argv.includes(n);
const EJECUTAR = arg('--ejecutar');
const SOLO_BACKFILL = arg('--backfill');
const SOLO_RECUPERAR = arg('--recuperar');
const HACER_BACKFILL = !SOLO_RECUPERAR;     // por defecto ambas; --recuperar desactiva backfill
const HACER_RECUPERAR = !SOLO_BACKFILL;     // por defecto ambas; --backfill desactiva recuperar
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity; })();

const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.zip', '.rar']);
const esDoc = (n) => EXT_DOC.has(path.extname(n).toLowerCase());
const ISBNRX = /^(97[89])?\d{9,12}[\dX]$/i;
const esISBNnombre = (n) => ISBNRX.test(path.basename(String(n || ''), path.extname(String(n || ''))).replace(/\(\d+\)$/, '').replace(/[ _\-.]/g, ''));
const idDe = (v) => (v && typeof v === 'object' && v._bsontype !== 'ObjectId' && v.$oid) ? v.$oid : v;

/** ¿Este "documento de revista" es en realidad un LIBRO mal clasificado? (→ lo deja para la Fix B) */
function esLibroDisfrazado(doc) {
    if (doc.isbn) return true;
    if (esTituloArtefacto(doc.titulo)) return true;
    if (doc.nombre_archivo && esISBNnombre(doc.nombre_archivo)) return true;
    return false;
}

async function* carpetasDeRevista(dir, dentro = false) {
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const archivos = entradas.filter(e => e.isFile()).map(e => e.name);
    if (dentro && archivos.some(esDoc)) yield { dir, archivos };
    for (const e of entradas) {
        if (e.isDirectory()) yield* carpetasDeRevista(path.join(dir, e.name), dentro || e.name === 'revistas');
    }
}
const carpetaEsRevista = (seg, segPadre, docFiles) => {
    if (esTituloArtefacto(seg) || esTituloArtefacto(segPadre)) return false;
    return docFiles.filter(esISBNnombre).length < Math.ceil(docFiles.length / 2);
};

async function backfill(db) {
    const col = db.collection('biblioteca');
    const docs = await col.find({ tipo_recurso: 'revista', $or: [{ obra: { $exists: false } }, { obra: null }] }).toArray();
    console.log(`\n══ FASE BACKFILL ══  ${docs.length} revista(s) sin cabecera`);

    let enlazados = 0, saltadosLibro = 0, saltadosSinClave = 0;
    const cabeceras = new Map(); // clave de agrupación → {titulo, n}
    for (const doc of docs) {
        if (esLibroDisfrazado(doc)) { saltadosLibro++; continue; }
        const issn = doc.issn || null;
        const cabTitulo = tituloCabecera(doc.obra_titulo || doc.titulo);
        if (!issn && !cabTitulo) { saltadosSinClave++; continue; }
        const clave = claveNumero(doc);
        const grupo = issn ? `issn:${issn}` : `tit:${cabTitulo}`;
        const g = cabeceras.get(grupo) || { titulo: cabTitulo || issn, n: 0 }; g.n++; cabeceras.set(grupo, g);

        if (EJECUTAR) {
            const { _id } = await resolverCabecera(db, {
                titulo: cabTitulo, issn,
                editorialId: idDe(doc.editorial) || null, coleccionId: idDe(doc.coleccion) || null, cdu: doc.cdu || null,
            });
            if (_id) {
                const set = { obra: _id, obra_titulo: cabTitulo || doc.obra_titulo };
                if (clave) set.clave_numero = clave;
                await col.updateOne({ _id: doc._id }, { $set: set });
                await registrarNumeroEnCabecera(db, _id, {
                    clave: clave || null, 'año': doc.año_edicion ?? null, mes: doc.mes_publicacion ?? null, numero_issue: doc.numero_issue ?? null,
                }, doc._id);
                enlazados++;
            }
        } else {
            enlazados++;
        }
    }
    console.log(`  Cabeceras que se ${EJECUTAR ? 'han usado/creado' : 'usarían/crearían'}: ${cabeceras.size}`);
    console.log(`  Números enlazados a su cabecera: ${enlazados}`);
    console.log(`  Saltados (parecen LIBROS → Fix B): ${saltadosLibro}`);
    console.log(`  Saltados (sin ISSN ni título usable): ${saltadosSinClave}`);
    const top = [...cabeceras.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
    if (top.length) { console.log('  Mayores cabeceras:'); for (const [k, v] of top) console.log(`    · ${v.n.toString().padStart(3)} × ${v.titulo}  [${k}]`); }
}

async function recuperar(db) {
    const col = db.collection('biblioteca');
    const all = await col.find({}, { projection: { nombre_archivo: 1, archivos_originales: 1 } }).toArray();
    const conRegistro = new Set();
    for (const d of all) { if (d.nombre_archivo) conRegistro.add(d.nombre_archivo); for (const a of (d.archivos_originales || [])) conRegistro.add(a); }

    // Recolectar los ficheros perdidos (en disco, sin registro) de carpetas de REVISTA genuina.
    const perdidos = [];
    for await (const { dir, archivos } of carpetasDeRevista(DIR_CDU)) {
        const docFiles = archivos.filter(esDoc);
        if (docFiles.length < 2) continue;
        const seg = path.basename(dir), segPadre = path.basename(path.dirname(dir));
        if (!carpetaEsRevista(seg, segPadre, docFiles)) continue; // libros/basura → Fix B
        for (const f of docFiles) {
            if (conRegistro.has(f) || esISBNnombre(f)) continue;   // ya catalogado, o pinta de libro
            perdidos.push(path.join(dir, f));
        }
    }
    console.log(`\n══ FASE RECUPERAR ══  ${perdidos.length} fichero(s) de número en disco sin registro (revistas)`);

    const STAGING = path.join(RAIZ, 'temp', 'recup-revistas');
    let hechos = 0, fallos = 0, ausentes = 0, n = 0;
    for (const abs of perdidos) {
        if (n++ >= LIMITE) { console.log(`  (límite ${LIMITE} alcanzado)`); break; }
        if (!EJECUTAR) { console.log(`  [dry-run] re-catalogaría: ${path.relative(DIR_CDU, abs)}`); continue; }
        // CLAVE: el original VIVE en el árbol CDU. NUNCA se lo damos directo al pipeline — para un
        // duplicado exacto el pipeline hace fs.rm del "origen" (= borraría el fichero del catálogo).
        // Lo COPIAMOS a un staging desechable y catalogamos ESA copia; el original queda intacto.
        try { await fs.access(abs); }
        catch { console.warn(`  ⊘ ya no está en disco (revisar Recycling/obras): ${path.relative(DIR_CDU, abs)}`); ausentes++; continue; }
        await fs.mkdir(STAGING, { recursive: true });
        const copia = path.join(STAGING, path.basename(abs));
        try {
            await fs.copyFile(abs, copia);
            const r = await ingestarRecurso({ rutas: [copia] });
            console.log(`  ✔ ${r.operacion} · ${r.documento?.titulo || path.basename(abs)}  (${r.issn || 's/issn'})`);
            hechos++;
        } catch (e) {
            console.warn(`  ✗ ${path.basename(abs)}: ${e.message}`);
            fallos++;
        } finally {
            await fs.rm(copia, { force: true }).catch(() => {});
        }
    }
    await fs.rm(STAGING, { recursive: true, force: true }).catch(() => {});
    if (EJECUTAR) console.log(`  Recatalogados: ${hechos} · fallos: ${fallos} · ausentes en disco: ${ausentes}`);
    if (EJECUTAR && hechos) console.log('  NOTA: el original "absorbido" queda en su carpeta vieja (intacto); un pase de integridad lo recicla.');
}

async function main() {
    if (!process.argv.includes('--force-legacy')) {
        console.log('⛔ SUPERSEDED — usa scripts/migrar-revistas-a-colecciones.js (modelo nuevo: cabecera = COLECCIÓN).');
        console.log('   Este script opera sobre el modelo ANTIGUO (cabecera = obra). Archivado; forzarlo: --force-legacy.');
        process.exit(0);
    }
    console.log(`🛠  Migración de revistas — ${EJECUTAR ? '⚠ EJECUTAR (aplica cambios)' : 'DRY-RUN (no cambia nada)'}`);
    console.log(`    Árbol CDU: ${DIR_CDU}`);
    const db = await conectarDB();
    if (HACER_BACKFILL) await backfill(db);
    if (HACER_RECUPERAR) await recuperar(db);
    if (!EJECUTAR) console.log('\n(esto fue un DRY-RUN; añade --ejecutar para aplicar)');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
