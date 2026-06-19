/**
 * scripts/importar-bne.js
 *
 * Importa el volcado JSON de datos abiertos de la BNE a la colección MongoDB
 * `bne_cdus`, creando un índice ISBN → {cdus, paginas, dimensiones, fecha, lengua}.
 *
 * Fichero fuente: monomodernas-JSON.json (descarga manual desde datosabiertos.bne.es)
 * Colocarlo en docs/ o pasar la ruta como argumento.
 *
 * Uso:
 *   node scripts/importar-bne.js
 *   node scripts/importar-bne.js docs/monomodernas-JSON.json
 *   node scripts/importar-bne.js C:\Descargas\monomodernas-JSON.json
 *
 * Estadísticas del fichero (monografías modernas, marzo 2025):
 *   2.368.294 registros totales
 *   1.275.537 con ISBN + CDU  ← los que importamos
 *   Estimado en MongoDB: ~130-150 MB (dentro del free tier M0)
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { conectarDB } from '../src/database.js';

const FICHERO_DEFAULT = path.resolve('docs/monomodernas-JSON.json');
const COL = 'bne_cdus';
const BATCH = 500;

// ─── Limpieza de campos ────────────────────────────────────────────────────

function limpiarISBN(raw) {
    if (!raw) return null;
    // La BNE puede almacenar varios ISBNs separados por espacio; tomamos el primero con
    // longitud válida (10 o 13 dígitos). Así evitamos importar concatenaciones.
    for (const parte of raw.trim().split(/\s+/)) {
        const limpio = parte.replace(/-/g, '').trim();
        if (/^\d{13}$/.test(limpio) || /^\d{9}[\dX]$/.test(limpio)) return limpio;
    }
    return null;
}

/**
 * La BNE termina cada campo CDU con el marcador de fin de campo "BARRA-ASTERISCO-ASTERISCO-BARRA".
 * Los CDUs que son solo subdivisiones sin código base (p.ej. "(07)", "(075.8)")
 * se descartan por ser inútiles sin contexto.
 */
function limpiarCDU(raw) {
    if (!raw) return null;
    const limpio = raw.replace(/\/\*\*\//g, '').trim();
    // Descarta si el código empieza directamente por "(" o "." sin número base
    if (!limpio || /^[\(\.\-\+]/.test(limpio)) return null;
    return limpio;
}

/**
 * Extrae el número de páginas del campo "extension".
 * Formatos encontrados: "256 páginas", "XI, 130 páginas", "1 memoria USB (340 páginas)"
 */
function extraerPaginas(extension) {
    if (!extension) return null;
    // Busca el último número árabe antes de "página/s"
    const m = extension.match(/(\d+)\s*p[áa]g/i);
    return m ? parseInt(m[1]) : null;
}

function limpiarDimensiones(raw) {
    if (!raw) return null;
    const d = raw.trim();
    // Filtra entradas absurdas (USB, CD de 4-5 cm no son dimensiones de libro)
    if (/^\d\s*cm$/.test(d) && parseInt(d) < 8) return null;
    return d || null;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
    const fichero = path.resolve(process.argv[2] || FICHERO_DEFAULT);
    if (!fs.existsSync(fichero)) {
        console.error(`No se encuentra: ${fichero}`);
        console.error(`Descarga el fichero desde datosabiertos.bne.es y colócalo en docs/`);
        process.exit(1);
    }

    const stat = fs.statSync(fichero);
    console.log(`Fichero: ${fichero}`);
    console.log(`Tamaño:  ${(stat.size / 1024 / 1024).toFixed(0)} MB`);
    console.log(`Colección destino: ${COL}\n`);

    const db = await conectarDB();
    const col = db.collection(COL);
    await col.createIndex({ isbn: 1 }, { unique: true, background: true });

    const rl = readline.createInterface({
        input: fs.createReadStream(fichero),
        crlfDelay: Infinity,
    });

    let totalLeidos = 0, totalImportados = 0, sinISBN = 0, sinCDU = 0;
    let lote = [];

    async function flush() {
        if (!lote.length) return;
        const ops = lote.map(doc => ({
            updateOne: {
                filter: { isbn: doc.isbn },
                update: { $set: doc },
                upsert: true,
            },
        }));
        await col.bulkWrite(ops, { ordered: false });
        totalImportados += lote.length;
        lote = [];
    }

    for await (const linea of rl) {
        // El fichero es un array JSON: cada línea es un objeto + coma opcional
        const clean = linea.trim().replace(/^[\[,]/, '').replace(/[,\]]$/, '').trim();
        if (!clean || clean === '[' || clean === ']') continue;

        let rec;
        try { rec = JSON.parse(clean); } catch { continue; }
        totalLeidos++;

        const isbn = limpiarISBN(rec.isbn);
        if (!isbn) { sinISBN++; continue; }

        const cdu = limpiarCDU(rec.cdu);
        if (!cdu) { sinCDU++; continue; }

        const doc = {
            isbn,
            cdus: [cdu],                                     // array para consistencia con buscador-bne.js
            paginas: extraerPaginas(rec.extension),
            dimensiones: limpiarDimensiones(rec.dimensiones),
            fecha: rec.fecha_de_publicacion || null,
            lengua: rec.lengua_principal || null,
            tema: rec.tema?.replace(/\s*\/\*\*\/\s*/g, ' / ').trim() || null,
            genero_forma: rec.genero_forma?.replace(/\s*\/\*\*\/\s*/g, ' / ').trim() || null,
        };
        // Quitar campos null para no hinchar los documentos
        for (const k of Object.keys(doc)) { if (doc[k] === null) delete doc[k]; }

        lote.push(doc);
        if (lote.length >= BATCH) {
            await flush();
            process.stdout.write(`\r  ${totalLeidos.toLocaleString()} leídos | ${totalImportados.toLocaleString()} importados...`);
        }
    }
    await flush();

    console.log(`\n\n✅ Importación completa.`);
    console.log(`   Registros leídos:       ${totalLeidos.toLocaleString()}`);
    console.log(`   Sin ISBN:               ${sinISBN.toLocaleString()}`);
    console.log(`   Sin CDU válida:         ${sinCDU.toLocaleString()}`);
    console.log(`   Importados a MongoDB:   ${totalImportados.toLocaleString()}`);
    console.log(`   Colección:              ${COL}`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
