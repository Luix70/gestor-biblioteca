import fs from 'fs';
import Database from 'better-sqlite3';
import { COLS, ESQUEMA_FICHERO, ESQUEMA_INDICES, parseAutorLine, parseEdicionLine, parseBneLine } from './etl-map.js';

/**
 * ETL del FICHERO local: vuelca los dumps de Open Library (TSV, ~92 GB) y BNE (JSON array, ~2,4 GB)
 * a un único SQLite `fichero.db` con columnas al estilo de `biblioteca`. Se ejecuta UNA VEZ en un PC
 * potente (con NVMe), y luego se copia el .db al NAS (/volume3/BIBLIOTECA DIGITAL/Fichero/).
 *
 *   1) en ese PC:  npm install better-sqlite3      (NO está en package.json para no romper el
 *                                                   build del NAS; allí lo añadiremos con buscador-local)
 *   2)  node scripts/etl-fichero.js --ol <ol_dump.txt> --bne <BNE_dump.json> --out <fichero.db> [--raw]
 *
 * REANUDABLE: cada lote (50k) commitea las filas Y el offset de bytes en la MISMA transacción
 * (tabla _etl_progreso). Un corte de luz / Ctrl-C NO corrompe (SQLite es ACID): al re-ejecutar,
 * retoma cada fase desde su último offset (no re-lee lo ya hecho). Ctrl-C cierra el lote en curso y
 * sale limpio. --raw guarda además el registro original íntegro en `extra` (infla mucho; por defecto NO).
 * La lógica de mapeo vive en etl-map.js (testeable sin SQLite).
 */
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const OL = opt('--ol'), BNE = opt('--bne'), OUT = opt('--out'), RAW = args.includes('--raw');
if (!OUT || (!OL && !BNE)) {
    console.error('Uso: node scripts/etl-fichero.js --ol <ol_dump.txt> --bne <BNE.json> --out <fichero.db> [--raw]');
    process.exit(1);
}
const BATCH = 50000, FLUSH_LINEAS = 1_000_000;

let parar = false;
process.on('SIGINT', () => { if (!parar) { console.log('\n⏸️  Parando tras el lote en curso… (Ctrl-C de nuevo para forzar)'); parar = true; } else process.exit(1); });

const db = new Database(OUT);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -300000'); // ~300 MB
db.exec(`
${ESQUEMA_FICHERO}
CREATE TABLE IF NOT EXISTS _ol_autores (key TEXT PRIMARY KEY, nombre TEXT);
CREATE TABLE IF NOT EXISTS _etl_progreso (fase TEXT PRIMARY KEY, offset INTEGER DEFAULT 0, hechos INTEGER DEFAULT 0, completa INTEGER DEFAULT 0);
`);

const insFichero = db.prepare(`INSERT INTO fichero (${COLS.join(',')}) VALUES (${COLS.map(c => '@' + c).join(',')})`);
const insAutor = db.prepare('INSERT OR IGNORE INTO _ol_autores (key, nombre) VALUES (@key, @nombre)');
const getAutorStmt = db.prepare('SELECT nombre FROM _ol_autores WHERE key = ?');
const getProg = db.prepare('SELECT offset, hechos, completa FROM _etl_progreso WHERE fase = ?');
const setProg = db.prepare(`INSERT INTO _etl_progreso (fase, offset, hechos, completa) VALUES (@fase,@offset,@hechos,@completa)
  ON CONFLICT(fase) DO UPDATE SET offset=@offset, hechos=@hechos, completa=@completa`);
const getAutor = (key) => { const r = key && getAutorStmt.get(key); return r ? r.nombre : null; };

// Lector de líneas con offset de bytes EXACTO (para reanudar sin re-leer).
async function* leerLineas(file, startOffset) {
    const stream = fs.createReadStream(file, { start: startOffset, highWaterMark: 1 << 20 });
    let resto = Buffer.alloc(0), offset = startOffset;
    for await (const chunk of stream) {
        let buf = resto.length ? Buffer.concat([resto, chunk]) : chunk, base = 0, i;
        while ((i = buf.indexOf(0x0a, base)) !== -1) {
            offset += (i - base) + 1;
            yield { line: buf.toString('utf8', base, i).replace(/\r$/, ''), offset };
            base = i + 1;
        }
        resto = buf.subarray(base);
    }
    if (resto.length) { offset += resto.length; yield { line: resto.toString('utf8').replace(/\r$/, ''), offset }; }
}

