/**
 * Resuelve AUTOMÁTICAMENTE el backlog de Cuarentena/duplicados con esta política:
 *
 *   · mismo HASH (fichero idéntico al catalogado)      → BORRAR el entrante.
 *   · formatos DISTINTOS (pdf vs epub…)                → CONSERVAR AMBOS (el entrante vuelve al
 *                                                         Inbox; la dedup por ISBN+formato lo cataloga
 *                                                         como documento aparte).
 *   · mismo formato, hash distinto                     → CONSERVAR EL MÁS GRANDE (por tamaño);
 *                                                         si empatan en tamaño → el MÁS RECIENTE.
 *        - gana el catalogado  → BORRAR el entrante.
 *        - gana el entrante    → REEMPLAZAR el fichero del documento y SINCRONIZAR la BD
 *                                (nombre_archivo, hash_contenido, paginas) + regenerar registros.
 *   · el documento catalogado ya no existe / sin fichero → REINGESTAR el entrante (recatalogar).
 *
 * Política "nunca borrar" matizada: el fichero REEMPLAZADO (distinto, se descarta el más pequeño) va
 * a la Papelera; el entrante IDÉNTICO se borra (es el mismo fichero, no aporta nada).
 *
 *   node scripts/resolver-duplicados.js              (DRY-RUN: decide y muestra, no toca nada)
 *   node scripts/resolver-duplicados.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc, archivoOriginal, numeroPaginasPdf } from '../src/mantenimiento/util-mantenimiento.js';
import { calcularHashArchivo } from '../src/utils/hash-archivo.js';
import { reciclar } from '../src/utils/papelera.js';
import { resolverNombres, aRegistroLegible, escribirSidecars } from '../src/utils/registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (env, def) => { const v = process.env[env] || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CUARENTENA = resolver('PATH_CUARENTENA', 'Cuarentena');
const DIR_INBOX = resolver('PATH_INBOX', 'Inbox');
const EJECUTAR = process.argv.includes('--ejecutar');

const mb = (b) => (b / 1e6).toFixed(1) + ' MB';
const formatoDe = (ruta) => path.extname(ruta).slice(1).toLowerCase();

async function metricas(ruta) {
    if (!ruta) return { existe: false };
    let st; try { st = await fs.stat(ruta); } catch { return { existe: false }; }
    const ext = path.extname(ruta).toLowerCase();
    const paginas = ext === '.pdf' ? await numeroPaginasPdf(ruta).catch(() => null) : null;
    return { existe: true, ruta, bytes: st.size, mtime: st.mtimeMs, paginas, formato: formatoDe(ruta) };
}

// Decide la acción según la política. Devuelve [accion, motivo].
function decidir(ex, en, hashIgual) {
    if (!en.existe) return ['revisar', 'el depósito no tiene fichero entrante'];
    if (!ex.existe) return ['reingestar', 'el catalogado no existe o no tiene fichero → recatalogar el entrante'];
    if (ex.formato !== en.formato) return ['ambos', `formatos distintos (${ex.formato} vs ${en.formato}) → documentos separados`];
    if (hashIgual) return ['borrar', 'mismo hash: es el mismo fichero'];
    if (en.bytes !== ex.bytes) return en.bytes > ex.bytes
        ? ['reemplazar', `entrante más grande (${mb(en.bytes)} > ${mb(ex.bytes)})`]
        : ['borrar', `catalogado más grande (${mb(ex.bytes)} > ${mb(en.bytes)})`];
    return en.mtime > ex.mtime
        ? ['reemplazar', 'mismo tamaño, entrante más reciente']
        : ['borrar', 'mismo tamaño, catalogado igual o más reciente'];
}

async function borrar(rutas) { for (const r of rutas) { await fs.chmod(r, 0o666).catch(() => {}); await fs.rm(r, { force: true }).catch(() => {}); } }
async function aInbox(rutas) {
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let ok = 0;
    for (const r of rutas) {
        try { const d = path.join(DIR_INBOX, path.basename(r)); await fs.copyFile(r, d);
            const [a, b] = await Promise.all([fs.stat(r), fs.stat(d)]); if (a.size === b.size) ok++; } catch { /* sigue */ }
    }
    return ok === rutas.length;
}

