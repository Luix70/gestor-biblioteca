/**
 * scripts/importar-bne.js
 *
 * Importa el volcado MARC21 (ISO 2709) de datos abiertos de la BNE a la colección
 * MongoDB `bne_cdus`, creando un índice ISBN→[CDUs] para consultas locales sin API.
 *
 * El volcado completo está disponible en:
 *   https://www.bne.es/es/Micrositios/Franquicias/opendata/Catalogos/BibliograficaNacional
 * Descargar el fichero .mrc (MARC21 binario) y pasarlo como argumento.
 *
 * Uso:
 *   node scripts/importar-bne.js <ruta-al-fichero.mrc>
 *   node scripts/importar-bne.js C:\Descargas\bne_marc.mrc
 *
 * El campo MARC21 relevante:
 *   020 $a → ISBN (puede tener texto tras el número: "9788491041795 (rústica)")
 *   080 $a → CDU (puede haber varios campos 080)
 *
 * El script es incremental (upsert): se puede re-ejecutar sin duplicar.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'fs';
import path from 'path';
import { conectarDB } from '../src/database.js';

const MARC_LEADER_LEN = 24;
const COL = 'bne_cdus';
const BATCH = 500;  // documentos por escritura masiva

// ─── Parser ISO 2709 (MARC21 binario) ────────────────────────────────────────

/**
 * Extrae el texto de un subfield $a del primer campo con el `tag` dado.
 * Devuelve todas las ocurrencias de ese campo (puede haber múltiples 080).
 */
function extraerCampos(buffer, offset, baseData, directorio, tag) {
    const resultados = [];
    for (const d of directorio) {
        if (d.tag !== tag) continue;
        const raw = buffer.slice(baseData + d.pos, baseData + d.pos + d.len - 1); // -1 quita el FS
        const texto = raw.toString('utf8');
        // subfield delimiter es 0x1F seguido de código de subcampo
        const subs = texto.split('\x1F').slice(1); // el primero es indicadores
        for (const s of subs) {
            if (s[0] === 'a') resultados.push(s.slice(1).trim());
        }
    }
    return resultados;
}

function limpiarISBN(raw) {
    // "9788491041795 (rústica)" → "9788491041795"
    const m = raw.match(/(\d[\d\-X]{8,})/i);
    return m ? m[1].replace(/-/g, '') : null;
}

function limpiarCDU(raw) {
    return raw.replace(/^\(|\)$/g, '').trim();
}

/**
 * Genera registros MARC21 desde un buffer completo.
 * Devuelve iterador síncrono de {isbns: string[], cdus: string[]}.
 */
function* parsearMARC(buffer) {
    let pos = 0;
    while (pos < buffer.length) {
        // Leader: 5 primeros bytes = longitud del registro
        const lenStr = buffer.slice(pos, pos + 5).toString('ascii');
        const len = parseInt(lenStr);
        if (!len || isNaN(len) || pos + len > buffer.length) break;

        const recBuf = buffer.slice(pos, pos + len);
        const leader = recBuf.slice(0, MARC_LEADER_LEN).toString('ascii');
        const baseData = parseInt(leader.slice(12, 17));
        const dirLen = baseData - MARC_LEADER_LEN - 1; // -1 por el field terminator del directorio

        // Directorio: cada entrada = 12 bytes (3 tag + 4 len + 5 offset)
        const directorio = [];
        for (let i = 0; i < dirLen; i += 12) {
            const tag = recBuf.slice(MARC_LEADER_LEN + i, MARC_LEADER_LEN + i + 3).toString('ascii');
            const fLen = parseInt(recBuf.slice(MARC_LEADER_LEN + i + 3, MARC_LEADER_LEN + i + 7).toString('ascii'));
            const fPos = parseInt(recBuf.slice(MARC_LEADER_LEN + i + 7, MARC_LEADER_LEN + i + 12).toString('ascii'));
            directorio.push({ tag, len: fLen, pos: fPos });
        }

        const rawIsbns = extraerCampos(recBuf, 0, baseData, directorio, '020');
        const rawCdus  = extraerCampos(recBuf, 0, baseData, directorio, '080');

        const isbns = rawIsbns.map(limpiarISBN).filter(Boolean);
        const cdus  = rawCdus.map(limpiarCDU).filter(Boolean);

        if (isbns.length > 0 && cdus.length > 0) yield { isbns, cdus };

        pos += len;
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const fichero = process.argv[2];
    if (!fichero) {
        console.error('Uso: node scripts/importar-bne.js <fichero.mrc>');
        process.exit(1);
    }
    const ruta = path.resolve(fichero);
    if (!fs.existsSync(ruta)) {
        console.error(`No se encuentra el fichero: ${ruta}`);
        process.exit(1);
    }

    console.log(`Leyendo: ${ruta}`);
    const buffer = fs.readFileSync(ruta);
    console.log(`Tamaño: ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

    const db = await conectarDB();
    const col = db.collection(COL);

    // Índice para búsquedas por ISBN
    await col.createIndex({ isbn: 1 }, { unique: true, background: true });

    let totalRegistros = 0;
    let totalIsbnCdu = 0;
    let lote = [];
    let insertados = 0;

    function flush() {
        if (lote.length === 0) return Promise.resolve();
        const ops = lote.map(({ isbn, cdus }) => ({
            updateOne: {
                filter: { isbn },
                update: { $set: { isbn, cdus } },
                upsert: true,
            },
        }));
        lote = [];
        return col.bulkWrite(ops, { ordered: false });
    }

    for (const { isbns, cdus } of parsearMARC(buffer)) {
        totalRegistros++;
        for (const isbn of isbns) {
            lote.push({ isbn, cdus });
            totalIsbnCdu++;
        }
        if (lote.length >= BATCH) {
            await flush();
            insertados += BATCH;
            process.stdout.write(`\r  ${totalRegistros} registros procesados, ${totalIsbnCdu} ISBN-CDU...`);
        }
    }
    await flush();

    console.log(`\n\n✅ Importación completa.`);
    console.log(`   Registros MARC21 leídos:    ${totalRegistros}`);
    console.log(`   Pares ISBN→CDU indexados:   ${totalIsbnCdu}`);
    console.log(`   Colección: ${COL}`);
    process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
