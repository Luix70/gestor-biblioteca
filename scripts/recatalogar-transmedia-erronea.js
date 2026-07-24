/**
 * RECATALOGAR UNA COLECCIÓN TRANSMEDIA MAL DETECTADA — recuperación del incidente 2026-07-24: una carpeta de
 * cientos de libros independientes se catalogó como UNA sola colección transmedia porque contenía un fichero
 * interactivo (.exe/.dll/…). Este script deshace ese error y devuelve los libros al Inbox para que se
 * recataloguen UNO A UNO por el pipeline normal (ISBN, CDU real, metadatos) — con el bug ya arreglado.
 *
 * Qué hace (en --ejecutar):
 *   1) Localiza la carpeta CDU de la colección y CLASIFICA su contenido: documentos legibles (los libros) vs.
 *      ficheros INTERACTIVOS (el culpable) vs. material/accesorios. Lo REPORTA (responde «¿dónde está el .exe?»).
 *   2) Mueve cada DOCUMENTO LEGIBLE, SUELTO, al Inbox (con nombre único) → el vigilante los cataloga como libros
 *      INDEPENDIENTES.
 *   3) Borra de Mongo los documentos-miembro y el documento de la colección (y los quita del índice de búsqueda).
 *   4) Recicla a la Papelera lo que quede en la carpeta CDU (el interactivo + accesorios): no se pierde nada.
 *
 * SEGURIDAD: DRY-RUN por defecto (no toca nada). El original que se soltó en el Inbox sigue además en la
 * Papelera de aquel día, así que hay doble red. Aun así: haz COPIA DE SEGURIDAD antes de --ejecutar, y ten el
 * VIGILANTE con el arreglo YA DESPLEGADO (si no, al llegar los libros al Inbox podría re-fundirlos).
 *
 * Uso:
 *   node scripts/recatalogar-transmedia-erronea.js --id <idColeccion>
 *   node scripts/recatalogar-transmedia-erronea.js --id <idColeccion> --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';
import { desindexarDoc } from '../src/utils/indice-busqueda.js';
import { reciclarCarpeta } from '../src/utils/papelera.js';
import { esDocumentoLeible } from '../src/utils/criba-material.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_INBOX = (() => { const v = process.env.PATH_INBOX || 'Inbox'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const EJECUTAR = process.argv.includes('--ejecutar');
const ID = arg('--id');

const EXT_INTERACTIVO = new Set(['.exe', '.swf', '.dll', '.bat', '.cmd', '.msi', '.dmg', '.jar']);
const esInteractivo = (nombre, rel) => EXT_INTERACTIVO.has(path.extname(nombre).toLowerCase())
    || /^autorun\.inf$/i.test(nombre) || /(^|\/)[^/]+\.app\//i.test(rel);
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#');

/** Lista recursiva de ficheros (abs, rel POSIX, nombre) de una carpeta. */
async function listar(raiz) {
    const out = [], pila = [raiz];
    while (pila.length) {
        const dir = pila.pop();
        let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (ignorar(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) pila.push(abs);
            else out.push({ abs, rel: path.relative(raiz, abs).split(path.sep).join('/'), nombre: e.name });
        }
    }
    return out;
}

/** Nombre libre en el Inbox (no pisar nada): «libro.pdf» → «libro (2).pdf». */
async function nombreLibre(nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let dest = path.join(DIR_INBOX, nombre);
    for (let i = 2; await fs.access(dest).then(() => true, () => false); i++) dest = path.join(DIR_INBOX, `${base} (${i})${ext}`);
    return dest;
}