// Reemplaza el fichero del documento por el entrante y SINCRONIZA la BD + registros.
async function reemplazar(db, doc, ficheroNuevo) {
    const carpeta = carpetaDeDoc(doc);
    const viejo = await archivoOriginal(carpeta);
    if (viejo) await reciclar([viejo], `reemplazado-${doc.isbn || doc.titulo || String(doc._id)}`);
    const destino = path.join(carpeta, path.basename(ficheroNuevo));
    await fs.copyFile(ficheroNuevo, destino);
    const hash = await calcularHashArchivo(destino).catch(() => null);
    const paginas = path.extname(destino).toLowerCase() === '.pdf' ? await numeroPaginasPdf(destino).catch(() => null) : null;
    const set = { nombre_archivo: path.basename(ficheroNuevo) };
    if (hash) set.hash_contenido = hash;
    if (paginas) set.paginas = paginas;
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set });
    // Regenerar registro.json / .marc.xml con la BD ya actualizada (queda en sync).
    const docAct = { ...doc, ...set };
    const nombres = await resolverNombres(db, docAct);
    await escribirSidecars(carpeta, aRegistroLegible(docAct, nombres)).catch(() => {});
}

async function main() {
    console.log(`\nResolución de Cuarentena/duplicados  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    const catDir = path.join(DIR_CUARENTENA, 'duplicados');
    let deps; try { deps = (await fs.readdir(catDir, { withFileTypes: true })).filter(d => d.isDirectory()); } catch { deps = []; }
    if (!deps.length) { console.log('  (no hay depósitos en Cuarentena/duplicados)'); process.exit(0); }

    const db = await conectarDB();
    const cuenta = {};
    for (const d of deps) {
        const depDir = path.join(catDir, d.name);
        let estado; try { estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8')); } catch { estado = {}; }
        const ficheros = (await fs.readdir(depDir).catch(() => [])).filter(n => n !== 'estado.json').map(n => path.join(depDir, n));
        const entrante = ficheros[0] || null;
        const en = await metricas(entrante);

        const idExist = estado.documento_existente_id;
        const doc = (idExist && ObjectId.isValid(idExist)) ? await db.collection('biblioteca').findOne({ _id: new ObjectId(idExist) }) : null;
        const exFichero = doc ? await archivoOriginal(carpetaDeDoc(doc)) : null;
        const ex = await metricas(exFichero);

        let hashIgual = false;
        if (ex.existe && en.existe && ex.bytes === en.bytes && ex.formato === en.formato) {
            const [h1, h2] = await Promise.all([calcularHashArchivo(ex.ruta).catch(() => null), calcularHashArchivo(en.ruta).catch(() => null)]);
            hashIgual = !!(h1 && h2 && h1 === h2);
        }
        const [accion, motivo] = decidir(ex, en, hashIgual);
        cuenta[accion] = (cuenta[accion] || 0) + 1;
        console.log(`  • ${d.name}\n      ${accion.toUpperCase()} — ${motivo}`);

        if (!EJECUTAR) continue;
        try {
            if (accion === 'borrar') { await borrar(ficheros); await fs.rm(depDir, { recursive: true, force: true }); }
            else if (accion === 'reemplazar') { await reemplazar(db, doc, entrante); await borrar(ficheros); await fs.rm(depDir, { recursive: true, force: true }); }
            else if (accion === 'ambos' || accion === 'reingestar') { if (await aInbox(ficheros)) await fs.rm(depDir, { recursive: true, force: true }); }
            // 'revisar' → se deja el depósito intacto
        } catch (e) { console.error(`      ⛔ error al aplicar: ${e.message}`); }
    }

    console.log(`\n${'─'.repeat(56)}\nRESUMEN [${EJECUTAR ? 'aplicado' : 'simulado'}]:`);
    for (const [a, n] of Object.entries(cuenta)) console.log(`  ${a}: ${n}`);
    if (!EJECUTAR) console.log('\n(simulación) Re-ejecuta con --ejecutar para aplicar.');
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
