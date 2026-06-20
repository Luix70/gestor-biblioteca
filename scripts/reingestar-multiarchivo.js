/**
 * Utilidad de UN SOLO USO — reingesta de carpetas CDU con varios documentos.
 *
 * Históricamente, varios .epub/.pdf (distintas ediciones/versiones del mismo ISBN, o ficheros
 * mal fusionados por título) acabaron en una sola carpeta CDU compartiendo un único registro
 * Mongo. Con la nueva lógica (dedup por hash + por versión, carpetas disambiguadas, revistas
 * por número) cada documento debe tener su propio registro y su propia carpeta.
 *
 * Esta utilidad, por cada carpeta de la lista:
 *   1. Respalda el/los documento(s) Mongo asociados a un JSON (nada se pierde).
 *   2. MUEVE cada .epub/.pdf/... al Inbox de forma TRANSACCIONAL (copia → verifica tamaño →
 *      borra origen). Los sidecars (registro.json, .marc.xml, portadas) se DESCARTAN.
 *   3. Borra el/los registro(s) Mongo.
 *   4. Elimina la carpeta CDU (ya vacía de documentos; quedan solo sidecars que se descartan).
 *
 * Al reiniciar la app, el vigilante reprocesa el Inbox y recataloga cada fichero por separado.
 *
 * ⚠️  EJECUTAR CON LA APP / EL CONTENEDOR DETENIDO. Si el vigilante está vivo, podría reprocesar
 *     un fichero y reescribir la misma carpeta ISBN justo cuando esta utilidad la borra (carrera).
 *     Flujo correcto: detener la app → ejecutar esta utilidad → arrancar la app.
 *
 * Uso:
 *   node scripts/reingestar-multiarchivo.js                 (DRY-RUN: solo informa, no toca nada)
 *   node scripts/reingestar-multiarchivo.js --ejecutar      (aplica los cambios)
 *   node scripts/reingestar-multiarchivo.js --lista otra.txt --ejecutar
 */

import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { MongoClient, ObjectId } from 'mongodb';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');

const EXT_DOC = ['.epub', '.pdf', '.mobi', '.cbr', '.djvu', '.zip', '.rar'];

const resolverDir = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
const DIR_INBOX = resolverDir('PATH_INBOX', 'Inbox');

// --- args ---
const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const idxLista = args.indexOf('--lista');
const RUTA_LISTA = idxLista >= 0 && args[idxLista + 1]
    ? path.resolve(args[idxLista + 1])
    : path.join(__dirname, 'reingesta-lista.txt');

const existe = (p) => fs.access(p).then(() => true).catch(() => false);