async function correrFase(fase, file, stmt, parseLinea) {
    if (!file) return;
    const p = getProg.get(fase) || { offset: 0, hechos: 0, completa: 0 };
    if (p.completa) { console.log(`✓ ${fase}: ya completa (${p.hechos}).`); return; }
    const total = fs.statSync(file).size;
    let lote = [], hechos = p.hechos, lastOffset = p.offset, lineasDesde = 0, ultimoLog = 0;
    const t0 = Date.now(), off0 = p.offset;
    const flush = db.transaction((filas, off, hh, completa) => {
        for (const f of filas) stmt.run(f);
        setProg.run({ fase, offset: off, hechos: hh, completa });
    });
    console.log(`▶ ${fase}: desde ${(p.offset / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`);
    for await (const { line, offset } of leerLineas(file, p.offset)) {
        lastOffset = offset; lineasDesde++;
        const fila = parseLinea(line);
        if (fila) lote.push(fila);
        if (lote.length >= BATCH || lineasDesde >= FLUSH_LINEAS) {
            hechos += lote.length; flush(lote, lastOffset, hechos, 0); lote = []; lineasDesde = 0;
            const ahora = Date.now();
            if (ahora - ultimoLog > 5000) {
                ultimoLog = ahora;
                const bps = (lastOffset - off0) / 1e6 / ((ahora - t0) / 1000);
                const eta = bps > 0 ? Math.round((total - lastOffset) / 1e6 / bps) : 0;
                console.log(`  ${fase}: ${hechos.toLocaleString()} filas · ${(lastOffset / 1e9).toFixed(1)}/${(total / 1e9).toFixed(0)} GB · ${bps.toFixed(0)} MB/s · ETA ${Math.floor(eta / 60)}m${eta % 60}s`);
            }
            if (parar) break;
        }
    }
    hechos += lote.length; flush(lote, lastOffset, hechos, parar ? 0 : 1);
    console.log(parar ? `⏸️  ${fase}: pausada en ${(lastOffset / 1e9).toFixed(2)} GB (${hechos.toLocaleString()}). Re-ejecuta para continuar.`
        : `✓ ${fase}: COMPLETA (${hechos.toLocaleString()} filas).`);
}

function faseIndices() {
    const p = getProg.get('indices');
    if (p && p.completa) { console.log('✓ indices: ya completa.'); return; }
    console.log('▶ indices: índice ISBN + FTS5 (varios minutos)…');
    db.exec(ESQUEMA_INDICES);
    db.exec('DROP TABLE IF EXISTS _ol_autores');
    setProg.run({ fase: 'indices', offset: 0, hechos: 0, completa: 1 });
    console.log('✓ indices: COMPLETA.');
}

(async () => {
    console.log(`ETL Fichero → ${OUT}${RAW ? ' (con --raw)' : ''}`);
    if (OL) await correrFase('ol_autores', OL, insAutor, parseAutorLine);
    if (OL && !parar) await correrFase('ol_ediciones', OL, insFichero, (l) => parseEdicionLine(l, getAutor, RAW));
    if (BNE && !parar) await correrFase('bne', BNE, insFichero, (l) => parseBneLine(l, RAW));
    if (!parar) faseIndices();
    const n = db.prepare('SELECT COUNT(*) c FROM fichero').get().c;
    const conIsbn = db.prepare('SELECT COUNT(*) c FROM fichero WHERE isbn IS NOT NULL').get().c;
    console.log(`\n📚 fichero.db: ${n.toLocaleString()} registros (${conIsbn.toLocaleString()} con ISBN).`);
    db.close();
    process.exit(parar ? 130 : 0);
})().catch(e => { console.error('ETL error:', e); db.close(); process.exit(1); });