async function main() {
    if (!ID || !ObjectId.isValid(ID)) { console.error('Falta --id <idColeccion> válido.'); process.exit(1); }
    const db = await conectarDB();
    const col = db.collection('colecciones');
    const bib = db.collection('biblioteca');
    const _id = new ObjectId(ID);
    const coleccion = await col.findOne({ _id });
    if (!coleccion) { console.error('No existe esa colección.'); process.exit(1); }

    console.log(`\n=== Recatalogar «${coleccion.nombre}» (${coleccion.tipo}) ${EJECUTAR ? '· EJECUCIÓN' : '· SIMULACIÓN (dry-run)'} ===\n`);
    if (coleccion.tipo !== 'transmedia') console.log(`⚠ OJO: esta colección NO es transmedia (${coleccion.tipo}). Continúa solo si sabes lo que haces.\n`);

    const miembros = await bib.find({ coleccion: _id }, { projection: { ruta_base: 1 } }).toArray();
    console.log(`Documentos-miembro en Mongo: ${miembros.length}`);

    // Carpeta CDU de la colección (raiz_web del doc de colección, o el ruta_base común de los miembros).
    const web = coleccion.raiz_web || (miembros[0] && miembros[0].ruta_base) || null;
    if (!web) { console.error('No se pudo determinar la carpeta de la colección.'); process.exit(1); }
    const carpeta = path.join(DIR_CDU, web.replace(/^\/?recursos\//, '').split('/').join(path.sep));
    console.log(`Carpeta CDU: ${carpeta}`);

    const ficheros = await listar(carpeta);
    const docs = ficheros.filter((f) => esDocumentoLeible(f.nombre));
    const interactivos = ficheros.filter((f) => esInteractivo(f.nombre, f.rel));
    const otros = ficheros.filter((f) => !esDocumentoLeible(f.nombre) && !esInteractivo(f.nombre, f.rel));

    console.log(`\nContenido de la carpeta:`);
    console.log(`  · documentos legibles (libros): ${docs.length}`);
    console.log(`  · ficheros INTERACTIVOS (el culpable de la mala clasificación): ${interactivos.length}`);
    for (const f of interactivos) console.log(`      → ${f.rel}`);
    console.log(`  · otros (material/accesorios): ${otros.length}`);

    if (!EJECUTAR) {
        console.log(`\n(simulación) Se moverían ${docs.length} libros SUELTOS al Inbox, se borrarían ${miembros.length} docs + la colección,`);
        console.log(`             y el resto (interactivo + material) iría a la Papelera. Nada se ha tocado.`);
        console.log(`\nHaz COPIA DE SEGURIDAD y despliega el arreglo del vigilante; luego re-ejecuta con --ejecutar.`);
        process.exit(0);
    }

    // 1) COPIAR los documentos legibles, SUELTOS, al Inbox → se catalogan como libros independientes. Se COPIA
    //    (fs.copyFile), no se mueve: el Inbox y el árbol CDU están en VOLÚMENES distintos (fs.rename da EXDEV),
    //    y además copiar deja el origen intacto hasta que se recicla entero al final (nada en el limbo).
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let movidos = 0, fallidos = 0;
    for (const f of docs) {
        try { await fs.copyFile(f.abs, await nombreLibre(f.nombre)); movidos++; }
        catch (e) { fallidos++; console.warn(`  ⚠ no se pudo copiar «${f.nombre}»: ${e.message}`); }
    }
    console.log(`\n${fallidos ? '⚠' : '✅'} ${movidos} libro(s) copiados al Inbox${fallidos ? ` · ${fallidos} FALLIDOS` : ''}.`);

    // SALVAGUARDA: NO borrar nada de Mongo ni reciclar si la copia no fue ÍNTEGRA. Antes seguía adelante aunque
    // se copiaran 0 → habría borrado los miembros dejando los libros solo en la Papelera. Ahora se aborta.
    if (fallidos > 0 || movidos < docs.length) {
        console.error(`\n⛔ ABORTADO: no se copiaron todos los documentos (${movidos}/${docs.length}). NO se ha borrado`);
        console.error(`   nada de Mongo ni reciclado nada. Revisa los errores de copia y vuelve a intentarlo.`);
        process.exit(1);
    }

    // 2) Borrar de Mongo los miembros (+ índice) y la colección.
    let borrados = 0;
    for (const m of miembros) { await desindexarDoc(m._id).catch(() => {}); await bib.deleteOne({ _id: m._id }); borrados++; }
    await col.deleteOne({ _id });
    console.log(`✅ Borrados ${borrados} documentos-miembro y la colección «${coleccion.nombre}» de Mongo.`);

    // 3) Reciclar a la Papelera lo que quede en la carpeta (interactivo + material + marcadores): no se pierde.
    const dest = await reciclarCarpeta(carpeta, `transmedia-erronea-${coleccion.nombre}`).catch((e) => { console.warn(`  ⚠ reciclado: ${e.message}`); return null; });
    console.log(dest ? `✅ Carpeta CDU reciclada a la Papelera (interactivo + material dentro).` : `⚠ La carpeta CDU no se pudo reciclar; revísala a mano: ${carpeta}`);

    console.log(`\nListo. Activa el Vigilante (con el arreglo desplegado) para que catalogue los ${movidos} libros del Inbox.`);
    process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