/** Lee la lista de carpetas (relativas a PATH_CDU), ignorando comentarios/blancos y './'. */
async function leerLista(ruta) {
    const txt = await fs.readFile(ruta, 'utf8');
    return txt.split(/\r?\n/)
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .map(l => l.replace(/^\.\//, ''));
}

/** /recursos/... a partir de la ruta absoluta de la carpeta. */
function webDeCarpeta(abs) {
    const rel = path.relative(DIR_CDU, abs).split(path.sep).join('/');
    return '/recursos/' + rel;
}

/** Nombre libre en el Inbox: añade " (reN)" antes de la extensión si ya existe. */
async function nombreLibreInbox(nombre) {
    let destino = path.join(DIR_INBOX, nombre);
    if (!await existe(destino)) return destino;
    const ext = path.extname(nombre);
    const base = path.basename(nombre, ext);
    let n = 1;
    while (await existe(destino)) destino = path.join(DIR_INBOX, `${base} (re${n++})${ext}`);
    return destino;
}

/**
 * Mueve un fichero al Inbox de forma transaccional:
 *   copia a un temp oculto (ignorado por el vigilante) → verifica tamaño → renombra (atómico)
 *   → verifica → borra el origen. Devuelve el destino final o lanza si la verificación falla.
 */
async function moverAInboxTransaccional(origen) {
    const stOrig = await fs.stat(origen);
    if (stOrig.size <= 0) throw new Error(`origen de 0 bytes: ${path.basename(origen)}`);

    const destinoFinal = await nombreLibreInbox(path.basename(origen));
    // Temp OCULTO en el MISMO dir que el destino → el rename es atómico y el vigilante ignora
    // los nombres que empiezan por '.' (no lo procesa a medio copiar).
    const temp = path.join(DIR_INBOX, `.reing-tmp-${Date.now()}-${path.basename(origen)}`);

    await fs.mkdir(DIR_INBOX, { recursive: true });
    await fs.copyFile(origen, temp);
    const stTemp = await fs.stat(temp);
    if (stTemp.size !== stOrig.size) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw new Error(`copia no íntegra (${stOrig.size}B → ${stTemp.size}B): ${path.basename(origen)}`);
    }
    await fs.rename(temp, destinoFinal);
    const stDest = await fs.stat(destinoFinal);
    if (stDest.size !== stOrig.size) {
        throw new Error(`verificación final fallida: ${path.basename(destinoFinal)}`);
    }
    // Origen verificado en destino → ya se puede borrar.
    await fs.rm(origen, { force: true });
    return destinoFinal;
}

async function main() {
    const uri = process.env.MONGO_URI;
    const dbName = process.env.MONGO_DB_NAME || 'biblioteca';
    if (!uri) { console.error('MONGO_URI no definida en .env'); process.exit(1); }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`Reingesta de carpetas multi-documento  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    console.log(`  PATH_CDU : ${DIR_CDU}`);
    console.log(`  PATH_INBOX: ${DIR_INBOX}`);
    console.log(`  lista    : ${RUTA_LISTA}`);
    console.log(`${'═'.repeat(70)}`);
    if (!EJECUTAR) console.log('ℹ️  DRY-RUN: no se moverá ni borrará nada. Añade --ejecutar para aplicar.\n');
    else console.log('⚠️  MODO EJECUCIÓN. Asegúrate de que la app/contenedor está DETENIDO.\n');

    const carpetas = await leerLista(RUTA_LISTA);
    console.log(`${carpetas.length} carpeta(s) en la lista.\n`);

    const client = new MongoClient(uri);
    await client.connect();
    const col = client.db(dbName).collection('biblioteca');

    // Carpeta de respaldo para los documentos Mongo que se vayan a borrar.
    const sello = new Date().toISOString().replace(/[:.]/g, '-');
    const dirBackup = path.join(RAIZ, '_reingesta-backup', sello);
    if (EJECUTAR) await fs.mkdir(dirBackup, { recursive: true });

    let okFolders = 0, saltadas = 0, ficherosMovidos = 0, docsBorrados = 0;
    const incidencias = [];

    for (const rel of carpetas) {
        const abs = path.join(DIR_CDU, ...rel.split('/'));
        console.log(`\n📂 ${rel}`);

        if (!await existe(abs)) {
            console.log(`   ⏭️  no existe en disco — se omite.`);
            saltadas++; incidencias.push({ rel, motivo: 'no existe' });
            continue;
        }

        // Clasificar contenido: documentos vs sidecars.
        let entradas;
        try { entradas = await fs.readdir(abs, { withFileTypes: true }); }
        catch (e) { console.log(`   ⚠️  ilegible: ${e.message}`); saltadas++; incidencias.push({ rel, motivo: e.message }); continue; }

        const documentos = entradas.filter(e => e.isFile() && EXT_DOC.includes(path.extname(e.name).toLowerCase()))
            .map(e => path.join(abs, e.name));
        const sidecars = entradas.filter(e => e.isFile() && !EXT_DOC.includes(path.extname(e.name).toLowerCase()))
            .map(e => e.name);

        if (documentos.length === 0) {
            console.log(`   ⏭️  sin documentos (.epub/.pdf/...) — se omite para no perder el registro.`);
            saltadas++; incidencias.push({ rel, motivo: 'sin documentos' });
            continue;
        }

        // Verificar que ningún documento esté a 0 bytes (no reingestar ficheros corruptos).
        const vacios = [];
        for (const d of documentos) {
            const st = await fs.stat(d).catch(() => null);
            if (!st || st.size <= 0) vacios.push(path.basename(d));
        }
        if (vacios.length) {
            console.log(`   ⛔ documento(s) de 0 bytes: ${vacios.join(', ')} — se omite la carpeta (revisar a mano).`);
            saltadas++; incidencias.push({ rel, motivo: `0 bytes: ${vacios.join(', ')}` });
            continue;
        }

        // Localizar registro(s) Mongo: por _id del registro.json y por ruta_base de la carpeta.
        const idsCandidatos = new Set();
        try {
            const reg = JSON.parse(await fs.readFile(path.join(abs, 'registro.json'), 'utf8'));
            if (reg._id) idsCandidatos.add(String(reg._id));
        } catch { /* sin registro.json */ }
        const web = webDeCarpeta(abs);
        const porRuta = await col.find({ ruta_base: web }, { projection: { _id: 1 } }).toArray();
        for (const d of porRuta) idsCandidatos.add(String(d._id));

        const docs = [];
        for (const id of idsCandidatos) {
            let oid; try { oid = new ObjectId(id); } catch { continue; }
            const d = await col.findOne({ _id: oid });
            if (d) docs.push(d);
        }

        console.log(`   documentos: ${documentos.map(d => path.basename(d)).join(' · ')}`);
        console.log(`   sidecars a descartar: ${sidecars.length ? sidecars.join(' · ') : '(ninguno)'}`);
        console.log(`   registro(s) Mongo: ${docs.length ? docs.map(d => String(d._id)).join(', ') : '⚠️ ninguno encontrado'}`);

        if (!EJECUTAR) {
            console.log(`   → (dry-run) movería ${documentos.length} fichero(s) al Inbox, borraría ${docs.length} doc(s) y la carpeta.`);
            okFolders++;
            continue;
        }

        // 1. Respaldo de los documentos Mongo.
        for (const d of docs) {
            await fs.writeFile(path.join(dirBackup, `${String(d._id)}.json`), JSON.stringify(d, null, 2), 'utf8');
        }

        // 2. Mover documentos al Inbox (transaccional).
        let fallo = false;
        for (const d of documentos) {
            try {
                const dest = await moverAInboxTransaccional(d);
                console.log(`   ➡️  ${path.basename(d)} → Inbox/${path.basename(dest)}`);
                ficherosMovidos++;
            } catch (e) {
                console.error(`   ⛔ no se pudo mover ${path.basename(d)}: ${e.message}`);
                fallo = true;
            }
        }
        if (fallo) {
            console.error(`   ⚠️  Carpeta NO eliminada (quedó algún documento sin mover). Registro(s) Mongo CONSERVADO(s).`);
            incidencias.push({ rel, motivo: 'fallo al mover algún documento' });
            continue;
        }

        // 3. Borrar registro(s) Mongo.
        for (const d of docs) {
            await col.deleteOne({ _id: d._id });
            docsBorrados++;
        }

        // 4. Eliminar la carpeta (sidecars descartados).
        await fs.rm(abs, { recursive: true, force: true });
        console.log(`   🗑️  carpeta eliminada (sidecars descartados).`);
        okFolders++;
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log('RESUMEN');
    console.log(`  Carpetas procesadas/OK : ${okFolders}`);
    console.log(`  Carpetas omitidas      : ${saltadas}`);
    if (EJECUTAR) {
        console.log(`  Ficheros movidos a Inbox: ${ficherosMovidos}`);
        console.log(`  Registros Mongo borrados: ${docsBorrados}`);
        console.log(`  Respaldo en            : ${dirBackup}`);
        console.log(`\n  Ahora arranca la app: el vigilante recatalogará el Inbox.`);
    } else {
        console.log(`\n  DRY-RUN: vuelve a ejecutar con --ejecutar para aplicar.`);
    }
    if (incidencias.length) {
        console.log(`\n  Incidencias:`);
        for (const i of incidencias) console.log(`   • ${i.rel} — ${i.motivo}`);
    }

    await client.close();
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
