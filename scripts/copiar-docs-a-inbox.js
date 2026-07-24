/**
 * COPIAR DOCUMENTOS A INBOX — utilidad de recuperación mínima y SEGURA: copia (nunca mueve) todos los
 * documentos legibles de una carpeta al Inbox, SUELTOS y con nombre único, para que el vigilante los catalogue
 * uno a uno. No toca Mongo ni recicla nada; la carpeta de origen queda intacta.
 *
 * Usa fs.copyFile (lee+escribe), así que funciona ENTRE VOLÚMENES distintos (el Inbox y el árbol CDU/Papelera
 * del NAS están en dispositivos distintos → `fs.rename` da EXDEV; copyFile no).
 *
 * Uso:
 *   node scripts/copiar-docs-a-inbox.js --desde "<carpeta>"            (DRY-RUN: solo cuenta)
 *   node scripts/copiar-docs-a-inbox.js --desde "<carpeta>" --ejecutar (COPIA al Inbox)
 */
import 'dotenv/config';
import '../src/config.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { esDocumentoLeible } from '../src/utils/criba-material.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_INBOX = (() => { const v = process.env.PATH_INBOX || 'Inbox'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const EJECUTAR = process.argv.includes('--ejecutar');
const DESDE = arg('--desde');
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#');

/** Ficheros (abs, nombre) recursivos de una carpeta. */
async function listar(raiz) {
    const out = [], pila = [raiz];
    while (pila.length) {
        const dir = pila.pop();
        let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (ignorar(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) pila.push(abs);
            else out.push({ abs, nombre: e.name });
        }
    }
    return out;
}

/** Nombre libre en el Inbox: «x.pdf» → «x (2).pdf». Nunca pisa nada. */
async function nombreLibre(nombre) {
    const ext = path.extname(nombre), base = path.basename(nombre, ext);
    let dest = path.join(DIR_INBOX, nombre);
    for (let i = 2; await fs.access(dest).then(() => true, () => false); i++) dest = path.join(DIR_INBOX, `${base} (${i})${ext}`);
    return dest;
}

async function main() {
    if (!DESDE) { console.error('Falta --desde "<carpeta origen>".'); process.exit(1); }
    const desde = path.resolve(DESDE);
    if (!(await fs.stat(desde).then((s) => s.isDirectory(), () => false))) { console.error(`No es una carpeta: ${desde}`); process.exit(1); }

    const ficheros = await listar(desde);
    const docs = ficheros.filter((f) => esDocumentoLeible(f.nombre));
    console.log(`\n=== Copiar documentos a Inbox ${EJECUTAR ? '· EJECUCIÓN' : '· SIMULACIÓN (dry-run)'} ===`);
    console.log(`Origen: ${desde}`);
    console.log(`Destino (Inbox): ${DIR_INBOX}`);
    console.log(`Documentos legibles encontrados: ${docs.length} (de ${ficheros.length} ficheros)`);

    if (!EJECUTAR) {
        console.log(`\n(simulación) Se copiarían ${docs.length} documentos SUELTOS al Inbox. La carpeta de origen NO se toca.`);
        console.log(`Re-ejecuta con --ejecutar para copiarlos.`);
        process.exit(0);
    }

    await fs.mkdir(DIR_INBOX, { recursive: true });
    let copiados = 0, fallidos = 0;
    for (const f of docs) {
        try { await fs.copyFile(f.abs, await nombreLibre(f.nombre)); copiados++; }
        catch (e) { fallidos++; console.warn(`  ⚠ «${f.nombre}»: ${e.message}`); }
    }
    console.log(`\n✅ ${copiados} documento(s) copiados al Inbox${fallidos ? ` · ${fallidos} con error` : ''}. La carpeta de origen sigue intacta.`);
    console.log(`Activa el Vigilante (con el arreglo desplegado) para catalogarlos uno a uno.`);
    process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
